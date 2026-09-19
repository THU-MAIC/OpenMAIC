import { db } from '@/lib/utils/database';
import { isConcreteMediaAddress } from './resolve-media-ref';
import { mayNameAPoolAsset } from './media-placeholder';
import { withAssetUrl } from './use-asset-url';
import { fetchMediaUrl } from './fetch-media-url';

const COMPATIBILITY_AUDIO_FETCH_TIMEOUT_MS = 15_000;

/**
 * Bytes an audio reference currently resolves to.
 *
 * A stable-id regeneration commits the replaced narration to the pool first and
 * deliberately keeps the same id; if the `audioFiles` mirror write then fails
 * (quota pressure, a transient IndexedDB error) the row is stale while the pool
 * is current. Every consumer of allocated audio therefore resolves through this
 * one function, with Dexie kept as the fallback for legacy and imported rows
 * that were never pool-backed. A compatibility row whose local bytes were
 * evicted can still carry a CDN `ossKey`; fetch that final source so playback
 * and every export surface agree that the narration exists.
 */
export async function resolveAudioBlob(audioId: string): Promise<Blob | null> {
  const pooled = await pooledAudioBlob(audioId);
  if (pooled) return pooled;
  const record = await db.audioFiles.get(audioId);
  const bytes = record?.blob;
  if (bytes && bytes.size > 0) return bytes;
  if (!record?.ossKey) return null;
  try {
    const response = await fetchMediaUrl(record.ossKey, COMPATIBILITY_AUDIO_FETCH_TIMEOUT_MS);
    if (!response.ok) return null;
    const fetched = await response.blob();
    // Zero-byte responses are not playable narration. Keep the reference
    // retryable instead of turning an empty CDN response into silence.
    return fetched.size > 0 ? fetched : null;
  } catch {
    return null;
  }
}

/** Resolve several ids at once, preserving input order. */
export async function resolveAudioBlobs(
  audioIds: readonly string[],
): Promise<ReadonlyArray<Blob | null>> {
  return Promise.all(audioIds.map((audioId) => resolveAudioBlob(audioId)));
}

async function pooledAudioBlob(audioId: string): Promise<Blob | null> {
  // A derived narration key predates allocated identities: its bytes are in the
  // local table, never in the pool, so leasing it is a guaranteed miss.
  if (!audioId || isConcreteMediaAddress(audioId) || !mayNameAPoolAsset(audioId)) return null;
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
