/**
 * MAIC Agent — agent runtime construction.
 *
 * Stands up a pi `Agent` with:
 * - injected StreamFn (-> OpenMAIC connector),
 * - request-scoped tools supplied by the route,
 * - a caller-supplied `beforeToolCall` allowlist gate,
 * - a `afterToolCall` quota hook (v0 stub: unlimited).
 */
import {
  Agent,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { makeAllowlistGate } from './allowlist';
import { makeQuotaHook } from './quota';
import { hasLengthToolCallProvenance } from './stream-fn';
import { withAgentToolTimeout } from './tool-timeout';

// pi needs *a* model object on state; the injected StreamFn ignores it and uses
// OpenMAIC's resolved model, so this is a metadata stub (high contextWindow so
// the harness never tries to compact).
const STUB_MODEL = {
  id: 'maic-connector',
  name: 'maic-connector',
  api: 'unknown',
  provider: 'unknown',
  baseUrl: '',
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 8192,
} as unknown as Model<Api>;

export interface BuildAgentOptions {
  streamFn: StreamFn;
  systemPrompt: string;
  tools: AgentTool[];
  /**
   * Optional pi model for the agent's initial state. Defaults to the connector
   * metadata stub; the injected StreamFn resolves the real model itself.
   */
  model?: Model<Api>;
  /** Tool names allowed for this agent. Callers must declare their boundary. */
  allowedToolNames: ReadonlySet<string>;
  /** Prior conversation turns to seed the agent with, so it has multi-turn memory. */
  history?: AgentMessage[];
  /** Optional Pi context transform, used by the Director's native compaction path. */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** Optional Pi message conversion, required when a context transform emits custom roles. */
  convertToLlm?: AgentOptions['convertToLlm'];
  /** Optional request-scoped hook composed with the shared quota hook. */
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
}

export function buildAgent(opts: BuildAgentOptions): Agent {
  const quotaHook = makeQuotaHook({ remaining: () => Number.MAX_SAFE_INTEGER });
  const agent = new Agent({
    streamFn: opts.streamFn,
    transformContext: opts.transformContext,
    convertToLlm: opts.convertToLlm,
    toolExecution: 'sequential',
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: opts.model ?? STUB_MODEL,
      // Every tool call is raced against a global execution timeout (and the
      // caller's abort signal); see tool-timeout.ts.
      tools: opts.tools.map((tool) => withAgentToolTimeout(tool)),
      // Seed prior turns so `agent.prompt(newMessage)` runs with the full
      // conversation in context — without this the agent is stateless per turn.
      ...(opts.history && opts.history.length > 0 ? { messages: opts.history } : {}),
    },
    beforeToolCall: makeAllowlistGate(opts.allowedToolNames),
    afterToolCall: async (context, signal) => {
      const markerIsError =
        typeof context.result === 'object' &&
        context.result !== null &&
        Object.prototype.hasOwnProperty.call(context.result, 'isError') &&
        (context.result as { isError?: unknown }).isError === true;
      const baseIsError = context.isError || markerIsError;
      const normalizedContext = baseIsError ? { ...context, isError: true } : context;
      const quotaResult = await quotaHook(normalizedContext);
      const requestResult = await opts.afterToolCall?.(normalizedContext, signal);
      if (!quotaResult && !requestResult && !baseIsError) return undefined;
      return {
        ...quotaResult,
        ...requestResult,
        isError: baseIsError || quotaResult?.isError === true || requestResult?.isError === true,
        terminate: quotaResult?.terminate === true || requestResult?.terminate === true,
      };
    },
  });

  let terminalBarrierActive = false;
  agent.subscribe((event) => {
    if (
      event.type === 'turn_end' &&
      event.message.role === 'assistant' &&
      event.message.stopReason === 'length' &&
      hasLengthToolCallProvenance(event.message)
    ) {
      terminalBarrierActive = true;
      agent.clearAllQueues();
    } else if (event.type === 'agent_end') {
      terminalBarrierActive = false;
    }
  });

  const steer = agent.steer.bind(agent);
  agent.steer = (message) => {
    if (!terminalBarrierActive) steer(message);
  };
  const followUp = agent.followUp.bind(agent);
  agent.followUp = (message) => {
    if (!terminalBarrierActive) followUp(message);
  };

  return agent;
}
