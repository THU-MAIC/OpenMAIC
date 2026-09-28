import { LEGACY_IMPORT_HEADER } from '@/lib/persistence/legacy-import-bindings';

import { resolveRequestOwner } from './resolve';
import type { OwnerAuthRequest, OwnerPrincipal } from './types';

/**
 * Route-handler helpers over {@link resolveRequestOwner}.
 *
 * The `Set-Cookie` values resolution returns (a minted anonymous owner,
 * say) must ride every response, including 4xx and 5xx: a client that retries
 * after an error keeps the same owner, while a 500 that dropped the cookie
 * would silently make the retry a different owner. Both helpers therefore hand
 * the handler a `Headers` that already carries them.
 */

/**
 * The response to a request a method refused, or that no method accepted with
 * the anonymous fallback off. It is never answered as a fresh anonymous owner
 * instead.
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
  const fenced = await legacyImportFence(req, principal.ownerId, responseHeaders);
  if (fenced) return { ok: false, response: fenced };
  return { ok: true, principal, responseHeaders };
}

/**
 * The server side of the one-way import of pre-server browser data
 * (`lib/legacy-browser-import/`): a request that carries a browser id in
 * `X-OpenMAIC-Legacy-Import` is the importer's, and is refused with
 * `409 LEGACY_IMPORT_NOT_BOUND` unless the owner it resolves to holds that
 * browser's binding (`lib/persistence/legacy-import-bindings.ts`). Checked
 * here, in the one resolution every owner-scoped route goes through, so no
 * route the importer writes to can skip it; a request without the header is
 * not affected. A malformed id answers 400; a binding that cannot be read
 * (the database is down) answers 503, which the importer retries. Every
 * answer carries the resolution's `Set-Cookie` values.
 */
async function legacyImportFence(
  req: OwnerAuthRequest,
  ownerId: string,
  responseHeaders: Headers,
): Promise<Response | undefined> {
  const browserId = req.headers.get(LEGACY_IMPORT_HEADER);
  if (browserId === null) return undefined;
  const refuse = (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status, headers: responseHeaders });
  const { BROWSER_ID_PATTERN, LEGACY_IMPORT_NOT_BOUND, legacyImportBindingOwner } =
    await import('@/lib/persistence/legacy-import-bindings');
  if (!BROWSER_ID_PATTERN.test(browserId)) {
    return refuse(400, 'INVALID_REQUEST', 'the legacy import browser id is malformed');
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    return refuse(409, LEGACY_IMPORT_NOT_BOUND, 'this browser is not bound to this owner');
  }
  let holder: string | null;
  try {
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const { pool } = await getServerPersistenceProvider(connectionString);
    holder = await legacyImportBindingOwner(
      pool as unknown as Parameters<typeof legacyImportBindingOwner>[0],
      browserId,
    );
  } catch (error) {
    console.error('[owner-identity] the legacy import binding could not be read', error);
    return refuse(503, 'PERSISTENCE_UNAVAILABLE', 'the legacy import binding could not be read');
  }
  if (holder !== ownerId) {
    return refuse(409, LEGACY_IMPORT_NOT_BOUND, 'this browser is not bound to this owner');
  }
  return undefined;
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
