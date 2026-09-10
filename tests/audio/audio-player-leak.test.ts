import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the IndexedDB layer so importing AudioPlayer doesn't pull in Dexie.
const getMock = vi.fn();
vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { get: getMock } },
}));

/** Stub URL.createObjectURL/revokeObjectURL while keeping `new URL(...)` working. */
function stubObjectUrl() {
  let next = 0;
  const createObjectURL = vi.fn(() => `blob:fake-url-${++next}`);
  const revokeObjectURL = vi.fn();
  class URLStub extends URL {}
  Object.assign(URLStub, { createObjectURL, revokeObjectURL });
  vi.stubGlobal('URL', URLStub);
  return { createObjectURL, revokeObjectURL };
}

function stubAudio(play: () => Promise<void>) {
  class AudioStub {
    play = play;
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

describe('AudioPlayer blob URL lifecycle', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    getMock.mockReset();
    getMock.mockResolvedValue({ blob: new Blob(['audio']) });
  });

  it('revokes the blob URL when play() rejects (no leak)', async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrl();
    stubAudio(() => Promise.reject(new Error('NotAllowedError')));

    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    await expect(new AudioPlayer().play('audio-1')).rejects.toThrow();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url-1');
  });

  it('does not revoke during a successful play() (revocation is deferred to "ended")', async () => {
    const { revokeObjectURL } = stubObjectUrl();
    stubAudio(() => Promise.resolve());

    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    await expect(new AudioPlayer().play('audio-1')).resolves.toBe(true);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the blob URL when playback is stopped before it ends', async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrl();
    stubAudio(() => Promise.resolve());

    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    const player = new AudioPlayer();
    await expect(player.play('audio-1')).resolves.toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    player.stop();

    // The fetched narration is released with the dropped element instead of
    // leaking for the page lifetime.
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:fake-url-1');
  });

  it('revokes the previous blob URL when playback is replaced', async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrl();
    stubAudio(() => Promise.resolve());

    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    const player = new AudioPlayer();
    await player.play('audio-1');
    await player.play('audio-2');

    expect(createObjectURL).toHaveBeenCalledTimes(2);
    // The first narration's URL was released when the second replaced it.
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:fake-url-1');
  });

  it('does not revoke on pause (playback can resume from the same element)', async () => {
    const { revokeObjectURL } = stubObjectUrl();
    stubAudio(() => Promise.resolve());

    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    const player = new AudioPlayer();
    await player.play('audio-1');
    player.pause();

    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes through destroy(), which stops playback', async () => {
    const { revokeObjectURL } = stubObjectUrl();
    stubAudio(() => Promise.resolve());

    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    const player = new AudioPlayer();
    await player.play('audio-1');
    player.destroy();

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:fake-url-1');
  });
});
