/**
 * Owner identity seam: the host-facing surface.
 *
 * A host with its own identity writes an {@link OwnerAuthMethod} per
 * credential it accepts and registers them, in order, once from
 * `instrumentation.ts`:
 *
 * ```ts
 * const { configureOwnerAuthentication } = await import('@/lib/server/identity');
 * configureOwnerAuthentication({ methods: [mySessionMethod, myApiKeyMethod] });
 * ```
 *
 * Core asks the methods in order for every request: the first `authenticated`
 * answer wins, any `invalid` answer is a 401, and when none applies the
 * anonymous cookie is the fallback (`anonymousFallback: false` turns it off).
 * Route handlers and Server Actions resolve owners through `./with-owner.ts`
 * and `./resolve.ts`; nothing else reads identity cookies or headers, or asks
 * a method directly.
 */
export type {
  AuthOutcome,
  OwnerAssurance,
  OwnerAuthMethod,
  OwnerAuthMethodResult,
  OwnerAuthRequest,
  OwnerPrincipal,
  PendingOwnerClaim,
  StoredOwnerDescription,
  SubjectKind,
} from './types';
export { OWNER_ROLES, principalHasRole } from './types';
export type { OwnerAuthenticationOptions } from './registry';
export { configureOwnerAuthentication } from './registry';
export { sharedTeamAuthMethod } from './shared-team';
export { principalFromStoredOwner } from './stored-owner';
