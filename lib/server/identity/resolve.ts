import { createLogger } from '@/lib/logger';

import { anonymousCookieMethod, readAnonymousOwnerId } from './anonymous-cookie';
import { ownerAuthConfigurationForResolution } from './registry';
import { isSharedTeamAuthMethod } from './shared-team';
import type {
  AuthOutcome,
  OwnerAuthMethod,
  OwnerAuthMethodResult,
  OwnerAuthRequest,
  OwnerPrincipal,
  SubjectKind,
} from './types';
import { isStorableOwnerId } from './types';

/**
 * Owner resolution: the one call every owner-scoped entry point makes.
 *
 * Route handlers use {@link resolveRequestOwner} (usually through
 * `withRequestOwner` in `./with-owner.ts`); Server Actions use
 * {@link requireContextOwner}. Both ask the configured methods
 * (`./registry.ts`) in order and stop at the first answer that is not
 * `not-applicable`:
 *
 * - `authenticated`: that principal, plus a claim candidate (see
 *   {@link withPendingClaim});
 * - `invalid`: 401 `INVALID_CREDENTIAL`; no later method and no fallback is
 *   asked;
 * - every method `not-applicable`: the anonymous cookie owner, or 401 when the
 *   fallback is off.
 *
 * and check what they returned before anything stores it.
 */

const log = createLogger('OwnerIdentity');

const SUBJECT_KINDS: ReadonlySet<SubjectKind> = new Set<SubjectKind>([
  'anonymous',
  'user',
  'device',
  'shared',
  'service',
]);
const ASSURANCES = new Set(['verified', 'unverified-legacy', 'minted']);

const INVALID: AuthOutcome = { ok: false, status: 401, code: 'INVALID_CREDENTIAL' };

function assertPrincipal(principal: OwnerPrincipal, methodName: string): void {
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
              : principal.pendingClaim !== undefined
                ? 'a pendingClaim (core attaches claim candidates itself)'
                : undefined;
  if (problem) {
    // A server misconfiguration, not a client error: surfaces as a 500.
    throw new Error(`Owner auth method ${methodName} returned ${problem}`);
  }
}

function checkedResult(
  result: OwnerAuthMethodResult,
  methodName: string,
  inContext: boolean,
): OwnerAuthMethodResult {
  if (!result || typeof result !== 'object') {
    throw new Error(`Owner auth method ${methodName} returned no result`);
  }
  switch (result.status) {
    case 'not-applicable':
    case 'invalid':
      return result;
    case 'authenticated':
      assertPrincipal(result.principal, methodName);
      if (
        result.setCookies !== undefined &&
        (!Array.isArray(result.setCookies) ||
          result.setCookies.some((value) => typeof value !== 'string'))
      ) {
        throw new Error(`Owner auth method ${methodName} returned setCookies that are not strings`);
      }
      // A Server Action has no response whose headers could carry them, so a
      // cookie asked for here would be silently lost, and with it the identity
      // it minted.
      if (inContext && result.setCookies?.length) {
        throw new Error(
          `Owner auth method ${methodName} returned setCookies in a Server Action; ` +
            'authenticateFromContext must write cookies itself through next/headers.',
        );
      }
      return result;
    default:
      throw new Error(
        `Owner auth method ${methodName} returned an unknown status ` +
          JSON.stringify((result as { status?: unknown }).status),
      );
  }
}

/**
 * The claim candidate rule: a host method's non-anonymous principal, on a
 * request that also carries a valid anonymous owner cookie, gets
 * `pendingClaim` naming that cookie's owner. Not for the anonymous fallback
 * itself, and not for `sharedTeam`, which has no credential of its own:
 * nothing in such a request says which person's browser work it is.
 */
async function withPendingClaim(
  principal: OwnerPrincipal,
  method: OwnerAuthMethod,
  claimHeaders: () => Promise<Headers>,
): Promise<OwnerPrincipal> {
  if (principal.kind === 'anonymous' || isSharedTeamAuthMethod(method)) return principal;
  const fromOwnerId = readAnonymousOwnerId(await claimHeaders());
  if (fromOwnerId === undefined || fromOwnerId === principal.ownerId) return principal;
  return { ...principal, pendingClaim: { fromOwnerId, assurance: 'unverified-legacy' } };
}

/**
 * Ask the methods in order. `ask` runs one method for this entry point;
 * `claimHeaders` gives the request headers the anonymous cookie is read from
 * for the claim candidate.
 */
async function resolveWithMethods(
  ask: (method: OwnerAuthMethod) => Promise<OwnerAuthMethodResult>,
  claimHeaders: () => Promise<Headers>,
  inContext: boolean,
): Promise<AuthOutcome> {
  const { methods, anonymousFallback } = ownerAuthConfigurationForResolution();
  for (const method of methods) {
    const result = checkedResult(await ask(method), method.name, inContext);
    if (result.status === 'not-applicable') continue;
    if (result.status === 'invalid') {
      log.debug(
        `Owner auth method ${method.name} refused the request's credential` +
          (result.reason ? `: ${result.reason}` : ''),
      );
      return INVALID;
    }
    return {
      ok: true,
      principal: await withPendingClaim(result.principal, method, claimHeaders),
      ...(result.setCookies?.length ? { setCookies: result.setCookies } : {}),
    };
  }
  if (!anonymousFallback) return INVALID;
  const result = checkedResult(
    await ask(anonymousCookieMethod),
    anonymousCookieMethod.name,
    inContext,
  );
  if (result.status !== 'authenticated') {
    throw new Error('The anonymous cookie method did not authenticate');
  }
  return {
    ok: true,
    principal: result.principal,
    ...(result.setCookies?.length ? { setCookies: result.setCookies } : {}),
  };
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
  const resolution = resolveWithMethods(
    (method) => method.authenticate(req),
    async () => req.headers,
    false,
  );
  resolutions.set(req, resolution);
  return resolution;
}

/** A request whose credential was refused, or that presented none a method accepts. */
export class InvalidOwnerCredentialError extends Error {
  readonly status = 401;
  readonly code = 'INVALID_CREDENTIAL';
  constructor() {
    super('Invalid owner credential');
    this.name = 'InvalidOwnerCredentialError';
  }
}

async function resolveContextOwner(): Promise<AuthOutcome> {
  let requestHeaders: Promise<Headers> | undefined;
  const contextHeaders = () =>
    (requestHeaders ??= import('next/headers').then(
      async ({ headers }) => new Headers(await headers()),
    ));
  return resolveWithMethods(
    async (method) =>
      method.authenticateFromContext
        ? method.authenticateFromContext()
        : method.authenticate({ headers: await contextHeaders() }),
    contextHeaders,
    true,
  );
}

/**
 * Resolve the owner inside a Server Action. Throws
 * {@link InvalidOwnerCredentialError} when the request is refused: a Server
 * Action has no response of its own to turn into a 401.
 */
export async function requireContextOwner(): Promise<OwnerPrincipal> {
  const outcome = await resolveContextOwner();
  if (!outcome.ok) throw new InvalidOwnerCredentialError();
  return outcome.principal;
}
