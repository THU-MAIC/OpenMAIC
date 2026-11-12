// @vitest-environment jsdom
/**
 * A new conversation's request preview is up from the moment the request is
 * sent: queued before any event, and while the agent only thinks. A request
 * that ends only talking folds to the resting tab; closing is per request.
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

import {
  WorkspaceRequestActivity,
  type PreviewTabState,
} from '@/components/workbench/workspace/WorkspaceRequestActivity';
import {
  createInitialSessionState,
  foldEvent,
  useWorkbenchStore,
  type SessionStatus,
  type WorkbenchFold,
} from '@/lib/workbench/session-store';

type Frame = [number, string, unknown];

function fold(frames: readonly Frame[]): WorkbenchFold {
  return frames.reduce<WorkbenchFold>(
    (state, [ts, type, data], index) =>
      foldEvent(state, { id: index + 1, ts, attempt: 1, type, data }),
    createInitialSessionState(),
  );
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
  useWorkbenchStore.setState(createInitialSessionState() as never);
});

const section = () => container.querySelector('[data-testid="workspace-request-activity"]');

async function show(
  state: Partial<WorkbenchFold> & { status: SessionStatus; sessionPrompt?: string | null },
  closedKey: string | null = null,
) {
  const reports: PreviewTabState[] = [];
  await act(async () => {
    useWorkbenchStore.setState({
      ...createInitialSessionState(),
      ...state,
      sessionId: 'session-new',
      replaying: false,
    } as never);
  });
  await act(async () =>
    root.render(
      createElement(WorkspaceRequestActivity, {
        closedKey,
        onClose: () => {},
        onStateChange: (report: PreviewTabState) => reports.push(report),
      }),
    ),
  );
  return reports;
}

describe('a new conversation shows its preview as soon as the request is sent', () => {
  it('while the session waits in the queue with nothing folded', async () => {
    vi.setSystemTime(1_000);
    const reports = await show({ status: 'queued', sessionPrompt: 'Make a course' });
    // Says it is waiting, not that an agent is reading the request: nothing has started.
    expect(section()?.getAttribute('data-scene')).toBe('queued');
    expect(section()?.getAttribute('data-preview-mode')).toBe('scene');
    expect(section()?.textContent).toContain('workbench.preview.queued');
    expect(section()?.textContent).toContain('workbench.preview.queuedEyebrow');
    expect(section()?.textContent).not.toContain('workbench.preview.understanding');
    expect(section()?.textContent).not.toContain('workbench.preview.eyebrow');
    // Live, so the tab takes focus for this request.
    expect(reports.at(-1)).toMatchObject({ shown: true, live: true, requestKey: 'queued' });
  });

  it('while the agent only thinks, before any tool call or question', async () => {
    vi.setSystemTime(2_000);
    const state = fold([
      [1_000, 'user_message', { text: 'The history of Disney, richly illustrated' }],
      [1_200, 'session_start', { prompt: 'The history of Disney, richly illustrated' }],
      [1_500, 'message_start', { message: { role: 'assistant', content: [] } }],
    ]);
    const reports = await show({ ...state, status: 'running' });
    expect(section()?.getAttribute('data-scene')).toBe('understanding');
    expect(reports.at(-1)).toMatchObject({ shown: true, live: true });
  });

  const chatOnly: Frame[] = [
    [1_000, 'user_message', { text: 'hi' }],
    [1_200, 'session_start', { prompt: 'hi' }],
    [1_500, 'message_start', { message: { role: 'assistant', content: [] } }],
    [
      1_600,
      'message_end',
      { message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] } },
    ],
    [1_700, 'agent_end', {}],
    [1_700, 'session_end', { status: 'succeeded' }],
  ];

  it('folds away once a request that only talked has ended and its scene was held', async () => {
    const state = fold(chatOnly);
    // Ended, but understanding has not held its two seconds yet.
    vi.setSystemTime(1_800);
    await show({ ...state, status: 'succeeded' });
    expect(section()?.getAttribute('data-scene')).toBe('understanding');
    // Held: a conversation that has only talked gives the main column back.
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(section()).toBeNull();
  });

  it('rests instead in a conversation that has done something', async () => {
    const state = fold([
      [500, 'tool_execution_start', { toolCallId: 's', toolName: 'web_search', args: {} }],
      [600, 'tool_execution_end', { toolCallId: 's', isError: false, result: { content: [] } }],
      ...chatOnly,
    ]);
    vi.setSystemTime(10_000);
    const reports = await show({ ...state, status: 'succeeded' });
    expect(section()?.getAttribute('data-preview-mode')).toBe('collapsed');
    expect(section()?.getAttribute('data-scene')).toBe('resting');
    // At rest: shown, but nothing to take focus for.
    expect(reports.at(-1)).toMatchObject({ shown: true, live: false });
  });

  it('stays closed for the request it was closed for, and opens for the next one', async () => {
    vi.setSystemTime(2_000);
    const first = fold([[1_000, 'user_message', { text: 'hi' }]]);
    const key = first.chat[0]!.key;
    await show({ ...first, status: 'running' }, key);
    expect(section()).toBeNull();

    const next = fold([
      [1_000, 'user_message', { text: 'hi' }],
      [1_100, 'agent_end', {}],
      [1_100, 'session_end', { status: 'succeeded' }],
      [1_500, 'user_message', { text: 'a course on fractions', delivery: 'queued' }],
    ]);
    await show({ ...next, status: 'running' }, key);
    expect(section()?.getAttribute('data-scene')).toBe('understanding');
  });
});
