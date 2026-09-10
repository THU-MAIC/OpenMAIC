import { db } from '@/lib/utils/database';
import { isConcreteMediaAddress } from './resolve-media-ref';
import { withAssetUrl } from './use-asset-url';

/**
 * Bytes an audio reference currently resolves to.
 *
 * A stable-id regeneration commits the replaced narration to the pool first and
 * deliberately keeps the same id; if the `audioFiles` mirror write then fails
 * (quota pressure, a transient IndexedDB error) the row is stale while the pool
 * is current. Every consumer of allocated audio therefore resolves through this
 * one function, with Dexie kept as the fallback for legacy and imported rows
 * that were never pool-backed.
 */
export async function resolveAudioBlob(audioId: string): Promise<Blob | null> {
  const pooled = await pooledAudioBlob(audioId);
  if (pooled) return pooled;
  const record = await db.audioFiles.get(audioId);
  const bytes = record?.blob;
  // Zero-byte rows (evicted, or an empty fetch) are not playable narration:
  // report no bytes so callers keep the reference retryable instead of
  // playing silence.
  return bytes && bytes.size > 0 ? bytes : null;
}

/** Resolve several ids at once, preserving input order. */
export async function resolveAudioBlobs(
  audioIds: readonly string[],
): Promise<ReadonlyArray<Blob | null>> {
  return Promise.all(audioIds.map((audioId) => resolveAudioBlob(audioId)));
}

async function pooledAudioBlob(audioId: string): Promise<Blob | null> {
  if (!audioId || isConcreteMediaAddress(audioId)) return null;
  try {
    return await withAssetUrl(audioId, async (url) => {
      if (!url) return null;
      const response = await fetch(url);
      const blob = response.ok ? await response.blob() : null;
      return blob && blob.size > 0 ? blob : null;
    });
  } catch {
    // Stored rows stay the fallback when the pool is unavailable.
    return null;
  }
}
