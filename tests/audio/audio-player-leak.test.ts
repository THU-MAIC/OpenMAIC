import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the IndexedDB layer so importing AudioPlayer doesn't pull in Dexie.
const getMock = vi.fn();
vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { get: getMock } },
}));

/** Stub URL.createObjectURL/revokeObjectURL while keeping `new URL(...)` working. */
function stubObjectUrl() {
  const createObjectURL = vi.fn(() => 'blob:fake-url');
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
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });

  it('does not revoke during a successful play() (revocation is deferred to "ended")', async () => {
    const { revokeObjectURL } = stubObjectUrl();
    stubAudio(() => Promise.resolve());

    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    await expect(new AudioPlayer().play('audio-1')).resolves.toBe(true);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
