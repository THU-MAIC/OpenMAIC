/**
 * Tests for the promoted stream-fn adapter — `toModelMessages` conversion.
 */
import { describe, it, expect } from 'vitest';
import {
  toModelMessages,
  createPartMapper,
  createCallLlmStreamFn,
} from '@/lib/agent/runtime/stream-fn';
import { getModel } from '@/lib/ai/providers';
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
    expect(types).toEqual([
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_end',
    ]);
  });

  it('finalize closes an unterminated thinking block', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));
    mapper.handle({ type: 'reasoning-delta', text: 'x' });
    mapper.finalize();
    expect(events.some((e) => e.type === 'thinking_end')).toBe(true);
  });

  it('opens a SECOND thinking block when reasoning resumes after it ended (same turn)', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));

    mapper.handle({ type: 'reasoning-delta', text: 'first' });
    mapper.handle({ type: 'reasoning-end' });
    mapper.handle({ type: 'text-delta', text: 'answer' });
    mapper.handle({ type: 'reasoning-delta', text: 'second' });
    mapper.handle({ type: 'reasoning-end' });
    mapper.finalize();

    // Two distinct thinking blocks, not one merged block.
    const thinking = partial.content.filter((c) => (c as { type: string }).type === 'thinking');
    expect(thinking).toEqual([
      { type: 'thinking', thinking: 'first' },
      { type: 'thinking', thinking: 'second' },
    ]);
    expect(events.filter((e) => e.type === 'thinking_start')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'thinking_end')).toHaveLength(2);
  });

  it('preserves order for a reasoning→text→reasoning→text interleave in one turn', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));

    mapper.handle({ type: 'reasoning-delta', text: 'r1' });
    mapper.handle({ type: 'reasoning-end' });
    mapper.handle({ type: 'text-delta', text: 't1' });
    mapper.handle({ type: 'reasoning-delta', text: 'r2' });
    mapper.handle({ type: 'reasoning-end' });
    mapper.handle({ type: 'text-delta', text: 't2' });
    mapper.finalize();

    // Stream order must be preserved as four distinct blocks — t2 must NOT be
    // merged back into the first text block.
    expect(partial.content).toEqual([
      { type: 'thinking', thinking: 'r1' },
      { type: 'text', text: 't1' },
      { type: 'thinking', thinking: 'r2' },
      { type: 'text', text: 't2' },
    ]);
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
  it('preserves assistant thinking as an AI SDK reasoning part', () => {
    const messages: PiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'keep this reasoning' },
          { type: 'text', text: 'answer' },
        ],
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
      },
    ];

    const result = toModelMessages(messages, { includeReasoning: true });
    expect((result[0] as { content: unknown }).content).toEqual([
      { type: 'reasoning', text: 'keep this reasoning' },
      { type: 'text', text: 'answer' },
    ]);
  });

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

  it('encodes failed toolResult content as AI SDK error-text', () => {
    const messages: PiMessage[] = [
      {
        role: 'toolResult',
        toolCallId: 'call-error',
        toolName: 'myTool',
        content: [{ type: 'text', text: 'failure detail' }],
        isError: true,
        timestamp: 0,
      },
    ];

    const result = toModelMessages(messages);
    const content = (result[0] as { content: Array<Record<string, unknown>> }).content;

    expect(content[0].output).toEqual({ type: 'error-text', value: 'failure detail' });
  });
});

describe('createCallLlmStreamFn — reasoning round-trip on the driver wire', () => {
  function sseBody(chunks: unknown[]): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }

  function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
    return {
      id: 'chatcmpl-driver',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-v4-pro',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  function priorTurnMessages(): PiMessage[] {
    return [
      {
        role: 'user',
        content: [{ type: 'text', text: 'find it' }],
        timestamp: 0,
      },
      {
        ...emptyPartial(),
        content: [
          { type: 'thinking', thinking: 'use the lookup tool' },
          { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: {} },
        ],
      } as PiMessage,
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'lookup',
        content: [{ type: 'text', text: '{"found":true}' }],
        isError: false,
        timestamp: 0,
      } as PiMessage,
    ];
  }

  function emptyThinkingTurnMessages(): PiMessage[] {
    return [
      {
        role: 'user',
        content: [{ type: 'text', text: 'find it' }],
        timestamp: 0,
      },
      {
        ...emptyPartial(),
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: {} },
        ],
      } as PiMessage,
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'lookup',
        content: [{ type: 'text', text: '{"found":true}' }],
        isError: false,
        timestamp: 0,
      } as PiMessage,
    ];
  }

  async function driveDeepseekTurn(
    thinkingConfig?: { enabled?: boolean },
    messages: PiMessage[] = priorTurnMessages(),
  ) {
    const requestBodies: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseBody([chunk({ content: 'done' }), chunk({}, 'stop')]);
    }) as typeof globalThis.fetch;

    try {
      const { model } = getModel({
        providerId: 'deepseek',
        modelId: 'deepseek-v4-pro',
        apiKey: 'sk-test',
      });
      const streamFn = createCallLlmStreamFn({
        languageModel: model,
        thinkingConfig,
        omitMaxOutputTokens: true,
      });
      const stream = streamFn(
        { id: 'maic-connector' } as never,
        { systemPrompt: 'sys', messages },
        undefined,
      );
      for await (const _event of stream as unknown as AsyncIterable<unknown>) {
        void _event;
      }
      return requestBodies;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it('carries the prior thinking block as reasoning_content when thinking is on', async () => {
    const requestBodies = await driveDeepseekTurn({ enabled: true });

    expect(requestBodies).toHaveLength(1);
    const assistant = (requestBodies[0]?.messages as Array<Record<string, unknown>>).find(
      (message) => message.role === 'assistant',
    );
    expect(assistant?.reasoning_content).toBe('use the lookup tool');
  });

  it('strips the private marker instead of shipping it on a disabled turn', async () => {
    const requestBodies = await driveDeepseekTurn({ enabled: false });

    expect(requestBodies).toHaveLength(1);
    const assistant = (requestBodies[0]?.messages as Array<Record<string, unknown>>).find(
      (message) => message.role === 'assistant',
    );
    expect(assistant?.reasoning_content).toBeUndefined();
    expect(String(assistant?.content ?? '')).not.toContain('openmaic:kimi-reasoning');
  });

  it('round-trips an empty prior thinking block as an empty field without the marker', async () => {
    const requestBodies = await driveDeepseekTurn({ enabled: true }, emptyThinkingTurnMessages());

    expect(requestBodies).toHaveLength(1);
    const assistant = (requestBodies[0]?.messages as Array<Record<string, unknown>>).find(
      (message) => message.role === 'assistant',
    );
    expect(assistant?.reasoning_content).toBe('');
    expect(String(assistant?.content ?? '')).not.toContain('openmaic:kimi-reasoning');
  });

  it('drops an empty prior thinking block without a trace on a disabled turn', async () => {
    const requestBodies = await driveDeepseekTurn({ enabled: false }, emptyThinkingTurnMessages());

    expect(requestBodies).toHaveLength(1);
    const assistant = (requestBodies[0]?.messages as Array<Record<string, unknown>>).find(
      (message) => message.role === 'assistant',
    );
    expect(assistant?.reasoning_content).toBeUndefined();
    expect(String(assistant?.content ?? '')).not.toContain('openmaic:kimi-reasoning');
  });
});
