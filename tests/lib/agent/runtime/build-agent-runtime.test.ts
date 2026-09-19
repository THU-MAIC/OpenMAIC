import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

import { buildAgent } from '@/lib/agent/runtime/build-agent';
import { createCallLlmStreamFn, hasLengthToolCallProvenance } from '@/lib/agent/runtime/stream-fn';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};

function finish(finishReason: string) {
  return { type: 'finish', finishReason, totalUsage: ZERO_USAGE };
}

function toolCall(args: unknown = { value: 1 }) {
  return {
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'demo',
    input: args,
  };
}

function resultFrom(parts: Array<Record<string, unknown>>) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    usage: new Promise(() => {}),
  };
}

function useResponses(responses: Array<Array<Record<string, unknown>>>) {
  mocks.streamLLM.mockImplementation(() => {
    const parts = responses.shift();
    return resultFrom(
      parts ?? [{ type: 'text-delta', text: 'unexpected transport' }, finish('stop')],
    );
  });
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
}

function makeTool(
  execute: AgentTool<typeof DemoParams>['execute'] = async () => ({
    content: [{ type: 'text', text: 'ok' }],
    details: { source: 'tool' },
  }),
): AgentTool<typeof DemoParams> {
  return {
    name: 'demo',
    label: 'Demo',
    description: 'Test tool',
    parameters: DemoParams,
    execute,
  };
}

const DemoParams = Type.Object({ value: Type.Number() });

function makeAgent(options: {
  tool?: AgentTool<typeof DemoParams>;
  afterToolCall?: Parameters<typeof buildAgent>[0]['afterToolCall'];
  allowedToolNames?: ReadonlySet<string>;
}) {
  return buildAgent({
    streamFn: createCallLlmStreamFn({ languageModel: {} as never }),
    systemPrompt: 'system',
    tools: [options.tool ?? makeTool()],
    allowedToolNames: options.allowedToolNames ?? new Set(['demo']),
    afterToolCall: options.afterToolCall,
  });
}

function transportMessages(index: number) {
  const params = mocks.streamLLM.mock.calls[index]?.[0] as { messages?: unknown[] } | undefined;
  return params?.messages ?? [];
}

function toolOutputType(index: number): unknown {
  const toolMessage = transportMessages(index).find(
    (message) => (message as { role?: string }).role === 'tool',
  ) as { content?: Array<{ output?: { type?: string } }> } | undefined;
  return toolMessage?.content?.[0]?.output?.type;
}

