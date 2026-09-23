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
  return { ok: true, principal: outcome.principal, responseHeaders };
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
