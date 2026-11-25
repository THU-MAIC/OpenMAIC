// @vitest-environment jsdom
/**
 * Voice input in the workbench composers (`WorkbenchChat`, `ProLaunchPanel`,
 * and `ComposerInputHandle.insertTranscription`):
 *  - inserts dictated text at the caret (or appends with a space when no caret
 *    has been placed yet) without ever auto-sending;
 *  - preserves inline mention chips around the insertion point;
 *  - hides the voice button when ASR is unavailable, and disables it on the
 *    exact same condition as the attach button.
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPOSER_INPUT } from './_composer-driver';

let mockAsrAvailable = true;
let lastSpeechProps: {
  onTranscription?: (text: string) => void;
  onActiveChange?: (active: boolean) => void;
  disabled?: boolean;
  hiddenWhenIdle?: boolean;
} | null = null;

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'en-US', t: (key: string) => key }),
}));
vi.mock('@/lib/hooks/use-asr-available', () => ({
  useASRAvailable: () => mockAsrAvailable,
}));
vi.mock('@/components/audio/speech-button', () => ({
  SpeechButton: (props: {
    onTranscription: (text: string) => void;
    onActiveChange?: (active: boolean) => void;
    disabled?: boolean;
    hiddenWhenIdle?: boolean;
    className?: string;
  }) => {
    lastSpeechProps = props;
    if (props.hiddenWhenIdle) return null;
    return createElement('button', {
      type: 'button',
      'data-mock-speech-button': '',
      disabled: props.disabled,
    });
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/workbench/agent-skills', () => ({
  useAgentSkills: () => ({ skills: [], loading: false, error: null, reload: async () => {} }),
  invalidateAgentSkills: async () => {},
}));
vi.mock('@/components/workbench/chat/chat-timeline', () => ({
  ChatTimeline: () => null,
}));
vi.mock('@/components/workbench/chat/autoscroll', () => ({
  useWorkbenchAutoscroll: () => ({
    scrollRef: { current: null },
    contentRef: { current: null },
    isNearBottom: true,
    scrollToBottom: async () => {},
  }),
}));

import { ComposerInput, composerInputHandleOf } from '@/components/workbench/composer-input';
import { ProLaunchPanel } from '@/components/workbench/ProLaunchPanel';
import { WorkbenchChat } from '@/components/workbench/WorkbenchChat';
import type { InlineMention } from '@/lib/workbench/composer-mentions';
import {
  WorkbenchCourseNavigationProvider,
  WorkbenchDraftConversationProvider,
} from '@/lib/workbench/panel-context';
import { useWorkbenchStore } from '@/lib/workbench/session-store';

Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const hosts: Array<{ root: Root; host: HTMLDivElement }> = [];
let posts: string[] = [];

function mountNode(node: ReturnType<typeof createElement>): HTMLDivElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  hosts.push({ root, host });
  act(() => {
    root.render(node);
  });
  return host;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  mockAsrAvailable = true;
  lastSpeechProps = null;
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push(url);
        return Response.json({ id: 'ses-1', elementRefsAccepted: true, courseRefsAccepted: true });
      }
      if (url === '/api/agent/runtime') return Response.json({ enabled: true });
      return Response.json({});
    }),
  );
  useWorkbenchStore.getState().detach();
});

afterEach(() => {
  for (const { root, host } of hosts.splice(0)) {
    act(() => {
      root.unmount();
    });
    host.remove();
  }
  vi.unstubAllGlobals();
});

describe('ComposerInputHandle.insertTranscription', () => {
  it('appends with a separating space when no caret has been placed, and inserts at caret once placed', () => {
    const mention: InlineMention = {
      label: '@Fractions',
      kind: 'course',
      id: 'stage-1',
      name: 'Fractions',
    };
    const values: string[] = [];

    function Harness() {
      const [value, setValue] = useState('@Fractions review slides');
      return createElement(ComposerInput, {
        value,
        mentions: [mention],
        onValueChange: (next) => {
          values.push(next);
          setValue(next);
        },
      });
    }

    const host = mountNode(createElement(Harness));
    const input = host.querySelector(COMPOSER_INPUT)!;
    const handle = composerInputHandleOf(input)!;

    // Never focused / no caret set yet -> appends at the end with a space, chip intact.
    act(() => {
      handle.insertTranscription('with diagrams');
    });
    expect(handle.value).toBe('@Fractions review slides with diagrams');
    expect(values.at(-1)).toBe('@Fractions review slides with diagrams');
    expect(host.querySelectorAll('[data-chip="course"]')).toHaveLength(1);

    // Place caret mid-sentence (after "@Fractions review") and dictate again.
    act(() => {
      handle.setSelectionRange('@Fractions review'.length, '@Fractions review'.length);
    });
    act(() => {
      handle.insertTranscription('all');
    });
    expect(handle.value).toBe('@Fractions review all slides with diagrams');
    expect(host.querySelectorAll('[data-chip="course"]')).toHaveLength(1);
  });
});

describe('WorkbenchChat and ProLaunchPanel voice input wiring', () => {
  it('hides the voice button in both composers when ASR is unavailable', () => {
    mockAsrAvailable = false;
    useWorkbenchStore.getState().attach('ses-1', 'stage-1');
    useWorkbenchStore.setState({ replaying: false, status: 'succeeded' });

    const chatHost = mountNode(
      createElement(
        WorkbenchCourseNavigationProvider,
        {
          navigation: {
            activeCourseId: null,
            courseOptions: [],
            openCourse: () => {},
            lookupCourse: () => null,
          },
        } as never,
        createElement(WorkbenchChat, { hosted: true }),
      ),
    );
    expect(chatHost.querySelector('[data-testid="workbench-voice-button"]')).toBeNull();

    const homeHost = mountNode(
      createElement(ProLaunchPanel, { courseOptions: [], onSessionCreated: () => {} }),
    );
    expect(homeHost.querySelector('[data-testid="pro-launch-voice-button"]')).toBeNull();
  });

  it('inserts transcription into WorkbenchChat without auto-sending and mirrors attach disabled state', () => {
    useWorkbenchStore.getState().attach('ses-1', 'stage-1');
    useWorkbenchStore.setState({ replaying: false, status: 'succeeded' });

    const host = mountNode(
      createElement(
        WorkbenchCourseNavigationProvider,
        {
          navigation: {
            activeCourseId: null,
            courseOptions: [{ id: 'stage-1', name: 'Fractions' }],
            openCourse: () => {},
            lookupCourse: () => null,
          },
        } as never,
        createElement(WorkbenchChat, { hosted: true, conversation: 'ses-1' }),
      ),
    );

    const voiceButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="workbench-voice-button"] button',
    );
    expect(voiceButton).not.toBeNull();
    expect(voiceButton!.disabled).toBe(false);

    const input = host.querySelector(COMPOSER_INPUT)!;
    const handle = composerInputHandleOf(input)!;

    act(() => {
      handle.insertText('Explain ');
    });
    act(() => {
      lastSpeechProps?.onTranscription?.('quantum tunneling');
    });

    expect(handle.value).toBe('Explain quantum tunneling');
    expect(posts).toEqual([]);

    // Disables send while speech recording/processing is active.
    const sendButton = host.querySelector<HTMLButtonElement>('[data-testid="workbench-send"]')!;
    expect(sendButton.disabled).toBe(false);
    act(() => {
      lastSpeechProps?.onActiveChange?.(true);
    });
    expect(sendButton.disabled).toBe(true);
    act(() => {
      lastSpeechProps?.onActiveChange?.(false);
    });
    expect(sendButton.disabled).toBe(false);

    // Disables when the composer cannot send (e.g., conversation owner not attached).
    const detachedHost = mountNode(
      createElement(
        WorkbenchDraftConversationProvider,
        { draft: null } as never,
        createElement(WorkbenchChat, { hosted: true, conversation: 'other-session' }),
      ),
    );
    const detachedVoice = detachedHost.querySelector<HTMLButtonElement>(
      '[data-testid="workbench-voice-button"] button',
    );
    expect(detachedVoice?.disabled).toBe(true);
  });

  it('inserts transcription into ProLaunchPanel without auto-sending', () => {
    const host = mountNode(
      createElement(ProLaunchPanel, { courseOptions: [], onSessionCreated: () => {} }),
    );
    const voiceButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="pro-launch-voice-button"] button',
    );
    expect(voiceButton).not.toBeNull();
    expect(voiceButton!.disabled).toBe(false);

    const input = host.querySelector(COMPOSER_INPUT)!;
    const handle = composerInputHandleOf(input)!;

    act(() => {
      lastSpeechProps?.onTranscription?.('Build a lesson on photosynthesis');
    });
    expect(handle.value).toBe('Build a lesson on photosynthesis');
    expect(posts).toEqual([]);
  });
});
