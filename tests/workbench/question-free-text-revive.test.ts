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

Element.prototype.scrollIntoView ??= function scrollIntoView() {};

let posts: string[] = [];
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push(url);
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

async function mount(): Promise<HTMLElement> {
  useWorkbenchStore.getState().attach('ses-q', 'stage-1');
  useWorkbenchStore.setState({
    replaying: false,
    status: 'succeeded',
    chat: [{ key: 'u', kind: 'user', text: 'Make a course' }, question],
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
