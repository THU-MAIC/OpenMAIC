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

describe('primeDiscussionAudioElement', () => {
  afterEach(() => {
    resetDiscussionAudioElementForTests();
    vi.unstubAllGlobals();
    FakeAudio.instances = [];
  });

  it('unlocks the shared element during the call and leaves it idle', () => {
    vi.stubGlobal('Audio', FakeAudio);
    expect(FakeAudio.instances).toHaveLength(0);

    primeDiscussionAudioElement();

    expect(FakeAudio.instances).toHaveLength(1);
    const audio = FakeAudio.instances[0];
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.playedMuted).toBe(true);
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.muted).toBe(false);
    expect(audio.src).toBe('');
    expect(audio.paused).toBe(true);
    expect(getDiscussionAudioElement()).toBe(audio);
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
