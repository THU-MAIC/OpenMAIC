import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  audioGet: vi.fn(),
  poolResolve: vi.fn(),
  poolRelease: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { get: mocks.audioGet } },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  getAssetPool: () => ({ resolve: mocks.poolResolve, release: mocks.poolRelease }),
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
    mocks.audioGet.mockResolvedValue({ id: 'ast_voice', blob: new Blob(['stale']) });
    mocks.poolResolve.mockResolvedValue('blob:pool-audio');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['current']))),
    );

    expect(await (await resolveAudioBlob('ast_voice'))?.text()).toBe('current');
    expect(mocks.poolRelease).toHaveBeenCalled();
  });

  it('falls back to the stored row for legacy and imported audio', async () => {
    mocks.audioGet.mockResolvedValue({ id: 'tts_s1_legacy', blob: new Blob(['legacy']) });

    expect(await (await resolveAudioBlob('tts_s1_legacy'))?.text()).toBe('legacy');
  });

  it('returns null when neither store has bytes', async () => {
    expect(await resolveAudioBlob('ast_missing')).toBeNull();
  });

  it('does not consult the pool for a concrete address', async () => {
    mocks.audioGet.mockResolvedValue({ id: 'https://cdn/a.mp3', blob: new Blob(['served']) });

    expect(await (await resolveAudioBlob('https://cdn/a.mp3'))?.text()).toBe('served');
    expect(mocks.poolResolve).not.toHaveBeenCalled();
  });
});
