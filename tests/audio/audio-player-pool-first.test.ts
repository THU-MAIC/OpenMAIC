import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { AudioPlayer } from '@/lib/utils/audio-player';

/** Captures the blob each object URL was minted from. */
function stubObjectUrl(): { sources: Blob[] } {
  const sources: Blob[] = [];
  class URLStub extends URL {}
  Object.assign(URLStub, {
    createObjectURL: vi.fn((blob: Blob) => {
      sources.push(blob);
      return `blob:audio-${sources.length}`;
    }),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal('URL', URLStub);
  return { sources };
}

function stubAudio() {
  class AudioStub {
    play = vi.fn(async () => {});
    addEventListener = vi.fn();
    pause = vi.fn();
    volume = 1;
    defaultPlaybackRate = 1;
    playbackRate = 1;
    src = '';
    currentTime = 0;
  }
  vi.stubGlobal('Audio', AudioStub);
}

describe('AudioPlayer stored-byte resolution', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    stubAudio();
  });

  /**
   * Speech regeneration replaces bytes under the same id, committing to the
   * pool first. When the compatibility write then fails, the Dexie row is
   * stale and playback must not serve the superseded narration.
   */
  it('prefers pool bytes over a lagging audio row', async () => {
    const { sources } = stubObjectUrl();
    mocks.audioGet.mockResolvedValue({ id: 'ast_voice', blob: new Blob(['stale-narration']) });
    mocks.poolResolve.mockResolvedValue('blob:pool-audio');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input === 'blob:pool-audio') return new Response(new Blob(['current-narration']));
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );

    const played = await new AudioPlayer().play('ast_voice');

    expect(played).toBe(true);
    expect(await sources[0].text()).toBe('current-narration');
    expect(mocks.poolRelease).toHaveBeenCalled();
  });

  it('falls back to the stored row when the pool has no entry', async () => {
    const { sources } = stubObjectUrl();
    mocks.audioGet.mockResolvedValue({ id: 'tts_s1_legacy', blob: new Blob(['legacy-narration']) });
    mocks.poolResolve.mockResolvedValue(null);

    const played = await new AudioPlayer().play('tts_s1_legacy');

    expect(played).toBe(true);
    expect(await sources[0].text()).toBe('legacy-narration');
  });

  it('reports no audio when neither store has bytes', async () => {
    stubObjectUrl();
    mocks.audioGet.mockResolvedValue(undefined);
    mocks.poolResolve.mockResolvedValue(null);

    expect(await new AudioPlayer().play('ast_missing')).toBe(false);
  });
});
