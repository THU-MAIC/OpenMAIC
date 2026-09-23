/**
 * The owner identity contract.
 *
 * Every owner-scoped surface — the persistence route, `/api/stages/*`,
 * folders, materials, agent sessions and skills, stage-meta, publish and
 * Server Actions — asks one question: who is making this request? The answer
 * is an {@link OwnerPrincipal}, produced by exactly one configured
 * {@link OwnerAuthenticator} (see `./registry.ts`).
 *
 * The built-in authenticators (`./anonymous-cookie.ts`, `./shared-team.ts`)
 * reproduce the identities OpenMAIC has always used. A host with its own
 * accounts implements this interface and registers it at boot instead of
 * patching every route.
 */

/** What kind of subject an owner id stands for. Resolved per request, never stored. */
export type SubjectKind = 'anonymous' | 'user' | 'device' | 'shared' | 'service';

/**
 * How much the credential behind a principal proves.
 *
 * - `verified`: a credential the authenticator checked (a signed token, a
 *   trusted gateway header).
 * - `unverified-legacy`: an identifier the client presented that nothing
 *   signs, such as the anonymous cookie, or a deployment-wide id.
 * - `minted`: an identity created by this very request.
 *
 * Core does not branch on it; it is carried so trust- or billing-sensitive
 * hosts can.
 */
export type OwnerAssurance = 'verified' | 'unverified-legacy' | 'minted';

/** The core role vocabulary. Hosts may grant additional roles of their own. */
export const OWNER_ROLES = {
  /** May make a course public (`POST /api/stages/[id]/publish` and `/unpublish`). */
  coursePublish: 'course:publish',
  /** Reserved for administrative surfaces. No built-in grants it. */
  admin: 'admin',
} as const;

export interface OwnerPrincipal {
  /**
   * Opaque, stable, authenticator-minted. Stored verbatim in every owner id
   * column. Core never derives meaning from its shape: authorization decisions
   * read {@link kind} and {@link roles} instead.
   */
  readonly ownerId: string;
  readonly kind: SubjectKind;
  readonly roles: ReadonlySet<string>;
  readonly assurance: OwnerAssurance;
  /** Free-form transport label, e.g. `'web'`, `'api-key'`, `'proxy'`. Informational. */
  readonly channel?: string;
}

export type AuthOutcome =
  | {
      readonly ok: true;
      readonly principal: OwnerPrincipal;
      /**
       * Complete `Set-Cookie` header values to attach to the response. They
       * ride every response of the request, including 4xx and 5xx, so an
       * identity minted on an error path is not lost.
       */
      readonly setCookies?: readonly string[];
    }
  | {
      /**
       * The request presented a credential and it is invalid. The request is
       * refused with a 401; it is never re-identified as a fresh anonymous
       * owner. "No credential at all" is not this case: an authenticator that
       * admits anonymous visitors answers that with an anonymous principal.
       */
      readonly ok: false;
      readonly status: 401;
      readonly code: 'INVALID_CREDENTIAL';
    };

/** The parts of an incoming request an authenticator may read. */
export interface OwnerAuthRequest {
  readonly headers: Headers;
  readonly method?: string;
  readonly url?: string;
}

export interface OwnerAuthenticator {
  /** Short label for logs and boot errors. */
  readonly name: string;
  /** Resolve the owner of a route handler request. */
  authenticate(req: OwnerAuthRequest): Promise<AuthOutcome>;
  /**
   * Resolve the owner inside a Server Action, where no `Request` exists and
   * cookies are read and written through `next/headers`.
   *
   * A Server Action cannot forward raw `Set-Cookie` values, so this method
   * must write any cookie it mints itself, through `cookies()` from
   * `next/headers`, and must not populate `setCookies`: an outcome that does is
   * refused with an error.
   *
   * Optional: without it the request headers from `next/headers` are passed to
   * {@link authenticate}, under the same rule — an authenticator whose
   * `authenticate` mints cookies must implement this method.
   */
  authenticateFromContext?(): Promise<AuthOutcome>;
}

/** Whether a principal carries a role. */
export function principalHasRole(principal: OwnerPrincipal, role: string): boolean {
  return principal.roles.has(role);
}
