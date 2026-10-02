import { cookies } from 'next/headers';
import { timingSafeEqual } from 'crypto';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { ACCESS_TOKEN_MAX_AGE_SECONDS } from '@/lib/server/access-token-shared';
import { createAccessToken } from '@/lib/server/access-token';
import { accessCodeAttemptLimiter } from '@/lib/server/attempt-limiter';
import { clientIdentity, isTrustedProxyIdentity } from '@/lib/server/client-identity';
import { warnIfAccessCodeIsShort } from '@/lib/server/access-code-warning';

/**
 * Pull the candidate code out of an already-parsed JSON body. Anything that is
 * not `{ code: <non-empty string> }` is treated as an invalid code.
 */
function readCandidateCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = (body as { code?: unknown }).code;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

export async function POST(request: Request) {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return apiSuccess({ valid: true });
  }

  // Everything down to `consume` runs synchronously, so for a trusted identity
  // the limiter decision and the reservation happen in the same tick: a burst of
  // concurrent requests cannot all pass the window check before any of them is
  // recorded. For an untrusted identity `consume` always allows and stores
  // nothing, so there is no shared counter to race on.
  warnIfAccessCodeIsShort(accessCode);
  const trusted = isTrustedProxyIdentity();
  const identity = clientIdentity(request);
  const limit = accessCodeAttemptLimiter.consume(identity, trusted);
  if (limit.limited) {
    const response = apiError('RATE_LIMITED', 429, 'Too many access-code attempts');
    response.headers.set('Retry-After', String(limit.retryAfterSeconds));
    return response;
  }

  // The reservation (trusted identities only) is taken before the body is
  // parsed, so even a malformed body consumes a slot. That is intentional.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid JSON body');
  }

  const candidate = readCandidateCode(body);
  if (candidate === null) {
    return apiError('INVALID_REQUEST', 401, 'Invalid access code');
  }

  // Constant-time comparison
  const encoder = new TextEncoder();
  const a = encoder.encode(candidate);
  const b = encoder.encode(accessCode);
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
    // For a trusted identity the reservation taken above already counts this
    // failure; an untrusted identity is not counted at all.
    return apiError('INVALID_REQUEST', 401, 'Invalid access code');
  }

  // For a trusted per-client identity a success clears that client's history.
  // Untrusted callers stored nothing, so this is a no-op for them.
  accessCodeAttemptLimiter.recordSuccess(identity, trusted);

  const token = createAccessToken(accessCode);
  const cookieStore = await cookies();
  cookieStore.set('openmaic_access', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === 'production',
  });

  return apiSuccess({ valid: true });
}
