import { describe, expect, it } from 'vitest';
import { deriveSessionTitle } from '@/lib/agent/client/agent-edit-session-types';
import type { SerializedMessage } from '@/lib/agent/client/serialize-thread';

const user = (text: string): SerializedMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

describe('deriveSessionTitle', () => {
  it('uses the first user text part', () => {
    expect(deriveSessionTitle([user('改一下标题颜色')], 'fallback')).toBe('改一下标题颜色');
  });

  it('truncates to 40 chars with ellipsis', () => {
    const long = 'x'.repeat(60);
    const title = deriveSessionTitle([user(long)], 'fallback');
    expect(title.length).toBeLessThanOrEqual(41);
    expect(title.endsWith('…')).toBe(true);
  });

  it('skips assistant messages and finds first user text', () => {
    const msgs: SerializedMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      user('真正的指令'),
    ];
    expect(deriveSessionTitle(msgs, 'fallback')).toBe('真正的指令');
  });

  it('falls back when no user text exists', () => {
    expect(deriveSessionTitle([], '未命名对话')).toBe('未命名对话');
    const toolOnly: SerializedMessage[] = [
      { role: 'user', content: [{ type: 'tool-call', toolCallId: 't', toolName: 'x', args: {} }] },
    ];
    expect(deriveSessionTitle(toolOnly, '未命名对话')).toBe('未命名对话');
  });

  it('trims whitespace/newlines', () => {
    expect(deriveSessionTitle([user('  多行\n指令  ')], 'fb')).toBe('多行 指令');
  });
});
