/**
 * The owner identity contract.
 *
 * Every owner-scoped surface — the persistence route, `/api/stages/*`,
 * folders, materials, agent sessions and skills, stage-meta, publish and
 * Server Actions — asks one question: who is making this request? The answer
 * is an {@link OwnerPrincipal}, produced by exactly one configured
 * {@link OwnerAuthenticator} (see `./registry.ts`).
 *
 * The built-in authenticators (`./anonymous-cookie.ts`, `./shared-team.ts`,
 * `./trusted-proxy.ts`) cover per-browser, per-team and gateway-backed
 * identities. A host with its own
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
  /** Reserved for administrative surfaces. Granted only by the trusted-proxy built-in, to configured groups. */
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
  /**
   * An anonymous identity the same request presented alongside this one: the
   * candidate for claiming that anonymous owner's work into this owner (see
   * `lib/persistence/owner-claims.ts`). Set only by an authenticator that
   * resolved a non-anonymous principal and recognized a valid anonymous
   * credential beside it; its presence is the authenticator's statement that
   * `fromOwnerId` is an anonymous owner. Nothing is claimed until the host's
   * trigger runs (`POST /api/identity/claim`, or `OWNER_CLAIM_TRIGGER=auto`).
   */
  readonly pendingClaim?: PendingOwnerClaim;
}

/** See {@link OwnerPrincipal.pendingClaim}. */
export interface PendingOwnerClaim {
  /** The anonymous owner id the request's anonymous credential names. */
  readonly fromOwnerId: string;
  /** What that credential proves; the anonymous cookie is `unverified-legacy`. */
  readonly assurance: OwnerAssurance;
}

/**
 * What an authenticator knows about an owner id it minted, without a request:
 * see {@link OwnerAuthenticator.describeStoredOwner}.
 */
export interface StoredOwnerDescription {
  readonly kind: SubjectKind;
  /** Roles the id always carries. Roles granted per request (groups) are not known here. */
  readonly roles?: ReadonlySet<string>;
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
  /**
   * Describe an owner id this authenticator minted, for work that holds only
   * the stored id (an agent run, a claim). Answer `undefined` for an id it
   * does not recognize. Optional: without it, `principalFromStoredOwner`
   * describes every id as `kind: 'user'` with no roles, which is also what
   * makes an unrecognized id ineligible as the anonymous side of a claim.
   *
   * An authenticator that sets {@link OwnerPrincipal.pendingClaim} must
   * describe those anonymous ids as `kind: 'anonymous'`: a claim is refused
   * for any other source, and the write fences rely on it (only an id
   * described as anonymous can ever be retired, so only those are looked up).
   *
   * The answer must be stable: an id once described as anonymous must keep
   * being described so, or a retired id stops being fenced and a stale write
   * under it succeeds. Classify from the id itself (as the built-ins do), not
   * from state that can be pruned.
   */
  describeStoredOwner?(ownerId: string): StoredOwnerDescription | undefined;
  /**
   * `Set-Cookie` values that drop the anonymous credential this authenticator
   * reads -- the one behind a {@link OwnerPrincipal.pendingClaim}, or the
   * anonymous principal's own. Sent once a claim is done (or can never
   * succeed), and with every `403 OWNER_RETIRED`, so a browser stops
   * presenting a retired identity and gets a fresh one. An authenticator
   * whose anonymous path keeps accepting a retired credential without this
   * leaves that browser refused on every write. Optional: one with no
   * anonymous credential, or whose credential is not a cookie, leaves it out
   * and must treat a retired anonymous credential as absent itself.
   */
  clearPendingClaim?(): readonly string[];
}

/**
 * Core treats owner ids as opaque but they are stored verbatim and become part
 * of object keys, so they get a charset and length guard: printable ASCII
 * without spaces, at most 256 characters.
 */
const OWNER_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;

/** Whether a value is usable as an owner id (see {@link OwnerPrincipal.ownerId}). */
export function isStorableOwnerId(value: unknown): value is string {
  return typeof value === 'string' && OWNER_ID_PATTERN.test(value);
}

/** Whether a principal carries a role. */
export function principalHasRole(principal: OwnerPrincipal, role: string): boolean {
  return principal.roles.has(role);
}
