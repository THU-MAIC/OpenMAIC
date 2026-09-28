import { ownerAbsorbedDigest } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

const HEX = /^[0-9a-f]+$/;

function jsonError(status: number, code: string, message: string, headers?: Headers): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

/**
 * `GET /api/identity/merged-from?salt=<hex>&digest=<hex>`: whether a claim
 * merged into the requesting owner an owner whose id hashes to `digest`, as
 * SHA-256 (hex) of `<salt>\u0000<owner id>`.
 *
 * The browser's one-way import of pre-server data records the first owner it
 * ran for only as such a salted digest, and hands the import to a different
 * owner only when that owner absorbed the first one through a claim. This is
 * the server-side confirmation. It answers for the requesting owner's own
 * merges only (`owner_merges.to_owner_id`), never lists or names any owner,
 * and resolves the owner like every other owner-scoped route (a rejected
 * credential answers 401).
 *
 * `200 { merged: boolean }`, uncacheable. `400` for a malformed query.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const salt = url.searchParams.get('salt') ?? '';
  const digest = url.searchParams.get('digest') ?? '';
  if (
    !HEX.test(salt) ||
    salt.length < 16 ||
    salt.length > 128 ||
    !HEX.test(digest) ||
    digest.length !== 64
  ) {
    return jsonError(400, 'INVALID_REQUEST', 'salt and digest must be lowercase hex');
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    return jsonError(404, 'PERSISTENCE_NOT_CONFIGURED', 'server persistence not configured');
  }
  return withRequestOwner(request, async (principal, responseHeaders) => {
    responseHeaders.set('cache-control', 'private, no-store');
    const { pool } = await getServerPersistenceProvider(connectionString);
    const merged = await ownerAbsorbedDigest(
      pool as unknown as Parameters<typeof ownerAbsorbedDigest>[0],
      principal.ownerId,
      salt,
      digest,
    );
    return Response.json({ merged }, { status: 200, headers: responseHeaders });
  });
}
