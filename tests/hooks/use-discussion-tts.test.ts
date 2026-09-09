// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { UseBrowserTTSOptions } from '@/lib/hooks/use-browser-tts';

const mocks = vi.hoisted(() => ({
  settings: {
    ttsProvidersConfig: {
      'openai-tts': { enabled: true, apiKey: 'test-key', modelId: 'tts-1' },
      'browser-native-tts': { enabled: true },
      'qwen-tts': { enabled: true, apiKey: 'test-key' },
    },
    ttsProviderId: 'openai-tts',
    ttsVoice: 'alloy',
    ttsSpeed: 1,
    ttsMuted: false,
    ttsVolume: 0.7,
    playbackSpeed: 1,
    agentVoiceOverrides: {},
  },
  browserOptions: {} as UseBrowserTTSOptions,
  speak: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  voiceOptions: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (selector: (state: typeof mocks.settings) => unknown) =>
    selector(mocks.settings),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
vi.mock('@/lib/audio/voxcpm-voices', () => ({
  useAllVoiceProfiles: () => ({ profiles: [] }),
}));
vi.mock('@/lib/audio/agent-voice', () => ({
  resolveAgentVoiceOptions: mocks.voiceOptions,
}));
vi.mock('sonner', () => ({ toast: { warning: mocks.warning } }));
vi.mock('@/lib/hooks/use-browser-tts', () => ({
  useBrowserTTS: (options: UseBrowserTTSOptions) => {
    mocks.browserOptions = options;
    return {
      speak: mocks.speak,
      pause: mocks.pause,
      resume: mocks.resume,
      cancel: mocks.cancel,
    };
  },
}));

import { useDiscussionTTS } from '@/lib/hooks/use-discussion-tts';
import { clearUnavailableVoiceBindingsForTests } from '@/lib/audio/unavailable-voice-bindings';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  playbackRate = 1;
  volume = 1;
  paused = true;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });

  constructor(public src: string) {
    super();
    FakeAudio.instances.push(this);
  }

  end() {
    this.paused = true;
    this.dispatchEvent(new Event('ended'));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const teacher = {
  id: 'teacher',
  role: 'teacher',
  voiceConfig: { providerId: 'openai-tts', modelId: 'tts-1', voiceId: 'alloy' },
} as AgentConfig;

let root: Root;
let hook: ReturnType<typeof useDiscussionTTS>;
let enabled: boolean;
let agents: AgentConfig[];
const stateChange = vi.fn();
const requests: Array<{
  body: Record<string, unknown>;
  signal: AbortSignal;
  response: ReturnType<typeof deferred<Response>>;
}> = [];

function Probe() {
  const result = useDiscussionTTS({ enabled, agents, onAudioStateChange: stateChange });
  useEffect(() => {
    hook = result;
  });
  return null;
}

async function seal(partId: string, agentId = 'teacher') {
  await act(async () =>
    hook.handleSegmentSealed('message', partId, `Sentence ${partId}.`, agentId),
  );
}

async function respond(index: number, body = { base64: btoa(`audio-${index}`), format: 'mp3' }) {
  await act(async () => requests[index].response.resolve(Response.json(body)));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearUnavailableVoiceBindingsForTests();
  mocks.voiceOptions.mockResolvedValue(undefined);
  mocks.settings.ttsMuted = false;
  mocks.settings.ttsVolume = 0.7;
  mocks.settings.playbackSpeed = 1;
  requests.length = 0;
  FakeAudio.instances = [];
  enabled = true;
  agents = [teacher];
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      const response = deferred<Response>();
      requests.push({
        body: JSON.parse(init.body as string),
        signal: init.signal as AbortSignal,
        response,
      });
      return response.promise;
    }),
  );
  root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('discussion TTS synthesis lookahead', () => {
  it('requests B during A playback and consumes the prepared result exactly once', async () => {
    await seal('A');
    await seal('B');
    expect(requests.map((r) => r.body.audioId)).toEqual(['A']);
    await respond(0);

    expect(FakeAudio.instances[0].paused).toBe(false);
    expect(requests.map((r) => r.body.audioId)).toEqual(['A', 'B']);
    await respond(1);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(stateChange).toHaveBeenLastCalledWith('teacher', 'playing');

    await act(async () => FakeAudio.instances[0].end());
    expect(requests).toHaveLength(2);
    expect(FakeAudio.instances[1].src).toContain(btoa('audio-1'));
    expect(FakeAudio.instances[1].play).toHaveBeenCalledOnce();
    expect(hook.shouldHold()).toEqual({ holding: true, segmentDone: 1 });
    await act(async () => FakeAudio.instances[1].end());
    expect(hook.shouldHold()).toEqual({ holding: false, segmentDone: 2 });
  });

  it('limits lookahead to one queued segment, including text arriving during playback', async () => {
    await seal('A');
    await respond(0);
    await seal('B');
    await seal('C');
    await seal('D');
    expect(requests.map((r) => r.body.audioId)).toEqual(['A', 'B']);
    await respond(1);
    expect(requests).toHaveLength(2);

    await act(async () => FakeAudio.instances[0].end());
    expect(requests.map((r) => r.body.audioId)).toEqual(['A', 'B', 'C']);
    expect(FakeAudio.instances).toHaveLength(2);
  });

  it('ignores an old response after cleanup, even if the transport ignores abort', async () => {
    await seal('A');
    act(() => hook.cleanup());
    expect(requests[0].signal.aborted).toBe(true);
    await seal('new');
    await respond(0);
    expect(FakeAudio.instances).toHaveLength(0);
    expect(hook.shouldHold()).toEqual({ holding: true, segmentDone: 0 });
    await respond(1);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].src).toContain(btoa('audio-1'));
  });

  it('waits for an unfinished prefetch without duplicate requests or concurrent playback', async () => {
    await seal('A');
    await seal('B');
    await seal('C');
    await respond(0);
    await act(async () => FakeAudio.instances[0].end());
    expect(requests).toHaveLength(2);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(stateChange).toHaveBeenLastCalledWith('teacher', 'generating');
    await respond(1);
    expect(FakeAudio.instances[1].play).toHaveBeenCalledOnce();
    expect(requests.map((r) => r.body.audioId)).toEqual(['A', 'B', 'C']);
  });

  it('keeps generated audio paused and resumes playback and lookahead exactly once', async () => {
    await seal('A');
    await seal('B');
    act(() => hook.pause());
    await respond(0);
    expect(FakeAudio.instances[0].play).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);

    await act(async () => {
      hook.resume();
      hook.resume();
    });
    expect(FakeAudio.instances[0].play).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    act(() => hook.pause());
    await respond(1);
    await act(async () => FakeAudio.instances[0].end());
    expect(FakeAudio.instances).toHaveLength(1);
    await act(async () => hook.resume());
    expect(FakeAudio.instances[1].play).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
  });

  it('aborts lookahead on cleanup and ignores stale audio events and failures', async () => {
    await seal('A');
    await seal('B');
    await respond(0);
    const oldAudio = FakeAudio.instances[0];
    act(() => hook.cleanup());
    expect(requests[1].signal.aborted).toBe(true);
    expect(oldAudio.paused).toBe(true);
    expect(oldAudio.src).toBe('');
    await seal('new');
    await respond(2);
    await act(async () => {
      requests[1].response.reject(new Error('late failure'));
      oldAudio.end();
      oldAudio.dispatchEvent(new Event('error'));
    });
    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[1].paused).toBe(false);
    expect(hook.shouldHold()).toEqual({ holding: true, segmentDone: 0 });
  });

  it.each(['disable', 'unmount'])('cancels speculative work on %s', async (change) => {
    await seal('A');
    await seal('B');
    await respond(0);
    act(() => {
      if (change === 'unmount') root.unmount();
      else {
        enabled = false;
        root.render(createElement(Probe));
      }
    });
    expect(requests[1].signal.aborted).toBe(true);
    await respond(1);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].paused).toBe(true);
    expect(hook.shouldHold()).toEqual({ holding: false, segmentDone: 0 });
  });

  it('cancels lookahead on mute while preserving the current clip for unmute', async () => {
    await seal('A');
    await seal('B');
    await respond(0);
    const audio = FakeAudio.instances[0];
    mocks.settings.ttsMuted = true;
    enabled = false; // The real caller also derives enabled from !ttsMuted.
    act(() => root.render(createElement(Probe)));
    expect(requests[1].signal.aborted).toBe(true);
    expect(audio.paused).toBe(false);
    expect(audio.volume).toBe(0);
    expect(hook.shouldHold()).toEqual({ holding: true, segmentDone: 0 });
    await respond(1); // A cancelled prefetch must never be consumed.
    mocks.settings.ttsMuted = false;
    enabled = true;
    await act(async () => root.render(createElement(Probe)));
    expect(audio.volume).toBe(0.7);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(requests.map((r) => r.body.audioId)).toEqual(['A', 'B', 'B']);
    await respond(2);
    await act(async () => audio.end());
    expect(FakeAudio.instances[1].src).toContain(btoa('audio-2'));
    expect(FakeAudio.instances[1].play).toHaveBeenCalledOnce();
  });

  it('does not send a request after cancellation during voice-option resolution', async () => {
    const options = deferred<undefined>();
    mocks.voiceOptions.mockReturnValueOnce(options.promise);
    await seal('A');
    act(() => hook.cleanup());
    await act(async () => options.resolve(undefined));
    expect(requests).toHaveLength(0);
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it('honors a mute applied while the current segment is still generating', async () => {
    await seal('A');
    mocks.settings.ttsMuted = true;
    enabled = false;
    act(() => root.render(createElement(Probe)));
    await respond(0);
    expect(FakeAudio.instances[0].volume).toBe(0);
    mocks.settings.ttsMuted = false;
    enabled = true;
    act(() => root.render(createElement(Probe)));
    expect(FakeAudio.instances[0].volume).toBe(0.7);
    expect(FakeAudio.instances[0].play).toHaveBeenCalledOnce();
  });

  it('handles a prefetched generation failure only at its turn and advances to C', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await seal('A');
    await seal('B');
    await seal('C');
    await respond(0);
    await act(async () =>
      requests[1].response.resolve(Response.json({ error: 'failed' }, { status: 500 })),
    );
    expect(log).not.toHaveBeenCalled();
    expect(stateChange).toHaveBeenLastCalledWith('teacher', 'playing');
    await act(async () => FakeAudio.instances[0].end());
    expect(log).toHaveBeenCalledOnce();
    expect(requests.map((r) => r.body.audioId)).toEqual(['A', 'B', 'C']);
    await respond(2);
    expect(FakeAudio.instances[1].src).toContain(btoa('audio-2'));
    expect(hook.shouldHold()).toEqual({ holding: true, segmentDone: 2 });
  });

  it('retries a missing prefetched clone with its fallback before advancing the segment counter', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    agents = [
      teacher,
      {
        ...teacher,
        id: 'clone-teacher',
        voiceConfig: { providerId: 'qwen-tts', voiceId: 'clone-missing' },
      },
    ];
    act(() => root.render(createElement(Probe)));
    await seal('A');
    await seal('B', 'clone-teacher');
    await respond(0);
    expect(requests[1].body.ttsVoice).toBe('clone-missing');
    await act(async () =>
      requests[1].response.resolve(
        Response.json(
          {
            error: 'Missing clone',
            errorCode: 'QWEN_VC_VOICE_NOT_FOUND',
          },
          { status: 404 },
        ),
      ),
    );
    expect(mocks.warning).not.toHaveBeenCalled();
    await act(async () => FakeAudio.instances[0].end());
    expect(requests.map((r) => r.body.audioId)).toEqual(['A', 'B', 'B']);
    expect(requests[2].body).toMatchObject({ ttsProviderId: 'openai-tts', ttsVoice: 'alloy' });
    expect(hook.shouldHold()).toEqual({ holding: true, segmentDone: 1 });
    expect(mocks.warning).toHaveBeenCalledOnce();
    await respond(2);
    await act(async () => FakeAudio.instances[1].end());
    expect(hook.shouldHold()).toEqual({ holding: false, segmentDone: 2 });
  });

  it('preserves browser/server ordering and resumes after browser speech ends while paused', async () => {
    agents = [
      teacher,
      {
        ...teacher,
        id: 'browser-teacher',
        voiceConfig: { providerId: 'browser-native-tts', voiceId: 'browser-voice' },
      },
    ];
    act(() => root.render(createElement(Probe)));
    await seal('A');
    await seal('B', 'browser-teacher');
    await seal('C');
    await respond(0);
    expect(requests).toHaveLength(1);
    expect(mocks.speak).not.toHaveBeenCalled();
    await act(async () => FakeAudio.instances[0].end());
    expect(mocks.speak).toHaveBeenCalledWith('Sentence B.', 'browser-voice');
    expect(requests.map((r) => r.body.audioId)).toEqual(['A', 'C']);
    act(() => hook.pause());
    expect(mocks.pause).toHaveBeenCalledOnce();
    await respond(1);
    act(() => mocks.browserOptions.onEnd?.());
    expect(FakeAudio.instances).toHaveLength(1);
    await act(async () => hook.resume());
    expect(FakeAudio.instances[1].play).toHaveBeenCalledOnce();
  });

  it('applies current playback speed and volume when consuming prepared audio', async () => {
    await seal('A');
    await seal('B');
    await respond(0);
    await respond(1);
    mocks.settings.playbackSpeed = 1.5;
    mocks.settings.ttsVolume = 0.3;
    act(() => root.render(createElement(Probe)));
    expect(FakeAudio.instances[0].playbackRate).toBe(1.5);
    await act(async () => FakeAudio.instances[0].end());
    expect(FakeAudio.instances[1].playbackRate).toBe(1.5);
    expect(FakeAudio.instances[1].volume).toBe(0.3);
  });

  it('advances once if playback errors, even if an ended event arrives afterward', async () => {
    await seal('A');
    await seal('B');
    await respond(0);
    await respond(1);
    const audio = FakeAudio.instances[0];
    await act(async () => {
      audio.dispatchEvent(new Event('error'));
      audio.end();
    });
    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[1].play).toHaveBeenCalledOnce();
    expect(hook.shouldHold()).toEqual({ holding: true, segmentDone: 1 });
  });

  it('advances after a rejected resume without leaving prepared audio stuck', async () => {
    await seal('A');
    await seal('B');
    await respond(0);
    await respond(1);
    act(() => hook.pause());
    FakeAudio.instances[0].play.mockRejectedValueOnce(new Error('play rejected'));
    await act(async () => hook.resume());
    expect(FakeAudio.instances[1].play).toHaveBeenCalledOnce();
    expect(hook.shouldHold()).toEqual({ holding: true, segmentDone: 1 });
  });
});
