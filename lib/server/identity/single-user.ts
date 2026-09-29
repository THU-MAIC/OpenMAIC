/**
 * The `singleUser` built-in: one fixed owner for a personal installation.
 *
 * A self-hosted instance that one person runs for themselves (`docker compose
 * up` on a laptop, a home server on a private network) gains nothing from the
 * per-browser anonymous cookie: a second browser, a cleared cookie or a
 * private window would each see an empty library, and publishing would be
 * refused because an anonymous owner does not hold `course:publish`.
 * `OWNER_SINGLE_USER=true` resolves every request to one owner id instead
 * (`OWNER_SINGLE_USER_ID`, default `local`), described as `kind: 'user'`
 * with the `course:publish` role.
 *
 * **Exposure.** Resolving every request to one owner hands that owner's whole
 * library to whoever can reach the server, and route handlers cannot tell a
 * loopback client from an internet one (the TCP peer is not visible to them,
 * and forwarding headers are client-controlled), so nothing here inspects a
 * request. The mode runs with or without `ACCESS_CODE`: behind one, the
 * access-code middleware is the gate, as for `sharedTeam`; without one, the
 * deployment relies on not being reachable by anyone else (the Compose file
 * publishes the port on `127.0.0.1` by default), and
 * {@link warnIfSingleUserIsUnprotected} logs one prominent warning at startup.
 *
 * It is a method like any other (`./registry.ts`): with no host registration,
 * the variable makes it the only method. It has no credential, so it always
 * authenticates and nothing after it is asked, including the anonymous
 * fallback: no anonymous cookie is minted. It excludes `sharedTeam`: both
 * answer every request, so setting both fails the boot.
 *
 * Unlike `sharedTeam`, its principal gets a claim candidate (core's rule in
 * `./resolve.ts`): the deployment has exactly one person, so an anonymous
 * cookie the browser still carries from earlier anonymous use of the same
 * deployment names that person's own work, and claiming it into the single
 * owner is what keeps it visible.
 */

import { createLogger } from '@/lib/logger';

import type { OwnerAuthMethod, OwnerAuthMethodResult, OwnerPrincipal } from './types';
import { OWNER_ROLES } from './types';

export const SINGLE_USER_ENV = 'OWNER_SINGLE_USER';
export const SINGLE_USER_ID_ENV = 'OWNER_SINGLE_USER_ID';

/** The owner id when {@link SINGLE_USER_ID_ENV} is unset. */
export const DEFAULT_SINGLE_USER_OWNER_ID = 'local';

/**
 * Same restriction as `PERSISTENCE_SHARED_OWNER_ID`: the id becomes part of
 * material object keys, and excluding `:` rules out the `anon:` namespace of
 * the anonymous cookie method.
 */
const SINGLE_USER_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * A boolean setting: unset or blank is `false`; `true`/`1` and `false`/`0`
 * (any case) are accepted; anything else throws, so a typo cannot silently
 * leave a deployment in the other mode.
 */
function readBooleanSetting(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return false;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(
    `${name} must be "true", "1", "false" or "0", got ${JSON.stringify(process.env[name])}.`,
  );
}

/**
 * The single owner id, or `undefined` when single-user mode is off.
 *
 * Read from the environment on each call, like `resolveSharedOwnerId()`. Throws
 * on every configuration the server must not run with: a malformed switch or
 * id, and an id set while the mode is off (it would be ignored).
 * `instrumentation.ts` calls this at startup, so each of these fails the
 * deployment rather than every request.
 */
export function resolveSingleUserOwnerId(): string | undefined {
  const enabled = readBooleanSetting(SINGLE_USER_ENV);
  const configuredId = process.env[SINGLE_USER_ID_ENV]?.trim();
  if (!enabled) {
    if (configuredId) {
      throw new Error(
        `${SINGLE_USER_ID_ENV} is set but ${SINGLE_USER_ENV} is not "true", so it would be ` +
          `ignored. Set ${SINGLE_USER_ENV}=true, or unset ${SINGLE_USER_ID_ENV}.`,
      );
    }
    return undefined;
  }
  const ownerId = configuredId || DEFAULT_SINGLE_USER_OWNER_ID;
  if (!SINGLE_USER_ID_PATTERN.test(ownerId)) {
    throw new Error(
      `${SINGLE_USER_ID_ENV} must be 1-128 characters of [A-Za-z0-9._-], got ` +
        `${JSON.stringify(ownerId)}. It becomes the owner id for every request and part of ` +
        'material object keys, so it cannot use the reserved "anon:" prefix or a character ' +
        'the key sanitiser would rewrite.',
    );
  }
  return ownerId;
}

