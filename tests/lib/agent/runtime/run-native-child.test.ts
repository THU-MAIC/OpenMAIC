import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from '@earendil-works/pi-ai';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';
import { runNativeChild } from '@/lib/agent/runtime/run-native-child';
import { buildNativeSpotlightTool } from '@/lib/chat/pi/tools/native-spotlight';
import type { AgentConfig } from '@/lib/orchestration/registry/types';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const teacher: AgentConfig = {
  id: 'teacher-1',
  name: 'Teacher',
  role: 'teacher',
  persona: 'Teach clearly.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['spotlight'],
  priority: 10,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  isDefault: true,
};

function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'test-model',
    usage: EMPTY_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function text(value: string) {
  return assistant([{ type: 'text', text: value }]);
}

function call(id: string, name = 'demo', args: Record<string, unknown> = { value: 1 }) {
  return assistant([{ type: 'toolCall', id, name, arguments: args }], 'toolUse');
}

function calls(
  ...toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
) {
  return assistant(
    toolCalls.map((toolCall) => ({ type: 'toolCall' as const, ...toolCall })),
    'toolUse',
  );
}

function scriptedStream(
  messages: AssistantMessage[],
  contexts: Context[] = [],
  emitTextDeltas = false,
): StreamFn {
  return ((_model, context) => {
    contexts.push(context);
    const stream = createAssistantMessageEventStream();
    const message = messages.shift() ?? text('unexpected transport');
    queueMicrotask(() => {
      const textContent = message.content.find((content) => content.type === 'text');
      if (emitTextDeltas && textContent?.type === 'text' && textContent.text) {
        const partial = {
          ...message,
          content: [{ type: 'text' as const, text: textContent.text }],
        };
        stream.push({ type: 'start', partial });
        stream.push({ type: 'text_start', contentIndex: 0, partial });
        stream.push({
          type: 'text_delta',
          contentIndex: 0,
          delta: textContent.text,
          partial,
        });
        stream.push({ type: 'text_end', contentIndex: 0, content: textContent.text, partial });
      }
      stream.push({
        type: 'done',
        reason: message.stopReason as 'stop' | 'length' | 'toolUse',
        message,
      });
    });
    return stream;
  }) as StreamFn;
}

function deltaStream(value: string): StreamFn {
  return ((_model, _context) => {
    const stream = createAssistantMessageEventStream();
    const message = text(value);
    const partial = { ...message, content: [{ type: 'text' as const, text: value }] };
    queueMicrotask(() => {
      stream.push({ type: 'start', partial });
      stream.push({ type: 'text_start', contentIndex: 0, partial });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: value, partial });
      stream.push({ type: 'text_end', contentIndex: 0, content: value, partial });
      stream.push({ type: 'done', reason: 'stop', message });
    });
    return stream;
  }) as StreamFn;
}

const DemoParams = Type.Object({ value: Type.Number() });

function demoTool(
  execute: AgentTool<typeof DemoParams>['execute'] = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    details: {},
  })),
): AgentTool<typeof DemoParams> {
  return {
    name: 'demo',
    label: 'Demo',
    description: 'Demo tool',
    parameters: DemoParams,
    executionMode: 'sequential',
    execute,
  };
}

function run(options: Partial<Parameters<typeof runNativeChild>[0]> = {}) {
  const tool = demoTool();
  return runNativeChild({
    streamFn: scriptedStream([text('done')]),
    systemPrompt: 'system',
    prompt: 'prompt',
    tools: [tool],
    allowedToolNames: new Set(['demo']),
    timeoutMs: 1_000,
    maxToolCallAttempts: 4,
    maxProviderTransports: 5,
    ...options,
  });
}

