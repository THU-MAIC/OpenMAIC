import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

import { buildAgent } from '@/lib/agent/runtime/build-agent';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import {
  createTerminalToolGate,
  getTerminalToolGateSnapshot,
  TERMINAL_TOOL_GATE_SIGNAL,
  type TerminalToolGate,
} from '@/lib/agent/runtime/terminal-tool-gate';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};

const RequiredParams = Type.Object({ value: Type.Number() });

function finish(finishReason: string) {
  return { type: 'finish', finishReason, totalUsage: ZERO_USAGE };
}

function toolCall(
  toolName = 'required_action',
  input: unknown = { value: 1 },
  toolCallId = 'required-call-1',
) {
  return { type: 'tool-call', toolCallId, toolName, input };
}

function resultFrom(parts: Array<Record<string, unknown>>) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    usage: new Promise(() => {}),
  };
}

function useResponses(responses: Array<Array<Record<string, unknown>>>): void {
  mocks.streamLLM.mockImplementation(() => {
    const parts = responses.shift();
    return resultFrom(
      parts ?? [{ type: 'text-delta', text: 'unexpected second model call' }, finish('stop')],
    );
  });
}

function createGate(): TerminalToolGate {
  return createTerminalToolGate({
    requiredToolName: 'required_action',
    suppressAssistantTextBeforeTool: true,
    terminalAfterTool: true,
  });
}

function makeTool(
  execute: AgentTool<typeof RequiredParams>['execute'] = async () => ({
    content: [{ type: 'text', text: 'server presentation' }],
    details: { source: 'server' },
  }),
): AgentTool<typeof RequiredParams> {
  return {
    name: 'required_action',
    label: 'Required action',
    description: 'Required test action',
    parameters: RequiredParams,
    execute,
  };
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
}

function makeGuardedAgent(options: {
  gate?: TerminalToolGate;
  tool?: AgentTool<typeof RequiredParams>;
  afterToolCall?: Parameters<typeof buildAgent>[0]['afterToolCall'];
}) {
  const gate = options.gate ?? createGate();
  const tool = options.tool ?? makeTool();
  const agent = buildAgent({
    streamFn: createCallLlmStreamFn({
      languageModel: {} as never,
      terminalToolGate: gate,
    }),
    systemPrompt: 'system',
    tools: [tool],
    allowedToolNames: new Set([tool.name]),
    afterToolCall: options.afterToolCall,
    terminalToolGate: gate,
  });
  return { agent, gate };
}

async function collectStream(
  parts: Array<Record<string, unknown>>,
  options: { gate?: TerminalToolGate; tools?: AgentTool[] } = {},
) {
  mocks.streamLLM.mockReturnValue(resultFrom(parts));
  const gate = options.gate ?? createGate();
  const streamFn = createCallLlmStreamFn({
    languageModel: {} as never,
    terminalToolGate: gate,
  });
  const stream = await streamFn({} as never, {
    systemPrompt: 'system',
    messages: [],
    tools: options.tools ?? [makeTool()],
  });
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { gate, events, message: await stream.result() };
}

