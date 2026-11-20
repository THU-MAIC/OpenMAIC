// @vitest-environment jsdom
/**
 * The compaction divider opened in a real DOM: the summary and the admission
 * counts only exist behind the toggle, so a static render cannot reach them.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatTimeline } from '@/components/workbench/chat/chat-timeline';
import { createWorkbenchTranslator } from '@/lib/i18n/workbench';
import type { ChatNode } from '@/lib/workbench/session-store';

const divider: ChatNode = {
  key: 'e45',
  kind: 'compaction',
  text: '',
  copyKey: 'workbench.system.contextCompacted',
  compactionSummary: '## Goal\nThe learner is loading physics notes in batches.',
  compactionTokensBefore: 33_171,
  compactionTokensAfter: 29_380,
  compactionMessagesBefore: 7,
  compactionMessagesAfter: 6,
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const toggle = () =>
  container.querySelector<HTMLButtonElement>(
    '[data-testid="workbench-compaction-divider"] button',
  )!;

describe('compaction divider disclosure', () => {
  it('opens to the summary with before → after counts, and closes again', async () => {
    await act(async () =>
      root.render(
        createElement(ChatTimeline, {
          chat: [divider],
          plan: [],
          t: createWorkbenchTranslator('en-US'),
        }),
      ),
    );
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('The learner is loading');

    await act(async () => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    const text = container.textContent ?? '';
    // messagesAfter counts the summary plus the kept tail: the divider states
    // the change, never "7 messages summarized" when only two were.
    expect(text).toContain(
      `Context: 7 → 6 messages · about ${(33_171).toLocaleString()} → ${(29_380).toLocaleString()} tokens`,
    );
    expect(text).toContain('The learner is loading physics notes in batches.');

    await act(async () => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('The learner is loading');
  });

  it('shows the summary without a count line when the frame carried no counts', async () => {
    const bare: ChatNode = {
      key: 'e46',
      kind: 'compaction',
      text: '',
      copyKey: 'workbench.system.contextCompacted',
      compactionSummary: 'Older turns summarized.',
    };
    await act(async () =>
      root.render(
        createElement(ChatTimeline, {
          chat: [bare],
          plan: [],
          t: createWorkbenchTranslator('en-US'),
        }),
      ),
    );
    await act(async () => toggle().click());
    const text = container.textContent ?? '';
    expect(text).toContain('Older turns summarized.');
    expect(text).not.toContain('Context:');
  });
});
