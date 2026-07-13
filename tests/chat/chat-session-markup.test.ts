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
});
