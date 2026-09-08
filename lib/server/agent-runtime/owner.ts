import { randomUUID } from 'node:crypto';

const ANONYMOUS_COOKIE = 'anonymous_id';
const ANONYMOUS_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const OWNER_RECOVERY_PREFIX = 'openmaic-teacher-v1:';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type OwnerRequest = Pick<Request, 'headers'> & Partial<Pick<Request, 'url'>>;

function readCookie(headers: Headers, name: string): string | undefined {
  const encoded = headers.get('cookie');
  if (!encoded) return undefined;
  for (const item of encoded.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function requestUsesHttps(req: OwnerRequest): boolean {
  if (req.url) {
    try {
      return new URL(req.url).protocol === 'https:';
    } catch {
      // Older adapters only supply headers; preserve their production fallback.
    }
  }
  return process.env.NODE_ENV === 'production';
}

function anonymousCookieHeader(req: OwnerRequest, id: string): string {
  const secure = requestUsesHttps(req) ? '; Secure' : '';
  return (
    `${ANONYMOUS_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${ANONYMOUS_COOKIE_MAX_AGE_SECONDS}${secure}`
  );
}

/**
 * Resolve the request identity used to partition agent sessions.
 *
 * Session lists are user-visible data keyed by owner. A shared constant would
 * let unrelated visitors see one another's sessions, while an anonymous cookie
 * provides the smallest useful isolation boundary.
 *
 * An explicit `authenticatedOwnerId` (from the host's auth layer) is returned
 * verbatim: authenticated principals must not be partitioned under a fresh
 * anonymous identity, and no anonymous cookie is minted for them.
 *
 * Otherwise the identity comes from a valid anonymous cookie, or a fresh UUID
 * is minted. A mint is only useful when it is persisted, so `responseHeaders`
 * — the headers the caller returns to the client — is required: it receives
 * the outgoing Set-Cookie header whenever a cookie is issued or renewed.
 *
 * Current callers (the agent event-stream routes) pass no authenticated
 * owner: for them this slice resolves only the anonymous cookie identity. A
 * future auth integration must thread `authenticatedOwnerId` through those
 * call sites, or sessions created under authenticated identities would be
 * unreachable by their own owner.
 */
export function resolveRequestOwnerId(
  req: OwnerRequest,
  responseHeaders: Headers,
  authenticatedOwnerId?: string,
): string {
  if (authenticatedOwnerId) return authenticatedOwnerId;

  const existingId = readCookie(req.headers, ANONYMOUS_COOKIE);
  const id = existingId && UUID_V4.test(existingId) ? existingId : randomUUID();
  responseHeaders.append('Set-Cookie', anonymousCookieHeader(req, id));
  return `anon:${id}`;
}

/** Recovery codes are bearer credentials for the existing owner partition. */
export function createOwnerRecoveryCode(ownerId: string): string {
  const id = ownerId.startsWith('anon:') ? ownerId.slice('anon:'.length) : '';
  if (!UUID_V4.test(id)) throw new Error('Only anonymous owners support recovery codes');
  return `${OWNER_RECOVERY_PREFIX}${id}`;
}

export function restoreRequestOwnerId(
  req: OwnerRequest,
  responseHeaders: Headers,
  recoveryCode: unknown,
): string | null {
  if (typeof recoveryCode !== 'string' || !recoveryCode.startsWith(OWNER_RECOVERY_PREFIX)) {
    return null;
  }
  const id = recoveryCode.slice(OWNER_RECOVERY_PREFIX.length);
  if (!UUID_V4.test(id)) return null;

  responseHeaders.append('Set-Cookie', anonymousCookieHeader(req, id));
  return `anon:${id}`;
}
