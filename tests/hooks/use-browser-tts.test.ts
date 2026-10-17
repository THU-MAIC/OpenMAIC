// @vitest-environment jsdom
/**
 * A missing voice URI must set utterance.voice to the same lang match the
 * roster reserves, instead of leaving the pick to the user agent.
 */
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useBrowserTTS } from '@/lib/hooks/use-browser-tts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FakeVoice = {
  voiceURI: string;
  name: string;
  lang: string;
  default: boolean;
  localService: boolean;
};

type FakeUtterance = {
  text: string;
  rate: number;
  pitch: number;
  volume: number;
  lang: string;
  voice: FakeVoice | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onpause: (() => void) | null;
  onresume: (() => void) | null;
};

const voices: FakeVoice[] = [
  { voiceURI: 'uri-david', name: 'David', lang: 'en-US', default: true, localService: true },
  { voiceURI: 'uri-xiaoxiao', name: 'Xiaoxiao', lang: 'zh-CN', default: false, localService: true },
  { voiceURI: 'uri-zira', name: 'Zira', lang: 'en-GB', default: false, localService: true },
];

let spoken: FakeUtterance | null = null;

class FakeUtteranceImpl implements FakeUtterance {
  rate = 1;
  pitch = 1;
  volume = 1;
  lang = '';
  voice: FakeVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onpause: (() => void) | null = null;
  onresume: (() => void) | null = null;

  constructor(public text: string) {}
}

const synth = {
  getVoices: () => voices,
  cancel: () => {},
  speak: (utterance: FakeUtterance) => {
    spoken = utterance;
  },
  pause: () => {},
  resume: () => {},
  onvoiceschanged: null as null | (() => void),
};

afterEach(() => {
  spoken = null;
  vi.unstubAllGlobals();
});

describe('useBrowserTTS speak', () => {
  it('sets utterance.voice to the zh-CN voice when the URI is the default sentinel', async () => {
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtteranceImpl);
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });

    const handle: { current?: ReturnType<typeof useBrowserTTS> } = {};
    function Probe({ onReady }: { onReady: (api: ReturnType<typeof useBrowserTTS>) => void }) {
      const tts = useBrowserTTS();
      useEffect(() => {
        onReady(tts);
      });
      return null;
    }

    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Probe, { onReady: (api) => (handle.current = api) }));
    });
    await act(async () => {
      handle.current!.speak('你好', 'default');
    });

    expect(spoken?.lang).toBe('zh-CN');
    expect(spoken?.voice?.voiceURI).toBe('uri-xiaoxiao');

    await act(async () => root.unmount());
  });

  it('sets utterance.voice to that same zh-CN voice when the URI is not installed', async () => {
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtteranceImpl);
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });

    const handle: { current?: ReturnType<typeof useBrowserTTS> } = {};
    function Probe({ onReady }: { onReady: (api: ReturnType<typeof useBrowserTTS>) => void }) {
      const tts = useBrowserTTS();
      useEffect(() => {
        onReady(tts);
      });
      return null;
    }

    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Probe, { onReady: (api) => (handle.current = api) }));
    });
    await act(async () => {
      handle.current!.speak('你好', 'com.apple.voice.compact.gone');
    });

    expect(spoken?.voice?.voiceURI).toBe('uri-xiaoxiao');

    await act(async () => root.unmount());
  });

  it('keeps an in-list voiceURI on the utterance', async () => {
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtteranceImpl);
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });

    const handle: { current?: ReturnType<typeof useBrowserTTS> } = {};
    function Probe({ onReady }: { onReady: (api: ReturnType<typeof useBrowserTTS>) => void }) {
      const tts = useBrowserTTS();
      useEffect(() => {
        onReady(tts);
      });
      return null;
    }

    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Probe, { onReady: (api) => (handle.current = api) }));
    });
    await act(async () => {
      handle.current!.speak('hello', 'uri-david');
    });

    expect(spoken?.voice?.voiceURI).toBe('uri-david');

    await act(async () => root.unmount());
  });
});
