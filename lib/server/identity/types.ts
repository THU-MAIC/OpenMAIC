/**
 * The owner identity contract.
 *
 * Every owner-scoped surface — the persistence route, `/api/stages/*`,
 * folders, materials, agent sessions and skills, stage-meta, publish and
 * Server Actions — asks one question: who is making this request? The answer
 * is an {@link OwnerPrincipal}, resolved in one place (`./resolve.ts`) from an
 * ordered list of {@link OwnerAuthMethod}s the deployment registers at boot
 * (`./registry.ts`), with the anonymous cookie as the fallback.
 *
 * A host with its own accounts writes a method for its credential (a session
 * cookie, a bearer token, a gateway-signed JWT) and registers it, instead of
 * patching every route.
 */

/** What kind of subject an owner id stands for. Resolved per request, never stored. */
export type SubjectKind = 'anonymous' | 'user' | 'device' | 'shared' | 'service';

/**
 * How much the credential behind a principal proves.
 *
 * - `verified`: a credential the method checked (a signed token, a
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
  /** Reserved for administrative surfaces. No built-in grants it; a host method may. */
  admin: 'admin',
} as const;

export interface OwnerPrincipal {
  /**
   * Opaque, stable, minted by the method that authenticated the request. Stored verbatim in every owner id
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
   * `lib/persistence/owner-claims.ts`). Attached by core, never by a method:
   * when a host method authenticates a non-anonymous principal and the
   * request also carries a valid anonymous owner cookie, `fromOwnerId` is
   * that cookie's owner. Nothing is claimed until the trigger runs
   * (`POST /api/identity/claim`, or `OWNER_CLAIM_TRIGGER=auto`).
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
 * What a method knows about an owner id it minted, without a request: see
 * {@link OwnerAuthMethod.describeStoredOwner}.
 */
export interface StoredOwnerDescription {
  readonly kind: SubjectKind;
  /** Roles the id always carries. Roles granted per request (groups) are not known here. */
  readonly roles?: ReadonlySet<string>;
}

/**
 * The resolved outcome for one request: a principal, or a refusal. Produced by
 * core from the registered methods (`./resolve.ts`); a method answers with an
 * {@link OwnerAuthMethodResult} instead.
 */
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
       * Refused with a 401: a method found its credential invalid, or no
       * method applied and the anonymous fallback is off. Never answered as a
       * fresh anonymous owner instead.
       */
      readonly ok: false;
      readonly status: 401;
      readonly code: 'INVALID_CREDENTIAL';
    };

/** The parts of an incoming request a method may read. */
export interface OwnerAuthRequest {
  readonly headers: Headers;
  readonly method?: string;
  readonly url?: string;
}

/**
 * What one {@link OwnerAuthMethod} says about one request. Exactly one of:
 *
 * - `authenticated`: its credential is present and valid; `principal` is the
 *   owner. Resolution stops here.
 * - `not-applicable`: no credential of its kind is present at all. Core asks
 *   the next method, and after the last one falls back to the anonymous
 *   cookie (when enabled).
 * - `invalid`: its credential is present but invalid (bad signature, expired,
 *   wrong audience, malformed). Core refuses the request with 401
 *   `INVALID_CREDENTIAL` at once: no later method and no anonymous fallback is
 *   asked, so a broken credential can never quietly become a different
 *   identity.
 *
 * Core cannot tell the two apart itself: a method that answers
 * `not-applicable` for a malformed, expired or otherwise unusable credential
 * of its own kind (its header or cookie is there, but it cannot use it)
 * silently downgrades that request to the next method or to an anonymous
 * owner. Answer `invalid` whenever the credential is present; answer
 * `not-applicable` only when it is absent.
 *
 * A method that cannot decide (its key endpoint is down, its session store
 * is unreachable) throws: the request fails as a server error, and neither a
 * later method nor the fallback is asked.
 */
export type OwnerAuthMethodResult =
  | {
      readonly status: 'authenticated';
      readonly principal: OwnerPrincipal;
      /**
       * `Set-Cookie` values for the response (see {@link AuthOutcome}). Route
       * handler path only: a Server Action cannot forward them, so a method
       * that mints cookies writes them itself in
       * {@link OwnerAuthMethod.authenticateFromContext}.
       */
      readonly setCookies?: readonly string[];
    }
  | { readonly status: 'not-applicable' }
  | {
      readonly status: 'invalid';
      /** For server logs only; never sent to the client. */
      readonly reason?: string;
    };

/**
 * One way a request can prove who it is. The deployment registers an ordered
 * list of them at boot (`configureOwnerAuthentication` in `./registry.ts`);
 * core asks them in order for every request and keeps the first
 * `authenticated` answer.
 */
export interface OwnerAuthMethod {
  /** Short, unique label for logs and boot errors. */
  readonly name: string;
  /** Answer for a route handler request. */
  authenticate(req: OwnerAuthRequest): Promise<OwnerAuthMethodResult>;
  /**
   * Answer inside a Server Action, where no `Request` exists and cookies are
   * read and written through `next/headers`. Same semantics as
   * {@link authenticate}; it must write any cookie it mints itself, through
   * `cookies()`, and must not populate `setCookies` (refused with an error).
   *
   * Optional: without it, the request headers from `next/headers` are passed
   * to {@link authenticate} under the same rule — a method whose
   * `authenticate` mints cookies must implement this.
   */
  authenticateFromContext?(): Promise<OwnerAuthMethodResult>;
  /**
   * Describe an owner id this method minted, for work that holds only the
   * stored id (an agent run, a claim). Answer `undefined` for an id it does
   * not recognize; the first method with an answer wins. Without any answer,
   * `principalFromStoredOwner` describes an id as `kind: 'user'` with no
   * roles.
   *
   * The answer must be stable: a method that mints `kind: 'anonymous'` ids and
   * describes them so must keep describing them so, or a retired id stops
   * being fenced (only ids described as anonymous can be claimed and retired).
   * Classify from the id itself, not from state that can be pruned.
   */
  describeStoredOwner?(ownerId: string): StoredOwnerDescription | undefined;
  /**
   * Whether this method authenticates `kind: 'anonymous'` principals itself
   * (a host's own guest or device cookie). Only such a method's
   * {@link clearCredential} is ever sent with a `403 OWNER_RETIRED`; for any
   * other method core never calls it there, so an account session cookie is
   * never cleared because some anonymous identity was retired.
   */
  readonly issuesAnonymousOwners?: boolean;
  /**
   * `Set-Cookie` values that drop this method's anonymous credential. Sent
   * with every `403 OWNER_RETIRED`, so a browser stops presenting an anonymous
   * identity a claim retired — only when {@link issuesAnonymousOwners} is
   * `true`. A throw is logged and skipped, so the 403 still goes out.
   */
  clearCredential?(): readonly string[];
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
