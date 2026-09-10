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

  /**
   * Gating's headline promise is that an in-flight regeneration suppresses
   * stale bytes at EVERY level, not only at the final one -- otherwise an
   * export ships media the classroom no longer shows.
   */
  it('suppresses stale pool and row bytes while a regeneration is in flight', async () => {
    mocks.getState.mockReturnValue({
      tasks: { ast_img_1: { status: 'generating', stageId: 'stage-1' } },
    });
    mocks.withAssetUrl.mockImplementation(
      async (_ref: string, use: (url: string | null) => Promise<Blob | null>) =>
        use('blob:pool-stale'),
    );
    mocks.mediaGet.mockResolvedValue({
      id: 'stage-1:ast_img_1',
      blob: new Blob(['row-stale']),
    } as MediaFileRecord);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['stale']))),
    );

    expect(
      await resolveStoredBytes('ast_img_1', {
        stageId: 'stage-1',
        loadCompatRow: true,
        resolutionGating: true,
        fetchPolicy: STRICT,
      }),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  /**
   * Documents the pool level's unconditional branch: with gating off the
   * caller gets pool bytes even while a regeneration is in flight. This one is
   * NOT a regression sentinel for the task/gate separation -- the pool level
   * branches on the option, never on the gate, so it survives that mutation.
   * The compatibility-row case below is the discriminator.
   */
  it('accepts pool bytes with gating off even while a task is generating', async () => {
    mocks.getState.mockReturnValue({ tasks: { ast_img_1: { status: 'generating' } } });
    mocks.withAssetUrl.mockImplementation(
      async (_ref: string, use: (url: string | null) => Promise<Blob | null>) =>
        use('blob:pool-current'),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['pool-bytes']))),
    );

    const bytes = await resolveStoredBytes('ast_img_1', {
      taskUrlFallback: true,
      resolutionGating: false,
      fetchPolicy: STRICT,
    });

    expect(await bytes?.text()).toBe('pool-bytes');
  });

  /**
   * The discriminating case for keeping `gate` separate from `task`: the
   * compatibility level's acceptance check is the only place the gate is read
   * once the pool has been consulted, so a task leaking into it would suppress
   * a row the caller asked for unconditionally.
   */
  it('accepts the compatibility row with gating off while a task is generating', async () => {
    mocks.getState.mockReturnValue({
      tasks: { ast_img_1: { status: 'generating', stageId: 'stage-1' } },
    });
    mocks.mediaGet.mockResolvedValue({
      id: 'stage-1:ast_img_1',
      blob: new Blob(['row-bytes']),
    } as MediaFileRecord);

    const bytes = await resolveStoredBytes('ast_img_1', {
      stageId: 'stage-1',
      loadCompatRow: true,
      taskUrlFallback: true,
      resolutionGating: false,
      fetchPolicy: STRICT,
    });

    expect(await bytes?.text()).toBe('row-bytes');
  });

  /** A row evicted under storage pressure keeps its CDN copy as the byte source. */
  it('falls through a zero-length row blob to the CDN source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['cdn-bytes']))),
    );

    const record = {
      id: 'stage-1:ast_img_1',
      blob: new Blob([]),
      ossKey: 'https://cdn.example.com/evicted.png',
    } as unknown as MediaFileRecord;

    const bytes = await resolveStoredBytes('ast_img_1', {
      stageId: 'stage-1',
      record,
      compatRowCdnFallback: true,
      fetchPolicy: STRICT,
    });

    expect(await bytes?.text()).toBe('cdn-bytes');
    expect(fetch).toHaveBeenCalledWith('https://cdn.example.com/evicted.png');
  });

  /** The CDN level stays unreachable for a caller that did not enable it. */
  it('never reaches the CDN source when the fallback is off', async () => {
    mocks.getState.mockReturnValue({
      tasks: {
        ast_img_1: {
          status: 'done',
          objectUrl: 'https://cdn.example.com/task.png',
          stageId: 'stage-1',
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['task-bytes']))),
    );

    const record = {
      id: 'stage-1:ast_img_1',
      blob: new Blob([]),
      ossKey: 'https://cdn.example.com/evicted.png',
    } as unknown as MediaFileRecord;

    const bytes = await resolveStoredBytes('ast_img_1', {
      stageId: 'stage-1',
      record,
      taskUrlFallback: true,
      fetchPolicy: STRICT,
    });

    expect(await bytes?.text()).toBe('task-bytes');
    expect(fetch).not.toHaveBeenCalledWith('https://cdn.example.com/evicted.png');
  });

  /**
   * A supplied row's compound id authoritatively names the document ref, so
   * every level must resolve for that ref rather than the one the caller
   * happened to pass.
   */
  it("derives the effective ref from a supplied row's compound id", async () => {
    const record = {
      id: 'stage-1:gen_img_7',
      blob: new Blob(['row-bytes']),
    } as unknown as MediaFileRecord;

    const bytes = await resolveStoredBytes('caller-supplied-ref', {
      stageId: 'stage-1',
      record,
      fetchPolicy: STRICT,
    });

    expect(await bytes?.text()).toBe('row-bytes');
    expect(mocks.withAssetUrl).toHaveBeenCalledWith('gen_img_7', expect.any(Function));
  });

  /**
   * The pre-refactor video path decided whether a SUPPLIED row was usable
   * before it awaited the pool. The row is a live object, so taking that
   * verdict after the await would let an `error` landing mid-lookup change
   * which bytes the export ships.
   */
  it("takes a supplied row's error verdict before the pool lookup", async () => {
    const record = {
      id: 'stage-1:ast_img_1',
      blob: new Blob(['row-bytes']),
    } as unknown as MediaFileRecord;
    mocks.withAssetUrl.mockImplementation(
      async (_ref: string, use: (url: string | null) => Promise<Blob | null>) => {
        (record as { error?: string }).error = 'MEDIA_TASK_FAILED';
        return use(null);
      },
    );

    const bytes = await resolveStoredBytes('ast_img_1', {
      stageId: 'stage-1',
      record,
      fetchPolicy: STRICT,
    });

    expect(await bytes?.text()).toBe('row-bytes');
  });

  /** The same snapshot in the other direction: a clear mid-lookup is ignored too. */
  it('keeps an errored supplied row excluded when the flag clears mid-lookup', async () => {
    const record = {
      id: 'stage-1:ast_img_1',
      blob: new Blob(['row-bytes']),
      error: 'MEDIA_TASK_FAILED',
    } as unknown as MediaFileRecord;
    mocks.withAssetUrl.mockImplementation(
      async (_ref: string, use: (url: string | null) => Promise<Blob | null>) => {
        delete (record as { error?: string }).error;
        return use(null);
      },
    );

    expect(
      await resolveStoredBytes('ast_img_1', {
        stageId: 'stage-1',
        record,
        fetchPolicy: STRICT,
      }),
    ).toBeNull();
  });
});
