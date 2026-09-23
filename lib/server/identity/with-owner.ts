import { resolveRequestOwner } from './resolve';
import type { OwnerAuthRequest, OwnerPrincipal } from './types';

/**
 * Route-handler helpers over {@link resolveRequestOwner}.
 *
 * The `Set-Cookie` values an authenticator returns (a minted anonymous owner,
 * say) must ride every response, including 4xx and 5xx: a client that retries
 * after an error keeps the same owner, while a 500 that dropped the cookie
 * would silently make the retry a different owner. Both helpers therefore hand
 * the handler a `Headers` that already carries them.
 */

/**
 * The response to a request whose credential the authenticator rejected. It is
 * never answered as a fresh anonymous owner instead.
 */
export function invalidOwnerCredentialResponse(): Response {
  return Response.json(
    { error: { code: 'INVALID_CREDENTIAL', message: 'invalid owner credential' } },
    { status: 401 },
  );
}

export type RequestOwnerResolution =
  | { ok: true; principal: OwnerPrincipal; responseHeaders: Headers }
  | { ok: false; response: Response };

/**
 * Resolve the request owner for a handler that builds its own response (the
 * SSE streams). On an invalid credential, return `response` as is.
 */
export async function authenticateRequestOwner(
  req: OwnerAuthRequest,
): Promise<RequestOwnerResolution> {
  const outcome = await resolveRequestOwner(req);
  if (!outcome.ok) return { ok: false, response: invalidOwnerCredentialResponse() };
  const responseHeaders = new Headers();
  for (const value of outcome.setCookies ?? []) responseHeaders.append('Set-Cookie', value);
  const principal = await autoClaim(req, outcome.principal, responseHeaders);
  return { ok: true, principal, responseHeaders };
}

/** The routes that perform a claim themselves: `POST /api/identity/claim` and the runtime learner merge. */
const EXPLICIT_CLAIM_PATHS = ['/api/identity/claim', '/api/persistence/runtime/learners/merge'];

function isExplicitClaimRoute(url: string | undefined): boolean {
  if (!url) return false;
  let pathname: string;
  try {
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    return false;
  }
  const trimmed = pathname.replace(/\/+$/, '');
  return EXPLICIT_CLAIM_PATHS.includes(trimmed);
}

/**
 * `OWNER_CLAIM_TRIGGER=auto`: claim a pending anonymous owner on the first
 * route request that presents one, before the handler runs, so the handler
 * already sees the claimed work. The default (`explicit`) leaves it to
 * `POST /api/identity/claim`. A claim that fails for a reason other than a
 * refusal is logged and the request goes on unclaimed; the next request tries
 * again. Server Actions never trigger it.
 */
async function autoClaim(
  req: OwnerAuthRequest,
  principal: OwnerPrincipal,
  responseHeaders: Headers,
) {
  if (!principal.pendingClaim || principal.kind === 'anonymous') return principal;
  // The explicit claim routes claim themselves and report the outcome: an
  // automatic claim ahead of them would leave them nothing to report but a
  // refusal ("no pending claim") for a claim that succeeded.
  if (isExplicitClaimRoute(req.url)) return principal;
  if (!process.env.DATABASE_URL?.trim()) return principal;
  const { resolveOwnerClaimTrigger, runPendingClaim } =
    await import('@/lib/persistence/owner-claim-http');
  if (resolveOwnerClaimTrigger() !== 'auto') return principal;
  try {
    const outcome = await runPendingClaim(principal);
    for (const cookie of outcome.setCookies) responseHeaders.append('Set-Cookie', cookie);
    if (!outcome.ok && outcome.setCookies.length === 0) return principal;
  } catch (error) {
    console.error(
      '[owner-identity] automatic claim failed; the request continues unclaimed',
      error,
    );
    return principal;
  }
  const { pendingClaim: _claimed, ...claimed } = principal;
  return claimed;
}

/**
 * Resolve the request owner and run a handler with it and the response
 * headers every response must carry. A handler that throws answers a 500 that
 * still carries them.
 */
export async function withRequestOwner(
  req: OwnerAuthRequest,
  handler: (principal: OwnerPrincipal, responseHeaders: Headers) => Promise<Response>,
): Promise<Response> {
  const resolution = await authenticateRequestOwner(req);
  if (!resolution.ok) return resolution.response;
  const { principal, responseHeaders } = resolution;
  try {
    return await handler(principal, responseHeaders);
  } catch (error) {
    console.error('[owner-identity] owner-scoped request failed', error);
    return new Response('Internal Server Error', { status: 500, headers: responseHeaders });
  }
}
