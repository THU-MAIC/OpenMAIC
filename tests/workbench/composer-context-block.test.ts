// @vitest-environment jsdom
/**
 * A conversation blocked by the context limit closes its composer: nothing
 * can be staged or sent into it again, and the box says why where the
 * ordinary placeholder sat. An ordinary failure keeps the composer open —
 * its way out is the retry the notice offers, not a new chat.
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
vi.mock('@/components/workbench/chat/chat-timeline', () => ({ ChatTimeline: () => null }));
vi.mock('@/components/workbench/chat/autoscroll', () => ({
  useWorkbenchAutoscroll: () => ({
    scrollRef: { current: null },
    contentRef: { current: null },
    isNearBottom: true,
    scrollToBottom: async () => {},
  }),
}));

import { WorkbenchChat } from '@/components/workbench/WorkbenchChat';
import { WorkbenchCourseNavigationProvider } from '@/lib/workbench/panel-context';
import { foldEvents, useWorkbenchStore, type WorkbenchEvent } from '@/lib/workbench/session-store';
import { COMPOSER_INPUT } from './_composer-driver';

let seq = 0;
const ev = (type: string, data: unknown): WorkbenchEvent => {
  seq += 1;
  return { id: seq, ts: 1000 + seq, attempt: 1, type, data };
};

/** A conversation whose log ended on the given failure, replayed and settled. */
const openFailedConversation = (error: string) => {
  useWorkbenchStore.getState().attach('s1', null);
  useWorkbenchStore.setState(
    foldEvents(useWorkbenchStore.getState(), [
      ev('session_start', { prompt: 'keep my request' }),
      ev('session_end', { status: 'failed', error }),
    ]),
  );
  useWorkbenchStore.setState({ replaying: false });
};

const mountChat = async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposers.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      createElement(
        WorkbenchCourseNavigationProvider,
        { navigation: { courseOptions: [] } } as never,
        createElement(WorkbenchChat, { hosted: true, conversation: 's1' }),
      ) as never,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return container;
};

const disposers: Array<() => Promise<void>> = [];

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
  // Any POST is a send that must not happen: fail the test loudly instead of
  // letting it look like the composer held.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/agent/runtime') return Response.json({ enabled: true });
      throw new Error(`unexpected fetch ${String(input)}`);
    }),
  );
  useWorkbenchStore.getState().detach();
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

describe('the context-limit block closes the composer', () => {
  it('disables the box and every action, and says why where the placeholder sat', async () => {
    openFailedConversation('CONTEXT_BUDGET_EXCEEDED:still_oversized');
    const container = await mountChat();

    const input = container.querySelector<HTMLElement>(COMPOSER_INPUT)!;
    expect(input.getAttribute('aria-disabled')).toBe('true');
    expect(input.getAttribute('aria-placeholder')).toBe('workbench.chat.contextBlockedPlaceholder');
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="workbench-send"]')!.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="workbench-attach"]')!.disabled,
    ).toBe(true);
  });

  it('keeps the composer after an ordinary failure: its way out is the retry', async () => {
    openFailedConversation('provider 502');
    const container = await mountChat();

    const input = container.querySelector<HTMLElement>(COMPOSER_INPUT)!;
    expect(input.getAttribute('aria-disabled')).toBeNull();
    expect(input.getAttribute('aria-placeholder')).toBe('workbench.chat.continuePlaceholder');
    // The send button stays disabled only because the box is empty; the attach
    // action (blocked above) is the honest "the composer is open" signal.
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="workbench-attach"]')!.disabled,
    ).toBe(false);
  });

  it('keeps the composer after a failed compaction summary: the next message retries it', async () => {
    // A provider outage or timeout on the summary request is not a transcript
    // that cannot fit, so it must not close the conversation for good.
    openFailedConversation('CONTEXT_BUDGET_EXCEEDED:summary_failed');
    const container = await mountChat();

    const input = container.querySelector<HTMLElement>(COMPOSER_INPUT)!;
    expect(input.getAttribute('aria-disabled')).toBeNull();
    expect(input.getAttribute('aria-placeholder')).toBe('workbench.chat.continuePlaceholder');
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="workbench-attach"]')!.disabled,
    ).toBe(false);
  });
});
