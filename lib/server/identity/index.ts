/**
 * Owner identity seam: the host-facing surface.
 *
 * A host with its own identity implements {@link OwnerAuthenticator} and
 * registers it once from `instrumentation.ts`:
 *
 * ```ts
 * const { configureOwnerAuthenticator } = await import('@/lib/server/identity');
 * configureOwnerAuthenticator(myAuthenticator);
 * ```
 *
 * Route handlers and Server Actions resolve owners through `./with-owner.ts`
 * and `./resolve.ts`; nothing else reads identity cookies or headers.
 */
export type {
  AuthOutcome,
  OwnerAssurance,
  OwnerAuthenticator,
  OwnerAuthRequest,
  OwnerPrincipal,
  SubjectKind,
} from './types';
export { OWNER_ROLES, principalHasRole } from './types';
export { configureOwnerAuthenticator, getOwnerAuthenticator } from './registry';
export { createAnonymousCookieAuthenticator } from './anonymous-cookie';
export { createSharedTeamAuthenticator } from './shared-team';
