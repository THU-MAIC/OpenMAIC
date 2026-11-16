// @vitest-environment jsdom
/**
 * The preview's asking scene is generic: the question is the title, `details`
 * (or the agent's reply, from an agent that wrote its material there) sits in a
 * clamped block, and the options come from the conversation's own form — with
 * the recommendation marked, and a countdown only for a live question.
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
  foldEvent,
  useWorkbenchStore,
  type WorkbenchFold,
} from '@/lib/workbench/session-store';
import { useQuestionHost } from '@/lib/workbench/question-host';
import { useQuestionAutoConfirm } from '@/lib/workbench/question-auto-confirm';
import { sessionScopedKey } from '@/lib/workbench/request-scope';
import { useSettingsStore } from '@/lib/store/settings';

type Frame = [number, string, unknown];

function fold(frames: readonly Frame[]): WorkbenchFold {
  return frames.reduce<WorkbenchFold>(
    (state, [ts, type, data], index) =>
      foldEvent(state, { id: index + 1, ts, attempt: 1, type, data }),
    createInitialSessionState(),
  );
}

const asked = (reply: string | null, question: Record<string, unknown>): Frame[] => [
  [1_000, 'user_message', { text: 'Make a course' }],
  [1_100, 'session_start', { prompt: 'Make a course' }],
  ...(reply
    ? ([
        [1_200, 'message_start', { message: { role: 'assistant', content: [] } }],
        [
          1_300,
          'message_end',
          { message: { role: 'assistant', content: [{ type: 'text', text: reply }] } },
        ],
      ] as Frame[])
    : []),
  [1_400, 'tool_execution_start', { toolCallId: 'ask', toolName: 'ask_user', args: {} }],
  [1_500, 'user_question', question],
  [1_600, 'tool_execution_end', { toolCallId: 'ask', toolName: 'ask_user', result: {} }],
  [1_700, 'agent_end', {}],
];

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(3_000);
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
  useSettingsStore.setState({ autoConfirmRecommendedAnswer: true });
  useQuestionHost.getState().setAnswer(async () => true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useQuestionHost.getState().setAnswer(null);
  useQuestionAutoConfirm.setState({ live: [], stopped: [], autoConfirmed: [] });
  useWorkbenchStore.setState(createInitialSessionState() as never);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function show(frames: Frame[], live = false) {
  const state = fold(frames);
  const questionKey = state.chat.find((node) => node.kind === 'question')?.key ?? '';
  useQuestionAutoConfirm.setState({
    live: live ? [sessionScopedKey('s1', questionKey)] : [],
    stopped: [],
    autoConfirmed: [],
  });
  await act(async () => {
    useWorkbenchStore.setState({
      ...createInitialSessionState(),
      ...state,
      status: 'succeeded',
      sessionId: 's1',
      replaying: false,
    } as never);
  });
  await act(async () =>
    root.render(createElement(WorkspaceRequestActivity, { closedKey: null, onClose: () => {} })),
  );
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe('the preview asking scene', () => {
  it('shows the question as its title and the details clamped, with the recommendation marked', async () => {
    await show(
      asked('I planned the course.', {
        question: 'Build this plan?',
        details: '1. **Light**\n2. Quiz',
        options: [
          { id: 'go', label: 'Go ahead', recommended: true },
          { id: 'change', label: 'Change it' },
        ],
      }),
      true,
    );
    expect(q('request-preview-title')?.textContent).toContain('Build this plan?');
    // The details, not the reply, fill the block.
    expect(q('request-preview-plan')?.textContent).toContain('Light');
    expect(q('request-preview-plan')?.textContent).not.toContain('I planned the course.');
    expect(q('request-preview-plan')?.getAttribute('data-open')).toBe('false');
    // The question is not repeated inside the form.
    expect(q('workbench-question-form')?.textContent).not.toContain('Build this plan?');
    expect(q('workbench-question-form-recommended')).not.toBeNull();
    expect(q('workbench-question-form')?.getAttribute('data-auto-confirm')).toBe('running');
  });

  it('leaves the reply in the conversation when the question carries no details', async () => {
    await show(
      asked('Plan:\n1. Light\n2. Quiz', {
        question: 'Build this plan?',
        options: [{ id: 'go', label: 'Go ahead' }],
      }),
    );
    expect(q('request-preview-plan')).toBeNull();
    expect(q('request-preview-title')?.textContent).toContain('Build this plan?');
  });

  it('is just the question and its options for a short clarification', async () => {
    await show(
      asked(null, {
        question: 'Which course do you mean?',
        options: [
          { id: 'a', label: 'Photosynthesis' },
          { id: 'b', label: 'Plant life' },
          { id: 'other', label: 'Neither' },
        ],
      }),
      true,
    );
    expect(q('request-preview-title')?.textContent).toContain('Which course do you mean?');
    expect(q('request-preview-plan')).toBeNull();
    expect(q('workbench-question-form-recommended')).toBeNull();
    expect(q('workbench-question-form')?.getAttribute('data-auto-confirm')).toBeNull();
    expect(q('workbench-question-form')?.textContent).toContain(
      'workbench.question.orAnswerInChat',
    );
  });

  it('marks the recommendation but does not count down for a replayed question', async () => {
    await show(
      asked(null, {
        question: 'Which interactions?',
        multiSelect: true,
        options: [
          { id: 'quiz', label: 'Quiz', recommended: true },
          { id: 'sim', label: 'Simulation' },
        ],
      }),
      false,
    );
    expect(q('workbench-question-form')?.getAttribute('data-mode')).toBe('multi');
    expect(q('workbench-question-form-recommended')).not.toBeNull();
    expect(q('workbench-question-form')?.getAttribute('data-auto-confirm')).toBeNull();
  });
});
