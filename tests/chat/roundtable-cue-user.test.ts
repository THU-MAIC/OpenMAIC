// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
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

describe('Roundtable suggested replies', () => {
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
  const render = async (extra: Partial<ComponentProps<typeof Roundtable>> = {}) => {
    await act(async () =>
      root.render(
        createElement(Roundtable, {
          playbackView: view,
          isCueUser: true,
          sessionType: 'qa',
          isStreaming: false,
          controlsVisible: true,
          ...extra,
        }),
      ),
    );
  };

  it.each([
    { isPresenting: false, cueUserOptions: undefined },
    { isPresenting: true, cueUserOptions: undefined },
    { isPresenting: false, cueUserOptions: [] },
    { isPresenting: true, cueUserOptions: [] },
    { isPresenting: false, cueUserOptions: ['', '   '] },
    { isPresenting: true, cueUserOptions: ['', '   '] },
  ])(
    'keeps main idle cue without bubbles when options are empty ($isPresenting, $cueUserOptions)',
    async (extra) => {
      await render(extra);
      expect(container.querySelector('[data-bubble-role]')).toBeNull();
      expect(container.querySelector('[data-testid="cue-user-options"]')).toBeNull();
      expect(container.textContent).toContain('roundtable.yourTurn');
      expect(container.textContent).not.toContain('Old lecture');
    },
  );

  it.each([false, true])(
    'shows full-label ordinary replies with hover text and deduplicates immediate clicks (fullscreen=%s)',
    async (isPresenting) => {
      const onMessageSend = vi.fn();
      const onStopDiscussion = vi.fn();
      const label = 'Back to the lesson and keep this as an ordinary user message';
      await render({
        isPresenting,
        cueUserOptions: ['Show an example', label],
        onMessageSend,
        onStopDiscussion,
      });
      const replies = container.querySelector('[data-testid="cue-user-options"]');
      expect(replies).not.toBeNull();
      expect(replies?.querySelectorAll('button')).toHaveLength(2);
      const button = replies!.querySelectorAll('button')[1] as HTMLButtonElement;
      expect(button.title).toBe(label);
      expect(button.getAttribute('aria-label')).toBe(label);
      expect(button.textContent).toBe(label);
      act(() => {
        button.click();
        button.click();
      });
      expect(onMessageSend).toHaveBeenCalledExactlyOnceWith(label);
      expect(onStopDiscussion).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'does not consume a reply rejected by the ordinary send guard (fullscreen=%s)',
    async (isPresenting) => {
      const canSendMessage = vi.fn(() => false);
      const onMessageSend = vi.fn();
      const label = 'Show an example';
      await render({
        isPresenting,
        cueUserOptions: [label, 'Keep going'],
        canSendMessage,
        onMessageSend,
      });
      const button = container.querySelector(
        '[data-testid="cue-user-options"] button',
      ) as HTMLButtonElement;
      act(() => button.click());
      expect(onMessageSend).not.toHaveBeenCalled();
      expect(button.disabled).toBe(false);
      canSendMessage.mockReturnValue(true);
      act(() => button.click());
      expect(onMessageSend).toHaveBeenCalledExactlyOnceWith(label);
    },
  );

  it.each([false, true])(
    'keeps manual input available while offering replies (fullscreen=%s)',
    async (isPresenting) => {
      await render({ isPresenting, cueUserOptions: ['Show an example', 'Keep going'] });
      const cueButton = container.querySelector(
        '[data-testid="cue-user-panel"] button',
      ) as HTMLButtonElement;
      act(() => cueButton.click());
      expect(container.querySelector('textarea')).not.toBeNull();
    },
  );

  it.each([false, true])(
    'does not show stale options after the cue ends (fullscreen=%s)',
    async (isPresenting) => {
      await render({
        isPresenting,
        isCueUser: false,
        cueUserOptions: ['Show an example', 'Keep going'],
      });
      expect(container.querySelector('[data-testid="cue-user-options"]')).toBeNull();
    },
  );

  it.each([false, true])(
    'renders replies as a suggested user bubble, not inside the centered cue (fullscreen=%s)',
    async (isPresenting) => {
      await render({ isPresenting, cueUserOptions: ['Show an example', 'Keep going'] });
      const bubble = container.querySelector('[data-testid="cue-user-suggested-bubble"]');
      const replies = container.querySelector('[data-testid="cue-user-options"]');
      expect(bubble).not.toBeNull();
      expect(bubble?.contains(replies)).toBe(true);
      expect(
        container.querySelector('[data-testid="cue-user-panel"] [data-testid="cue-user-options"]'),
      ).toBeNull();
      // Outlined "you could say" variant, never the filled "you said" bubble.
      const surface = bubble!.firstElementChild!.classList;
      expect(surface.contains('border-dashed')).toBe(true);
      expect(surface.contains('rounded-br-sm')).toBe(true);
      expect(surface.contains('bg-purple-600/95')).toBe(false);
      if (!isPresenting) expect(bubble?.getAttribute('class')).toContain('justify-end');
    },
  );

  it.each([false, true])(
    'hides the suggested bubble while the text input is open (fullscreen=%s)',
    async (isPresenting) => {
      await render({ isPresenting, cueUserOptions: ['Show an example', 'Keep going'] });
      const cueButton = container.querySelector(
        '[data-testid="cue-user-panel"] button',
      ) as HTMLButtonElement;
      act(() => cueButton.click());
      expect(container.querySelector('textarea')).not.toBeNull();
      await vi.waitFor(() =>
        expect(container.querySelector('[data-testid="cue-user-suggested-bubble"]')).toBeNull(),
      );
    },
  );

  it.each([false, true])(
    'wraps four long replies in one bounded, vertically scrolling region (fullscreen=%s)',
    async (isPresenting) => {
      const options = ['a', 'b', 'c', 'd'].map((label) => label.repeat(60));
      await render({ isPresenting, cueUserOptions: options });
      const regions = container.querySelectorAll('[data-testid="cue-user-options"]');
      expect(regions).toHaveLength(1);
      const replies = regions[0];
      expect(replies?.querySelectorAll('button')).toHaveLength(4);
      const classes = replies?.getAttribute('class') ?? '';
      expect(classes).toContain('flex-wrap');
      expect(classes).toContain('overflow-y-auto');
      expect(classes).toContain('max-h-[3.75rem]');
      for (const button of replies!.querySelectorAll('button')) {
        expect(button.getAttribute('class')).toContain('truncate');
      }
      expect(container.querySelector('[data-bubble-role]')).toBeNull();
      if (!isPresenting) {
        expect(
          container.querySelector('[data-testid="roundtable-region"]')?.getAttribute('class'),
        ).toContain('h-[192px]');
      }
    },
  );
});
