// @vitest-environment jsdom
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({ locale: 'de-DE' }));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: ui.locale, t: (key: string) => key }),
}));
vi.mock('@/components/ui/select', async () => {
  const { createElement: h, Fragment } = await import('react');
  type Props = { children?: ReactNode };
  return {
    Select: ({ value, children }: Props & { value: string }) =>
      h('select', { value, onChange: () => {} }, children),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: Props) => h(Fragment, null, children),
    SelectItem: ({ value, children }: Props & { value: string }) =>
      h('option', { value }, children),
  };
});

import { useAudioRecorder } from '@/lib/hooks/use-audio-recorder';
import { useBrowserASR } from '@/lib/hooks/use-browser-asr';
import { useTTSPreview } from '@/lib/audio/use-tts-preview';
import { useSettingsStore } from '@/lib/store/settings';
import { modelSettingsClient } from '@/lib/model-settings/client';
import { ASRSettings } from '@/components/settings/asr-settings';
import { modelSettingsViewFor } from '../helpers/model-settings-view';
import { workspaceProvider } from '../model-settings/fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const recognitions: FakeRecognition[] = [];
class FakeRecognition {
  lang = '';
  onend?: () => void;
  constructor() {
    recognitions.push(this);
  }
  start() {}
  stop() {
    this.onend?.();
  }
  abort() {}
}

function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (next: ReactElement) => act(() => root.render(next));
  render(element);
  return { host, render };
}

function mountHook<T>(hook: () => T) {
  let current!: T;
  function Probe() {
    current = hook();
    return null;
  }
  const mounted = mount(createElement(Probe));
  return {
    get current() {
      return current;
    },
    rerender: () => mounted.render(createElement(Probe)),
    host: mounted.host,
  };
}

beforeEach(() => {
  ui.locale = 'de-DE';
  recognitions.length = 0;
  useSettingsStore.setState({ asrLanguage: '' });
  vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  modelSettingsClient.adopt(null);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('speech consumers follow the current locale', () => {
  it('starts browser ASR in the new locale after switching the UI', async () => {
    const hook = mountHook(() => useBrowserASR());
    act(() => hook.current.startListening());
    expect(recognitions.at(-1)?.lang).toBe('de-DE');
    act(() => hook.current.stopListening());
    ui.locale = 'zh-TW';
    hook.rerender();
    act(() => hook.current.startListening());
    expect(recognitions.at(-1)?.lang).toBe('zh-TW');
    act(() => hook.current.stopListening());
    await act(async () => {
      useSettingsStore.getState().setASRLanguage('zh-CN');
    });
    act(() => hook.current.startListening());
    expect(recognitions.at(-1)?.lang).toBe('zh-CN');
  });

  it('uses the same runtime language for the classroom recorder', async () => {
    modelSettingsClient.adopt(modelSettingsViewFor({ asr: { registryId: 'browser-native' } }));
    const hook = mountHook(() => useAudioRecorder());
    await act(async () => hook.current.startRecording());
    expect(recognitions.at(-1)?.lang).toBe('de-DE');
    act(() => hook.current.stopRecording());
    ui.locale = 'zh-TW';
    hook.rerender();
    await act(async () => hook.current.startRecording());
    expect(recognitions.at(-1)?.lang).toBe('zh-TW');
    act(() => hook.current.stopRecording());
  });

  it('sends the latest provider-mapped locale when the UI changes during recording', async () => {
    modelSettingsClient.adopt(modelSettingsViewFor({ asr: { registryId: 'openai-whisper' } }));
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ text: 'Hallo' }) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    });
    const recorders: Array<{
      onstop?: () => Promise<void>;
      ondataavailable?: (event: { data: Blob }) => void;
    }> = [];
    vi.stubGlobal(
      'MediaRecorder',
      class {
        onstop?: () => Promise<void>;
        ondataavailable?: (event: { data: Blob }) => void;
        constructor() {
          recorders.push(this);
        }
        start() {}
        stop() {}
      },
    );
    const hook = mountHook(() => useAudioRecorder());
    await act(async () => hook.current.startRecording());
    ui.locale = 'zh-TW';
    hook.rerender();
    recorders[0].ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
    await act(async () => recorders[0].onstop?.());
    expect(
      (fetchMock.mock.calls[0] as unknown as [string, { body: FormData }])[1].body.get('language'),
    ).toBe('zh');
    act(() => hook.current.stopRecording());
  });

  it('uses the latest language when a settings recording is transcribed', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ text: '你好' }) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    });
    const recorders: Array<{ onstop?: () => Promise<void> }> = [];
    vi.stubGlobal(
      'MediaRecorder',
      class {
        onstop?: () => Promise<void>;
        constructor() {
          recorders.push(this);
        }
        start() {}
      },
    );
    const props = {
      view: modelSettingsViewFor({ asr: { registryId: 'openai-whisper' } }),
      entry: {
        id: 'openai-whisper',
        registryId: 'openai-whisper',
        state: 'deployment' as const,
        provider: workspaceProvider('openai-whisper'),
      },
      apply: vi.fn(),
    };
    const { host, render } = mount(createElement(ASRSettings, props));
    const recordingButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('settings.startRecording'),
    )!;
    await act(async () => recordingButton.click());
    ui.locale = 'zh-TW';
    render(createElement(ASRSettings, props));
    await act(async () => recorders[0].onstop?.());
    expect(
      (fetchMock.mock.calls[0] as unknown as [string, { body: FormData }])[1].body.get('language'),
    ).toBe('zh');
  });

  it('shows and tests the same language in ASR settings', async () => {
    const { host } = mount(
      createElement(ASRSettings, {
        view: modelSettingsViewFor({ asr: { registryId: 'browser-native' } }),
        entry: { id: 'browser-native', registryId: 'browser-native', state: 'deployment' },
        apply: vi.fn(),
      }),
    );
    expect(host.querySelector('select')?.value).toBe('de-DE');
    await act(async () => {
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('settings.startRecording'))!
        .click();
    });
    expect(recognitions.at(-1)?.lang).toBe('de-DE');
  });

  it('previews browser speech with the current UI fallback and preserves explicit voices', async () => {
    const utterances: SpeechSynthesisUtterance[] = [];
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        lang = '';
        onstart?: () => void;
        onend?: () => void;
      },
    );
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [{ voiceURI: 'english', lang: 'en-GB' }],
      cancel() {},
      speak(utterance: SpeechSynthesisUtterance) {
        utterances.push(utterance);
        (utterance.onstart as () => void)?.();
        (utterance.onend as () => void)?.();
      },
    });
    const hook = mountHook(() => useTTSPreview());
    const options = {
      text: 'Guten Morgen',
      providerId: 'browser-native-tts',
      voice: 'default',
      speed: 1,
    };
    await act(async () => hook.current.startPreview(options));
    expect(utterances.at(-1)?.lang).toBe('de-DE');
    ui.locale = 'zh-TW';
    hook.rerender();
    await act(async () => hook.current.startPreview(options));
    expect(utterances.at(-1)?.lang).toBe('zh-TW');
    await act(async () => hook.current.startPreview({ ...options, voice: 'english' }));
    expect(utterances.at(-1)?.lang).toBe('en-GB');
  });
});