describe('runNativeChild', () => {
  it('keeps the tool result in the same Child history and tracks all three counters', async () => {
    const contexts: Context[] = [];
    const onDispatchedAction = vi.fn();
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'accepted' }],
      details: { dispatchedAction: true },
    }));
    const result = await run({
      streamFn: scriptedStream([call('call-1'), text('Visible completion.')], contexts, true),
      tools: [demoTool(execute)],
      onDispatchedAction,
      onVisibleTextDelta: (delta) => delta,
    });

    expect(result).toMatchObject({
      status: 'completed',
      visibleOutput: 'Visible completion.',
      attemptCount: 1,
      executionCount: 1,
      dispatchedActionCount: 1,
      providerTransportCount: 2,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onDispatchedAction).toHaveBeenCalledTimes(1);
    expect(contexts[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'demo',
          isError: false,
        }),
      ]),
    );
  });

  it('accepts an action-only ordinary stop without fabricating visible text', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'accepted' }],
      details: { dispatchedAction: true },
    }));
    const result = await run({
      streamFn: scriptedStream([call('call-1'), text('')]),
      tools: [demoTool(execute)],
    });

    expect(result).toMatchObject({
      status: 'completed',
      visibleOutput: '',
      dispatchedActionCount: 1,
    });
  });

  it('fails a pure empty ordinary stop', async () => {
    await expect(run({ streamFn: scriptedStream([text('')]) })).resolves.toMatchObject({
      status: 'failed',
      stopReason: 'native_empty_response',
      dispatchedActionCount: 0,
    });
  });

  it('does not treat prior assistant history as current-run visible output', async () => {
    await expect(
      run({
        streamFn: scriptedStream([text('')]),
        history: [
          { role: 'user', content: 'earlier question', timestamp: 1 },
          assistant([{ type: 'text', text: 'earlier answer' }]),
        ],
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      stopReason: 'native_empty_response',
      visibleOutput: '',
    });
  });

  it('does not recover raw text that the visible-delivery callback filtered out', async () => {
    await expect(
      run({
        streamFn: deltaStream('###'),
        onVisibleTextDelta: () => '',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      stopReason: 'native_empty_response',
      visibleOutput: '',
    });
  });

  it.each([
    ['unknown', call('unknown-1', 'not_registered'), []],
    ['schema-invalid', call('invalid-1', 'demo', { value: 'bad' }), [demoTool()]],
  ])('charges one attempt but no execution for %s calls', async (_name, message, tools) => {
    const execute = tools[0]?.execute as ReturnType<typeof vi.fn> | undefined;
    const result = await run({
      streamFn: scriptedStream([message as AssistantMessage, text('recovered')]),
      tools: tools as AgentTool[],
      allowedToolNames: new Set(tools.map((tool) => tool.name)),
    });

    expect(result).toMatchObject({
      status: 'completed',
      attemptCount: 1,
      executionCount: 0,
      dispatchedActionCount: 0,
    });
    if (execute) expect(execute).not.toHaveBeenCalled();
  });

  it('charges an unauthorized registered call without entering its handler', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'must not execute' }],
      details: {},
    }));
    const result = await run({
      streamFn: scriptedStream([call('unauthorized-1'), text('recovered')]),
      tools: [demoTool(execute)],
      allowedToolNames: new Set(),
    });

    expect(result).toMatchObject({ attemptCount: 1, executionCount: 0 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('terminates a duplicate toolCallId without replaying the side effect', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'accepted' }],
      details: { dispatchedAction: true },
    }));
    const result = await run({
      streamFn: scriptedStream([call('same-id'), call('same-id')]),
      tools: [demoTool(execute)],
    });

    expect(result).toMatchObject({
      status: 'exhausted',
      stopReason: 'native_duplicate_tool_call',
      attemptCount: 2,
      executionCount: 1,
      dispatchedActionCount: 1,
      providerTransportCount: 2,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('classifies the fifth observation as over-budget without charging it', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'must not execute' }],
      details: {},
    }));
    const messages = [
      ...Array.from({ length: 4 }, (_, index) => call(`unknown-${index + 1}`, 'not_registered')),
      calls(
        { id: 'unknown-1', name: 'not_registered', arguments: {} },
        { id: 'later-same-batch', name: 'demo', arguments: { value: 1 } },
      ),
    ];
    const result = await run({
      streamFn: scriptedStream(messages),
      tools: [demoTool(execute)],
      allowedToolNames: new Set(['demo']),
    });

    expect(result).toMatchObject({
      status: 'exhausted',
      stopReason: 'native_tool_attempt_budget',
      attemptCount: 4,
      executionCount: 0,
      dispatchedActionCount: 0,
      providerTransportCount: 5,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not charge execution when the fifth observation is itself authorized and valid', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'must not execute' }],
      details: {},
    }));
    const messages = [
      ...Array.from({ length: 4 }, (_, index) => call(`unknown-${index + 1}`, 'not_registered')),
      calls(
        { id: 'fifth-valid', name: 'demo', arguments: { value: 1 } },
        { id: 'later-same-batch', name: 'demo', arguments: { value: 2 } },
      ),
    ];
    const result = await run({
      streamFn: scriptedStream(messages),
      tools: [demoTool(execute)],
      allowedToolNames: new Set(['demo']),
    });

    expect(result).toMatchObject({
      status: 'exhausted',
      stopReason: 'native_tool_attempt_budget',
      attemptCount: 4,
      executionCount: 0,
      dispatchedActionCount: 0,
      providerTransportCount: 5,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not impose a generic execution budget and continues after every admitted call', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      details: {},
    }));
    const result = await run({
      streamFn: scriptedStream([
        call('call-1'),
        call('call-2'),
        call('call-3'),
        call('call-4'),
        text('continued after four executions'),
      ]),
      tools: [demoTool(execute)],
    });

    expect(result).toMatchObject({
      status: 'completed',
      visibleOutput: 'continued after four executions',
      attemptCount: 4,
      executionCount: 4,
      providerTransportCount: 5,
    });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('settles a never-resolving transport at the internal deadline', async () => {
    const never: StreamFn = (() => new Promise(() => {})) as StreamFn;
    const result = await run({ streamFn: never, timeoutMs: 10 });

    expect(result).toMatchObject({
      status: 'exhausted',
      stopReason: 'native_timeout',
      providerTransportCount: 1,
    });
  });

  it('observes a provider rejection that loses to the internal deadline', async () => {
    let rejectProvider!: (reason: Error) => void;
    const pendingProvider = new Promise<never>((_resolve, reject) => {
      rejectProvider = reject;
    });
    const result = await run({ streamFn: (() => pendingProvider) as StreamFn, timeoutMs: 10 });

    expect(result).toMatchObject({
      status: 'exhausted',
      stopReason: 'native_timeout',
      providerTransportCount: 1,
    });
    rejectProvider(new Error('late provider rejection'));
    await Promise.resolve();
    expect(result.stopReason).toBe('native_timeout');
  });

  it('settles a pending tool at the deadline without counting a late action', async () => {
    let resolveTool!: (value: {
      content: [{ type: 'text'; text: string }];
      details: { dispatchedAction: true };
    }) => void;
    const pendingTool = new Promise<{
      content: [{ type: 'text'; text: string }];
      details: { dispatchedAction: true };
    }>((resolve) => {
      resolveTool = resolve;
    });
    const result = await run({
      streamFn: scriptedStream([call('call-1')]),
      tools: [demoTool(() => pendingTool)],
      timeoutMs: 10,
    });

    expect(result).toMatchObject({
      status: 'exhausted',
      stopReason: 'native_timeout',
      executionCount: 1,
      dispatchedActionCount: 0,
      providerTransportCount: 1,
    });
    resolveTool({
      content: [{ type: 'text', text: 'late' }],
      details: { dispatchedAction: true },
    });
    await Promise.resolve();
    expect(result.dispatchedActionCount).toBe(0);
  });

  it('observes a tool rejection that loses to the internal deadline', async () => {
    let rejectTool!: (reason: Error) => void;
    const pendingTool = new Promise<never>((_resolve, reject) => {
      rejectTool = reject;
    });
    const result = await run({
      streamFn: scriptedStream([call('call-1')]),
      tools: [demoTool(() => pendingTool)],
      timeoutMs: 10,
    });

    expect(result).toMatchObject({
      status: 'exhausted',
      stopReason: 'native_timeout',
      executionCount: 1,
      dispatchedActionCount: 0,
      providerTransportCount: 1,
    });
    rejectTool(new Error('late tool rejection'));
    await Promise.resolve();
    expect(result.stopReason).toBe('native_timeout');
  });

  it('settles a pending Native Spotlight dispatch at the deadline and observes late rejection', async () => {
    let rejectSend!: (reason: Error) => void;
    const pendingSend = new Promise<void>((_resolve, reject) => {
      rejectSend = reject;
    });
    const send = vi.fn(() => pendingSend);
    const onDispatchedAction = vi.fn();
    const spotlight = buildNativeSpotlightTool({
      agent: teacher,
      messageId: 'message-1',
      send,
      authorizedElementIds: new Set(['exact-element']),
    });
    const result = await run({
      streamFn: scriptedStream([call('spotlight-1', 'spotlight', { elementId: 'exact-element' })]),
      tools: [spotlight],
      allowedToolNames: new Set(['spotlight']),
      onDispatchedAction,
      timeoutMs: 10,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'exhausted',
      stopReason: 'native_timeout',
      attemptCount: 1,
      executionCount: 1,
      dispatchedActionCount: 0,
      providerTransportCount: 1,
    });
    expect(onDispatchedAction).not.toHaveBeenCalled();
    rejectSend(new Error('late dispatch rejection'));
    await Promise.resolve();
    expect(result).toMatchObject({ status: 'exhausted', dispatchedActionCount: 0 });
  });

  it('bounds a never-resolving visible-text delta callback with the same deadline', async () => {
    const result = await run({
      streamFn: deltaStream('pending delivery'),
      onVisibleTextDelta: () => new Promise(() => {}),
      timeoutMs: 10,
    });

    expect(result).toMatchObject({
      status: 'exhausted',
      stopReason: 'native_timeout',
      visibleOutput: '',
      providerTransportCount: 1,
    });
  });

  it('preserves caller-owned cancellation', async () => {
    const controller = new AbortController();
    const never: StreamFn = (() => new Promise(() => {})) as StreamFn;
    const pending = run({ streamFn: never, abortSignal: controller.signal });
    controller.abort('request cancelled');

    await expect(pending).resolves.toMatchObject({ status: 'cancelled', stopReason: 'aborted' });
  });
});
