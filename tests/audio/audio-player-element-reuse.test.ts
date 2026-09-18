import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the IndexedDB layer so importing AudioPlayer doesn't pull in Dexie.
const getMock = vi.fn();
vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { get: getMock } },
}));

/** A rejection shaped like the browser's autoplay refusal. */
function notAllowed(): Error {
  return Object.assign(new Error('play() failed because the user did not interact'), {
    name: 'NotAllowedError',
  });
}

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

class AudioStub {
  play = vi.fn(async () => {});
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  volume = 1;
  muted = false;
  preload = 'auto';
  defaultPlaybackRate = 1;
  playbackRate = 1;
  currentTime = 0;
  duration = 0;
  src = '';
  paused = true;
  readyState = 0;
  onended: (() => void) | null = null;
}

/**
 * Stub Audio, tracking every element the player creates.
 *
 * `mobile` applies the autoplay policy the way a phone does: the element the
 * user's own gesture reached plays, and every element created afterwards is
 * refused — which is exactly how a player that mints an element per narration
 * line loses its voice from the second line on while the lesson keeps going.
 * `permissive` accepts every play, as a desktop browser effectively does.
 */
function stubAudio(policy: 'mobile' | 'permissive' = 'permissive') {
  const instances: AudioStub[] = [];
  class PolicyAudioStub extends AudioStub {
    constructor() {
      super();
      if (policy === 'mobile' && instances.length > 0) {
        this.play = vi.fn(async () => Promise.reject(notAllowed()));
      }
      instances.push(this);
    }
  }
  vi.stubGlobal('Audio', PolicyAudioStub);
  return { instances };
}

describe('AudioPlayer narration element', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    getMock.mockReset();
    getMock.mockResolvedValue({ blob: new Blob(['audio']) });
  });

  it('keeps narration audible after the first line, when the policy refuses new elements', async () => {
    stubObjectUrl();
    const audio = stubAudio('mobile');
    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const player = new AudioPlayer();

    // Only the first line is covered by the user's gesture; the lines after it
    // are programmatic, and they are the ones the policy used to refuse.
    await expect(player.play('audio-1')).resolves.toBe(true);
    await expect(player.play('audio-2')).resolves.toBe(true);
    await expect(player.play('audio-3')).resolves.toBe(true);

    expect(audio.instances).toHaveLength(1);
  });

  it('reuses that one element for every line', async () => {
    stubObjectUrl();
    const { instances } = stubAudio('mobile');
    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const player = new AudioPlayer();

    await player.play('audio-1');
    await player.play('audio-2');

    expect(instances).toHaveLength(1);
    expect(instances[0].play).toHaveBeenCalledTimes(2);
  });

  it('reports the end of each line through a single assigned handler', async () => {
    stubObjectUrl();
    const { instances } = stubAudio('mobile');
    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const player = new AudioPlayer();
    const onEnded = vi.fn();
    player.onEnded(onEnded);

    await player.play('audio-1');
    await player.play('audio-2');

    const element = instances[0];
    // A listener per line would accumulate on the reused element and call the
    // engine back several times for a single line.
    expect(element.addEventListener).not.toHaveBeenCalledWith('ended', expect.anything());

    element.onended?.();
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('releases the line’s state when playback is stopped', async () => {
    const { revokeObjectURL } = stubObjectUrl();
    const { instances } = stubAudio('mobile');
    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const player = new AudioPlayer();

    await player.play('audio-1');
    const element = instances[0];
    player.stop();

    expect(element.pause).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url-1');
    // The element outlives the line, so nothing of that line may outlive it too.
    expect(element.onended).toBeNull();
    expect(element.removeAttribute).toHaveBeenCalledWith('src');
    expect(element.load).toHaveBeenCalled();
  });

  it('still surfaces a failure that is not an autoplay refusal', async () => {
    stubObjectUrl();
    const { instances } = stubAudio('permissive');
    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const player = new AudioPlayer();
    await player.play('audio-1');

    instances[0].play = vi.fn(async () => Promise.reject(new Error('decode error')));

    await expect(player.play('audio-2')).rejects.toThrow('decode error');
  });
});
