import { randomUUID } from 'node:crypto';

const ANONYMOUS_COOKIE = 'anonymous_id';
const ANONYMOUS_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function anonymousCookieHeader(id: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
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
 * the outgoing Set-Cookie header whenever a new cookie is issued.
 *
 * Current callers (the agent event-stream routes) pass no authenticated
 * owner: for them this slice resolves only the anonymous cookie identity. A
 * future auth integration must thread `authenticatedOwnerId` through those
 * call sites, or sessions created under authenticated identities would be
 * unreachable by their own owner.
 */
export function resolveRequestOwnerId(
  req: Pick<Request, 'headers'>,
  responseHeaders: Headers,
  authenticatedOwnerId?: string,
): string {
  if (authenticatedOwnerId) return authenticatedOwnerId;

  const existingId = readCookie(req.headers, ANONYMOUS_COOKIE);
  if (existingId && UUID_V4.test(existingId)) return `anon:${existingId}`;

  const id = randomUUID();
  responseHeaders.append('Set-Cookie', anonymousCookieHeader(id));
  return `anon:${id}`;
}
