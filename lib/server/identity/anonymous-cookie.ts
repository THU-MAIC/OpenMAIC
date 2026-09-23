import { randomUUID } from 'node:crypto';

import type { AuthOutcome, OwnerAuthenticator, OwnerAuthRequest, OwnerPrincipal } from './types';

/**
 * The `anonymousCookie` built-in: one owner per browser.
 *
 * Owner-scoped data is user-visible and keyed by owner. A shared constant would
 * let unrelated visitors see one another's sessions and courses, while an
 * anonymous cookie provides the smallest useful isolation boundary.
 *
 * This is the only module that reads or writes the anonymous owner cookie. A
 * host that brings its own authenticator can therefore use its own cookie
 * without clashing with this one (`tests/server/identity/cookie-guard.test.ts`
 * keeps it that way).
 */

const ANONYMOUS_COOKIE = 'anonymous_id';
const ANONYMOUS_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/**
 * An over-strict guard is fail-safe: a forged or malformed value merely gets a
 * fresh id, nobody is locked out of their own data.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANONYMOUS_OWNER_PREFIX = 'anon:';

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

/**
 * Whether the anonymous owner cookie carries `Secure`. Production sets it by
 * default; plain-HTTP deployments opt out with the exact value COOKIE_SECURE=0
 * (Safari refuses to store `Secure` cookies served over plain http://localhost,
 * which makes every request mint a fresh owner and owner-scoped writes fail).
 * Shared by the route and Server Action paths so both entry points agree.
 */
export function anonymousCookieSecure(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== '0';
}

function anonymousCookieHeader(id: string): string {
  const secure = anonymousCookieSecure() ? '; Secure' : '';
  return (
    `${ANONYMOUS_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${ANONYMOUS_COOKIE_MAX_AGE_SECONDS}${secure}`
  );
}

const NO_ROLES: ReadonlySet<string> = new Set<string>();

/**
 * An anonymous owner holds no core role: publishing makes a course a durable
 * public artifact, which needs an identity more lasting than a cookie.
 */
function anonymousPrincipal(uuid: string, assurance: 'unverified-legacy' | 'minted') {
  return {
    ownerId: `${ANONYMOUS_OWNER_PREFIX}${uuid}`,
    kind: 'anonymous',
    roles: NO_ROLES,
    assurance,
  } satisfies OwnerPrincipal;
}

/**
 * Resolve the anonymous owner of a route handler request.
 *
 * A valid cookie is reused and nothing is sent back. Otherwise — absent,
 * undecodable or not a UUID v4 — a fresh id is minted and returned with the
 * `Set-Cookie` that persists it; the caller attaches it to every response.
 */
function authenticateAnonymousRequest(req: OwnerAuthRequest): AuthOutcome {
  const existingId = readCookie(req.headers, ANONYMOUS_COOKIE);
  if (existingId && UUID_V4.test(existingId)) {
    return { ok: true, principal: anonymousPrincipal(existingId, 'unverified-legacy') };
  }
  const id = randomUUID();
  return {
    ok: true,
    principal: anonymousPrincipal(id, 'minted'),
    setCookies: [anonymousCookieHeader(id)],
  };
}

/**
 * The Server Action counterpart. A Server Action has no `Request`, so the same
 * cookie is read and, when needed, minted through `next/headers` with the same
 * attributes as {@link anonymousCookieHeader}.
 */
async function authenticateAnonymousContext(): Promise<AuthOutcome> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const existing = cookieStore.get(ANONYMOUS_COOKIE)?.value;
  if (existing && UUID_V4.test(existing)) {
    return { ok: true, principal: anonymousPrincipal(existing, 'unverified-legacy') };
  }
  const minted = randomUUID();
  cookieStore.set(ANONYMOUS_COOKIE, minted, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ANONYMOUS_COOKIE_MAX_AGE_SECONDS,
    secure: anonymousCookieSecure(),
  });
  return { ok: true, principal: anonymousPrincipal(minted, 'minted') };
}

/**
 * Create the `anonymousCookie` authenticator: `kind: 'anonymous'`, no roles,
 * owner ids of the form `anon:<uuid>` backed by a 30-day `HttpOnly`,
 * `SameSite=Lax` cookie at `/`. It has no invalid-credential case: a malformed
 * cookie is re-minted, never refused.
 */
export function createAnonymousCookieAuthenticator(): OwnerAuthenticator {
  return {
    name: 'anonymousCookie',
    authenticate: async (req) => authenticateAnonymousRequest(req),
    authenticateFromContext: authenticateAnonymousContext,
  };
}