describe('TerminalToolGate stream boundary', () => {
  beforeEach(() => mocks.streamLLM.mockReset());

  it('drops reasoning plus text before and after the required tool call', async () => {
    const leak = 'MODEL_LEAK_ANSWER_42';
    const { events, message, gate } = await collectStream([
      { type: 'reasoning-delta', text: leak },
      { type: 'text-delta', text: leak },
      toolCall(),
      { type: 'text-delta', text: leak },
      finish('tool-calls'),
    ]);

    expect(events.map((event) => event.type)).toEqual([
      'start',
      'toolcall_start',
      'toolcall_end',
      'done',
    ]);
    expect(JSON.stringify(events)).not.toContain(leak);
    expect(JSON.stringify(message)).not.toContain(leak);
    expect(message.content).toEqual([
      expect.objectContaining({ type: 'toolCall', name: 'required_action' }),
    ]);
    expect(getTerminalToolGateSnapshot(gate)).toMatchObject({ status: 'accepted' });

    const request = mocks.streamLLM.mock.calls[0]?.[0] as {
      tools?: Record<string, unknown>;
      toolChoice?: unknown;
    };
    expect(Object.keys(request.tools ?? {})).toEqual(['required_action']);
    expect(request.toolChoice).toEqual({ type: 'tool', toolName: 'required_action' });
  });

  it('returns a stable missing-tool signal for a text-only response', async () => {
    const leak = 'MODEL_TEXT_ONLY_42';
    const { events, message, gate } = await collectStream([
      { type: 'text-delta', text: leak },
      finish('stop'),
    ]);

    expect(events.map((event) => event.type)).toEqual(['start', 'done']);
    expect(message.content).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(leak);
    expect(getTerminalToolGateSnapshot(gate)).toEqual({
      status: 'blocked',
      requiredToolName: 'required_action',
      signal: {
        kind: 'terminal_tool_gate',
        code: TERMINAL_TOOL_GATE_SIGNAL.requiredToolMissing,
        requiredToolName: 'required_action',
      },
    });
  });

  it('replaces a guarded provider error with a fixed non-provider message', async () => {
    const privateError = 'PRIVATE_PROVIDER_ERROR_WITH_INTERNAL_DETAILS';
    const { events, message, gate } = await collectStream([
      { type: 'error', error: new Error(privateError) },
    ]);

    expect(JSON.stringify(events)).not.toContain(privateError);
    expect(JSON.stringify(message)).not.toContain(privateError);
    expect(message.errorMessage).toBe('Required terminal tool flow did not complete.');
    expect(getTerminalToolGateSnapshot(gate)).toMatchObject({
      status: 'blocked',
      signal: { code: TERMINAL_TOOL_GATE_SIGNAL.requiredToolStreamFailed },
    });
  });

  it('filters a provider-emitted unexpected tool even when the provider ignores toolChoice', async () => {
    const { events, message, gate } = await collectStream([
      toolCall('other_action'),
      finish('tool-calls'),
    ]);

    expect(events.map((event) => event.type)).toEqual(['start', 'done']);
    expect(message.content).toEqual([]);
    expect(getTerminalToolGateSnapshot(gate)).toMatchObject({
      status: 'blocked',
      signal: {
        code: TERMINAL_TOOL_GATE_SIGNAL.unexpectedToolCall,
        observedToolName: 'other_action',
      },
    });
  });

  it('filters invalid required-tool arguments before Pi can execute them', async () => {
    const { events, message, gate } = await collectStream([
      toolCall('required_action', { value: 'not-a-number' }),
      finish('tool-calls'),
    ]);

    expect(events.map((event) => event.type)).toEqual(['start', 'done']);
    expect(message.content).toEqual([]);
    expect(getTerminalToolGateSnapshot(gate)).toMatchObject({
      status: 'blocked',
      signal: { code: TERMINAL_TOOL_GATE_SIGNAL.invalidRequiredToolArguments },
    });
  });

  it('blocks a duplicate required call so one response cannot execute the tool twice', async () => {
    const { message, gate } = await collectStream([
      toolCall('required_action', { value: 1 }, 'call-1'),
      toolCall('required_action', { value: 2 }, 'call-2'),
      finish('tool-calls'),
    ]);

    expect(message.content).toEqual([]);
    expect(getTerminalToolGateSnapshot(gate)).toMatchObject({
      status: 'blocked',
      signal: {
        code: TERMINAL_TOOL_GATE_SIGNAL.duplicateRequiredToolCall,
        toolCallId: 'call-2',
      },
    });
  });

  it('does not call the provider when the required tool is unavailable', async () => {
    const { message, gate } = await collectStream([], { tools: [] });

    expect(mocks.streamLLM).not.toHaveBeenCalled();
    expect(message.content).toEqual([]);
    expect(getTerminalToolGateSnapshot(gate)).toMatchObject({
      status: 'blocked',
      signal: { code: TERMINAL_TOOL_GATE_SIGNAL.requiredToolUnavailable },
    });
  });
});

