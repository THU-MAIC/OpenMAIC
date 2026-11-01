// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudioRecorder } from '@/lib/hooks/use-audio-recorder';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'en-US', t: (key: string) => key }),
}));

const capabilities = vi.hoisted(() => vi.fn());
vi.mock('@/lib/model-settings/capabilities', () => ({ loadModelCapabilities: capabilities }));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => ({ asrLanguage: 'en' }) },
  resolveASRLanguage: () => 'en',
}));
vi.mock('@/lib/audio/wav-utils', () => ({
  normalizeASRUploadAudio: async (_provider: string, blob: Blob) => ({
    blob,
    fileName: 'recording.webm',
  }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function microphone() {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}
const recorders: FakeRecorder[] = [];
class FakeRecorder {
  state: RecordingState = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: MediaStream) {
    recorders.push(this);
  }
  start = vi.fn(() => {
    this.state = 'recording';
  });
  stop = vi.fn(() => {
    this.state = 'inactive';
    queueMicrotask(() => this.onstop?.());
  });
}
let root: Root | undefined;
let recorder: ReturnType<typeof useAudioRecorder>;
const onTranscription = vi.fn();
const onError = vi.fn();
async function mount() {
  function Probe() {
    const value = useAudioRecorder({ onTranscription, onError });
    useEffect(() => {
      recorder = value;
    }, [value]);
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(Probe)));
}
async function unmount() {
  await act(async () => root?.unmount());
  root = undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  recorders.length = 0;
  capabilities.mockResolvedValue({
    asr: { registryId: 'openai-whisper', modelId: 'compatible-asr' },
  });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'hello' }) }),
  );
  onTranscription.mockClear();
  onError.mockClear();
});
afterEach(async () => {
  await unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('recorder resource lifetime', () => {
  it('stops the recorder, microphone and timer on unmount without uploading', async () => {
    const mic = microphone();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(mic.stream) },
    });
    await mount();
    await act(async () => recorder.startRecording());
    expect(recorders[0].state).toBe('recording');
    expect(vi.getTimerCount()).toBe(1);
    await unmount();
    expect(recorders[0].state).toBe('inactive');
    expect(mic.track.stop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(onTranscription).not.toHaveBeenCalled();
  });

  it('releases a microphone permission result that arrives after unmount', async () => {
    const mic = microphone();
    const permission = deferred<MediaStream>();
    const getUserMedia = vi.fn().mockReturnValue(permission.promise);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await mount();
    let task!: Promise<void>;
    await act(async () => {
      task = recorder.startRecording();
    });
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    await unmount();
    await act(async () => {
      permission.resolve(mic.stream);
      await task;
    });
    expect(mic.track.stop).toHaveBeenCalledOnce();
    expect(recorders).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not request microphone access if model settings arrive after unmount', async () => {
    const setup = deferred<{ asr: { registryId: string } }>();
    capabilities.mockReturnValue(setup.promise);
    const getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await mount();
    let task!: Promise<void>;
    await act(async () => {
      task = recorder.startRecording();
    });
    await unmount();
    await act(async () => {
      setup.resolve({ asr: { registryId: 'openai-whisper' } });
      await task;
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts native recognition and ignores already queued results on unmount', async () => {
    capabilities.mockResolvedValue({ asr: { registryId: 'browser-native' } });
    const recognitions: FakeRecognition[] = [];
    class FakeRecognition {
      onstart: (() => void) | null = null;
      onresult: ((event: unknown) => void) | null = null;
      onerror: (() => void) | null = null;
      onend: (() => void) | null = null;
      constructor() {
        recognitions.push(this);
      }
      start = vi.fn(() => this.onstart?.());
      stop = vi.fn();
      abort = vi.fn();
    }
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    await mount();
    await act(async () => recorder.startRecording());
    const recognition = recognitions[0];
    const queuedResult = recognition.onresult!;
    await unmount();
    expect(recognition.abort).toHaveBeenCalledOnce();
    queuedResult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'late' } }] });
    expect(onTranscription).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an upload on unmount and suppresses a late transcription response', async () => {
    const mic = microphone();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(mic.stream) },
    });
    const response = deferred<{ ok: boolean; json: () => Promise<{ text: string }> }>();
    vi.mocked(fetch).mockReturnValue(response.promise as Promise<Response>);
    await mount();
    await act(async () => recorder.startRecording());
    await act(async () => recorder.stopRecording());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    await unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      response.resolve({ ok: true, json: async () => ({ text: 'late' }) });
    });
    expect(onTranscription).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps a recording alive across renders and transcribes only on explicit stop', async () => {
    const mic = microphone();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(mic.stream) },
    });
    await mount();
    await act(async () => recorder.startRecording());
    act(() => vi.advanceTimersByTime(1000));
    expect(recorder.recordingTime).toBe(1);
    expect(mic.track.stop).not.toHaveBeenCalled();
    await act(async () => recorder.stopRecording());
    await vi.waitFor(() => expect(onTranscription).toHaveBeenCalledWith('hello'));
    expect(mic.track.stop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(recorder.isRecording).toBe(false);
    expect(recorder.isProcessing).toBe(false);
  });

  it('releases the microphone if MediaRecorder construction fails', async () => {
    const mic = microphone();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(mic.stream) },
    });
    vi.stubGlobal(
      'MediaRecorder',
      class {
        constructor() {
          throw new Error('unsupported format');
        }
      },
    );
    await mount();
    await act(async () => recorder.startRecording());
    expect(mic.track.stop).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels pending permission without allowing its late result to replace a newer recording', async () => {
    const oldMic = microphone();
    const newMic = microphone();
    const permission = deferred<MediaStream>();
    const getUserMedia = vi
      .fn()
      .mockReturnValueOnce(permission.promise)
      .mockResolvedValueOnce(newMic.stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await mount();
    let oldTask!: Promise<void>;
    await act(async () => {
      oldTask = recorder.startRecording();
    });
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    act(() => recorder.cancelRecording());
    await act(async () => recorder.startRecording());
    await act(async () => {
      permission.resolve(oldMic.stream);
      await oldTask;
    });
    expect(oldMic.track.stop).toHaveBeenCalledOnce();
    expect(newMic.track.stop).not.toHaveBeenCalled();
    expect(recorders).toHaveLength(1);
    expect(recorders[0].stream).toBe(newMic.stream);
    expect(recorders[0].state).toBe('recording');
    expect(vi.getTimerCount()).toBe(1);
  });
});
