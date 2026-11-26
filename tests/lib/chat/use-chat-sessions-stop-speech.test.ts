// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChatSessions } from '@/components/chat/use-chat-sessions';
import type { CleanupSource } from '@/lib/playback/auto-resume';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

type Hook = ReturnType<typeof useChatSessions>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(onLiveSessionStopping: () => void) {
  const hookRef: { current: Hook | null } = { current: null };
  function Probe() {
    const hook = useChatSessions({ onLiveSessionStopping });
    useEffect(() => {
      hookRef.current = hook;
    });
    return null;
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root!.render(createElement(Probe)));
  return hookRef;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container = null;
});

describe('ending a live session stops its speech before waiting', () => {
  it.each(['manual_stop', 'soft_close_confirmed', 'scene_switch'] as CleanupSource[])(
    'calls onLiveSessionStopping synchronously for %s',
    async (source) => {
      const stopping = vi.fn();
      const hook = await mount(stopping);
      let sessionId = '';
      await act(async () => {
        sessionId = await hook.current!.createSession('discussion', 'Topic');
      });

      let ended: Promise<void> | undefined;
      act(() => {
        ended = hook.current!.endSession(sessionId, { source });
      });
      // Called before endSession's first await, i.e. before any in-flight
      // whiteboard action is waited for.
      expect(stopping).toHaveBeenCalledOnce();
      await act(async () => ended);
    },
  );

  it.each([undefined, 'error', 'soft_close_timeout'] as Array<CleanupSource | undefined>)(
    'leaves speech alone for source %s',
    async (source) => {
      const stopping = vi.fn();
      const hook = await mount(stopping);
      let sessionId = '';
      await act(async () => {
        sessionId = await hook.current!.createSession('qa', 'Question');
      });
      await act(async () => hook.current!.endSession(sessionId, { source }));
      expect(stopping).not.toHaveBeenCalled();
    },
  );

  it('does not call it for a lecture session', async () => {
    const stopping = vi.fn();
    const hook = await mount(stopping);
    let sessionId = '';
    await act(async () => {
      sessionId = await hook.current!.createSession('lecture', 'Lecture');
    });
    await act(async () => hook.current!.endSession(sessionId, { source: 'manual_stop' }));
    expect(stopping).not.toHaveBeenCalled();
  });
});
