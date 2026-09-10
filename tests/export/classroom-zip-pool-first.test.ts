import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetManifestEntry } from '@openmaic/dsl';

const mocks = vi.hoisted(() => ({
  rows: new Map<string, { id: string; stageId: string; blob: Blob; mimeType?: string }>(),
  poolResolve: vi.fn(),
  poolRelease: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    mediaFiles: {
      get: async (id: string) => mocks.rows.get(id),
    },
    audioFiles: { get: vi.fn() },
  },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  getAssetPool: () => ({ resolve: mocks.poolResolve, release: mocks.poolRelease }),
}));

import {
  audioArchivePath,
  collectMediaFiles,
  legacyAudioArchivePath,
  mediaArchivePath,
  mediaPosterArchivePath,
} from '@/lib/export/classroom-zip-utils';

const entry = (ref: string): AssetManifestEntry => ({ ref, kind: 'image' });

function seedRow(ref: string, blob: Blob, stageId = 'stage-1') {
  const id = `${stageId}:${ref}`;
  mocks.rows.set(id, { id, stageId, blob, mimeType: blob.type || 'image/png' });
}

describe('classroom ZIP media collection', () => {
  afterEach(() => {
    mocks.rows.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  /**
   * A same-id replacement commits pool bytes first. When the compatibility
   * write then fails (MEDIA_COMPATIBILITY_STORE_LAGGED) the document keeps the
   * same reference, so the ZIP must ship what the classroom renders.
   */
  it('prefers pool bytes over a lagging compatibility row', async () => {
    const ref = 'ast_replaced_media';
    seedRow(ref, new Blob(['stale-row-bytes'], { type: 'image/png' }));
    const poolUrl = 'blob:pool-current';
    mocks.poolResolve.mockResolvedValue(poolUrl);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input === poolUrl) return new Response(new Blob(['pool-current-bytes']));
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );

    const collected = await collectMediaFiles('stage-1', [entry(ref)]);

    expect(collected).toHaveLength(1);
    expect(await collected[0].record.blob.text()).toBe('pool-current-bytes');
    expect(mocks.poolRelease).toHaveBeenCalled();
  });

  it('falls back to the compatibility row when the pool misses', async () => {
    const ref = 'ast_pool_missing';
    seedRow(ref, new Blob(['row-bytes'], { type: 'image/png' }));
    mocks.poolResolve.mockResolvedValue(null);

    const collected = await collectMediaFiles('stage-1', [entry(ref)]);

    expect(await collected[0].record.blob.text()).toBe('row-bytes');
  });

  it('treats a zero-byte pooled answer as a miss and ships the compatibility row', async () => {
    const ref = 'ast_pool_empty';
    seedRow(ref, new Blob(['row-bytes'], { type: 'image/png' }));
    const poolUrl = 'blob:pool-empty';
    mocks.poolResolve.mockResolvedValue(poolUrl);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input === poolUrl) return new Response(new Blob([]));
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );

    const collected = await collectMediaFiles('stage-1', [entry(ref)]);

    expect(await collected[0].record.blob.text()).toBe('row-bytes');
  });

  /**
   * The ZIP predates the `response.ok` validation the other export paths
   * added, and keeps that laxity: a non-OK response carrying a body is still
   * shipped. The shared resolver expresses this through `requireOk: false`.
   */
  it('ships a non-OK pool response body, as the ZIP always has', async () => {
    const ref = 'ast_pool_error_body';
    seedRow(ref, new Blob(['row-bytes'], { type: 'image/png' }));
    const poolUrl = 'blob:pool-error';
    mocks.poolResolve.mockResolvedValue(poolUrl);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input === poolUrl) return new Response(new Blob(['error-body']), { status: 404 });
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );

    const collected = await collectMediaFiles('stage-1', [entry(ref)]);

    expect(await collected[0].record.blob.text()).toBe('error-body');
  });

  it('leaves legacy placeholder rows on their stored bytes', async () => {
    seedRow('gen_img_1', new Blob(['legacy-bytes'], { type: 'image/png' }));
    mocks.poolResolve.mockResolvedValue(null);

    const collected = await collectMediaFiles('stage-1', [entry('gen_img_1')]);

    expect(await collected[0].record.blob.text()).toBe('legacy-bytes');
    expect(collected[0].zipPath).toBe('media/asset-1.png');
  });

  it('collects a referenced asset whose bytes exist only in the pool', async () => {
    // No compatibility row (never written, or pruned): the pre-manifest scan
    // could not see this asset at all, but the document references it and the
    // pool resolves it, so the archive must carry it.
    const ref = 'ast_pool_only';
    const poolUrl = 'blob:pool-only';
    mocks.poolResolve.mockResolvedValue(poolUrl);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input === poolUrl) {
          return new Response(new Blob(['pool-only-bytes'], { type: 'image/webp' }));
        }
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );

    const collected = await collectMediaFiles('stage-1', [entry(ref)]);

    expect(collected).toHaveLength(1);
    expect(collected[0].zipPath).toBe('media/asset-1.webp');
    expect(await collected[0].record.blob.text()).toBe('pool-only-bytes');
  });

  it('skips a referenced asset whose bytes resolve nowhere', async () => {
    mocks.poolResolve.mockResolvedValue(null);

    const collected = await collectMediaFiles('stage-1', [entry('ast_nowhere')]);

    expect(collected).toEqual([]);
  });

  it('never collects rows the manifest does not name (orphan exclusion)', async () => {
    // The pre-manifest implementation scanned the whole table for the stage,
    // so this orphan row would have ridden into the archive. The manifest
    // drives collection now: a row no document reference names stays out.
    seedRow('ast_orphan', new Blob(['orphan-bytes'], { type: 'image/png' }));
    seedRow('ast_referenced', new Blob(['referenced-bytes'], { type: 'image/png' }));
    mocks.poolResolve.mockResolvedValue(null);

    const collected = await collectMediaFiles('stage-1', [entry('ast_referenced')]);

    expect(collected).toHaveLength(1);
    expect(collected[0].elementId).toBe('ast_referenced');
  });

  it('assigns distinct safe paths without interpolating adversarial source refs', async () => {
    const refs = ['../evil', 'a/b', 'a/../collision', 'collision'];
    for (const ref of refs) seedRow(ref, new Blob([ref], { type: 'image/png' }));
    mocks.poolResolve.mockResolvedValue(null);

    const collected = await collectMediaFiles('stage-1', refs.map(entry));

    expect(collected.map(({ zipPath }) => zipPath)).toEqual([
      'media/asset-1.png',
      'media/asset-2.png',
      'media/asset-3.png',
      'media/asset-4.png',
    ]);
    expect(new Set(collected.map(({ zipPath }) => zipPath)).size).toBe(refs.length);
    expect(collected.map(({ sourceRef }) => sourceRef)).toEqual(refs);
    expect(collected.every(({ zipPath }) => !zipPath.includes('..'))).toBe(true);
  });

  it.each(['/../../evil', 'png/../x', '', undefined])(
    'canonicalizes the untrusted archive extension %s at every path generator',
    (extension) => {
      expect(audioArchivePath(0, extension)).toBe('audio/audio-1.mp3');
      expect(legacyAudioArchivePath(0, extension)).toBe('audio/legacy-1.mp3');
      expect(mediaArchivePath(0, extension)).toBe('media/asset-1.jpg');
      expect(mediaPosterArchivePath(0)).toBe('media/asset-1.poster.jpg');
    },
  );

  it.each([
    ['image//../../evil', 'media/asset-1.jpg'],
    ['image/png/../x', 'media/asset-1.jpg'],
    ['', 'media/asset-1.jpg'],
    [undefined, 'media/asset-1.jpg'],
  ])('re-exports imported media MIME %s under a safe canonical path', async (mimeType, path) => {
    const ref = 'ast_imported_media';
    seedRow(ref, new Blob(['imported']), 'stage-1');
    mocks.rows.get(`stage-1:${ref}`)!.mimeType = mimeType;
    mocks.poolResolve.mockResolvedValue(null);

    const collected = await collectMediaFiles('stage-1', [entry(ref)]);

    expect(collected[0]?.zipPath).toBe(path);
    expect(collected[0]?.posterZipPath).toBe('media/asset-1.poster.jpg');
    expect(collected[0]?.zipPath).not.toMatch(/(?:\.\.|\\)/);
  });
});
