// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roundtable } from '@/components/roundtable';
import { computePlaybackView } from '@/lib/playback/derived-state';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/hooks/use-audio-recorder', () => ({
  useAudioRecorder: () => ({
    isRecording: false,
    isProcessing: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
  }),
}));
vi.mock('@/lib/model-settings/use-model-settings', () => ({ useModelCapabilities: () => ({}) }));
vi.mock('@/lib/hooks/use-asr-available', () => ({ useASRAvailable: () => false }));
vi.mock('@/components/ui/avatar-display', () => ({ AvatarDisplay: () => null }));

const view = computePlaybackView({
  engineMode: 'idle',
  lectureSpeech: 'Old lecture',
  liveSpeech: null,
  speakingAgentId: null,
  thinkingState: null,
  isCueUser: true,
  isTopicPending: false,
  chatIsStreaming: false,
  discussionTrigger: null,
  playbackCompleted: false,
  idleText: 'Old intro',
  speakingStudent: false,
  sessionType: 'qa',
});

describe('Roundtable parked learner turn', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(extra = {}) {
    await act(async () =>
      root.render(
        createElement(Roundtable, {
          playbackView: view,
          isCueUser: true,
          sessionType: 'qa',
          isStreaming: false,
          cueUserPrompt: 'Which path should we explore next?',
          cueUserOptions: ['Show an example', 'Let me practice', '不用，继续课程'],
          controlsVisible: true,
          ...extra,
        }),
      ),
    );
  }

  it.each([false, true])(
    'uses the existing user bubble with small replies (presentation=%s)',
    async (isPresenting) => {
      await render({ isPresenting, onStopDiscussion: vi.fn() });
      const bubble = container.querySelector('[data-bubble-role="user"]');
      expect(bubble?.textContent).toContain('Which path should we explore next?');
      expect(bubble?.querySelectorAll('[data-testid="cue-user-options"] button')).toHaveLength(3);
      expect(container.textContent).not.toContain('Old lecture');
      expect(container.querySelector('[title="roundtable.stopDiscussion"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="cue-user-card"]')).toBeNull();
      expect(container.querySelector('[data-testid="cue-user-resume-lesson"]')).toBeNull();
    },
  );

  it('sends an ordinary reply once even on immediate repeated clicks', async () => {
    const onMessageSend = vi.fn();
    await render({ onMessageSend });
    const button = container.querySelector(
      '[data-testid="cue-user-options"] button',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    act(() => {
      button.click();
      button.click();
    });
    expect(onMessageSend).toHaveBeenCalledExactlyOnceWith('Show an example');
  });

  it.each(['不用，继续课程', 'Continue the lesson', '回到课堂'])(
    'routes %s to Stop discussion with no model send',
    async (option) => {
      const onMessageSend = vi.fn();
      const onStopDiscussion = vi.fn();
      await render({
        cueUserOptions: ['Show an example', option],
        onMessageSend,
        onStopDiscussion,
        canSendMessage: () => false,
      });
      const button = container.querySelectorAll(
        '[data-testid="cue-user-options"] button',
      )[1] as HTMLButtonElement;
      expect(button).not.toBeUndefined();
      act(() => {
        button.click();
        button.click();
      });
      expect(onStopDiscussion).toHaveBeenCalledTimes(1);
      expect(onMessageSend).not.toHaveBeenCalled();
    },
  );
});
