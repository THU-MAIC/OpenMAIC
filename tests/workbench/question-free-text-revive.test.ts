// @vitest-environment jsdom
/**
 * The agent's free-text choice (`other`) on the transcript card, after the user
 * dismissed the question's form. Its label is a prompt to write, not an
 * answer: clicking it brings the form back on its text row, focused, and
 * sends nothing.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'en-US', t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/workbench/agent-skills', () => ({
  useAgentSkills: () => ({ skills: [], loading: false, error: null, reload: async () => {} }),
  invalidateAgentSkills: async () => {},
}));
vi.mock('@/components/workbench/chat/autoscroll', () => ({
  useWorkbenchAutoscroll: () => ({
    scrollRef: { current: null },
    contentRef: { current: null },
    isNearBottom: true,
    scrollToBottom: async () => {},
  }),
}));

import { WorkbenchChat } from '@/components/workbench/WorkbenchChat';
import {
  WorkbenchCourseNavigationProvider,
  WorkbenchDraftConversationProvider,
} from '@/lib/workbench/panel-context';
import { useWorkbenchStore, type ChatNode } from '@/lib/workbench/session-store';
import { useQuestionDrafts } from '@/lib/workbench/question-host';

Element.prototype.scrollIntoView ??= function scrollIntoView() {};

let posts: string[] = [];
let sent: string[] = [];
let dispose: (() => Promise<void>) | undefined;

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
  posts = [];
  sent = [];
  useQuestionDrafts.setState({ drafts: {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push(url);
        if (url.endsWith('/messages')) {
          const body = JSON.parse(String(init.body)) as { text?: string; content?: string };
          sent.push(String(body.text ?? body.content ?? ''));
        }
        return Response.json({});
      }
      if (url === '/api/agent/runtime') return Response.json({ enabled: true });
      if (url.startsWith('/api/materials/library')) return Response.json({ materials: [] });
      return Response.json({});
    }),
  );
  useWorkbenchStore.getState().detach();
});

afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});

const question: ChatNode = {
  key: 'q1',
  kind: 'question',
  text: 'Who is the course for?',
  questionOptions: [
    { id: 'students', label: 'Students' },
    { id: 'other', label: 'Someone else (describe)' },
  ],
};

async function mount(node: ChatNode = question, sessionId = 'ses-q'): Promise<HTMLElement> {
  useWorkbenchStore.getState().attach(sessionId, 'stage-1');
  useWorkbenchStore.setState({
    replaying: false,
    status: 'succeeded',
    chat: [{ key: 'u', kind: 'user', text: 'Make a course' }, node],
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const navigation = {
    activeCourseId: null,
    courseOptions: [],
    openCourse: () => {},
    lookupCourse: () => null,
  };
  await act(async () =>
    root.render(
      createElement(
        WorkbenchCourseNavigationProvider,
        { navigation } as never,
        createElement(
          WorkbenchDraftConversationProvider,
          { draft: null } as never,
          createElement(WorkbenchChat, { hosted: true }),
        ) as never,
      ),
    ),
  );
  dispose = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}

const click = (el: Element | null) =>
  act(async () => {
    (el as HTMLElement).click();
  });

describe("the transcript card's free-text option", () => {
  it('brings the dismissed form back on its text row instead of sending its label', async () => {
    const container = await mount();
    expect(container.querySelector('[data-testid="workbench-question-form"]')).not.toBeNull();
    await click(container.querySelector('[data-testid="workbench-question-form-dismiss"]'));
    expect(container.querySelector('[data-testid="workbench-question-form"]')).toBeNull();

    await click(container.querySelector('[data-testid="workbench-question-option-other"]'));
    expect(posts).toEqual([]);
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="workbench-question-form-other-input"]',
    );
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('still answers with an ordinary option', async () => {
    const container = await mount();
    await click(container.querySelector('[data-testid="workbench-question-form-dismiss"]'));
    await click(container.querySelector('[data-testid="workbench-question-option-students"]'));
    expect(posts.some((url) => url.endsWith('/messages'))).toBe(true);
  });

  it('keeps a half-written answer when the form steps aside and comes back', async () => {
    const container = await mount();
    await click(container.querySelector('[data-testid="workbench-question-form-other"]'));
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="workbench-question-form-other-input"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'Parents of young children',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Away (the form dismissed, or the question moving to the preview), then back.
    await click(container.querySelector('[data-testid="workbench-question-form-dismiss"]'));
    await click(container.querySelector('[data-testid="workbench-question-revive"]'));
    const back = container.querySelector<HTMLInputElement>(
      '[data-testid="workbench-question-form-other-input"]',
    );
    expect(back?.value).toBe('Parents of young children');
    expect(posts).toEqual([]);
  });
});

const multi: ChatNode = {
  key: 'q2',
  kind: 'question',
  text: 'Which topics?',
  questionMultiSelect: true,
  questionOptions: [
    { id: 'light', label: 'Light' },
    { id: 'sound', label: 'Sound' },
    { id: 'other', label: 'Something else' },
  ],
};

// The mocked translator returns keys, so the list separator is its key.
const SEP = 'workbench.question.multiAnswerSeparator';

const write = (container: HTMLElement, text: string) =>
  act(async () => {
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="workbench-question-form-other-input"]',
    )!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const q = (container: HTMLElement, id: string) => container.querySelector(`[data-testid="${id}"]`);

describe('one answer in progress per question, across its surfaces', () => {
  it('keeps the card’s picks when its free-text option opens the form', async () => {
    const container = await mount(multi);
    await click(q(container, 'workbench-question-form-dismiss'));
    await click(q(container, 'workbench-question-option-light'));
    await click(q(container, 'workbench-question-option-other'));
    // The form is back with the canned pick kept and the text row on.
    expect(q(container, 'workbench-question-form-option-light')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    await write(container, 'Lenses');
    await click(q(container, 'workbench-question-form-submit'));
    expect(sent).toEqual([`Light${SEP}Lenses`]);
  });

  it('sends the written answer with picks made on the card afterwards', async () => {
    const container = await mount(multi);
    await click(q(container, 'workbench-question-form-other'));
    await write(container, 'Lenses');
    await click(q(container, 'workbench-question-form-dismiss'));
    await click(q(container, 'workbench-question-option-sound'));
    await click(q(container, 'workbench-question-confirm'));
    expect(sent).toEqual([`Sound${SEP}Lenses`]);
  });

  it('keeps picks made in the form when it is dismissed and revived', async () => {
    const container = await mount(multi);
    await click(q(container, 'workbench-question-form-option-sound'));
    await click(q(container, 'workbench-question-form-dismiss'));
    // The card shows the same pick.
    expect(q(container, 'workbench-question-option-sound')?.getAttribute('data-picked')).toBe(
      'true',
    );
    await click(q(container, 'workbench-question-revive'));
    expect(q(container, 'workbench-question-form-option-sound')?.getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('keeps each conversation’s draft to itself', async () => {
    let container = await mount(multi, 'ses-a');
    await click(q(container, 'workbench-question-form-option-sound'));
    await dispose?.();
    dispose = undefined;
    container = await mount(multi, 'ses-b');
    expect(q(container, 'workbench-question-form-option-sound')?.getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('drops the draft once the question is answered', async () => {
    const container = await mount(multi);
    await click(q(container, 'workbench-question-form-option-sound'));
    expect(Object.keys(useQuestionDrafts.getState().drafts)).toHaveLength(1);
    await act(async () => {
      useWorkbenchStore.setState({
        chat: [
          { key: 'u', kind: 'user', text: 'Make a course' },
          { ...multi, questionAnswered: true },
          { key: 'u2', kind: 'user', text: 'Sound' },
        ],
      });
    });
    expect(useQuestionDrafts.getState().drafts).toEqual({});
    expect(container).toBeTruthy();
  });

  it("does not carry one conversation's question markers into another with the same key", async () => {
    const container = await mount(question, 'ses-a');
    // In A: wave the form off, then reopen it on its free-text row.
    await click(q(container, 'workbench-question-form-dismiss'));
    await click(q(container, 'workbench-question-option-other'));
    expect(q(container, 'workbench-question-form-other-input')).not.toBeNull();
    await click(q(container, 'workbench-question-form-dismiss'));
    // Switch to B (the chat stays mounted) with a question under the same key.
    await act(async () => {
      useWorkbenchStore.getState().attach('ses-b', 'stage-1');
      useWorkbenchStore.setState({
        replaying: false,
        status: 'succeeded',
        chat: [{ key: 'u', kind: 'user', text: 'Another course' }, question],
      });
    });
    // B's question takes the composer over, fresh: not dismissed, not on its text row.
    expect(q(container, 'workbench-question-form')).not.toBeNull();
    expect(q(container, 'workbench-question-form-other-input')).toBeNull();
    // And B's own free-text revival does not leak back into A.
    await click(q(container, 'workbench-question-form-dismiss'));
    await act(async () => {
      useWorkbenchStore.getState().attach('ses-a', 'stage-1');
      useWorkbenchStore.setState({
        replaying: false,
        status: 'succeeded',
        chat: [{ key: 'u', kind: 'user', text: 'Make a course' }, question],
      });
    });
    expect(q(container, 'workbench-question-form')).not.toBeNull();
  });
});
