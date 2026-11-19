import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackEngine } from '@/lib/playback/engine';
import { BrowserSpeechPlayer } from '@/lib/audio/browser-speech-player';
import { useSettingsStore } from '@/lib/store/settings';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { ActionEngine } from '@/lib/action/engine';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import { setModelSettingsViewForTests } from '../helpers/model-settings-view';
import { FakeSpeechSynthesis } from '../helpers/fake-speech-synthesis';

function speech(id: string, text: string): Action {
  return { id, type: 'speech', text } as Action;
}

function scene(actions: Action[]): Scene {
  return { id: 'scene', stageId: 'stage', type: 'slide', order: 1, actions } as unknown as Scene;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(actions: Action[], playbackSpeed = 1) {
  const synth = new FakeSpeechSynthesis();
  const onSpeechEnd = vi.fn();
  const onComplete = vi.fn();
  const engine = new PlaybackEngine(
    [scene(actions)],
    {
      execute: vi.fn(async () => {}),
      clearEffects: vi.fn(),
      resetPlaybackVisualState: vi.fn(),
    } as unknown as ActionEngine,
    {
      play: vi.fn(async () => false),
      onEnded: vi.fn(),
      stop: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPlaying: vi.fn(() => false),
      hasActiveAudio: vi.fn(() => false),
    } as unknown as AudioPlayer,
    { onSpeechEnd, onComplete, getPlaybackSpeed: () => playbackSpeed },
    new BrowserSpeechPlayer({ synth }),
  );
  return { synth, engine, onSpeechEnd, onComplete };
}

const initialSettings = useSettingsStore.getState();

beforeEach(() => {
  setModelSettingsViewForTests({ tts: { registryId: 'browser-native-tts' } });
  useSettingsStore.setState({
    ttsVoice: 'default',
    ttsVoiceProviderId: 'browser-native-tts',
    ttsSpeed: 1,
    ttsVolume: 1,
    ttsMuted: false,
  });
});

afterEach(() => {
  setModelSettingsViewForTests(null);
  useSettingsStore.setState(initialSettings);
});

describe('classroom playback with browser speech', () => {
  it('pauses mid-line and resumes by speaking the interrupted sentence again', async () => {
    const { synth, engine, onSpeechEnd, onComplete } = setup([
      speech('a', 'One. Two.'),
      speech('b', 'Three.'),
    ]);
    engine.start();
    await flush();
    synth.finish();
    expect(synth.texts).toEqual(['One.', 'Two.']);

    engine.pause();
    expect(engine.getMode()).toBe('paused');
    synth.finish(synth.spoken[1]);
    expect(onSpeechEnd).not.toHaveBeenCalled();

    engine.resume();
    expect(synth.texts).toEqual(['One.', 'Two.', 'Two.']);
    synth.finish();
    expect(onSpeechEnd).toHaveBeenCalledOnce();
    await flush();
    expect(synth.texts.at(-1)).toBe('Three.');
    synth.finish();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('speaks a sentence again after another speech on the page interrupted it', async () => {
    const { synth, engine, onComplete } = setup([speech('a', 'One. Two.')]);
    engine.start();
    await flush();
    synth.fail('interrupted');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(synth.texts).toEqual(['One.', 'One.']);
    synth.finish();
    synth.finish();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('applies speech speed × playback speed, volume and mute per sentence', async () => {
    useSettingsStore.setState({ ttsSpeed: 1.5, ttsVolume: 0.4 });
    const { synth, engine } = setup([speech('a', 'One. Two. Three.')], 2);
    engine.start();
    await flush();
    expect(synth.last).toMatchObject({ rate: 3, volume: 0.4 });

    useSettingsStore.setState({ ttsSpeed: 10 });
    synth.finish();
    expect(synth.last.rate).toBe(10);

    useSettingsStore.setState({ ttsMuted: true });
    synth.finish();
    expect(synth.last.volume).toBe(0);
  });

  it('stops speaking and ignores the stopped line when the user interrupts', async () => {
    const { synth, engine, onSpeechEnd } = setup([speech('a', 'One. Two.')]);
    engine.start();
    await flush();
    const stale = synth.last;
    engine.handleUserInterrupt('question');
    expect(engine.getMode()).toBe('live');
    synth.finish(stale);
    expect(synth.texts).toEqual(['One.']);
    expect(onSpeechEnd).not.toHaveBeenCalled();
  });
});
