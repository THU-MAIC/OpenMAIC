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
 * The resolution answers in four states so the route can map each to an honest
 * HTTP status: not configured (no `DATABASE_URL`), unauthenticated (the
 * development persistence credential is missing or wrong), missing (no entry
 * under this id for this principal), or resolved.
 */
import { AssetNotFoundError, toAssetId, type AssetPrincipal } from '@openmaic/storage';

import { authenticatePersistenceHeaders } from './server-auth';
import { getServerPersistenceProvider } from './server-provider';

export type ServerAssetResolution =
  | { status: 'resolved'; buffer: Buffer; mimeType: string }
  | { status: 'unconfigured' }
  | { status: 'unauthenticated' }
  | { status: 'missing' };

export async function resolveServerAsset(
  assetId: string,
  headers: Headers,
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
    const resolved = await provider.assetStore.resolve(assetPrincipal, toAssetId(assetId));
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
