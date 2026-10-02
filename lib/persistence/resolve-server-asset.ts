/**
 * Server-side resolution of an allocated asset id to its bytes, for an owner
 * already resolved (a generation run reading the images of its materials).
 *
 * The resolution answers missing (no entry under this id that this owner may
 * read), too large (the recorded byte length exceeds the caller-supplied cap,
 * rejected before any bytes are read), or resolved.
 *
 * "May read" is the persistence route's own rule (`./owner-assets.ts`): the
 * owner's own entries, legacy shared entries, and other owners' committed
 * entries that a live course references.
 */
import { AssetNotFoundError, toAssetId } from '@openmaic/storage';

import { assetPrincipalForOwner, createOwnerAssetStore } from './owner-assets';
import { getServerPersistenceProvider } from './server-provider';

type OwnedAssetResolution =
  | { status: 'resolved'; buffer: Buffer; mimeType: string }
  | { status: 'missing' }
  | { status: 'too_large' };

/**
 * Resolve an allocated asset id to its bytes as `ownerId` may read them.
 *
 * When `maxByteLength` is supplied, the store's identity read (`identify` —
 * the same call HEAD uses, carrying the recorded byte length without reading
 * the bytes) is consulted first: an asset whose recorded length exceeds the
 * cap answers `too_large` WITHOUT ever materializing the bytes, so a
 * multi-hundred-MB asset cannot be pulled into server memory just to be
 * rejected.
 */
export async function resolveOwnedAsset(
  assetId: string,
  ownerId: string,
  connectionString: string,
  maxByteLength: number | undefined,
): Promise<OwnedAssetResolution> {
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
