/**
 * Stubs HTMLAudioElement to check the unlock sequence this module controls.
 * jsdom does not implement a browser autoplay policy; a pass here is not
 * device verification.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDiscussionAudioElement,
  primeDiscussionAudioElement,
  resetDiscussionAudioElementForTests,
} from '@/lib/audio/discussion-audio';

class FakeAudio {
  static instances: FakeAudio[] = [];
  muted = false;
  paused = true;
  volume = 1;
  preload = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private srcAttribute: string | null = null;
  /** Muted flag observed by play(), so a later unmute cannot hide a noisy unlock. */
  playedMuted: boolean | null = null;
  play = vi.fn(async () => {
    this.playedMuted = this.muted;
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();

  constructor() {
    FakeAudio.instances.push(this);
  }

  get src(): string {
    return this.srcAttribute ?? '';
  }

  set src(value: string) {
    this.srcAttribute = value;
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.srcAttribute = null;
  }
}

/** PCM byte length of the `data` chunk. Zero means the clip has no samples. */
function wavDataByteLength(dataUrl: string): number {
  expect(dataUrl.startsWith('data:audio/wav;base64,')).toBe(true);
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (char) =>
    char.charCodeAt(0),
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') {
      expect(bytes.length).toBeGreaterThanOrEqual(offset + 8 + size);
      return size;
    }
    offset += 8 + size;
  }
  throw new Error('WAV is missing a data chunk');
}

describe('primeDiscussionAudioElement', () => {
  afterEach(() => {
    resetDiscussionAudioElementForTests();
    vi.unstubAllGlobals();
    FakeAudio.instances = [];
  });

  it('plays a silent clip with samples, and pauses only after play() fulfills', async () => {
    vi.stubGlobal('Audio', FakeAudio);
    expect(FakeAudio.instances).toHaveLength(0);

    primeDiscussionAudioElement();

    expect(FakeAudio.instances).toHaveLength(1);
    const audio = FakeAudio.instances[0];
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.playedMuted).toBe(true);
    // Synchronous pause aborts the pending play on iOS, and load() resets
    // readyState. Neither may happen before play() settles.
    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.load).not.toHaveBeenCalled();
    expect(audio.muted).toBe(false);
    expect(wavDataByteLength(audio.src)).toBeGreaterThan(0);
    expect(getDiscussionAudioElement()).toBe(audio);

    await audio.play.mock.results[0].value;
    await Promise.resolve();
    await Promise.resolve();

    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.paused).toBe(true);
    expect(audio.load).not.toHaveBeenCalled();
    expect(wavDataByteLength(audio.src)).toBeGreaterThan(0);
  });

  it('does not pause or load-reset a real clip that replaced the silent source', async () => {
    let resolvePlay: (() => void) | undefined;
    class DeferredAudio extends FakeAudio {
      override play = vi.fn(() => {
        this.playedMuted = this.muted;
        return new Promise<void>((resolve) => {
          resolvePlay = resolve;
        });
      });
    }
    vi.stubGlobal('Audio', DeferredAudio);

    primeDiscussionAudioElement();

    const audio = DeferredAudio.instances[0];
    expect(audio.pause).not.toHaveBeenCalled();
    audio.src = 'data:audio/mp3;base64,QQ==';
    audio.paused = false;
    resolvePlay!();
    await Promise.resolve();
    await Promise.resolve();

    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.load).not.toHaveBeenCalled();
    expect(audio.src).toBe('data:audio/mp3;base64,QQ==');
    expect(audio.paused).toBe(false);
  });

  it('handles a rejected play() on the play() result and can retry', async () => {
    const caught: Array<(reason: unknown) => void> = [];
    class ThenableAudio extends FakeAudio {
      constructor() {
        super();
        // Not a Promise: records `catch` on the object play() returned.
        this.play = vi.fn(() => {
          this.playedMuted = this.muted;
          const thenable = {
            then() {
              return thenable;
            },
            catch(onRejected: (reason: unknown) => void) {
              caught.push(onRejected);
              return thenable;
            },
          };
          return thenable;
        }) as unknown as FakeAudio['play'];
      }
    }
    vi.stubGlobal('Audio', ThenableAudio);

    primeDiscussionAudioElement();

    const audio = ThenableAudio.instances[0];
    expect(caught).toHaveLength(1);
    expect(audio.load).not.toHaveBeenCalled();
    expect(audio.src).not.toBe('');

    caught[0](new Error('NotAllowedError'));

    expect(audio.src).toBe('');
    expect(audio.load).toHaveBeenCalled();

    caught.length = 0;
    audio.load.mockClear();
    primeDiscussionAudioElement();
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(caught).toHaveLength(1);
  });

  it('does not replace a line the element is already holding', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const audio = getDiscussionAudioElement() as unknown as FakeAudio;
    audio.src = 'data:audio/mp3;base64,QQ==';
    audio.paused = false;

    primeDiscussionAudioElement();

    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.src).toBe('data:audio/mp3;base64,QQ==');
    expect(audio.paused).toBe(false);
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it('does not drop a paused line that is waiting to resume', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const audio = getDiscussionAudioElement() as unknown as FakeAudio;
    audio.src = 'data:audio/mp3;base64,QQ==';
    audio.paused = true;

    primeDiscussionAudioElement();

    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.src).toBe('data:audio/mp3;base64,QQ==');
  });
});
