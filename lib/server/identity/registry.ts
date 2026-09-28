import { anonymousCookieMethod } from './anonymous-cookie';
import { isSharedTeamAuthMethod, resolveSharedOwnerId, sharedTeamAuthMethod } from './shared-team';
import {
  isSingleUserAuthMethod,
  resolveSingleUserOwnerId,
  SINGLE_USER_ENV,
  singleUserAuthMethod,
  warnIfSingleUserIsUnprotected,
} from './single-user';
import { resolveClaimLockWaitMs, resolveWriteLockWaitMs } from '@/lib/persistence/owner-lock-waits';

import { createLogger } from '@/lib/logger';

import { assertNoRetiredIdentityConfiguration } from './retired-config';
import type { OwnerAuthMethod, StoredOwnerDescription } from './types';

const log = createLogger('OwnerIdentity');

/**
 * Which {@link OwnerAuthMethod}s this process resolves owners with.
 *
 * A host registers an ordered list once, at server bootstrap, with
 * {@link configureOwnerAuthentication}; `instrumentation.ts` is the place.
 * Core asks the methods in order for every request (`./resolve.ts`), and when
 * none applies falls back to the built-in anonymous cookie
 * (`./anonymous-cookie.ts`) unless the registration turned that off.
 *
 * Unregistered — the default — the list comes from the environment on every
 * request: `PERSISTENCE_SHARED_OWNER_ID` (validated, and requiring
 * `ACCESS_CODE`) makes it `[sharedTeam]`, `OWNER_SINGLE_USER=true`
 * (validated) makes it `[singleUser]`, setting both is refused, and otherwise it is empty and every
 * request is an anonymous owner. Reading the environment per call keeps a
 * value changed for a test observable without a module reload.
 *
 * The state lives on `globalThis` because Next can evaluate this module more
 * than once in one process (the instrumentation hook and route bundles), and
 * all of them must see the one registration.
 */

export interface OwnerAuthenticationOptions {
  /**
   * The host's methods, asked in this order. At least one. Include
   * {@link sharedTeamAuthMethod} (last) to keep a `PERSISTENCE_SHARED_OWNER_ID`
   * team owner alongside host methods.
   */
  readonly methods: readonly OwnerAuthMethod[];
  /**
   * Whether a request no method applies to resolves to an anonymous cookie
   * owner (the default, `true`) or is refused with 401 `INVALID_CREDENTIAL`
   * (`false`: every owner-scoped request must present a host credential).
   * Either way, anonymous owners minted earlier stay describable, claimable
   * and fenced.
   */
  readonly anonymousFallback?: boolean;
}

/** The methods core resolves one request with. */
export interface OwnerAuthConfiguration {
  readonly methods: readonly OwnerAuthMethod[];
  readonly anonymousFallback: boolean;
}

interface RegistryState {
  configured?: OwnerAuthConfiguration;
  /** Set by the first lookup; configuring after it would split one process across two identities. */
  inUse?: boolean;
}

const REGISTRY_KEY = Symbol.for('openmaic.owner-identity.registry');
const globalState = globalThis as typeof globalThis & { [REGISTRY_KEY]?: RegistryState };
function registry(): RegistryState {
  return (globalState[REGISTRY_KEY] ??= {});
}

const sharedTeamFromEnvironment = sharedTeamAuthMethod();
const singleUserFromEnvironment = singleUserAuthMethod();

/**
 * `sharedTeam` and `singleUser` both answer every request, so at most one of
 * them can be in effect; a deployment that sets both has not decided whose
 * library it serves.
 */
function assertOneCatchAllOwner(
  sharedOwnerId: string | undefined,
  singleOwnerId: string | undefined,
) {
  if (sharedOwnerId && singleOwnerId) {
    throw new Error(
      `PERSISTENCE_SHARED_OWNER_ID and ${SINGLE_USER_ENV}=true are both set, but only one ` +
        'fixed owner can answer every request. Unset one of them (with Docker Compose, ' +
        `set ${SINGLE_USER_ENV}=false to keep the shared team owner).`,
    );
  }
}

function configurationFromEnvironment(): OwnerAuthConfiguration {
  const sharedOwnerId = resolveSharedOwnerId();
  const singleOwnerId = resolveSingleUserOwnerId();
  assertOneCatchAllOwner(sharedOwnerId, singleOwnerId);
  return {
    methods: sharedOwnerId
      ? [sharedTeamFromEnvironment]
      : singleOwnerId
        ? [singleUserFromEnvironment]
        : [],
    anonymousFallback: true,
  };
}

const METHOD_SHAPE =
  '{ name, authenticate(req), authenticateFromContext?(), describeStoredOwner?(ownerId), ' +
  'issuesAnonymousOwners?: boolean, clearCredential?() }';

