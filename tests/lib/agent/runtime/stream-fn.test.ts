/**
 * Tests for the promoted stream-fn adapter — `toModelMessages` conversion.
 */
import { describe, it, expect } from 'vitest';
import { toModelMessages, createPartMapper } from '@/lib/agent/runtime/stream-fn';
import type { ToolCallProviderMetadata } from '@/lib/agent/runtime/provider-metadata';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Message as PiMessage,
  ToolCall,
} from '@earendil-works/pi-ai';

function emptyPartial(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'unknown' as never,
    provider: 'unknown' as never,
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  };
}

describe('createPartMapper — reasoning/thinking channel', () => {
  it('maps reasoning-delta parts to thinking_start + thinking_delta and accumulates a thinking content block', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));

    mapper.handle({ type: 'reasoning-start' });
    mapper.handle({ type: 'reasoning-delta', text: 'We ' });
    mapper.handle({ type: 'reasoning-delta', text: 'think' });

    const types = events.map((e) => e.type);
    expect(types).toEqual(['thinking_start', 'thinking_delta', 'thinking_delta']);
    expect(partial.content).toHaveLength(1);
    expect(partial.content[0]).toEqual({ type: 'thinking', thinking: 'We think' });
  });

  it('emits thinking_end with the full reasoning when the reasoning part ends', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));

    mapper.handle({ type: 'reasoning-delta', text: 'done' });
    mapper.handle({ type: 'reasoning-end' });

    const end = events.find((e) => e.type === 'thinking_end') as Extract<
      AssistantMessageEvent,
      { type: 'thinking_end' }
    >;
    expect(end).toBeDefined();
    expect(end.content).toBe('done');
  });

  it('keeps thinking and text as separate content blocks, thinking first', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));

    mapper.handle({ type: 'reasoning-delta', text: 'reasoning' });
    mapper.handle({ type: 'reasoning-end' });
    mapper.handle({ type: 'text-delta', text: 'answer' });
    mapper.finalize();

    expect(partial.content).toEqual([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'answer' },
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual(['thinking_start', 'thinking_delta', 'thinking_end', 'text_start', 'text_delta', 'text_end']);
  });

  it('finalize closes an unterminated thinking block', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));
    mapper.handle({ type: 'reasoning-delta', text: 'x' });
    mapper.finalize();
    expect(events.some((e) => e.type === 'thinking_end')).toBe(true);
  });

  it('ignores empty reasoning deltas (no thinking block created)', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));
    mapper.handle({ type: 'reasoning-delta', text: '' });
    expect(events).toHaveLength(0);
    expect(partial.content).toHaveLength(0);
  });
});

describe('toModelMessages', () => {
  it('converts assistant toolCall with providerMetadata to tool-call part with providerOptions', () => {
    const toolCallWithMeta: ToolCall & { providerMetadata?: ToolCallProviderMetadata } = {
      type: 'toolCall',
      id: 'call-1',
      name: 'myTool',
      arguments: { x: 1 },
      providerMetadata: { google: { thoughtSignature: 's' } },
    };

    const messages: PiMessage[] = [
      {
        role: 'assistant',
        content: [toolCallWithMeta],
        api: 'unknown' as never,
        provider: 'unknown' as never,
        model: 'test',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 0,
      },
    ];

    const result = toModelMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    const parts = (result[0] as { content: Array<Record<string, unknown>> }).content;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('tool-call');
    expect(parts[0].toolCallId).toBe('call-1');
    expect(parts[0].toolName).toBe('myTool');
    expect(parts[0].providerOptions).toEqual({ google: { thoughtSignature: 's' } });
  });

  it('converts toolResult message to AI SDK tool role message', () => {
    const messages: PiMessage[] = [
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'myTool',
        content: [{ type: 'text', text: 'result text' }],
        isError: false,
        timestamp: 0,
      },
    ];

    const result = toModelMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('tool');
    const content = (result[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('tool-result');
    expect(content[0].toolCallId).toBe('call-1');
    expect(content[0].toolName).toBe('myTool');
    expect(content[0].output).toEqual({ type: 'text', value: 'result text' });
  });
});
