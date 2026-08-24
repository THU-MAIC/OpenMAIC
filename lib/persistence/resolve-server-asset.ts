/**
 * Server-side resolution of a client-allocated asset id for extraction.
 *
 * The browser asset pool hands every uploaded course material an allocated
 * asset id at upload time. When the deployment's pool is server-backed
 * (`NEXT_PUBLIC_PERSISTENCE=1` bootstraps an `HttpAssetStore`), that id also
 * names an entry in the server asset store, and the extract route can resolve
 * the original bytes here instead of asking the client to re-upload them.
 *
 * A browser-backed (self-deploy) pool never reaches this module: the client
 * detects the mode with `isAssetPoolServerBacked` and keeps uploading bytes.
 * The id still exists client-side, it is just not usable as a server-side
 * reference.
 *
 * The resolution answers in five states so the route can map each to an honest
 * HTTP status: not configured (no `DATABASE_URL`), unauthenticated (the
 * development persistence credential is missing or wrong), missing (no entry
 * under this id for this principal), too large (the recorded byte length
 * exceeds the caller-supplied cap, rejected before any bytes are read), or
 * resolved.
 */
import { AssetNotFoundError, toAssetId, type AssetPrincipal } from '@openmaic/storage';

import { authenticatePersistenceHeaders } from './server-auth';
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
  headers: Headers,
  maxByteLength?: number,
): Promise<ServerAssetResolution> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { status: 'unconfigured' };

  // Shared-partition development auth: this authenticator maps every caller to
  // one 'shared' asset principal (see the server-auth.ts docstring). It is the
  // documented stopgap for this deployment shape — its cost surface is
  // accepted until real per-learner principals land in a later part of the
  // RFC; do not extend it here.
  const principal = authenticatePersistenceHeaders(headers);
  // The authenticator always supplies a partition key on success, but its type
  // leaves it optional; a keyless principal fails closed as unauthenticated.
  if (!principal?.key) return { status: 'unauthenticated' };
  const assetPrincipal: AssetPrincipal = {
    key: principal.key,
    ...(principal.learnerKey ? { learnerKey: principal.learnerKey } : {}),
  };

  try {
    const provider = await getServerPersistenceProvider(connectionString);
    const ref = toAssetId(assetId);
    // Size check BEFORE materialization: `identify` reads only the registry
    // row (recorded byte length), never the bytes, so an oversized asset is
    // rejected without ever pulling it into server memory.
    if (maxByteLength !== undefined) {
      const identity = await provider.assetStore.identify(assetPrincipal, ref);
      if (!identity) return { status: 'missing' };
      if (identity.byteLength > maxByteLength) return { status: 'too_large' };
    }
    const resolved = await provider.assetStore.resolve(assetPrincipal, ref);
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
