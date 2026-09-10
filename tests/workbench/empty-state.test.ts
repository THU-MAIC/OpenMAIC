import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  EMPTY_STATE_HINT,
  EMPTY_STATE_TITLE,
  shouldShowWorkbenchEmptyState,
  WorkbenchChatEmptyState,
} from '@/components/workbench/chat/empty-state';
import type { ChatNode } from '@/lib/workbench/session-store';
import { createWorkbenchTranslator } from '@/lib/i18n/workbench';
import { supportedLocales } from '@/lib/i18n/locales';

function userMessage(key = 'u1'): ChatNode {
  return { key, kind: 'user', text: '改一下' };
}

describe('shouldShowWorkbenchEmptyState', () => {
  it('shows the placeholder on an empty, idle conversation', () => {
    expect(shouldShowWorkbenchEmptyState({ chat: [], catchingUp: false, live: false })).toBe(true);
  });

  it('hides the placeholder the moment a message exists', () => {
    expect(
      shouldShowWorkbenchEmptyState({ chat: [userMessage()], catchingUp: false, live: false }),
    ).toBe(false);
  });

  it('hides the placeholder while the pane is still catching up', () => {
    expect(shouldShowWorkbenchEmptyState({ chat: [], catchingUp: true, live: false })).toBe(false);
  });

  it('shows it for a conversation that does not exist yet', () => {
    // A brand-new conversation has no session and therefore nothing to catch up
    // to. Reading the store's raw `replaying` here is what left it on a spinner
    // that nothing could turn off — see `catchingUp` in `WorkbenchChat`.
    expect(shouldShowWorkbenchEmptyState({ chat: [], catchingUp: false, live: false })).toBe(true);
  });

  it('hides the placeholder while a run is live or a send is in flight', () => {
    expect(shouldShowWorkbenchEmptyState({ chat: [], catchingUp: false, live: true })).toBe(false);
  });
});

describe('WorkbenchChatEmptyState', () => {
  it('renders a quiet two-line hint about describing the change', () => {
    const html = renderToStaticMarkup(createElement(WorkbenchChatEmptyState));
    expect(html).toContain('data-testid="workbench-chat-empty"');
    expect(html).toContain(EMPTY_STATE_TITLE);
    expect(html).toContain(EMPTY_STATE_HINT);
  });

  /**
   * The copy used to read "this course has no workbench record yet" — the
   * conversation described as the course's record, which is the binding the two
   * independent columns removed, restated in words. An empty conversation is a
   * NEW conversation, and the hint is where `@` is taught.
   */
  it('invites a new conversation instead of calling itself a course’s record', () => {
    for (const locale of supportedLocales.map((entry) => entry.code)) {
      const t = createWorkbenchTranslator(locale);
      const title = t('workbench.chat.emptyTitle');
      const hint = t('workbench.chat.emptyHint');
      expect(title.trim(), `${locale} title`).not.toBe('');
      expect(hint.trim(), `${locale} hint`).not.toBe('');
      // No key leaked through, and no "this course has no record" framing.
      expect(title).not.toContain('workbench.chat');
      expect(hint).not.toContain('workbench.chat');
      for (const bound of ['这节课', '這堂課', 'this classroom yet', 'workbench activity']) {
        expect(title, `${locale} title still binds the chat to a course`).not.toContain(bound);
        expect(hint, `${locale} hint still binds the chat to a course`).not.toContain(bound);
      }
    }
    // And the English hint names the affordance the user now needs.
    expect(createWorkbenchTranslator('en-US')('workbench.chat.emptyHint')).toContain('@');
  });
});