describe('buildAgent shared transport lifecycle', () => {
  beforeEach(() => mocks.streamLLM.mockReset());

  it('executes an ordinary toolUse once and continues through the same Agent loop', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'tool success' }],
      details: { source: 'tool' },
    }));
    useResponses([
      [toolCall(), finish('tool-calls')],
      [{ type: 'text-delta', text: 'complete' }, finish('stop')],
    ]);
    const agent = makeAgent({ tool: makeTool(execute) });

    await agent.prompt('start');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    expect(toolOutputType(1)).toBe('text');
  });

  it('makes length plus parsed toolCall terminal and side-effect-free', async () => {
    let actionCount = 0;
    const execute = vi.fn(async () => {
      actionCount += 1;
      return {
        content: [{ type: 'text' as const, text: 'must not run' }],
        details: {},
      };
    });
    const allowlistHas = vi.fn(() => true);
    const allowedToolNames = { has: allowlistHas } as unknown as ReadonlySet<string>;
    const afterToolCall = vi.fn();
    useResponses([[toolCall(), finish('length')]]);
    const agent = makeAgent({ tool: makeTool(execute), afterToolCall, allowedToolNames });

    await agent.prompt('start');

    const final = agent.state.messages.at(-1);
    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(allowlistHas).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(afterToolCall).not.toHaveBeenCalled();
    expect(actionCount).toBe(0);
    expect(final?.role).toBe('assistant');
    if (final?.role !== 'assistant') throw new Error('expected assistant message');
    expect(final.stopReason).toBe('length');
    expect(final.content.some((content) => content.type === 'toolCall')).toBe(false);
    expect(hasLengthToolCallProvenance(final)).toBe(true);
    expect(JSON.stringify(final)).not.toContain('provenance');
  });

  it('clears undrained queues and silently suppresses terminal-window queue calls', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.streamLLM.mockReturnValue({
      fullStream: (async function* () {
        await gate;
        yield toolCall();
        yield finish('length');
      })(),
      usage: new Promise(() => {}),
    });
    const agent = makeAgent({});
    agent.followUp(userMessage('pre-run follow-up'));
    agent.subscribe((event) => {
      if (event.type !== 'turn_end') return;
      expect(() => agent.steer(userMessage('listener steering'))).not.toThrow();
      expect(() => agent.followUp(userMessage('listener follow-up'))).not.toThrow();
    });

    const prompt = agent.prompt('start');
    await vi.waitFor(() => expect(mocks.streamLLM).toHaveBeenCalledTimes(1));
    agent.steer(userMessage('streaming steering'));
    agent.followUp(userMessage('streaming follow-up'));
    release();
    await prompt;

    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it('keeps pre-run steering that Pi drains into the initial provider request', async () => {
    useResponses([[toolCall(), finish('length')]]);
    const agent = makeAgent({});
    agent.steer(userMessage('pre-run steering'));

    await agent.prompt('start');

    const userText = transportMessages(0)
      .filter((message) => (message as { role?: string }).role === 'user')
      .map((message) => JSON.stringify(message))
      .join(' ');
    expect(userText).toContain('start');
    expect(userText).toContain('pre-run steering');
    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
  });

  it('preserves existing queue semantics for plain length', async () => {
    useResponses([
      [{ type: 'text-delta', text: 'truncated' }, finish('length')],
      [{ type: 'text-delta', text: 'follow-up complete' }, finish('stop')],
    ]);
    const agent = makeAgent({});
    agent.followUp(userMessage('queued follow-up'));

    await agent.prompt('start');

    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    const firstAssistant = agent.state.messages.find(
      (message) => message.role === 'assistant' && message.stopReason === 'length',
    );
    expect(firstAssistant?.role).toBe('assistant');
    if (firstAssistant?.role !== 'assistant') throw new Error('expected assistant message');
    expect(hasLengthToolCallProvenance(firstAssistant)).toBe(false);
  });

  it('restores queue methods after agent_end for the next independent run', async () => {
    useResponses([
      [toolCall(), finish('length')],
      [{ type: 'text-delta', text: 'next run' }, finish('stop')],
    ]);
    const agent = makeAgent({});

    await agent.prompt('start');
    agent.followUp(userMessage('after agent end'));
    expect(agent.hasQueuedMessages()).toBe(true);
    await agent.continue();

    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it('normalizes only an own boolean isError true before caller hooks', async () => {
    const details = { source: 'existing-tool' };
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'existing failure' }],
      details,
      isError: true,
    }));
    const afterToolCall = vi.fn((context: { isError: boolean }) => {
      expect(context.isError).toBe(true);
      return { isError: false };
    });
    useResponses([
      [toolCall(), finish('tool-calls')],
      [{ type: 'text-delta', text: 'acknowledged' }, finish('stop')],
    ]);
    const agent = makeAgent({
      tool: makeTool(execute as never),
      afterToolCall: afterToolCall as never,
    });

    await agent.prompt('start');

    const toolResult = agent.state.messages.find((message) => message.role === 'toolResult');
    expect(afterToolCall).toHaveBeenCalledTimes(1);
    expect(toolResult).toMatchObject({
      role: 'toolResult',
      isError: true,
      content: [{ type: 'text', text: 'existing failure' }],
      details,
    });
    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    expect(toolOutputType(1)).toBe('error-text');
  });

  it.each([
    {
      name: 'inherited marker',
      makeResult: () =>
        Object.assign(Object.create({ isError: true }), {
          content: [{ type: 'text' as const, text: 'not an error' }],
          details: {},
        }),
    },
    {
      name: 'nested marker',
      makeResult: () => ({
        content: [{ type: 'text' as const, text: 'not an error' }],
        details: { isError: true },
      }),
    },
    {
      name: 'truthy string marker',
      makeResult: () => ({
        content: [{ type: 'text' as const, text: 'not an error' }],
        details: {},
        isError: 'true',
      }),
    },
    {
      name: 'numeric marker',
      makeResult: () => ({
        content: [{ type: 'text' as const, text: 'not an error' }],
        details: {},
        isError: 1,
      }),
    },
    {
      name: 'own boolean false marker',
      makeResult: () => ({
        content: [{ type: 'text' as const, text: 'not an error' }],
        details: {},
        isError: false,
      }),
    },
    {
      name: 'error-like text',
      makeResult: () => ({
        content: [{ type: 'text' as const, text: 'ERROR: looks bad' }],
        details: {},
      }),
    },
  ])('does not infer failure from $name', async ({ makeResult }) => {
    const observed: boolean[] = [];
    useResponses([
      [toolCall(), finish('tool-calls')],
      [{ type: 'text-delta', text: 'complete' }, finish('stop')],
    ]);
    const agent = makeAgent({
      tool: makeTool(vi.fn(async () => makeResult()) as never),
      afterToolCall: (context) => {
        observed.push(context.isError);
        return undefined;
      },
    });

    await agent.prompt('start');

    expect(observed).toEqual([false]);
    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    expect(toolOutputType(1)).toBe('text');
  });

  it('keeps caller error promotion monotonic for an ordinary success', async () => {
    useResponses([
      [toolCall(), finish('tool-calls')],
      [{ type: 'text-delta', text: 'complete' }, finish('stop')],
    ]);
    const agent = makeAgent({ afterToolCall: () => ({ isError: true }) });

    await agent.prompt('start');

    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    expect(toolOutputType(1)).toBe('error-text');
  });

  it.each(['handler throw', 'schema rejection', 'hook throw'] as const)(
    'encodes Pi-recognized failure from %s as error-text',
    async (caseName) => {
      const execute =
        caseName === 'handler throw'
          ? vi.fn(async () => {
              throw new Error('handler failed');
            })
          : vi.fn(async () => ({
              content: [{ type: 'text' as const, text: 'ok' }],
              details: {},
            }));
      useResponses([
        [
          toolCall(caseName === 'schema rejection' ? { value: 'bad' } : undefined),
          finish('tool-calls'),
        ],
        [{ type: 'text-delta', text: 'complete' }, finish('stop')],
      ]);
      const agent = makeAgent({
        tool: makeTool(execute as never),
        afterToolCall:
          caseName === 'hook throw'
            ? () => {
                throw new Error('hook failed');
              }
            : undefined,
      });

      await agent.prompt('start');

      if (caseName === 'schema rejection') expect(execute).not.toHaveBeenCalled();
      expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
      expect(toolOutputType(1)).toBe('error-text');
    },
  );
});
