// @vitest-environment jsdom
/**
 * The preview follows the stream while it stays MOUNTED (#2283): the frames
 * of a queued send — the run finally starts, the agent thinks, it asks — land
 * one by one in the fold, and the asking card with its form must follow the
 * `user_question` frame itself, not some later re-render. The state chain
 * (fold → track → schedule → the form handshake) is exercised together; the
 * animation layer is mocked out (AnimatePresence passes through), so what
 * this pins is everything BELOW the commit.
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

import { WorkspaceRequestActivity } from '@/components/workbench/workspace/WorkspaceRequestActivity';
import {
  createInitialSessionState,
  useWorkbenchStore,
  type WorkbenchEvent,
} from '@/lib/workbench/session-store';
import { useQuestionHost } from '@/lib/workbench/question-host';
import { sessionScopedKey } from '@/lib/workbench/request-scope';

/** One frame of the stream, as `useWorkbenchStream` would hand it to the fold. */
const frame = (
  id: number,
  ts: number,
  type: string,
  data: Record<string, unknown>,
): WorkbenchEvent => ({
  id,
  ts,
  attempt: 1,
  type,
  data,
});

/**
 * The queued send of #2283: a one-line course request waits in the runner
 * queue with no events, then the run starts and the agent asks right away.
 */
const RUN_START: WorkbenchEvent = frame(1, 30_000, 'session_start', {
  prompt: 'Make a course',
});
const THINKING: WorkbenchEvent = frame(2, 30_500, 'message_start', {
  message: { role: 'assistant', content: [] },
});
const ASKING: WorkbenchEvent = frame(4, 31_200, 'user_question', {
  question: 'Build this plan?',
  details: '1. Light and dark\n2. A quiz',
  options: [
    { id: 'go', label: 'Go ahead', recommended: true },
    { id: 'change', label: 'Change it' },
  ],
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
  useQuestionHost.getState().setAnswer(async () => true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useQuestionHost.getState().setAnswer(null);
  useQuestionHost.getState().setPreviewKey(null);
  useWorkbenchStore.setState(createInitialSessionState() as never);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const section = () => container.querySelector('[data-testid="workspace-request-activity"]');
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

/** Mount the preview once on a queued, just-created session and leave it mounted. */
async function mountQueued(props: { hidden?: boolean } = {}) {
  await act(async () => {
    useWorkbenchStore.setState({
      ...createInitialSessionState(),
      sessionId: 's1',
      status: 'queued',
      sessionPrompt: 'Make a course',
      replaying: false,
    } as never);
  });
  await act(async () =>
    root.render(
      createElement(WorkspaceRequestActivity, {
        closedKey: null,
        onClose: () => {},
        ...(props.hidden ? { hidden: true } : {}),
      }),
    ),
  );
}

/** A frame lands on the mounted component, as the live stream delivers it. */
async function lands(...events: readonly WorkbenchEvent[]) {
  for (const event of events) {
    vi.setSystemTime(event.ts + 100);
    await act(async () => {
      useWorkbenchStore.getState().applyEvent(event);
    });
  }
}

describe('the mounted preview follows the queued send live', () => {
  it('shows the queued copy while the request waits with nothing folded', async () => {
    await mountQueued();
    expect(section()?.getAttribute('data-scene')).toBe('queued');
    expect(section()?.getAttribute('data-preview-mode')).toBe('scene');
  });

  it('leaves the queued copy the moment the run starts, and asks the moment the question lands', async () => {
    await mountQueued();
    await lands(RUN_START);
    // The runner picked the request up: no more "waiting for a free runner".
    expect(section()?.getAttribute('data-scene')).toBe('understanding');
    await lands(THINKING);
    expect(section()?.getAttribute('data-scene')).toBe('understanding');
    await lands(ASKING);
    // The question frame itself must flip the scene and mount the form: the
    // scheduler marks it urgent, and the answer path is already published.
    expect(section()?.getAttribute('data-scene')).toBe('asking');
    expect(section()?.getAttribute('data-preview-awaiting')).toBe('true');
    expect(q('request-preview-question')).not.toBeNull();
    expect(q('request-preview-title')?.textContent).toContain('Build this plan?');
    expect(q('workbench-question-form')).not.toBeNull();
    // The conversation can point across: the preview claims the question.
    expect(useQuestionHost.getState().previewKey).toBe(sessionScopedKey('s1', 'e4'));
  });

  it('switches to asking even when the whole catch-up lands as one batch', async () => {
    // A reconnect's replay flushes the missed frames in one applyEvents —
    // the question must not wait behind the batch either.
    await mountQueued();
    vi.setSystemTime(ASKING.ts + 100);
    await act(async () => {
      useWorkbenchStore.getState().applyEvents([RUN_START, THINKING, ASKING]);
    });
    expect(section()?.getAttribute('data-scene')).toBe('asking');
    expect(q('workbench-question-form')).not.toBeNull();
  });
});

describe('the form handshake, sequenced', () => {
  it('the card shows with no form until the conversation publishes its answer path', async () => {
    useQuestionHost.getState().setAnswer(null);
    await mountQueued();
    await lands(RUN_START, ASKING);
    // The scene and the card follow the frame; the form waits on the chat.
    expect(section()?.getAttribute('data-scene')).toBe('asking');
    expect(q('request-preview-question')).not.toBeNull();
    expect(q('workbench-question-form')).toBeNull();
    expect(useQuestionHost.getState().previewKey).toBeNull();
    await act(async () => {
      useQuestionHost.getState().setAnswer(async () => true);
    });
    expect(q('workbench-question-form')).not.toBeNull();
    expect(useQuestionHost.getState().previewKey).toBe(sessionScopedKey('s1', 'e4'));
  });

  it('a hidden preview shows the card but hosts no form and claims nothing', async () => {
    await mountQueued({ hidden: true });
    await lands(RUN_START, ASKING);
    expect(section()?.getAttribute('aria-hidden')).toBe('true');
    expect(q('request-preview-question')).not.toBeNull();
    expect(q('workbench-question-form')).toBeNull();
    expect(useQuestionHost.getState().previewKey).toBeNull();
  });
});

describe('a late bootstrap cannot reopen a run that already started', () => {
  it('a queued status arriving after events is refused, so the asking scene keeps the screen', async () => {
    await mountQueued();
    await lands(RUN_START, ASKING);
    await act(async () => {
      // The meta read of the attachment resolves late with the queue-time
      // status; the fold has already seen the run start.
      useWorkbenchStore.getState().setSessionBootstrap({ status: 'queued' });
    });
    expect(useWorkbenchStore.getState().status).toBe('running');
    expect(section()?.getAttribute('data-scene')).toBe('asking');
  });
});