function assertMethodShape(method: OwnerAuthMethod, index: number): void {
  const valid =
    !!method &&
    typeof method === 'object' &&
    typeof method.name === 'string' &&
    method.name.trim() !== '' &&
    typeof method.authenticate === 'function' &&
    (['authenticateFromContext', 'describeStoredOwner', 'clearCredential'] as const).every(
      (hook) => method[hook] === undefined || typeof method[hook] === 'function',
    ) &&
    (method.issuesAnonymousOwners === undefined ||
      typeof method.issuesAnonymousOwners === 'boolean');
  if (!valid) {
    throw new Error(`configureOwnerAuthentication: methods[${index}] must be ${METHOD_SHAPE}.`);
  }
}

/**
 * The rules for the two catch-all built-ins in a host registration, checked
 * when it is made and again at boot validation (the environment may be read by
 * either first):
 *
 * - {@link sharedTeamAuthMethod} included requires `PERSISTENCE_SHARED_OWNER_ID`
 *   (and, through it, `ACCESS_CODE`); {@link singleUserAuthMethod} included
 *   requires `OWNER_SINGLE_USER=true`;
 * - either must be the last method, since it always authenticates and anything
 *   after it would never be asked, so at most one of them is included;
 * - the variable set while the registration does not include its method is
 *   refused: it would be silently ignored;
 * - both variables set is refused, as without a registration.
 */
function assertCatchAllPlacement(methods: readonly OwnerAuthMethod[]): void {
  const sharedOwnerId = resolveSharedOwnerId();
  const singleOwnerId = resolveSingleUserOwnerId();
  assertOneCatchAllOwner(sharedOwnerId, singleOwnerId);
  const names = methods.map((method) => method.name).join(', ');
  const builtIns = [
    {
      index: methods.findIndex(isSharedTeamAuthMethod),
      configured: sharedOwnerId !== undefined,
      label: 'sharedTeam',
      factory: 'sharedTeamAuthMethod()',
      variable: 'PERSISTENCE_SHARED_OWNER_ID',
      unset: 'PERSISTENCE_SHARED_OWNER_ID is not set',
    },
    {
      index: methods.findIndex(isSingleUserAuthMethod),
      configured: singleOwnerId !== undefined,
      label: 'singleUser',
      factory: 'singleUserAuthMethod()',
      variable: `${SINGLE_USER_ENV}=true`,
      unset: `${SINGLE_USER_ENV} is not "true"`,
    },
  ];
  for (const builtIn of builtIns) {
    if (builtIn.index < 0) {
      if (builtIn.configured) {
        throw new Error(
          `${builtIn.variable.replace(/=true$/, '')} is set but the registered owner auth methods ` +
            `(${names}) do not include ${builtIn.label}, so it would be ignored. Add ` +
            `${builtIn.factory} as the last method, or unset it.`,
        );
      }
      continue;
    }
    if (!builtIn.configured) {
      throw new Error(`${builtIn.factory} is registered but ${builtIn.unset}.`);
    }
    if (builtIn.index !== methods.length - 1) {
      throw new Error(
        `${builtIn.factory} must be the last owner auth method: it authenticates every ` +
          'request, so the methods after it would never be asked.',
      );
    }
  }
}

/**
 * Register the process-wide owner auth methods. Server-only, and single-shot:
 * call it once from `instrumentation.ts` `register()` before the server serves
 * a request. Throws — failing the boot — when called twice, after owner
 * resolution has already started, with no methods, with something that is not
 * a method, with two methods of one name, or against the `sharedTeam` /
 * `singleUser` rules above.
 */
export function configureOwnerAuthentication(options: OwnerAuthenticationOptions): void {
  if (typeof window !== 'undefined') {
    throw new Error('configureOwnerAuthentication is server-only');
  }
  const state = registry();
  if (state.configured) {
    throw new Error(
      'Owner authentication is already configured; configureOwnerAuthentication may be called ' +
        'once per process.',
    );
  }
  if (state.inUse) {
    throw new Error(
      'configureOwnerAuthentication was called after owner resolution started. Call it from ' +
        'instrumentation.ts register(), before the server serves a request.',
    );
  }
  if (!options || typeof options !== 'object' || !Array.isArray(options.methods)) {
    throw new Error(
      'configureOwnerAuthentication expects { methods: OwnerAuthMethod[], anonymousFallback?: boolean }.',
    );
  }
  if (options.anonymousFallback !== undefined && typeof options.anonymousFallback !== 'boolean') {
    throw new Error('configureOwnerAuthentication: anonymousFallback must be a boolean.');
  }
  if (options.methods.length === 0) {
    throw new Error(
      'configureOwnerAuthentication needs at least one method; leave it uncalled for the ' +
        'default anonymous behavior.',
    );
  }
  options.methods.forEach(assertMethodShape);
  const names = options.methods.map((method) => method.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined || names.includes(anonymousCookieMethod.name)) {
    throw new Error(
      `configureOwnerAuthentication: method names must be unique and must not be ` +
        `"${anonymousCookieMethod.name}" (the built-in fallback); got ${names.join(', ')}.`,
    );
  }
  assertCatchAllPlacement(options.methods);
  state.configured = {
    methods: Object.freeze([...options.methods]),
    anonymousFallback: options.anonymousFallback ?? true,
  };
}