describe('TerminalToolGate Agent lifecycle', () => {
  beforeEach(() => mocks.streamLLM.mockReset());

  it('terminates immediately after a successful required tool result', async () => {
    const execute = vi.fn(makeTool().execute);
    const { agent, gate } = makeGuardedAgent({ tool: makeTool(execute) });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });
    useResponses([
      [
        { type: 'text-delta', text: 'MODEL_PRE_TOOL_LEAK_42' },
        toolCall(),
        { type: 'text-delta', text: 'MODEL_POST_TOOL_LEAK_42' },
        finish('tool-calls'),
      ],
    ]);

    await agent.prompt('start');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toContain('MODEL_PRE_TOOL_LEAK_42');
    expect(JSON.stringify(events)).not.toContain('MODEL_POST_TOOL_LEAK_42');
    expect(JSON.stringify(agent.state.messages)).not.toContain('MODEL_PRE_TOOL_LEAK_42');
    expect(JSON.stringify(agent.state.messages)).not.toContain('MODEL_POST_TOOL_LEAK_42');
    expect(getTerminalToolGateSnapshot(gate)).toMatchObject({
      status: 'completed',
      isError: false,
    });
  });

  it('terminates an explicit tool error without another model iteration', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'stable server notice' }],
      details: { code: 'STABLE_ERROR' },
      isError: true,
    }));
    const { agent, gate } = makeGuardedAgent({ tool: makeTool(execute as never) });
    useResponses([[toolCall(), finish('tool-calls')]]);

    await agent.prompt('start');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(getTerminalToolGateSnapshot(gate)).toMatchObject({
      status: 'completed',
      isError: true,
    });
  });

  it('terminates a thrown tool handler without another model iteration', async () => {
    const privateError = 'PRIVATE_TOOL_HANDLER_ERROR';
    const execute = vi.fn(async () => {
      throw new Error(privateError);
    });
    const { agent, gate } = makeGuardedAgent({ tool: makeTool(execute) });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });
    useResponses([[toolCall(), finish('tool-calls')]]);

    await agent.prompt('start');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(getTerminalToolGateSnapshot(gate)).toMatchObject({
      status: 'completed',
      isError: true,
    });
    expect(JSON.stringify(events)).not.toContain(privateError);
    expect(JSON.stringify(agent.state.messages)).not.toContain(privateError);
  });

  it('turns a caller afterToolCall failure into a stable terminal signal', async () => {
    const { agent, gate } = makeGuardedAgent({
      afterToolCall: () => {
        throw new Error('private hook failure');
      },
    });
    useResponses([[toolCall(), finish('tool-calls')]]);

    await agent.prompt('start');

    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(getTerminalToolGateSnapshot(gate)).toMatchObject({
      status: 'blocked',
      signal: { code: TERMINAL_TOOL_GATE_SIGNAL.requiredToolAfterHookFailed },
    });
    expect(JSON.stringify(agent.state.messages)).not.toContain('private hook failure');
  });

  it('does not execute or retry a schema-invalid required call', async () => {
    const execute = vi.fn(makeTool().execute);
    const { agent, gate } = makeGuardedAgent({ tool: makeTool(execute) });
    useResponses([[toolCall('required_action', { value: 'bad' }), finish('tool-calls')]]);

    await agent.prompt('start');

    expect(execute).not.toHaveBeenCalled();
    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(getTerminalToolGateSnapshot(gate)).toMatchObject({
      status: 'blocked',
      signal: { code: TERMINAL_TOOL_GATE_SIGNAL.invalidRequiredToolArguments },
    });
  });

  it('drops same-run steering and follow-up instead of starting a post-tool iteration', async () => {
    let release!: () => void;
    const providerWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.streamLLM.mockReturnValue({
      fullStream: (async function* () {
        await providerWait;
        yield toolCall();
        yield finish('tool-calls');
      })(),
      usage: new Promise(() => {}),
    });
    const { agent } = makeGuardedAgent({});
    const prompt = agent.prompt('start');
    await vi.waitFor(() => expect(mocks.streamLLM).toHaveBeenCalledTimes(1));

    agent.steer(userMessage('next durable turn'));
    agent.followUp(userMessage('next durable follow-up'));
    release();
    await prompt;

    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(agent.hasQueuedMessages()).toBe(false);
    expect(JSON.stringify(agent.state.messages)).not.toContain('next durable turn');
    expect(JSON.stringify(agent.state.messages)).not.toContain('next durable follow-up');
  });

  it('leaves an ordinary ungated Agent stream unchanged', async () => {
    const leak = 'ordinary assistant response';
    useResponses([[{ type: 'text-delta', text: leak }, finish('stop')]]);
    const agent = buildAgent({
      streamFn: createCallLlmStreamFn({ languageModel: {} as never }),
      systemPrompt: 'system',
      tools: [makeTool()],
      allowedToolNames: new Set(['required_action']),
    });

    await agent.prompt('start');

    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(agent.state.messages)).toContain(leak);
    const request = mocks.streamLLM.mock.calls[0]?.[0] as { toolChoice?: unknown };
    expect(request.toolChoice).toBe('auto');
  });
});
