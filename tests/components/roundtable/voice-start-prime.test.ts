// @vitest-environment jsdom

/**
 * The mic click is the user gesture. Transcription calls onMessageSend only
 * after fetch resolves, so prime() has to run in the click itself. jsdom does
 * not implement an autoplay policy; this checks that call order.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prime: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  cancelRecording: vi.fn(),
  settings: {
    ttsMuted: false,
    setTTSMuted: vi.fn(),
    ttsEnabled: true,
    asrEnabled: true,
    chatAreaWidth: 360,
    ttsVolume: 1,
    setTTSVolume: vi.fn(),
    autoPlayLecture: false,
    setAutoPlayLecture: vi.fn(),
    playbackSpeed: 1,
    setPlaybackSpeed: vi.fn(),
  },
}));

vi.mock('@/lib/audio/discussion-audio', () => ({
  primeDiscussionAudioElement: mocks.prime,
}));

vi.mock('@/lib/hooks/use-audio-recorder', () => ({
  useAudioRecorder: () => ({
    isRecording: false,
    isProcessing: false,
    startRecording: mocks.startRecording,
    stopRecording: mocks.stopRecording,
    cancelRecording: mocks.cancelRecording,
  }),
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

vi.mock('@/lib/store/settings', () => ({
  PLAYBACK_SPEEDS: [0.75, 1, 1.25, 1.5, 2],
  useSettingsStore: (selector: (state: typeof mocks.settings) => unknown) =>
    selector(mocks.settings),
}));

vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ getAgent: () => undefined }) },
}));

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

vi.mock('@/components/canvas/canvas-toolbar', () => ({ CanvasToolbar: () => null }));
vi.mock('@/components/chat/proactive-card', () => ({ ProactiveCard: () => null }));
vi.mock('@/components/roundtable/presentation-speech-overlay', () => ({
  PresentationSpeechOverlay: () => null,
}));
vi.mock('@/components/ui/avatar-display', () => ({ AvatarDisplay: () => null }));
vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children?: unknown }) => children ?? null,
  HoverCardTrigger: ({ children }: { children?: unknown }) => children ?? null,
  HoverCardContent: () => null,
}));

import { Roundtable } from '@/components/roundtable';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('roundtable voice-start priming', () => {
  let root: Root;

  beforeEach(() => {
    mocks.prime.mockReset();
    mocks.startRecording.mockReset();
    mocks.stopRecording.mockReset();
    mocks.cancelRecording.mockReset();
    document.body.replaceChildren();
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it('primes inside the mic click, before startRecording and before onMessageSend', () => {
    const events: string[] = [];
    const onMessageSend = vi.fn(() => events.push('send'));
    mocks.prime.mockImplementation(() => events.push('prime'));
    mocks.startRecording.mockImplementation(() => {
      events.push('start');
      return Promise.resolve();
    });

    act(() => {
      root.render(
        createElement(Roundtable, {
          isPresenting: true,
          controlsVisible: true,
          onMessageSend,
        }),
      );
    });

    const button = document.querySelector<HTMLButtonElement>(
      '[aria-label="roundtable.voiceInput"]',
    );
    expect(button).not.toBeNull();
    act(() => {
      button!.click();
    });

    expect(events).toEqual(['prime', 'start']);
    expect(onMessageSend).not.toHaveBeenCalled();
  });
});
