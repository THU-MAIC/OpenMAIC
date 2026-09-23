/**
 * Server-side resolution of a client-allocated asset id for extraction.
 *
 * Compatibility read fallback for callers that already hold an allocated
 * server asset id. New app flows do not allocate registry assets, but retained
 * documents and SDK clients may still name an existing entry.
 *
 * The resolution answers in five states so the route can map each to an honest
 * HTTP status: not configured (no `DATABASE_URL`), unauthenticated (the owner
 * authenticator rejected the request's credential), missing (no entry under
 * this id that this owner may read), too large (the recorded byte length
 * exceeds the caller-supplied cap, rejected before any bytes are read), or
 * resolved.
 *
 * "May read" is the persistence route's own rule (`./owner-assets.ts`): the
 * owner's own entries, legacy shared entries, and other owners' committed
 * entries that a live course references.
 */
import { AssetNotFoundError, toAssetId } from '@openmaic/storage';

import { resolveRequestOwner } from '@/lib/server/identity/resolve';
import type { OwnerAuthRequest } from '@/lib/server/identity/types';

import { assetPrincipalForOwner, createOwnerAssetStore } from './owner-assets';
import { getServerPersistenceProvider } from './server-provider';

export type ServerAssetResolution =
  | { status: 'resolved'; buffer: Buffer; mimeType: string }
  | { status: 'unconfigured' }
  | { status: 'unauthenticated' }
  | { status: 'missing' }
  | { status: 'too_large' };

/**
 * Resolve an allocated asset id to its bytes for extraction.
 *
 * When `maxByteLength` is supplied, the store's identity read (`identify` —
 * the same call HEAD uses, carrying the recorded byte length without reading
 * the bytes) is consulted first: an asset whose recorded length exceeds the
 * cap answers `too_large` WITHOUT ever materializing the bytes, so a
 * multi-hundred-MB asset cannot be pulled into server memory just to be
 * rejected. The caller keeps its post-resolve length check as a defensive
 * backstop against a store whose recorded length disagrees with the bytes.
 */
export async function resolveServerAsset(
  assetId: string,
  request: OwnerAuthRequest,
  maxByteLength?: number,
): Promise<ServerAssetResolution> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { status: 'unconfigured' };

  // The same memoized owner resolution the rest of the request uses. A cookie
  // this resolution mints is not sent back from here; such an owner holds no
  // entries yet, so it can only read what any owner may read.
  const outcome = await resolveRequestOwner(request);
  if (!outcome.ok) return { status: 'unauthenticated' };
  const { ownerId } = outcome.principal;
  const assetPrincipal = assetPrincipalForOwner(ownerId);

  try {
    const provider = await getServerPersistenceProvider(connectionString);
    const assetStore = createOwnerAssetStore(provider.assetStore, {
      ownerId,
      queryable: provider.pool,
    });
    const ref = toAssetId(assetId);
    // Size check BEFORE materialization: `identify` reads only the registry
    // row (recorded byte length), never the bytes, so an oversized asset is
    // rejected without ever pulling it into server memory.
    if (maxByteLength !== undefined) {
      const identity = await assetStore.identify(assetPrincipal, ref);
      if (!identity) return { status: 'missing' };
      if (identity.byteLength > maxByteLength) return { status: 'too_large' };
    }
    const resolved = await assetStore.resolve(assetPrincipal, ref);
    if (!resolved) return { status: 'missing' };
    return { status: 'resolved', buffer: Buffer.from(resolved.bytes), mimeType: resolved.mime };
  } catch (error) {
    // An unknown id and another principal's id both miss; the registry raises
    // the same typed error for the shapes it rejects, so map it to `missing`
    // rather than leaking it as a 500.
    if (error instanceof AssetNotFoundError) return { status: 'missing' };
    throw error;
  }
}
