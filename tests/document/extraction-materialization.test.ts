import { describe, expect, it, vi } from 'vitest';

import {
  awaitWithFallback,
  materializeBundleImages,
} from '@/lib/document/extraction-materialization';
import type { ParsedDocumentImage } from '@/lib/document/bundle';

/**
 * Per-source image transport for a generation run (RFC #1153 part 2, N2/N4):
 * the cache-write await is bounded (a stalled pool/KV never gates the user's
 * generation) and the data-URL fallback is decided PER SOURCE (one source's
 * failed cache write never silently drops another source's images).
 */

function image(
  over: Partial<ParsedDocumentImage>,
): ParsedDocumentImage & { visionPriority: number } {
  return {
    id: 'img_1',
    src: 'data:image/png;base64,AQID',
    pageNumber: 1,
    sourceDocumentId: 'src_a',
    sourceDocumentOrder: 1,
    visionPriority: 1,
    ...over,
  };
}

describe('awaitWithFallback (N2 — bounded cache-write await)', () => {
  it('resolves the promise when it settles within the budget', async () => {
    await expect(awaitWithFallback(Promise.resolve(['img_1']), 1000, [])).resolves.toEqual([
      'img_1',
    ]);
  });

  it('resolves the FALLBACK when the promise never settles, without hanging', async () => {
    const neverSettling = new Promise<unknown[]>(() => undefined);
    await expect(awaitWithFallback(neverSettling, 20, [])).resolves.toEqual([]);
  });

  it('lets a rejected promise propagate only when it settles first (callers catch best-effort writes)', async () => {
    await expect(
      awaitWithFallback(Promise.reject(new Error('write failed')), 1000, []),
    ).rejects.toThrow('write failed');
  });
});

describe('materializeBundleImages (N4 — per-source fallback)', () => {
  it('materializes every image on a browser-backed run, exactly as before', async () => {
    const images = [
      image({ id: 'img_1', assetId: 'ast_1' }),
      image({ id: 'img_2', sourceDocumentId: 'src_b' }),
    ];
    const store = vi.fn(async (group: Array<ParsedDocumentImage & { visionPriority: number }>) =>
      group.map((img) => `session_x_${img.id}`),
    );

    const { storageIds } = await materializeBundleImages(false, images, store);

    expect(storageIds).toEqual(['session_x_img_1', 'session_x_img_2']);
    expect(store).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledWith(images);
  });

  it('decides PER SOURCE on a server-backed run: an id-fed source is skipped, a failed source materializes only ITS images', async () => {
    const images = [
      // Source A: every image carries an allocated asset id → id-fed, no bytes.
      image({ id: 'img_1', assetId: 'ast_a_1' }),
      image({ id: 'img_2', assetId: 'ast_a_2' }),
      // Source B: its cache write failed (no asset id) → materialize only B.
      image({ id: 'img_3', sourceDocumentId: 'src_b', sourceDocumentOrder: 2 }),
      image({ id: 'img_4', sourceDocumentId: 'src_b', sourceDocumentOrder: 2 }),
    ];
    const store = vi.fn(async (group: Array<ParsedDocumentImage & { visionPriority: number }>) =>
      group.map((img) => `session_x_${img.id}`),
    );

    const { storageIds } = await materializeBundleImages(true, images, store);

    // Only source B's images carry IndexedDB storage ids; source A stays
    // id-fed (undefined), so its images are NOT dropped from generation.
    expect(storageIds).toEqual([undefined, undefined, 'session_x_img_3', 'session_x_img_4']);
    expect(store).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledWith([images[2], images[3]]);
  });

  it('materializes a source that has a MIX of id-fed and id-less images (all-or-nothing per source)', async () => {
    const images = [image({ id: 'img_1', assetId: 'ast_partial_1' }), image({ id: 'img_2' })];
    const store = vi.fn(async (group: Array<ParsedDocumentImage & { visionPriority: number }>) =>
      group.map((img) => `session_x_${img.id}`),
    );

    const { storageIds } = await materializeBundleImages(true, images, store);

    expect(storageIds).toEqual(['session_x_img_1', 'session_x_img_2']);
  });

  it('composes with awaitWithFallback: a timed-out cache write (no ids) falls back to per-source materialization', async () => {
    const images = [image({ id: 'img_1', sourceDocumentId: 'src_b', sourceDocumentOrder: 2 })];
    const store = vi.fn(async () => ['session_x_img_1']);
    const neverSettlingWrite = new Promise<unknown[]>(() => undefined);

    // A server-backed run whose cache write hangs: the bounded await yields no
    // ids, so the source's images are materialized instead of being dropped.
    const derived = await awaitWithFallback(neverSettlingWrite, 20, []);
    const { storageIds } = await materializeBundleImages(true, images, store);

    expect(derived).toEqual([]);
    expect(storageIds).toEqual(['session_x_img_1']);
    expect(store).toHaveBeenCalledTimes(1);
  });
});
