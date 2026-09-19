/**
 * Agent-loop pins for the global tool-call execution bound.
 *
 * These tests drive the REAL pi Agent through the REAL `buildAgent` and the
 * REAL stream-fn adapter (only the underlying `streamLLM` transport is
 * mocked), so the timeout wiring is exercised end to end: a tool that never
 * settles must end its call with a structured error tool-result in the
 * transcript at the configured bound, and the agent must keep running (the
 * session does not die), while the abort signal is delivered to the tool's
 * in-flight work.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

import { buildAgent } from '@/lib/agent/runtime/build-agent';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { AGENT_TOOL_TIMEOUT_ENV } from '@/lib/agent/runtime/tool-timeout';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};

const finish = (finishReason: string) => ({
  type: 'finish',
  finishReason,
  totalUsage: ZERO_USAGE,
});

const toolCall = (args: unknown = {}) => ({
  type: 'tool-call',
  toolCallId: 'call-1',
  toolName: 'demo',
  input: args,
});

const resultFrom = (parts: Array<Record<string, unknown>>) => ({
  fullStream: (async function* () {
    for (const part of parts) yield part;
  })(),
  usage: new Promise(() => {}),
});

function useResponses(responses: Array<Array<Record<string, unknown>>>) {
  mocks.streamLLM.mockImplementation(() => {
    const parts = responses.shift();
    return resultFrom(
      parts ?? [{ type: 'text-delta', text: 'unexpected transport' }, finish('stop')],
    );
  });
}

const DemoParams = Type.Object({});

/** A tool whose execution never settles, recording the signal it received. */
function makeHungTool(captured: AbortSignal[], started?: () => void): AgentTool<typeof DemoParams> {
  return {
    name: 'demo',
    label: 'Demo',
    description: 'Test tool',
    parameters: DemoParams,
    async execute(_callId, _params, signal) {
      if (signal) captured.push(signal);
      started?.();
      return new Promise(() => {});
    },
  };
}

const setToolTimeout = (value: string | undefined): void => {
  if (value === undefined) delete process.env[AGENT_TOOL_TIMEOUT_ENV];
  else process.env[AGENT_TOOL_TIMEOUT_ENV] = value;
};

describe('agent loop tool-execution bound', () => {
  beforeEach(() => {
    mocks.streamLLM.mockReset();
  });

  afterEach(() => {
    setToolTimeout(undefined);
    vi.useRealTimers();
  });

  it('ends a never-settling tool call with a timeout error result at the configured bound', async () => {
    vi.useFakeTimers();
    setToolTimeout('5000');
    const captured: AbortSignal[] = [];
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    useResponses([
      [toolCall(), finish('tool-calls')],
      [{ type: 'text-delta', text: 'complete' }, finish('stop')],
    ]);
    const agent = buildAgent({
      streamFn: createCallLlmStreamFn({ languageModel: {} as never }),
      systemPrompt: 'system',
      tools: [makeHungTool(captured, started)],
      allowedToolNames: new Set(['demo']),
    });

    const prompt = agent.prompt('start');
    await gate;
    // The tool call is in flight with a live signal; the timeout fires at the
    // configured bound and the call settles as an error result.
    await vi.advanceTimersByTimeAsync(5_000);
    await prompt;

    const toolResult = agent.state.messages.find((message) => message.role === 'toolResult');
    expect(toolResult).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'demo',
      isError: true,
    });
    expect(JSON.stringify(toolResult)).toContain('execution budget');
    expect(JSON.stringify(toolResult)).toContain('5000ms');
    // The agent survived the timeout and continued with the next model turn.
    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    // The abort was delivered to the tool's in-flight work.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.aborted).toBe(true);
  });
});
