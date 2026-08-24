/**
 * Per-source image transport for a generation run (RFC #1153 part 2, N2/N4).
 *
 * A server-backed deployment names extracted images by their allocated pool
 * asset ids (the extraction cache rebuilds them by id); a browser-backed
 * deployment materializes base64 data URLs into IndexedDB exactly as before.
 * Part 2 B awaited the best-effort cache write to learn the ids and decided
 * the byte fallback once for the WHOLE bundle — so one source whose cache
 * write failed silently lost its images. These helpers keep the await bounded
 * and the fallback decision PER SOURCE:
 *
 * - `awaitWithFallback` races a best-effort write against a time budget so a
 *   stalled pool/KV never gates the user's generation (the detached write
 *   keeps running and benefits the NEXT run).
 * - `materializeBundleImages` decides per source: a source whose images ALL
 *   carry allocated asset ids is fed by id; a source with any image lacking
 *   an id (a failed best-effort cache write, a legacy session) materializes
 *   ITS images into IndexedDB as data URLs. The resulting `imageMapping` may
 *   therefore MIX asset ids and data URLs — the generation routes and
 *   `resolveImageIds` are shape-based and accept both.
 *
 * Client-reachable module (imported by `app/generation-preview/page.tsx` and
 * the classroom resume path): it must never import server-only code.
 */
import type { ParsedDocumentImage } from './bundle';

/**
 * Race a promise against a time budget, resolving `fallback` when the budget
 * expires first. The racing promise keeps running detached — its work is
 * best-effort by contract and still lands for the NEXT run. A rejection of
 * the racing promise propagates only when it settles first; callers attach
 * their own `.catch` for the best-effort case.
 */
export async function awaitWithFallback<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface MaterializedBundleImages {
  /**
   * IndexedDB storage ids aligned with the input image order; `undefined`
   * where the image is fed by its allocated asset id (no bytes materialized).
   */
  storageIds: Array<string | undefined>;
}

/**
 * Decide the byte transport per SOURCE (RFC #1153 part 2, N4): a server-backed
 * source whose images ALL carry allocated asset ids is fed by id; any source
 * with an image lacking an id materializes ITS image bytes through `store`
 * (IndexedDB) as data URLs. One source's failure never drops another source's
 * images — the bundle-level all-or-nothing decision is gone. Browser-backed
 * runs materialize everything, exactly as before.
 */
export async function materializeBundleImages(
  serverBacked: boolean,
  images: ReadonlyArray<ParsedDocumentImage & { visionPriority: number }>,
  store: (images: Array<ParsedDocumentImage & { visionPriority: number }>) => Promise<string[]>,
): Promise<MaterializedBundleImages> {
  const storageIds: Array<string | undefined> = new Array(images.length).fill(undefined);
  if (!serverBacked) {
    const stored = await store([...images]);
    stored.forEach((storageId, index) => {
      storageIds[index] = storageId;
    });
    return { storageIds };
  }
  const bySource = new Map<string, number[]>();
  images.forEach((image, index) => {
    const key = image.sourceDocumentId ?? 'unknown';
    const group = bySource.get(key) ?? [];
    group.push(index);
    bySource.set(key, group);
  });
  for (const indices of bySource.values()) {
    const group = indices.map((index) => images[index]!);
    if (group.every((image) => image.assetId)) continue;
    const stored = await store(group);
    stored.forEach((storageId, offset) => {
      storageIds[indices[offset]!] = storageId;
    });
  }
  return { storageIds };
}
