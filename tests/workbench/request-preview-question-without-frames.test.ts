// @vitest-environment jsdom
/**
 * The asking scene must not wait on animation frames (#2283). Motion runs its
 * exits and entrances on `requestAnimationFrame`; a covered window produces
 * none, and a frameloop that died on an exception never will again. Here no
 * frame ever fires and Motion is real (AnimatePresence is NOT mocked): the
 * question's card and form must be on the page the moment it lands, and the
 * conversation may point at the preview only while the preview's form is
 * there.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // Installed before Motion loads, so its frameloop captures a scheduler
  // that never runs.
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
});

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

import { WorkspaceRequestActivity } from '@/components/workbench/workspace/WorkspaceRequestActivity';
import {
  createInitialSessionState,
  useWorkbenchStore,
  type WorkbenchEvent,
} from '@/lib/workbench/session-store';
import { useQuestionHost } from '@/lib/workbench/question-host';
import { sessionScopedKey } from '@/lib/workbench/request-scope';

const frame = (
  id: number,
  ts: number,
  type: string,
  data: Record<string, unknown>,
): WorkbenchEvent => ({ id, ts, attempt: 1, type, data });

const RUN_START = frame(1, 30_000, 'session_start', { prompt: 'Make a course' });
const ASKING = frame(2, 30_500, 'user_question', {
  question: 'Build this plan?',
  options: [
    { id: 'go', label: 'Go ahead', recommended: true },
    { id: 'change', label: 'Change it' },
  ],
});
const ANSWER = frame(3, 34_000, 'user_message', { text: 'Go ahead' });

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
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
const q = (id: string) => section()?.querySelector(`[data-testid="${id}"]`) ?? null;

async function mountQueued() {
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
    root.render(createElement(WorkspaceRequestActivity, { closedKey: null, onClose: () => {} })),
  );
}

async function lands(...events: readonly WorkbenchEvent[]) {
  for (const event of events) {
    vi.setSystemTime(event.ts + 100);
    await act(async () => {
      useWorkbenchStore.getState().applyEvent(event);
    });
  }
  // A few clock ticks: anything that could only follow a frame never does.
  await act(async () => vi.advanceTimersByTime(1_000));
}

describe('the asking scene with no animation frames', () => {
  it('shows the question and its form the moment it lands on the queued scene', async () => {
    await mountQueued();
    expect(section()?.getAttribute('data-scene')).toBe('queued');
    await lands(RUN_START, ASKING);

    expect(section()?.getAttribute('data-scene')).toBe('asking');
    // The previous scene's card does not hold the screen on an exit that
    // cannot finish.
    expect(section()?.textContent).not.toContain('workbench.preview.queued');
    expect(q('request-preview-question')).not.toBeNull();
    expect(q('request-preview-title')?.textContent).toContain('Build this plan?');
    expect(q('workbench-question-form')).not.toBeNull();
    // The conversation points here only because the form is here.
    expect(useQuestionHost.getState().previewKey).toBe(sessionScopedKey('s1', 'e2'));
  });

  it('gives the screen back at once when the question is answered', async () => {
    // Opened on the waiting question: the first render needs no frame.
    await act(async () => {
      useWorkbenchStore.setState({
        ...createInitialSessionState(),
        sessionId: 's1',
        status: 'running',
        replaying: false,
      } as never);
      vi.setSystemTime(ASKING.ts + 100);
      useWorkbenchStore.getState().applyEvents([RUN_START, ASKING]);
    });
    await act(async () =>
      root.render(createElement(WorkspaceRequestActivity, { closedKey: null, onClose: () => {} })),
    );
    expect(q('workbench-question-form')).not.toBeNull();

    await lands(ANSWER);

    expect(section()?.getAttribute('data-scene')).toBe('understanding');
    // The answered card does not linger, form and all, on an exit that
    // cannot finish: a second press would send a second answer.
    expect(q('request-preview-question')).toBeNull();
    expect(q('workbench-question-form')).toBeNull();
    expect(useQuestionHost.getState().previewKey).toBeNull();
  });
});
