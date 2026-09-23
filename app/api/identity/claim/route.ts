import {
  claimRefusalResponse,
  isSameOriginJsonRequest,
  runPendingClaim,
} from '@/lib/persistence/owner-claim-http';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

function jsonError(status: number, code: string, message: string, headers: Headers): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

/**
 * `POST /api/identity/claim`: move the work of the anonymous owner this
 * browser used before signing in to the signed-in owner, and retire the
 * anonymous identity (`lib/persistence/owner-claims.ts`).
 *
 * - Needs a request the configured authenticator resolves to a non-anonymous
 *   owner that carries a `pendingClaim` (the trusted-proxy built-in sets one
 *   when the gateway user also holds an anonymous owner cookie).
 * - Same-origin only, with a JSON content type (`isSameOriginJsonRequest`):
 *   it acts on cookies, so no other site may make a browser send it.
 * - `200 { status: 'claimed', moved }` or `200 { status: 'already-claimed' }`,
 *   both with `Set-Cookie` values that drop the anonymous cookie. A refusal
 *   answers `4xx { error: { code } }` and changes nothing; one that can never
 *   succeed (`ALREADY_CLAIMED_ELSEWHERE`) drops the cookie as well. A claim
 *   that lost a lock race answers `503 OWNER_BUSY` with `Retry-After`.
 * - Never claimed automatically before this handler (`OWNER_CLAIM_TRIGGER=auto`
 *   skips this route), so the answer always reports this request's claim.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginJsonRequest(request)) {
    return jsonError(
      403,
      'CROSS_ORIGIN_REFUSED',
      'claims must be same-origin JSON requests',
      new Headers(),
    );
  }
  if (!process.env.DATABASE_URL?.trim()) {
    return jsonError(
      404,
      'PERSISTENCE_NOT_CONFIGURED',
      'server persistence not configured',
      new Headers(),
    );
  }
  return withRequestOwner(request, async (principal, responseHeaders) => {
    if (principal.kind === 'anonymous') {
      return jsonError(
        403,
        'TARGET_ANONYMOUS',
        'sign in before claiming anonymous work',
        responseHeaders,
      );
    }
    if (!principal.pendingClaim) {
      return jsonError(
        409,
        'NO_PENDING_CLAIM',
        'this request presents no anonymous identity to claim',
        responseHeaders,
      );
    }
    const outcome = await runPendingClaim(principal);
    for (const cookie of outcome.setCookies) responseHeaders.append('Set-Cookie', cookie);
    responseHeaders.set('cache-control', 'no-store');
    if (!outcome.ok) return claimRefusalResponse(outcome, responseHeaders);
    return Response.json(outcome.result, { status: 200, headers: responseHeaders });
  });
}
