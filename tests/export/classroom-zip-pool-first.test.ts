import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; stageId: string; blob: Blob; mimeType?: string }>,
  poolResolve: vi.fn(),
  poolRelease: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    mediaFiles: {
      where: () => ({
        equals: (stageId: string) => ({
          toArray: async () => mocks.rows.filter((row) => row.stageId === stageId),
        }),
      }),
    },
    audioFiles: { get: vi.fn() },
  },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  getAssetPool: () => ({ resolve: mocks.poolResolve, release: mocks.poolRelease }),
}));

import { collectMediaFiles } from '@/lib/export/classroom-zip-utils';

describe('classroom ZIP media collection', () => {
  afterEach(() => {
    mocks.rows.length = 0;
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
    mocks.rows.push({
      id: `stage-1:${ref}`,
      stageId: 'stage-1',
      blob: new Blob(['stale-row-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
    });
    const poolUrl = 'blob:pool-current';
    mocks.poolResolve.mockResolvedValue(poolUrl);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input === poolUrl) return new Response(new Blob(['pool-current-bytes']));
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );

    const collected = await collectMediaFiles('stage-1');

    expect(collected).toHaveLength(1);
    expect(await collected[0].record.blob.text()).toBe('pool-current-bytes');
    expect(mocks.poolRelease).toHaveBeenCalled();
  });

  it('falls back to the compatibility row when the pool misses', async () => {
    const ref = 'ast_pool_missing';
    mocks.rows.push({
      id: `stage-1:${ref}`,
      stageId: 'stage-1',
      blob: new Blob(['row-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
    });
    mocks.poolResolve.mockResolvedValue(null);

    const collected = await collectMediaFiles('stage-1');

    expect(await collected[0].record.blob.text()).toBe('row-bytes');
  });

  it('leaves legacy placeholder rows on their stored bytes', async () => {
    mocks.rows.push({
      id: 'stage-1:gen_img_1',
      stageId: 'stage-1',
      blob: new Blob(['legacy-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
    });
    mocks.poolResolve.mockResolvedValue(null);

    const collected = await collectMediaFiles('stage-1');

    expect(await collected[0].record.blob.text()).toBe('legacy-bytes');
    expect(collected[0].zipPath).toBe('media/gen_img_1.png');
  });
});
