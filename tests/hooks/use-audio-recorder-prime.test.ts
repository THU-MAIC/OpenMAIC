// @vitest-environment jsdom

/**
 * Voice capture awaits a settings import, then transcription. The discussion
 * element has to be primed in that synchronous prefix. jsdom does not
 * implement an autoplay policy; this only checks call order.
 */
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prime: vi.fn(),
}));

vi.mock('@/lib/audio/discussion-audio', () => ({
  primeDiscussionAudioElement: mocks.prime,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: () => ({
      asrProviderId: 'browser-native',
      asrLanguage: 'en-US',
      asrProvidersConfig: { 'browser-native': {} },
    }),
  },
}));

import { useAudioRecorder } from '@/lib/hooks/use-audio-recorder';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('useAudioRecorder voice-start priming', () => {
  let root: Root;
  let startRecording: () => Promise<void>;

  function Probe() {
    const recorder = useAudioRecorder();
    useEffect(() => {
      startRecording = recorder.startRecording;
    });
    return null;
  }

  beforeEach(() => {
    mocks.prime.mockReset();
    root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it('primes synchronously, before startRecording hits its first await', () => {
    let yielded = false;
    let primeSawYield = false;
    mocks.prime.mockImplementation(() => {
      primeSawYield = yielded;
    });
    queueMicrotask(() => {
      yielded = true;
    });

    let pending!: Promise<void>;
    act(() => {
      pending = startRecording();
    });

    expect(mocks.prime).toHaveBeenCalledOnce();
    expect(primeSawYield).toBe(false);
    return act(async () => {
      await pending;
    });
  });
});