/**
 * The methods owner resolution uses: the registered ones, else those the
 * environment selects. Internal to `lib/server/identity/`: code elsewhere
 * resolves owners through `./with-owner.ts` and `./resolve.ts`, never by
 * asking a method itself.
 */
export function ownerAuthConfigurationForResolution(): OwnerAuthConfiguration {
  const state = registry();
  state.inUse = true;
  return state.configured ?? configurationFromEnvironment();
}

/**
 * What the methods know about a stored owner id: the anonymous cookie method
 * first (in every configuration: anonymous ids minted before a deployment
 * switched to accounts are still anonymous owners), then the configured
 * methods in order. The first answer wins.
 */
export function describeStoredOwnerId(ownerId: string): StoredOwnerDescription | undefined {
  const anonymous = anonymousCookieMethod.describeStoredOwner?.(ownerId);
  if (anonymous) return anonymous;
  for (const method of ownerAuthConfigurationForResolution().methods) {
    const description = method.describeStoredOwner?.(ownerId);
    if (description) return description;
  }
  return undefined;
}

/**
 * `Set-Cookie` values that drop the anonymous cookie behind a principal's
 * `pendingClaim`: sent once a claim is
 * spent. Core attaches a claim candidate only from that cookie, so it is the
 * only credential a claim retires.
 */
export function pendingClaimClearCookies(): readonly string[] {
  return anonymousCookieMethod.clearCredential?.() ?? [];
}

/**
 * `Set-Cookie` values sent with every `403 OWNER_RETIRED`: the anonymous
 * cookie's, and the `clearCredential` of each configured method that declares
 * `issuesAnonymousOwners: true`. No other method's hook is called, so an
 * account's own session cookie is never cleared here. A hook that throws is
 * logged and skipped: the refusal must still reach the browser.
 */
export function retiredOwnerClearCookies(): readonly string[] {
  const cookies = [...pendingClaimClearCookies()];
  for (const method of ownerAuthConfigurationForResolution().methods) {
    if (method.issuesAnonymousOwners !== true || !method.clearCredential) continue;
    try {
      const values = method.clearCredential();
      if (Array.isArray(values)) {
        for (const value of values) if (typeof value === 'string') cookies.push(value);
      }
    } catch (error) {
      log.error(`Owner auth method ${method.name} failed to clear its credential`, error);
    }
  }
  return cookies;
}

/** Which configuration a validated process resolves owners with. */
export type OwnerIdentityMode = 'configured' | 'sharedTeam' | 'singleUser' | 'anonymousCookie';

/**
 * Boot-time validation, called from `instrumentation.ts` after any
 * registration. A malformed `PERSISTENCE_SHARED_OWNER_ID`, one set without
 * `ACCESS_CODE`, one a host registration would ignore, a malformed
 * single-user setting or one beside the shared owner, or a malformed claim
 * setting would otherwise boot, pass its health check, and then fail — or
 * silently mis-identify — every owner-scoped request; throwing here makes the
 * deployment fail to start instead.
 */
export function validateOwnerIdentityConfiguration(): OwnerIdentityMode {
  const trigger = process.env.OWNER_CLAIM_TRIGGER?.trim();
  if (trigger && trigger !== 'explicit' && trigger !== 'auto') {
    throw new Error(
      `OWNER_CLAIM_TRIGGER must be "explicit" or "auto", got ${JSON.stringify(trigger)}.`,
    );
  }
  assertNoRetiredIdentityConfiguration();
  // Read on every owner write and claim: a malformed value must stop the
  // server here, not fail each write as a 500.
  resolveWriteLockWaitMs();
  resolveClaimLockWaitMs();
  const configured = registry().configured;
  if (configured) {
    assertCatchAllPlacement(configured.methods);
    return 'configured';
  }
  const sharedOwnerId = resolveSharedOwnerId();
  const singleOwnerId = resolveSingleUserOwnerId();
  assertOneCatchAllOwner(sharedOwnerId, singleOwnerId);
  if (sharedOwnerId) return 'sharedTeam';
  return singleOwnerId ? 'singleUser' : 'anonymousCookie';
}

/**
 * Startup warnings about the validated owner identity configuration, called
 * from `instrumentation.ts` after {@link validateOwnerIdentityConfiguration}:
 * single-user mode in effect (from the environment, or registered by a host)
 * without `ACCESS_CODE`. Never throws on a valid configuration.
 */
export function warnAboutOwnerIdentityConfiguration(): void {
  const configured = registry().configured;
  const singleUserActive = configured
    ? configured.methods.some(isSingleUserAuthMethod)
    : !resolveSharedOwnerId() && resolveSingleUserOwnerId() !== undefined;
  warnIfSingleUserIsUnprotected(singleUserActive);
}

export function resetOwnerAuthenticationForTests(): void {
  delete globalState[REGISTRY_KEY];
}
