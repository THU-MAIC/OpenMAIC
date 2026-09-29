/**
 * Establish the anonymous owner on the page request, before the page's
 * scripts can send any API request.
 *
 * A route handler mints an anonymous owner for every request that arrives
 * without a valid cookie (`./anonymous-cookie.ts`). On a browser's first load
 * the page used to fire several API requests at once, all without a cookie:
 * each minted a different owner and set its own cookie, and whichever response
 * arrived last won. Work the page did in between -- the legacy browser import
 * binding this browser, a first course write -- then belonged to an owner the
 * browser no longer presented. Minting on the document response instead means
 * every request the page sends carries one owner, and a route handler never
 * mints for it (a valid cookie is always reused and never re-set).
 *
 * Only document navigations mint: not API calls, not React Server Component
 * fetches or prefetches, not Server Actions, all of which a page sends after
 * its document response already set the cookie.
 *
 * Which configurations mint. The middleware can run in the Edge runtime,
 * where the owner auth methods a host registers from `instrumentation.ts`
 * (`./registry.ts`) are not visible, so this decides from the environment
 * alone: it mints whenever neither built-in catch-all owner is configured
 * (`OWNER_SINGLE_USER`, `PERSISTENCE_SHARED_OWNER_ID`), since with either one
 * no request ever resolves to an anonymous owner and no cookie is minted
 * anywhere. With the default configuration -- no host registration -- that is
 * exactly when a request falls back to the anonymous cookie. A host that
 * registers its own methods decides in `middleware.ts`: a page cookie next to
 * its own credential is the same claim candidate an anonymous API request
 * would have left (`./resolve.ts`), so a host that does not want one skips
 * {@link anonymousOwnerForNavigation} for requests its methods own.
 */
import { establishAnonymousCookie } from './anonymous-cookie';
import { resolveSharedOwnerId } from './shared-team';
import { resolveSingleUserOwnerId } from './single-user';

/** The parts of a middleware request this reads. */
export interface NavigationRequest {
  readonly method: string;
  readonly headers: Headers;
  readonly pathname: string;
}

/** What the middleware attaches: see {@link anonymousOwnerForNavigation}. */
export interface NavigationIdentity {
  /** The `Set-Cookie` value for the page response. */
  readonly setCookie: string;
  /** The request's `Cookie` header carrying the minted id, for the rest of this request. */
  readonly requestCookie: string;
}

/**
 * Whether a request is a browser loading a document (a page), as opposed to a
 * request a loaded page sends. Browsers say so in `Sec-Fetch-Dest`; a client
 * without Fetch Metadata is taken at its `Accept` header.
 */
export function isDocumentNavigation(request: NavigationRequest): boolean {
  if (request.method !== 'GET') return false;
  if (request.pathname === '/api' || request.pathname.startsWith('/api/')) return false;
  const { headers } = request;
  if (headers.has('rsc') || headers.has('next-router-prefetch') || headers.has('next-action')) {
    return false;
  }
  const destination = headers.get('sec-fetch-dest');
  if (destination !== null) return destination === 'document';
  return (headers.get('accept') ?? '').includes('text/html');
}

/**
 * Whether the environment leaves anonymous owners in use: neither
 * `PERSISTENCE_SHARED_OWNER_ID` nor `OWNER_SINGLE_USER` is set. A malformed
 * value of either fails the boot (`validateOwnerIdentityConfiguration`), so
 * one seen here mints nothing.
 */
function anonymousOwnersInUse(): boolean {
  try {
    return resolveSharedOwnerId() === undefined && resolveSingleUserOwnerId() === undefined;
  } catch {
    return false;
  }
}

/**
 * The anonymous owner a page request should establish: a minted cookie when
 * the request is a document navigation, anonymous owners are in use, and the
 * request carries no valid anonymous cookie; `undefined` otherwise. The value
 * and attributes are the route handlers' own (`./anonymous-cookie.ts`).
 */
export function anonymousOwnerForNavigation(
  request: NavigationRequest,
): NavigationIdentity | undefined {
  if (!isDocumentNavigation(request) || !anonymousOwnersInUse()) return undefined;
  return establishAnonymousCookie(request.headers);
}
