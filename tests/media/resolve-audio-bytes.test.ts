import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  audioGet: vi.fn(),
  fetchMediaUrl: vi.fn(),
  poolResolve: vi.fn(),
  poolRelease: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { get: mocks.audioGet } },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  getAssetPool: () => ({ resolve: mocks.poolResolve, release: mocks.poolRelease }),
}));

vi.mock('@/lib/media/fetch-media-url', () => ({
  fetchMediaUrl: (...args: unknown[]) => mocks.fetchMediaUrl(...args),
}));

import { resolveAudioBlob } from '@/lib/media/resolve-audio-bytes';

describe('allocated audio byte resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audioGet.mockResolvedValue(undefined);
    mocks.poolResolve.mockResolvedValue(null);
  });

  afterEach(() => vi.unstubAllGlobals());

  /**
   * Stable-id regeneration commits pool bytes first; a failed mirror write
   * leaves the row on the superseded narration.
   */
  it('prefers pool bytes over a lagging compatibility row', async () => {
    mocks.audioGet.mockResolvedValue({
      id: 'ast_voice',
      blob: new Blob(['stale']),
      ossKey: 'https://cdn.example.com/audio/stale.mp3',
    });
    mocks.poolResolve.mockResolvedValue('blob:pool-audio');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['current']))),
    );

    expect(await (await resolveAudioBlob('ast_voice'))?.text()).toBe('current');
    expect(mocks.poolRelease).toHaveBeenCalled();
    expect(mocks.fetchMediaUrl).not.toHaveBeenCalled();
  });

  it('falls back to the stored row for legacy and imported audio', async () => {
    mocks.audioGet.mockResolvedValue({
      id: 'tts_s1_legacy',
      blob: new Blob(['legacy']),
      ossKey: 'https://cdn.example.com/audio/legacy.mp3',
    });

    expect(await (await resolveAudioBlob('tts_s1_legacy'))?.text()).toBe('legacy');
    expect(mocks.fetchMediaUrl).not.toHaveBeenCalled();
  });

  it('returns null when neither store has bytes', async () => {
    expect(await resolveAudioBlob('ast_missing')).toBeNull();
  });

  it('treats a zero-byte pooled answer as no bytes and falls back to the row', async () => {
    mocks.audioGet.mockResolvedValue({ id: 'ast_empty', blob: new Blob(['row-bytes']) });
    mocks.poolResolve.mockResolvedValue('blob:pool-empty');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob([]))),
    );

    expect(await (await resolveAudioBlob('ast_empty'))?.text()).toBe('row-bytes');
  });

  it('treats a zero-byte stored row as no bytes', async () => {
    mocks.audioGet.mockResolvedValue({ id: 'tts_empty', blob: new Blob([]) });

    expect(await resolveAudioBlob('tts_empty')).toBeNull();
  });

  it('fetches a compatibility row ossKey when its local blob is empty', async () => {
    const ossKey = 'https://cdn.example.com/audio/remote.mp3';
    mocks.audioGet.mockResolvedValue({
      id: 'ast_remote',
      blob: new Blob([]),
      ossKey,
    });
    mocks.fetchMediaUrl.mockResolvedValue(
      new Response(new Blob(['remote-bytes'], { type: 'audio/mpeg' }), { status: 200 }),
    );

    const resolved = await resolveAudioBlob('ast_remote');

    expect(mocks.fetchMediaUrl).toHaveBeenCalledWith(ossKey, 15_000);
    expect(await resolved?.text()).toBe('remote-bytes');
  });

  it.each([
    ['a failed response', new Response(null, { status: 404 })],
    ['an empty response', new Response(new Blob([]), { status: 200 })],
  ])('returns null when the compatibility ossKey yields %s', async (_case, response) => {
    mocks.audioGet.mockResolvedValue({
      id: 'ast_unusable_remote',
      blob: new Blob([]),
      ossKey: 'https://cdn.example.com/audio/unusable.mp3',
    });
    mocks.fetchMediaUrl.mockResolvedValue(response);

    expect(await resolveAudioBlob('ast_unusable_remote')).toBeNull();
  });

  it('returns null when the compatibility ossKey fetch throws', async () => {
    mocks.audioGet.mockResolvedValue({
      id: 'ast_failed_remote',
      blob: new Blob([]),
      ossKey: 'https://cdn.example.com/audio/failed.mp3',
    });
    mocks.fetchMediaUrl.mockRejectedValue(new Error('network'));

    expect(await resolveAudioBlob('ast_failed_remote')).toBeNull();
  });

  it('does not consult the pool for a concrete address', async () => {
    mocks.audioGet.mockResolvedValue({ id: 'https://cdn/a.mp3', blob: new Blob(['served']) });

    expect(await (await resolveAudioBlob('https://cdn/a.mp3'))?.text()).toBe('served');
    expect(mocks.poolResolve).not.toHaveBeenCalled();
  });
});
