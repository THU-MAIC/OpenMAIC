import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatSessionComponent } from '@/components/chat/chat-session';
import type { ChatSession } from '@/lib/types/chat';
import { WebEvidence } from '@/components/chat/web-evidence';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}));

describe('ChatSessionComponent markup contract', () => {
  it('renders retrieved page links and the actual partial range, without making unsafe links clickable', () => {
    const html = renderToStaticMarkup(
      createElement(WebEvidence, {
        active: false,
        items: [
          {
            id: 'read',
            kind: 'read',
            status: 'done',
            startedAt: 1,
            finishedAt: 2,
            url: 'https://example.com/page',
            title: '<b>Page title</b>',
            offset: 8000,
            chars: 8000,
            totalChars: 20000,
          },
          { id: 'bad', kind: 'read', status: 'error', startedAt: 1, url: 'javascript:alert(1)' },
          {
            id: 'unseen',
            kind: 'read',
            status: 'error',
            startedAt: 1,
            url: 'https://unseen.example/guess',
            reason: 'url_not_observed',
          },
        ],
      }),
    );
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('&lt;b&gt;Page title&lt;/b&gt;');
    expect(html).toContain(
      'chat.webEvidence.range {&quot;start&quot;:8001,&quot;end&quot;:16000,&quot;total&quot;:20000}',
    );
    expect(html).toContain('chat.webEvidence.unverified');
    expect(html).not.toContain('href="javascript:');
    // A read the trust gate refused is shown as text, never as a link.
    expect(html).toContain('https://unseen.example/guess');
    expect(html).not.toContain('href="https://unseen.example/guess"');
  });

  it("keeps an interrupted message's read stopped while a resumed session streams", () => {
    const session = (interrupted: boolean): ChatSession => ({
      id: 'session-1',
      type: 'qa',
      title: 'Q&A',
      status: 'active',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          parts: [{ type: 'text', text: '...' }],
          metadata: {
            originalRole: 'teacher',
            senderName: 'Teacher',
            interrupted,
            webEvidence: [
              {
                id: 'read',
                kind: 'read',
                status: 'running',
                startedAt: 1,
                url: 'https://example.com/page',
              },
            ],
          },
        },
      ],
      config: { agentIds: ['default-1'] },
      toolCalls: [],
      pendingToolCalls: [],
      createdAt: 1,
      updatedAt: 1,
    });
    const render = (interrupted: boolean) =>
      renderToStaticMarkup(
        createElement(ChatSessionComponent, {
          session: session(interrupted),
          isActive: true,
          isStreaming: true,
        }),
      );

    expect(render(false)).toContain('data-web-status="running"');
    const resumed = render(true);
    expect(resumed).toContain('data-web-status="cancelled"');
    expect(resumed).not.toContain('animate-spin');
  });

  it('does not leave a restored or interrupted source badge spinning', () => {
    const html = renderToStaticMarkup(
      createElement(WebEvidence, {
        active: false,
        items: [
          {
            id: 'read',
            kind: 'read',
            status: 'running',
            startedAt: 1,
            url: 'https://example.com/page',
          },
        ],
      }),
    );
    expect(html).toContain('data-web-status="cancelled"');
    expect(html).not.toContain('animate-spin');
    expect(html).not.toContain('chat.webEvidence.reading');
  });

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
