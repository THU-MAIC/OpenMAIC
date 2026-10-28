// @vitest-environment jsdom
/**
 * Request and node keys come from a conversation's own event sequence, so
 * two conversations reuse them. What the preview remembers about a request
 * (the cast already revealed, a question handed back) belongs to one
 * conversation and must not carry into another with the same keys.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
vi.mock('motion/react', async () => {
  const actual = await vi.importActual<typeof import('motion/react')>('motion/react');
  return { ...actual, AnimatePresence: ({ children }: { children: ReactNode }) => children };
});

import fixture from './fixtures/request-preview-roster-stream.json' with { type: 'json' };
import { WorkspaceRequestActivity } from '@/components/workbench/workspace/WorkspaceRequestActivity';
import {
  createInitialSessionState,
  foldEvent,
  useWorkbenchStore,
  type WorkbenchFold,
} from '@/lib/workbench/session-store';
import { rosterRevealMs } from '@/lib/workbench/request-schedule';

type Frame = [number, string, unknown];
const frames = fixture as Frame[];
const firstPageAt = frames.find(
  ([, type, data]) =>
    type === 'tool_execution_start' &&
    (data as { toolName?: string }).toolName === 'generate_scene',
)![0];

function foldUntil(until: number): WorkbenchFold {
  let state: WorkbenchFold = createInitialSessionState();
  frames.forEach(([ts, type, data], index) => {
    if (ts <= until) state = foldEvent(state, { id: index + 1, ts, attempt: 1, type, data });
  });
  return state;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
  );
  Element.prototype.scrollIntoView = () => {};
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const scene = () =>
  container.querySelector('[data-testid="workspace-request-activity"]')?.getAttribute('data-scene');

describe('preview memory across conversations', () => {
  it("reveals the cast in a second conversation whose request key matches the first's", async () => {
    // Opened well after set_roster: the late viewer's reveal.
    const openedAt = firstPageAt + 20_000;
    vi.setSystemTime(openedAt);
    const fold = foldUntil(firstPageAt);
    const attach = (sessionId: string) =>
      act(async () => {
        useWorkbenchStore.setState({
          ...fold,
          sessionId,
          status: 'running',
          replaying: false,
        } as never);
      });
    await attach('session-a');
    await act(async () =>
      root.render(createElement(WorkspaceRequestActivity, { closedKey: null, onClose: () => {} })),
    );
    expect(scene()).toBe('assembling');
    await act(async () => vi.advanceTimersByTime(rosterRevealMs(3) + 2_000));
    expect(scene()).toBe('generating');

    // Another conversation, same event ids, so the same request key.
    await attach('session-b');
    await act(async () => vi.advanceTimersByTime(300));
    expect(scene()).toBe('assembling');
  });

  it('reveals the cast when a preview that was hidden through set_roster is shown', async () => {
    const openedAt = firstPageAt + 20_000;
    vi.setSystemTime(openedAt);
    const fold = foldUntil(firstPageAt);
    await act(async () => {
      useWorkbenchStore.setState({
        ...fold,
        sessionId: 'session-hidden',
        status: 'running',
        replaying: false,
      } as never);
    });
    const preview = (hidden: boolean) =>
      createElement(WorkspaceRequestActivity, { closedKey: null, onClose: () => {}, hidden });
    // Behind a course tab the whole time the cast would have played.
    await act(async () => root.render(preview(true)));
    await act(async () => vi.advanceTimersByTime(rosterRevealMs(3) + 5_000));
    // Shown: this viewer has not seen the cast yet.
    await act(async () => root.render(preview(false)));
    expect(scene()).toBe('assembling');
    expect(
      container.querySelectorAll(
        '[data-testid="request-preview-roster-card"][data-revealed="true"]',
      ),
    ).toHaveLength(0);
  });

  it('reveals the cast after a question the late viewer landed on is answered', async () => {
    const rosterAt = frames.find(
      ([, type, data]) =>
        type === 'tool_execution_end' && (data as { toolName?: string }).toolName === 'set_roster',
    )![0];
    let state = foldUntil(rosterAt);
    let id = frames.length;
    const add = (ts: number, type: string, data: unknown) => {
      state = foldEvent(state, { id: ++id, ts, attempt: 1, type, data });
    };
    // After set_roster the agent asks, and the run stops on the question.
    add(rosterAt + 100, 'user_question', {
      question: 'Which grade?',
      options: [{ id: 'g7', label: 'Grade 7' }],
    });
    add(rosterAt + 150, 'agent_end', {});
    add(rosterAt + 200, 'session_end', { status: 'succeeded' });
    // A viewer attaches later and finds the question waiting.
    const attachedAt = rosterAt + 10_000;
    vi.setSystemTime(attachedAt);
    const attach = (status: string) =>
      act(async () => {
        useWorkbenchStore.setState({
          ...state,
          sessionId: 'session-ask',
          status,
          replaying: false,
        } as never);
      });
    await attach('succeeded');
    await act(async () =>
      root.render(createElement(WorkspaceRequestActivity, { closedKey: null, onClose: () => {} })),
    );
    expect(scene()).toBe('asking');
    // The answer takes longer than the reveal would have.
    await act(async () => vi.advanceTimersByTime(rosterRevealMs(3) + 10_000));
    const answeredAt = Date.now();
    add(answeredAt, 'user_message', { text: 'Grade 7', delivery: 'queued' });
    add(answeredAt + 10, 'tool_execution_start', {
      toolCallId: 'page-1',
      toolName: 'generate_scene',
      args: { order: 1, type: 'slide' },
    });
    await act(async () => vi.advanceTimersByTime(20));
    await attach('running');
    await act(async () => vi.advanceTimersByTime(300));
    // The cast has never been on screen: it is revealed now.
    expect(scene()).toBe('assembling');
  });

  it('reveals a replacement cast that arrived while the preview was hidden', async () => {
    let state = foldUntil(firstPageAt);
    let id = frames.length;
    const add = (ts: number, type: string, data: unknown) => {
      state = foldEvent(state, { id: ++id, ts, attempt: 1, type, data });
    };
    const attach = () =>
      act(async () => {
        useWorkbenchStore.setState({
          ...state,
          sessionId: 'session-recast',
          status: 'running',
          replaying: false,
        } as never);
      });
    const preview = (hidden: boolean) =>
      createElement(WorkspaceRequestActivity, { closedKey: null, onClose: () => {}, hidden });
    // The first cast, watched: revealed, then generation.
    vi.setSystemTime(firstPageAt + 1_000);
    await attach();
    await act(async () => root.render(preview(false)));
    await act(async () => vi.advanceTimersByTime(rosterRevealMs(3) + 5_000));
    expect(scene()).toBe('generating');

    // Behind a course tab, the same request casts again.
    await act(async () => root.render(preview(true)));
    const recastAt = Date.now();
    add(recastAt, 'tool_execution_start', {
      toolCallId: 'recast',
      toolName: 'set_roster',
      args: {},
    });
    add(recastAt + 10, 'tool_execution_end', {
      toolCallId: 'recast',
      toolName: 'set_roster',
      isError: false,
      result: {
        content: [],
        details: {
          roster: [
            { id: 'new-t', name: 'Teacher Wu', role: 'teacher', avatar: '/avatars/teacher.png' },
            { id: 'new-a', name: 'Student B', role: 'student', avatar: '/avatars/assist.png' },
          ],
        },
      },
    });
    await attach();
    await act(async () => vi.advanceTimersByTime(10_000));

    // Shown again: the replacement cast is revealed, in full.
    await act(async () => root.render(preview(false)));
    const flipped = () =>
      container.querySelectorAll(
        '[data-testid="request-preview-roster-card"][data-revealed="true"]',
      ).length;
    expect(scene()).toBe('assembling');
    expect(container.textContent).toContain('Teacher Wu');
    // From face down, at the classic pace, through every card.
    expect(flipped()).toBe(0);
    await act(async () => vi.advanceTimersByTime(rosterRevealMs(2)));
    expect(scene()).toBe('assembling');
    expect(flipped()).toBe(2);
  });
});
