/**
 * Contract pins for the pi loop behaviour the runner's shutdown handoff relies on.
 *
 * `lib/server/agent-runtime/runner.ts` injects `shouldStopAfterTurn` by patching
 * the Agent's private `createLoopConfig`, because the Agent class neither accepts
 * the hook in its constructor nor copies it into the loop config. That patch is
 * silent when it stops working (a renamed private method, a changed loop), so
 * these tests drive the REAL `runAgentLoop` and pin the three facts it depends
 * on:
 *
 * 1. the hook is called after EVERY step, including the last one that ends the
 *    answer — which is why the runner must return false there (a park would
 *    leave a finished answer in a `running` row);
 * 2. a step whose tool batch terminated does not need the hook to stop it;
 * 3. returning true stops the loop at that boundary: no further model call, and
 *    `agent_end` is still emitted.
 */
import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { runAgentLoop } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';

const Params = Type.Object({});

/** One assistant message, delivered through pi's stream protocol. */
function streamOf(message: Record<string, unknown>) {
  return {
    async *[Symbol.asyncIterator]() {
      // No deltas: the loop reads the final message from result() below.
    },
    result: async () => message,
  };
}

const assistantText = (text: string) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason: 'stop',
  timestamp: 1,
});

const assistantToolCall = (id: string) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name: 'demo', arguments: {} }],
  stopReason: 'toolUse',
  timestamp: 2,
});

function makeTool(execute?: AgentTool<typeof Params>['execute']): AgentTool<typeof Params> {
  return {
    name: 'demo',
    label: 'Demo',
    description: 'Test tool',
    parameters: Params,
    execute:
      execute ?? (async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} })),
  };
}

/** Run the real loop over the given scripted assistant messages. */
async function runLoop(options: {
  responses: Array<Record<string, unknown>>;
  shouldStopAfterTurn?: (turn: { message: AgentMessage }) => boolean;
  tool?: AgentTool<typeof Params>;
  afterToolCall?: (context: { toolCall: { name: string } }) => { terminate?: boolean };
}) {
  const events: AgentEvent[] = [];
  const hookCalls: Array<{ message: AgentMessage; toolResults: unknown[] }> = [];
  const tools = [options.tool ?? makeTool()];
  const streamFn = vi.fn(async () => {
    const message = options.responses.shift() ?? assistantText('unexpected');
    return streamOf(message);
  });
  const messages = await runAgentLoop(
    [
      {
        role: 'user',
        content: [{ type: 'text', text: 'start' }],
        timestamp: 0,
      } as unknown as AgentMessage,
    ],
    { systemPrompt: 'system', messages: [], tools },
    {
      model: { api: 'openai-completions', provider: 'openai', id: 'test' },
      convertToLlm: async (view: AgentMessage[]) => view,
      tools,
      toolExecution: 'parallel',
      afterToolCall: options.afterToolCall,
      shouldStopAfterTurn: (turn: { message: AgentMessage; toolResults: readonly unknown[] }) => {
        hookCalls.push({ message: turn.message, toolResults: [...turn.toolResults] });
        return options.shouldStopAfterTurn?.(turn) ?? false;
      },
    } as never,
    (event: AgentEvent) => {
      events.push(event);
    },
    undefined,
    streamFn as never,
  );
  return { events, hookCalls, messages, streamFn };
}

describe('pi loop contract the step-boundary handoff depends on', () => {
  it('calls shouldStopAfterTurn after the step that ended the answer', async () => {
    // The runner must return FALSE here: parking would leave a finished answer
    // in a `running` row. If pi ever stops calling the hook on the final step,
    // this pin fails and the runner's `continues` check can be simplified.
    const { hookCalls, events, streamFn } = await runLoop({
      responses: [assistantText('Done.')],
    });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(hookCalls).toHaveLength(1);
    const content = (hookCalls[0]!.message as { content?: Array<{ type?: string }> }).content ?? [];
    expect(content.some((part) => part.type === 'toolCall')).toBe(false);
    expect(hookCalls[0]!.toolResults).toEqual([]);
    expect(events.at(-1)?.type).toBe('agent_end');
  });

  it('stops at the step boundary when the hook returns true: no further model call', async () => {
    const { hookCalls, events, streamFn } = await runLoop({
      responses: [assistantToolCall('call_1'), assistantText('never requested')],
      shouldStopAfterTurn: () => true,
    });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(hookCalls).toHaveLength(1);
    // The tool batch ran, and its result is part of the stopped step.
    expect(hookCalls[0]!.toolResults).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('agent_end');
  });

  it('continues to the next step when the hook returns false', async () => {
    const { hookCalls, streamFn } = await runLoop({
      responses: [assistantToolCall('call_1'), assistantText('Done.')],
      shouldStopAfterTurn: () => false,
    });
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(hookCalls).toHaveLength(2);
    expect(hookCalls[1]!.toolResults).toEqual([]);
  });

  it('a tool that terminates its batch ends the loop even with the hook returning false', async () => {
    // Mirrors a terminal tool (ask_user, quota exhaustion). The runner's hook
    // also declines to park such a step, so both facts agree.
    const { hookCalls, streamFn, events } = await runLoop({
      responses: [assistantToolCall('call_1'), assistantText('never requested')],
      shouldStopAfterTurn: () => false,
      afterToolCall: () => ({ terminate: true }),
    });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(hookCalls).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('agent_end');
  });
});
