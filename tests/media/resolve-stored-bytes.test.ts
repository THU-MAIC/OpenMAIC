import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mediaGet: vi.fn(),
  withAssetUrl: vi.fn(),
  getState: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => ({
  db: { mediaFiles: { get: mocks.mediaGet } },
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
}));

vi.mock('@/lib/media/use-asset-url', () => ({
  withAssetUrl: mocks.withAssetUrl,
}));

vi.mock('@/lib/store/media-generation', () => ({
  useMediaGenerationStore: { getState: mocks.getState },
}));

import { resolveStoredBytes } from '@/lib/media/resolve-stored-bytes';
import type { MediaFileRecord } from '@/lib/utils/database';

const STRICT = { requireOk: true, requireNonEmpty: true } as const;

describe('shared stored-bytes resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pool miss by default: every test below exercises a later level.
    mocks.withAssetUrl.mockImplementation(
      async (_ref: string, use: (url: string | null) => Promise<Blob | null>) => use(null),
    );
    mocks.mediaGet.mockResolvedValue(undefined);
    mocks.getState.mockReturnValue({ tasks: {} });
  });

  afterEach(() => vi.unstubAllGlobals());

  /**
   * The task is what the final level resolves its address from. Deriving the
   * lookup from `resolutionGating` alone made `taskUrlFallback` inert without
   * it -- the option would be accepted and then decide nothing.
   */
  it('resolves the task URL fallback with gating off', async () => {
    mocks.getState.mockReturnValue({
      tasks: { ast_img_1: { status: 'done', objectUrl: 'https://cdn.example.com/generated.png' } },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['generated']))),
    );

    const bytes = await resolveStoredBytes('ast_img_1', {
      taskUrlFallback: true,
      resolutionGating: false,
      fetchPolicy: STRICT,
    });

    expect(await bytes?.text()).toBe('generated');
    expect(fetch).toHaveBeenCalledWith('https://cdn.example.com/generated.png');
  });

  /** Gating still suppresses stale bytes while a regeneration is in flight. */
  it('keeps gating independent of the fallback lookup', async () => {
    mocks.getState.mockReturnValue({
      tasks: {
        ast_img_1: { status: 'generating', objectUrl: 'https://cdn.example.com/stale.png' },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['stale']))),
    );

    expect(
      await resolveStoredBytes('ast_img_1', {
        taskUrlFallback: true,
        resolutionGating: true,
        fetchPolicy: STRICT,
      }),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  /**
   * The module promises it never throws. A row that lost its blob must fall
   * through to the next byte source, the way the pre-refactor video path did.
   */
  it('falls through a compatibility row whose blob is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['cdn-bytes']))),
    );

    const record = {
      id: 'stage-1:ast_img_1',
      blob: undefined,
      ossKey: 'https://cdn.example.com/evicted.png',
    } as unknown as MediaFileRecord;

    const bytes = await resolveStoredBytes('ast_img_1', {
      stageId: 'stage-1',
      record,
      compatRowCdnFallback: true,
      fetchPolicy: STRICT,
    });

    expect(await bytes?.text()).toBe('cdn-bytes');
  });

  it('returns null rather than throwing when a blob-less row has no CDN source', async () => {
    const record = { id: 'stage-1:ast_img_1', blob: undefined } as unknown as MediaFileRecord;

    await expect(
      resolveStoredBytes('ast_img_1', {
        stageId: 'stage-1',
        record,
        compatRowCdnFallback: true,
        fetchPolicy: STRICT,
      }),
    ).resolves.toBeNull();
  });

  /**
   * The compatibility row is keyed `stageId:ref`, so the level is unreachable
   * without a stage. Pinned so the documented dependency cannot drift into a
   * silent lookup against a wrong key.
   */
  it('skips the compatibility level when loadCompatRow has no stage', async () => {
    expect(
      await resolveStoredBytes('ast_img_1', {
        loadCompatRow: true,
        fetchPolicy: STRICT,
      }),
    ).toBeNull();
    expect(mocks.mediaGet).not.toHaveBeenCalled();
  });

  it('reads the compatibility row by compound key once a stage is supplied', async () => {
    mocks.mediaGet.mockResolvedValue({
      id: 'stage-1:ast_img_1',
      blob: new Blob(['row-bytes']),
    } as MediaFileRecord);

    const bytes = await resolveStoredBytes('ast_img_1', {
      stageId: 'stage-1',
      loadCompatRow: true,
      fetchPolicy: STRICT,
    });

    expect(await bytes?.text()).toBe('row-bytes');
    expect(mocks.mediaGet).toHaveBeenCalledWith('stage-1:ast_img_1');
  });
});
