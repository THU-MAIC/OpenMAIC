import { cookiesAreSecure } from '@/lib/server/cookie-secure';

import type {
  OwnerAuthMethod,
  OwnerAuthMethodResult,
  OwnerAuthRequest,
  OwnerPrincipal,
} from './types';

/**
 * The `anonymousCookie` built-in: one owner per browser, and the fallback
 * core resolves to when no registered method applies (`./resolve.ts`).
 *
 * Owner-scoped data is user-visible and keyed by owner. A shared constant would
 * let unrelated visitors see one another's sessions and courses, while an
 * anonymous cookie provides the smallest useful isolation boundary.
 *
 * This is the only module that reads or writes the anonymous owner cookie,
 * including the read core makes to attach a claim candidate beside a host
 * method's principal. A host method can therefore use its own cookie without
 * clashing with this one (`tests/server/identity/cookie-guard.test.ts`
 * keeps it that way).
 *
 * It uses only Web APIs (`crypto.randomUUID`, `Headers`), so the Edge
 * middleware mints the same cookie through it (`./navigation.ts`): one format,
 * one set of attributes, whichever side mints.
 */

const ANONYMOUS_COOKIE = 'anonymous_id';
/**
 * 400 days: the longest lifetime browsers keep a cookie (RFC 6265bis caps
 * Max-Age there). The cookie is the only key to an anonymous owner's library,
 * so it lasts as long as a browser allows and is renewed while in use (see
 * {@link authenticateAnonymousRequest}): an active visitor never loses it to
 * expiry, and an idle one keeps it for 400 days after the last use.
 */
export const ANONYMOUS_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
/**
 * An over-strict guard is fail-safe: a forged or malformed value merely gets a
 * fresh id, nobody is locked out of their own data.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANONYMOUS_OWNER_PREFIX = 'anon:';

/** A fresh anonymous cookie value: a random UUID v4 (Web Crypto, so Edge-safe). */
function mintAnonymousId(): string {
  return globalThis.crypto.randomUUID();
}

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
 * Whether the anonymous owner cookie carries `Secure` (see `cookiesAreSecure`).
 * Shared by the route and Server Action paths so both entry points agree.
 */
export function anonymousCookieSecure(): boolean {
  return cookiesAreSecure();
}

function anonymousCookieHeader(id: string): string {
  const secure = anonymousCookieSecure() ? '; Secure' : '';
  return (
    `${ANONYMOUS_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${ANONYMOUS_COOKIE_MAX_AGE_SECONDS}${secure}`
  );
}

/**
 * The anonymous owner id a request's cookie names, when the cookie is present
 * and well-formed; `undefined` otherwise. Nothing is minted. Core uses it to
 * recognize an anonymous identity presented beside a host method's principal
 * (the claim candidate), so the cookie is still parsed only here.
 */
export function readAnonymousOwnerId(headers: Headers): string | undefined {
  const existingId = readCookie(headers, ANONYMOUS_COOKIE);
  return existingId && UUID_V4.test(existingId)
    ? `${ANONYMOUS_OWNER_PREFIX}${existingId}`
    : undefined;
}

