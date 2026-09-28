import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { BROWSER_ID_PATTERN, bindLegacyImport } from '@/lib/persistence/legacy-import-bindings';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

function jsonError(status: number, code: string, message: string, headers?: Headers): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

/**
 * `POST /api/identity/legacy-import-binding` with `{ browserId }`: bind this
 * browser's pre-server data to the requesting owner unless another owner holds
 * it already, and answer `200 { bound }` -- whether the requesting owner holds
 * it now. It never says who else does.
 *
 * The one-way import of pre-server browser data (`lib/legacy-browser-import/`)
 * asks this before anything else and writes only when bound; owner resolution
 * refuses its later requests for any other owner
 * (`lib/persistence/legacy-import-bindings.ts`). The bind is one atomic insert,
 * so two owners racing from two tabs cannot both hold the browser, and a claim
 * carries the binding to the account.
 *
 * Same-origin JSON only (it writes on the owner's behalf), resolved like every
 * other owner-scoped route (a rejected credential answers 401), fenced like
 * every owner write (a retired owner answers `403 OWNER_RETIRED`, a claim in
 * progress `503 OWNER_BUSY`), uncacheable. `400` for a malformed browser id.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginJsonRequest(request)) {
    return jsonError(403, 'CROSS_ORIGIN_REFUSED', 'bindings must be same-origin JSON requests');
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'INVALID_REQUEST', 'request body must be JSON');
  }
  const browserId = (body as { browserId?: unknown } | null)?.browserId;
  if (typeof browserId !== 'string' || !BROWSER_ID_PATTERN.test(browserId)) {
    return jsonError(400, 'INVALID_REQUEST', 'browserId must be 32 lowercase hex characters');
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    return jsonError(404, 'PERSISTENCE_NOT_CONFIGURED', 'server persistence not configured');
  }
  return withRequestOwner(request, async (principal, responseHeaders) => {
    responseHeaders.set('cache-control', 'private, no-store');
    const { withTransaction } = await getServerPersistenceProvider(connectionString);
    let bound: boolean;
    try {
      bound = await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, principal.ownerId);
        return bindLegacyImport(tx, browserId, principal.ownerId);
      });
    } catch (error) {
      const refusal = ownerWriteErrorResponse(error, responseHeaders);
      if (refusal) return refusal;
      throw error;
    }
    return Response.json({ bound }, { status: 200, headers: responseHeaders });
  });
}
