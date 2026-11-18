// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'en-US', t: (key: string) => key }),
}));
vi.mock('@/lib/audio/voxcpm-voices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audio/voxcpm-voices')>()),
  useAllVoiceProfiles: () => ({ profiles: [] }),
}));

import { useBrowserTTS, type UseBrowserTTSOptions } from '@/lib/hooks/use-browser-tts';
import { useDiscussionTTS } from '@/lib/hooks/use-discussion-tts';
import { useSettingsStore } from '@/lib/store/settings';
import { modelSettingsClient } from '@/lib/model-settings/client';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { modelSettingsViewFor } from '../helpers/model-settings-view';
import { FakeSpeechSynthesis, FakeUtterance } from '../helpers/fake-speech-synthesis';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];
let synth: FakeSpeechSynthesis;

function mountHook<T>(hook: () => T) {
  let current!: T;
  function Probe() {
    current = hook();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => root.render(createElement(Probe)));
  return {
    get current() {
      return current;
    },
    unmount: () => act(() => root.unmount()),
  };
}

beforeEach(() => {
  synth = new FakeSpeechSynthesis();
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  modelSettingsClient.adopt(null);
  vi.unstubAllGlobals();
});

describe('useBrowserTTS', () => {
  function mountTTS(options: UseBrowserTTSOptions) {
    return mountHook(() => useBrowserTTS(options));
  }

  it('speaks sentence by sentence with settings read for each one', async () => {
    const onEnd = vi.fn();
    const settings = { rate: 1.5, volume: 0.5, muted: false, locale: 'en-US' };
    const hook = mountTTS({ onEnd, getSettings: () => settings });

    await expect(hook.current.speak('One. Two.', 'default')).resolves.toBe(true);
    expect(synth.last).toMatchObject({ text: 'One.', rate: 1.5, volume: 0.5 });
    settings.muted = true;
    synth.finish();
    expect(synth.last).toMatchObject({ text: 'Two.', volume: 0 });
    expect(onEnd).not.toHaveBeenCalled();
    synth.finish();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('pauses by cancelling and resumes the current sentence', async () => {
    const onEnd = vi.fn();
    const hook = mountTTS({ onEnd });
    await hook.current.speak('One. Two.');
    synth.finish();
    hook.current.pause();
    synth.finish(synth.spoken[1]);
    expect(synth.texts).toEqual(['One.', 'Two.']);
    hook.current.resume();
    expect(synth.texts).toEqual(['One.', 'Two.', 'Two.']);
    synth.finish();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('reports a failed sentence and still ends the line', async () => {
    const onEnd = vi.fn();
    const onError = vi.fn();
    const hook = mountTTS({ onEnd, onError });
    await hook.current.speak('One. Two.');
    synth.fail('synthesis-failed');
    expect(onError).toHaveBeenCalledWith('synthesis-failed');
    synth.finish();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('does not end a cancelled line, and stops speaking on unmount', async () => {
    const onEnd = vi.fn();
    const hook = mountTTS({ onEnd });
    await hook.current.speak('One. Two.');
    const stale = synth.last;
    hook.current.cancel();
    synth.finish(stale);
    expect(onEnd).not.toHaveBeenCalled();

    await hook.current.speak('Three.');
    const cancels = synth.cancelCount;
    hook.unmount();
    expect(synth.cancelCount).toBe(cancels + 1);
  });

  it('resolves false without speech synthesis', async () => {
    vi.unstubAllGlobals();
    const onEnd = vi.fn();
    const hook = mountTTS({ onEnd });
    await expect(hook.current.speak('Hello.')).resolves.toBe(false);
    expect(onEnd).not.toHaveBeenCalled();
  });
});

describe('discussion with browser speech', () => {
  const initialSettings = useSettingsStore.getState();
  afterEach(() => useSettingsStore.setState(initialSettings));

  function mountDiscussion() {
    modelSettingsClient.adopt(modelSettingsViewFor({ tts: { registryId: 'browser-native-tts' } }));
    useSettingsStore.setState({
      ttsVoice: 'default',
      ttsVoiceProviderId: 'browser-native-tts',
      ttsMuted: false,
      ttsSpeed: 1,
      ttsVolume: 1,
      playbackSpeed: 1,
    });
    const agents = [{ id: 'teacher', role: 'teacher' } as AgentConfig];
    return mountHook(() => useDiscussionTTS({ enabled: true, agents }));
  }

  it('speaks a long line sentence by sentence, then the next line', async () => {
    const hook = mountDiscussion();
    await act(async () => {
      hook.current.handleSegmentSealed(
        'm1',
        'long',
        'First part. Second part! Third part?',
        'teacher',
      );
      hook.current.handleSegmentSealed('m2', 'next', 'Next speaker.', 'teacher');
    });
    expect(synth.texts).toEqual(['First part.']);
    await act(async () => synth.finish());
    await act(async () => synth.finish());
    expect(hook.current.shouldHold()).toEqual({ holding: true, segmentDone: 0 });
    await act(async () => synth.finish());
    expect(synth.texts).toEqual(['First part.', 'Second part!', 'Third part?', 'Next speaker.']);
    expect(hook.current.shouldHold()).toEqual({ holding: true, segmentDone: 1 });
    await act(async () => synth.finish());
    expect(hook.current.shouldHold()).toEqual({ holding: false, segmentDone: 2 });
  });

  it('moves on when a sentence fails instead of stalling the queue', async () => {
    const hook = mountDiscussion();
    await act(async () => {
      hook.current.handleSegmentSealed('m1', 'a', 'Only sentence.', 'teacher');
      hook.current.handleSegmentSealed('m2', 'b', 'Next speaker.', 'teacher');
    });
    await act(async () => synth.fail('synthesis-failed'));
    expect(synth.texts).toEqual(['Only sentence.', 'Next speaker.']);
    expect(hook.current.shouldHold()).toEqual({ holding: true, segmentDone: 1 });
  });

  it('applies speed × playback speed and volume from the next sentence', async () => {
    const hook = mountDiscussion();
    await act(async () => {
      hook.current.handleSegmentSealed('m1', 'a', 'One. Two.', 'teacher');
    });
    expect(synth.last).toMatchObject({ rate: 1, volume: 1 });
    await act(async () => {
      useSettingsStore.setState({ ttsSpeed: 1.5, playbackSpeed: 2, ttsVolume: 0.25 });
    });
    expect(synth.last.rate).toBe(1);
    await act(async () => synth.finish());
    expect(synth.last).toMatchObject({ text: 'Two.', rate: 3, volume: 0.25 });
  });

  it('pauses and resumes the current sentence', async () => {
    const hook = mountDiscussion();
    await act(async () => {
      hook.current.handleSegmentSealed('m1', 'a', 'One. Two.', 'teacher');
    });
    act(() => hook.current.pause());
    expect(synth.texts).toEqual(['One.']);
    act(() => hook.current.resume());
    expect(synth.texts).toEqual(['One.', 'One.']);
  });
});