/** A `Set-Cookie` value that removes the anonymous owner cookie. */
export function clearAnonymousCookieHeader(): string {
  const secure = anonymousCookieSecure() ? '; Secure' : '';
  return `${ANONYMOUS_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/**
 * The anonymous owner a page request establishes (`./navigation.ts`), or
 * `undefined` when the request already presents a valid anonymous cookie: an
 * established identity is never replaced. Otherwise a fresh id is minted
 * exactly as a route handler would mint it, and returned as the `Set-Cookie`
 * for the page response plus the request's `Cookie` header rewritten to carry
 * it (any malformed value dropped), so the rest of the same request resolves
 * the same owner.
 */
export function establishAnonymousCookie(
  headers: Headers,
): { readonly setCookie: string; readonly requestCookie: string } | undefined {
  if (readAnonymousOwnerId(headers) !== undefined) return undefined;
  const id = mintAnonymousId();
  const others = (headers.get('cookie') ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item !== '' && item.split('=', 1)[0]!.trim() !== ANONYMOUS_COOKIE);
  return {
    setCookie: anonymousCookieHeader(id),
    requestCookie: [...others, `${ANONYMOUS_COOKIE}=${id}`].join('; '),
  };
}

/** Whether `ownerId` has the shape this built-in mints: `anon:<uuid v4>`. */
export function isAnonymousCookieOwnerId(ownerId: string): boolean {
  return (
    ownerId.slice(0, ANONYMOUS_OWNER_PREFIX.length) === ANONYMOUS_OWNER_PREFIX &&
    UUID_V4.test(ownerId.slice(ANONYMOUS_OWNER_PREFIX.length))
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
 * A valid cookie is reused and renewed: the same value is sent back with a
 * fresh Max-Age, so the identity expires 400 days after its last use, not
 * after its first. Otherwise — absent, undecodable or not a UUID v4 — a fresh
 * id is minted and returned with the `Set-Cookie` that persists it. Either
 * way the caller attaches it to every response; a response that also clears
 * the cookie (a claim, a retired owner) drops the renewal
 * (`./set-cookie.ts`). Page responses never renew (the middleware leaves a
 * valid cookie alone), so pages stay cacheable.
 */
function authenticateAnonymousRequest(req: OwnerAuthRequest): OwnerAuthMethodResult {
  const existingId = readCookie(req.headers, ANONYMOUS_COOKIE);
  if (existingId && UUID_V4.test(existingId)) {
    return {
      status: 'authenticated',
      principal: anonymousPrincipal(existingId, 'unverified-legacy'),
      setCookies: [anonymousCookieHeader(existingId)],
    };
  }
  const id = mintAnonymousId();
  return {
    status: 'authenticated',
    principal: anonymousPrincipal(id, 'minted'),
    setCookies: [anonymousCookieHeader(id)],
  };
}

/** {@link anonymousCookieHeader}'s attributes, for `next/headers`. */
function anonymousCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: ANONYMOUS_COOKIE_MAX_AGE_SECONDS,
    secure: anonymousCookieSecure(),
  };
}

/**
 * The Server Action counterpart. A Server Action has no `Request`, so the same
 * cookie is read and, when needed, minted through `next/headers` with the same
 * attributes as {@link anonymousCookieHeader}. A valid cookie is renewed the
 * same way; the renewal is best-effort, since `next/headers` refuses writes
 * outside a Server Action or route handler (a render), where the identity
 * still resolves.
 */
async function authenticateAnonymousContext(): Promise<OwnerAuthMethodResult> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const existing = cookieStore.get(ANONYMOUS_COOKIE)?.value;
  if (existing && UUID_V4.test(existing)) {
    try {
      cookieStore.set(ANONYMOUS_COOKIE, existing, anonymousCookieOptions());
    } catch {
      // Not writable here: nothing to renew, the cookie keeps its lifetime.
    }
    return {
      status: 'authenticated',
      principal: anonymousPrincipal(existing, 'unverified-legacy'),
    };
  }
  const minted = mintAnonymousId();
  cookieStore.set(ANONYMOUS_COOKIE, minted, anonymousCookieOptions());
  return { status: 'authenticated', principal: anonymousPrincipal(minted, 'minted') };
}

/**
 * The `anonymousCookie` method: `kind: 'anonymous'`, no roles, owner ids of
 * the form `anon:<uuid>` backed by a 400-day, renewed-on-use `HttpOnly`, `SameSite=Lax` cookie
 * at `/`. It always authenticates: a missing or malformed cookie is re-minted,
 * never refused. Core asks it last, and only when the fallback is enabled; its
 * `describeStoredOwner` and `clearCredential` apply whatever the fallback
 * setting, because anonymous owners minted earlier can still be claimed.
 */
export const anonymousCookieMethod: OwnerAuthMethod = {
  name: 'anonymousCookie',
  authenticate: async (req) => authenticateAnonymousRequest(req),
  authenticateFromContext: authenticateAnonymousContext,
  issuesAnonymousOwners: true,
  describeStoredOwner: (ownerId) =>
    isAnonymousCookieOwnerId(ownerId) ? { kind: 'anonymous', roles: NO_ROLES } : undefined,
  // Dropping a retired cookie is all recovery takes: the next request mints
  // a fresh anonymous owner.
  clearCredential: () => [clearAnonymousCookieHeader()],
};
