import { getOwnerAuthenticator } from './registry';
import type { AuthOutcome, OwnerAuthRequest, OwnerPrincipal, SubjectKind } from './types';
import { isStorableOwnerId } from './types';

/**
 * Owner resolution: the one call every owner-scoped entry point makes.
 *
 * Route handlers use {@link resolveRequestOwner} (usually through
 * `withRequestOwner` in `./with-owner.ts`); Server Actions use
 * {@link requireContextOwner}. Both go through the configured authenticator
 * (`./registry.ts`) and check what it returned before anything stores it.
 */

const SUBJECT_KINDS: ReadonlySet<SubjectKind> = new Set<SubjectKind>([
  'anonymous',
  'user',
  'device',
  'shared',
  'service',
]);
const ASSURANCES = new Set(['verified', 'unverified-legacy', 'minted']);

function assertPrincipal(principal: OwnerPrincipal, authenticatorName: string): void {
  const problem =
    !principal || typeof principal !== 'object'
      ? 'no principal'
      : !isStorableOwnerId(principal.ownerId)
        ? 'an ownerId outside 1-256 printable non-space ASCII characters'
        : !SUBJECT_KINDS.has(principal.kind)
          ? `an unknown kind ${JSON.stringify(principal.kind)}`
          : !(principal.roles instanceof Set)
            ? 'roles that are not a Set'
            : !ASSURANCES.has(principal.assurance)
              ? `an unknown assurance ${JSON.stringify(principal.assurance)}`
              : undefined;
  if (problem) {
    // A server misconfiguration, not a client error: surfaces as a 500.
    throw new Error(`Owner authenticator ${authenticatorName} returned ${problem}`);
  }
}

function checkedOutcome(outcome: AuthOutcome, authenticatorName: string): AuthOutcome {
  if (!outcome || typeof outcome !== 'object') {
    throw new Error(`Owner authenticator ${authenticatorName} returned no outcome`);
  }
  if (!outcome.ok) {
    if (outcome.status !== 401 || outcome.code !== 'INVALID_CREDENTIAL') {
      throw new Error(`Owner authenticator ${authenticatorName} returned an unknown failure`);
    }
    return outcome;
  }
  assertPrincipal(outcome.principal, authenticatorName);
  return outcome;
}

/**
 * One resolution per request. Keyed by the request object, so a handler and
 * any helper it passes the same request to share one authentication — and one
 * minted identity — instead of each minting their own.
 */
const resolutions = new WeakMap<object, Promise<AuthOutcome>>();

/** Resolve the owner of a route handler request. Memoized per request object. */
export function resolveRequestOwner(req: OwnerAuthRequest): Promise<AuthOutcome> {
  const existing = resolutions.get(req);
  if (existing) return existing;
  const authenticator = getOwnerAuthenticator();
  const resolution = authenticator
    .authenticate(req)
    .then((outcome) => checkedOutcome(outcome, authenticator.name));
  resolutions.set(req, resolution);
  return resolution;
}

/** A request whose credential the configured authenticator rejected. */
export class InvalidOwnerCredentialError extends Error {
  readonly status = 401;
  readonly code = 'INVALID_CREDENTIAL';
  constructor() {
    super('Invalid owner credential');
    this.name = 'InvalidOwnerCredentialError';
  }
}

/**
 * A Server Action has no response whose headers could carry `setCookies`, so
 * an outcome that asks for one would silently lose the cookie — and with it the
 * identity it minted. Refuse it loudly on both context paths.
 */
function refuseContextSetCookies(outcome: AuthOutcome, authenticatorName: string): AuthOutcome {
  if (outcome.ok && outcome.setCookies?.length) {
    throw new Error(
      `Owner authenticator ${authenticatorName} returned setCookies in a Server Action; ` +
        'authenticateFromContext must write cookies itself through next/headers.',
    );
  }
  return outcome;
}

async function resolveContextOwner(): Promise<AuthOutcome> {
  const authenticator = getOwnerAuthenticator();
  if (authenticator.authenticateFromContext) {
    return refuseContextSetCookies(
      checkedOutcome(await authenticator.authenticateFromContext(), authenticator.name),
      authenticator.name,
    );
  }
  const { headers } = await import('next/headers');
  return refuseContextSetCookies(
    checkedOutcome(
      await authenticator.authenticate({ headers: new Headers(await headers()) }),
      authenticator.name,
    ),
    authenticator.name,
  );
}

/**
 * Resolve the owner inside a Server Action. Throws
 * {@link InvalidOwnerCredentialError} for an invalid credential: a Server
 * Action has no response of its own to turn into a 401.
 */
export async function requireContextOwner(): Promise<OwnerPrincipal> {
  const outcome = await resolveContextOwner();
  if (!outcome.ok) throw new InvalidOwnerCredentialError();
  return outcome.principal;
}