const SINGLE_USER_ROLES: ReadonlySet<string> = new Set<string>([OWNER_ROLES.coursePublish]);

const SINGLE_USER_METHOD = Symbol.for('openmaic.owner-identity.single-user-method');

/** Whether `method` is the built-in from {@link singleUserAuthMethod}. */
export function isSingleUserAuthMethod(method: OwnerAuthMethod): boolean {
  return (method as { [SINGLE_USER_METHOD]?: true })[SINGLE_USER_METHOD] === true;
}

function singleUserOwnerIdOrThrow(): string {
  const ownerId = resolveSingleUserOwnerId();
  // Boot validation refuses a registration that includes this method without
  // the switch; reaching here means it was turned off after boot.
  if (!ownerId) throw new Error(`singleUser is registered but ${SINGLE_USER_ENV} is not "true".`);
  return ownerId;
}

/**
 * The `singleUser` method: every request resolves to the validated single
 * owner id (see {@link resolveSingleUserOwnerId}) with `kind: 'user'` and the
 * `course:publish` role, and no cookie is minted. It has no credential of its
 * own, so `assurance` is `unverified-legacy` and it never answers
 * `not-applicable`.
 */
export function singleUserAuthMethod(): OwnerAuthMethod {
  const authenticate = async (): Promise<OwnerAuthMethodResult> => ({
    status: 'authenticated',
    principal: {
      ownerId: singleUserOwnerIdOrThrow(),
      kind: 'user',
      roles: SINGLE_USER_ROLES,
      assurance: 'unverified-legacy',
    } satisfies OwnerPrincipal,
  });
  return {
    [SINGLE_USER_METHOD]: true,
    name: 'singleUser',
    authenticate,
    authenticateFromContext: authenticate,
    describeStoredOwner: (storedId) =>
      storedId === resolveSingleUserOwnerId()
        ? { kind: 'user', roles: SINGLE_USER_ROLES }
        : undefined,
  } as OwnerAuthMethod;
}

const log = createLogger('OwnerIdentity');
let warnedUnprotected = false;

/**
 * Log one prominent warning per process when single-user mode is in effect
 * (`active`) and `ACCESS_CODE` is unset: every visitor who can reach the
 * server is the single owner. A warning, never a boot failure; the
 * deployment's network exposure is not something the app can see. Called
 * from `instrumentation.ts` after boot validation.
 *
 * Returns whether that condition holds (whether or not this call logged), so
 * the caller can skip the generic unset-`ACCESS_CODE` warning it replaces.
 */
export function warnIfSingleUserIsUnprotected(active: boolean): boolean {
  // The middleware's truthiness check: an empty ACCESS_CODE leaves the gate open.
  if (!active || process.env.ACCESS_CODE) return false;
  if (warnedUnprotected) return true;
  warnedUnprotected = true;
  log.warn(
    '\n' +
      '************************************************************************\n' +
      `* Single-user mode (${SINGLE_USER_ENV}=true) is on and ACCESS_CODE is not set.\n` +
      '* Anyone who can reach this server is the single owner: they share, edit\n' +
      '* and can delete the one course library, and can publish from it.\n' +
      '* Keep the server on 127.0.0.1 or a private network, or set ACCESS_CODE to a\n' +
      '* long random value (at least 16 characters) in .env.local and restart.\n' +
      '************************************************************************',
  );
  return true;
}

/** Reset the once-per-process guard. Exists mainly for tests. */
export function resetSingleUserWarningForTests(): void {
  warnedUnprotected = false;
}
