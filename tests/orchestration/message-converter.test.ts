import { describe, test, expect } from 'vitest';
import { convertMessagesToOpenAI } from '@/lib/orchestration/summarizers/message-converter';
import type { StatelessChatRequest } from '@/lib/types/chat';

type UIMsg = StatelessChatRequest['messages'][number];

function userMsg(parts: unknown[], metadata: Record<string, unknown> = {}): UIMsg {
  return {
    role: 'user',
    content: '',
    parts,
    metadata,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
  } as any;
}

function assistantMsg(
  parts: unknown[],
  metadata: Record<string, unknown> = {},
): UIMsg {
  return {
    role: 'assistant',
    content: '',
    parts,
    metadata,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
  } as any;
}

describe('convertMessagesToOpenAI — text-only (backwards compatibility)', () => {
  test('user text message becomes a plain string content', () => {
    const msgs: UIMsg[] = [userMsg([{ type: 'text', text: 'hello world' }])];
    const out = convertMessagesToOpenAI(msgs);
    expect(out).toEqual([{ role: 'user', content: 'hello world' }]);
  });

  test('assistant with text + action parts stays a string (JSON array serialization)', () => {
    const msgs: UIMsg[] = [
      assistantMsg([
        { type: 'text', text: 'Here you go.' },
        {
          type: 'action-wb_draw_text',
          actionName: 'wb_draw_text',
          state: 'result',
          output: { success: true, data: { id: 'abc' } },
        },
      ]),
    ];
    const out = convertMessagesToOpenAI(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    expect(typeof out[0].content).toBe('string');
    expect(out[0].content).toContain('Here you go.');
    expect(out[0].content).toContain('wb_draw_text');
  });

  test('empty / whitespace-only user message is dropped', () => {
    const msgs: UIMsg[] = [userMsg([{ type: 'text', text: '...' }])];
    expect(convertMessagesToOpenAI(msgs)).toEqual([]);
  });

  test('interrupted assistant is passed through as user with interruption suffix', () => {
    const msgs: UIMsg[] = [
      userMsg([{ type: 'text', text: 'ok' }], { interrupted: true }),
    ];
    const out = convertMessagesToOpenAI(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain('interrupted');
  });
});

describe('convertMessagesToOpenAI — image attachments', () => {
  test('user message with a data: URL image → base64 payload + mediaType (data prefix stripped)', () => {
    const msgs: UIMsg[] = [
      userMsg([
        { type: 'text', text: 'Please look at this.' },
        {
          type: 'file',
          mediaType: 'image/png',
          url: 'data:image/png;base64,iVBORw0KGgo=',
        },
      ]),
    ];
    const out = convertMessagesToOpenAI(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(Array.isArray(out[0].content)).toBe(true);
    const parts = out[0].content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: 'Please look at this.' });
    // The data URL prefix must be stripped — AI SDK rejects `data:` strings
    // as invalid download URLs.
    expect(parts[1]).toEqual({
      type: 'image',
      image: 'iVBORw0KGgo=',
      mediaType: 'image/png',
    });
  });

  test('http URL image passes through unchanged', () => {
    const msgs: UIMsg[] = [
      userMsg([
        {
          type: 'file',
          mediaType: 'image/png',
          url: 'https://example.com/board.png',
        },
      ]),
    ];
    const out = convertMessagesToOpenAI(msgs);
    expect(out).toHaveLength(1);
    const parts = out[0].content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'image',
      image: 'https://example.com/board.png',
      mediaType: 'image/png',
    });
  });

  test('non-image file parts (pdf) are ignored (image-only experiment scope)', () => {
    const msgs: UIMsg[] = [
      userMsg([
        { type: 'text', text: 'summary?' },
        {
          type: 'file',
          mediaType: 'application/pdf',
          url: 'data:application/pdf;base64,XXX',
        },
      ]),
    ];
    const out = convertMessagesToOpenAI(msgs);
    expect(out[0].content).toBe('summary?');
  });

  test('image attachment on a message with empty text is retained (not filtered as empty)', () => {
    const msgs: UIMsg[] = [
      userMsg([
        {
          type: 'file',
          mediaType: 'image/png',
          url: 'data:image/png;base64,AA',
        },
      ]),
    ];
    const out = convertMessagesToOpenAI(msgs);
    expect(out).toHaveLength(1);
  });
});
