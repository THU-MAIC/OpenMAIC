import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatSessionComponent } from '@/components/chat/chat-session';
import type { ChatSession } from '@/lib/types/chat';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('ChatSessionComponent markup contract', () => {
  it('preserves newlines in the shared message text wrapper', () => {
    const session: ChatSession = {
      id: 'session-1',
      type: 'qa',
      title: 'Q&A',
      status: 'active',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'first line\nsecond line' }],
          metadata: { originalRole: 'user', senderName: 'You' },
        },
      ],
      config: { agentIds: ['default-1'] },
      toolCalls: [],
      pendingToolCalls: [],
      createdAt: 1,
      updatedAt: 1,
    };

    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, { session, isActive: false }),
    );

    expect(html).toContain('class="whitespace-pre-wrap break-words"');
    expect(html).toContain('first line\nsecond line');
  });

  it('renders the Native Child web calls as named icon-only markers alongside its text', () => {
    const session: ChatSession = {
      id: 'session',
      type: 'qa',
      title: 'Q&A',
      status: 'active',
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          parts: [
            { type: 'action-web_search', actionName: 'web_search', state: 'result' },
            { type: 'action-fetch_url', actionName: 'fetch_url', state: 'result' },
            { type: 'text', text: 'The page describes the procedure.' },
          ] as unknown as ChatSession['messages'][number]['parts'],
          metadata: { agentId: 'teacher', originalRole: 'agent' },
        },
      ],
      config: { agentIds: ['teacher'] },
      toolCalls: [],
      pendingToolCalls: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, { session, isActive: false }),
    );
    expect(html).toMatch(
      /title="Searched the web".*title="Read a web page".*The page describes the procedure\./,
    );
    expect(html).toContain('w-4 h-4 rounded-full border align-middle mr-0.5');
    expect(html).not.toContain('mx-1 rounded-full border');
    expect(html).not.toMatch(/>(Search|Read)</);
  });

  it('renders separate stop and continue controls during soft-closing', () => {
    const session: ChatSession = {
      id: 'session-1',
      type: 'qa',
      title: 'Q&A',
      status: 'soft-closing',
      messages: [],
      config: { agentIds: ['default-1'] },
      toolCalls: [],
      pendingToolCalls: [],
      createdAt: 1,
      updatedAt: 1,
      softCloseDeadline: Date.now() + 15_000,
    };

    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, {
        session,
        isActive: true,
        onEndSession: vi.fn(),
        onContinueSession: vi.fn(),
      }),
    );

    expect(html).toContain('chat.endQA');
    expect(html).toContain('chat.softClosing');
    expect(html).not.toContain('animate-ping');
  });
});
