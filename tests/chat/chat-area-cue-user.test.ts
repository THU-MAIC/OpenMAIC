// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ChatArea, type ChatAreaRef } from '@/components/chat/chat-area';

const actions = vi.hoisted(() => ({ endSession: vi.fn(), sendMessage: vi.fn() }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/store', () => ({ useStageStore: () => [] }));
vi.mock('@/components/chat/session-list', () => ({ SessionList: () => null }));
vi.mock('@/components/chat/lecture-notes-view', () => ({ LectureNotesView: () => null }));
vi.mock('@/components/chat/use-chat-sessions', () => ({
  MANUAL_STOP_END_OPTIONS: { source: 'manual_stop' },
  useChatSessions: () => ({
    sessions: [
      {
        id: 'parked',
        type: 'qa',
        status: 'waiting-user',
        cueUser: {
          prompt: 'Try another example?',
          options: ['Yes', 'Continue lesson'],
          parkedAt: 1,
        },
      },
    ],
    activeSessionType: 'qa',
    expandedSessionIds: new Set(['parked']),
    isStreaming: false,
    endSession: actions.endSession,
    sendMessage: actions.sendMessage,
  }),
}));

describe('ChatArea restored learner park', () => {
  it('rehydrates the cue without sending and claims repeated manual stops only once', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const ref = createRef<ChatAreaRef>();
    const onCueUser = vi.fn();
    const onStopSession = vi.fn();
    let finish!: () => void;
    actions.endSession.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    try {
      await act(async () =>
        root.render(createElement(ChatArea, { ref, onCueUser, onStopSession })),
      );
      expect(onCueUser).toHaveBeenCalledExactlyOnceWith(undefined, 'Try another example?', [
        'Yes',
        'Continue lesson',
      ]);
      expect(actions.sendMessage).not.toHaveBeenCalled();
      let first!: Promise<void>;
      let second!: Promise<void>;
      act(() => {
        first = ref.current!.stopActiveSession();
        second = ref.current!.stopActiveSession();
      });
      expect(actions.endSession).toHaveBeenCalledExactlyOnceWith('parked', {
        source: 'manual_stop',
      });
      await act(async () => {
        finish();
        await Promise.all([first, second]);
      });
      expect(onStopSession).toHaveBeenCalledExactlyOnceWith({
        sessionId: 'parked',
        source: 'manual_stop',
      });
      expect(actions.sendMessage).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
