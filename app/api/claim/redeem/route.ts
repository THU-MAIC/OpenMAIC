/**
 * POST /api/claim/redeem — the second device hands back a code and adopts the
 * first device's owner identity.
 *
 * Two rules this route exists to keep:
 *
 * - **One failure answer.** Unknown, expired and already-redeemed all leave
 *   through {@link rejectClaim}, so the three are the same body and the same
 *   status (AC-5). There is exactly one construction site for that response;
 *   adding a second is how the distinction leaks back in.
 * - **Adopt, never mint.** A success threads the redeemed owner into
 *   `resolveRequestOwnerId`'s `authenticatedOwnerId` slot, which returns it
 *   verbatim instead of inventing a fresh anonymous identity (AC-7). Minting
 *   here would hand the second device its own empty partition and quietly lose
 *   the whole point of the handshake.
 *
 * The attempt cadence is the access-code route's policy, not a second one:
 * per-identity throttling when a trusted proxy makes identities real, and no
 * shared counter otherwise, because a shared counter is a lever any single
 * caller can hold down to lock everyone else out.
 */
import { redeemClaimCode } from '@/lib/persistence/claim-code';
import {
  anonymousOwnerCookieHeader,
  resolveRequestOwnerId,
} from '@/lib/server/agent-runtime/owner';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { AccessCodeAttemptLimiter } from '@/lib/server/attempt-limiter';
import { clientIdentity, isTrustedProxyIdentity } from '@/lib/server/client-identity';

export const runtime = 'nodejs';

/** Per-process cadence for redemption attempts, separate from the access-code one. */
const claimRedeemAttemptLimiter = new AccessCodeAttemptLimiter();

/**
 * The one and only failure answer. Every rejected redemption — malformed body,
 * unknown code, expired code, spent code — returns exactly this.
 */
function rejectClaim() {
  return apiError('INVALID_REQUEST', 401, 'Invalid or expired claim code');
}

/** Pull the candidate code out of an already-parsed JSON body. */
function readCandidateCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = (body as { code?: unknown }).code;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

export async function POST(request: Request) {
  // Decision and reservation happen in one synchronous tick, so a burst of
  // concurrent attempts cannot all pass the window check before any is counted.
  const trusted = isTrustedProxyIdentity();
  const identity = clientIdentity(request);
  const limit = claimRedeemAttemptLimiter.consume(identity, trusted);
  if (limit.limited) {
    const response = apiError('RATE_LIMITED', 429, 'Too many claim-code attempts');
    response.headers.set('Retry-After', String(limit.retryAfterSeconds));
    return response;
  }

  // The reservation is taken before the body is parsed, so a malformed body
  // spends a slot too. That is intentional.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rejectClaim();
  }

  const candidate = readCandidateCode(body);
  if (candidate === null) return rejectClaim();

  const redeemed = await redeemClaimCode(candidate);
  if (!redeemed) return rejectClaim();

  claimRedeemAttemptLimiter.recordSuccess(identity, trusted);

  const responseHeaders = new Headers();
  const ownerId = resolveRequestOwnerId(request, responseHeaders, redeemed.owner);
  const cookie = anonymousOwnerCookieHeader(ownerId);
  if (!cookie) {
    // Unreachable today: codes are minted from whatever identity /api/claim
    // resolved, which is an anonymous one. It would become reachable the day a
    // host auth layer threads its own principal through, and that identity
    // cannot be adopted by handing over a cookie — so say so instead of
    // returning a success that adopted nothing.
    return apiError('INTERNAL_ERROR', 500, 'This identity cannot be claimed by another device');
  }

  const response = apiSuccess({ claimed: true });
  response.headers.append('Set-Cookie', cookie);
  return response;
}
