import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionEngine } from '@/lib/action/engine';
import { PlaybackEngine } from '@/lib/playback/engine';
import { useStageStore } from '@/lib/store/stage';
import { AudioPlayer } from '@/lib/utils/audio-player';
import type { Scene } from '@/lib/types/stage';

vi.mock('@/lib/media/resolve-audio-bytes', () => ({
  resolveAudioBlob: vi.fn(async () => new Blob(['audio'], { type: 'audio/mpeg' })),
}));

class AudioStub {
  src = '';
  paused = true;
  currentTime = 0;
  volume = 1;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  onended: (() => void) | null = null;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  load() {}
}

const instances: AudioStub[] = [];
let playbackFailure: DOMException | null = null;

beforeEach(() => {
  instances.length = 0;
  playbackFailure = null;
  vi.stubGlobal(
    'Audio',
    class extends AudioStub {
      constructor() {
        super();
        if (playbackFailure) this.play.mockRejectedValueOnce(playbackFailure);
        instances.push(this);
      }
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function refusePlayback(name: string) {
  playbackFailure = new DOMException('Cannot play narration', name);
}

describe('failed narration recovery', () => {
  it.each(['NotAllowedError', 'NotSupportedError'])(
    'releases a %s failure so it cannot be resumed and the next line can play',
    async (name) => {
      refusePlayback(name);
      const player = new AudioPlayer();
      try {
        await expect(player.play('audio-1')).rejects.toMatchObject({ name });
        expect(player.hasActiveAudio()).toBe(false);
        player.resume();
        expect(instances[0].play).toHaveBeenCalledTimes(1);

        await expect(player.play('audio-2')).resolves.toBe(true);
        expect(player.hasActiveAudio()).toBe(true);
        expect(instances).toHaveLength(1);
        player.pause();
        player.resume();
        expect(instances[0].play).toHaveBeenCalledTimes(3);
      } finally {
        player.destroy();
      }
    },
  );

  it('does not clear a replacement line when an earlier play rejects late', async () => {
    const firstPlay = Promise.withResolvers<void>();
    const player = new AudioPlayer();
    // Prime the reusable element, then keep the next play pending.
    await player.play('audio-0');
    instances[0].play.mockImplementationOnce(() => firstPlay.promise);
    const first = player.play('audio-1');
    const rejected = expect(first).rejects.toThrow('superseded');
    await vi.waitFor(() => expect(instances[0].play).toHaveBeenCalledTimes(2));
    await player.play('audio-2');
    const replacementSource = instances[0].src;

    firstPlay.reject(new Error('superseded'));
    await rejected;
    expect(player.hasActiveAudio()).toBe(true);
    expect(instances[0].src).toBe(replacementSource);
    expect(instances[0].paused).toBe(false);
    player.destroy();
  });

  it('releases a pending play that fails after the user pauses', async () => {
    const pendingPlay = Promise.withResolvers<void>();
    const player = new AudioPlayer();
    await player.play('audio-0');
    instances[0].play.mockImplementationOnce(() => pendingPlay.promise);
    const playing = player.play('audio-1');
    const rejected = expect(playing).rejects.toThrow('decode error');
    await vi.waitFor(() => expect(instances[0].play).toHaveBeenCalledTimes(2));

    player.pause();
    pendingPlay.reject(new Error('decode error'));
    await rejected;
    expect(player.hasActiveAudio()).toBe(false);
    player.resume();
    expect(instances[0].play).toHaveBeenCalledTimes(2);
    player.destroy();
  });

  it('finishes the reading fallback after pause and resume when narration is refused', async () => {
    vi.useFakeTimers();
    refusePlayback('NotAllowedError');
    const player = new AudioPlayer();
    const onComplete = vi.fn();
    const onSpeechEnd = vi.fn();
    const lesson: Scene = {
      id: 'scene-1',
      stageId: 'stage-1',
      title: 'Narration recovery',
      order: 1,
      type: 'quiz',
      content: { type: 'quiz', questions: [] },
      actions: [{ id: 'speech-1', type: 'speech', text: 'Hello.', audioId: 'audio-1' }],
    };
    const engine = new PlaybackEngine([lesson], new ActionEngine(useStageStore, player), player, {
      onComplete,
      onSpeechEnd,
    });
    try {
      engine.start();
      await vi.advanceTimersByTimeAsync(500);
      engine.pause();
      await vi.advanceTimersByTimeAsync(5000);
      expect(onComplete).not.toHaveBeenCalled();

      engine.resume();
      await vi.advanceTimersByTimeAsync(1499);
      expect(onComplete).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onSpeechEnd).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(engine.getMode()).toBe('idle');
    } finally {
      engine.stop();
      player.destroy();
    }
  });
});
