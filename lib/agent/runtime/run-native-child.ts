import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import { buildAgent } from './build-agent';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type InternalTerminalCause =
  | 'native_duplicate_tool_call'
  | 'native_tool_attempt_budget'
  | 'native_provider_transport_budget';

export interface NativeChildRunResult {
  status: 'completed' | 'failed' | 'exhausted' | 'cancelled';
  stopReason: string;
  visibleOutput: string;
  attemptCount: number;
  executionCount: number;
  dispatchedActionCount: number;
  providerTransportCount: number;
}

export interface RunNativeChildOptions {
  streamFn: StreamFn;
  systemPrompt: string;
  prompt: string;
  tools: AgentTool[];
  allowedToolNames: ReadonlySet<string>;
  history?: AgentMessage[];
  abortSignal?: AbortSignal;
  timeoutMs: number;
  maxToolCallAttempts: number;
  maxProviderTransports: number;
  onVisibleTextDelta?: (delta: string) => Promise<string> | string;
  onDispatchedAction?: () => void;
}

function terminalMessage(stopReason: 'error' | 'aborted', message: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'unknown',
    provider: 'unknown',
    model: 'maic-connector',
    usage: EMPTY_USAGE,
    stopReason,
    errorMessage: message,
    timestamp: Date.now(),
  };
}

function abortAwareStream(streamFn: StreamFn, args: Parameters<StreamFn>) {
  const proxy = createAssistantMessageEventStream();
  const signal = args[2]?.signal;
  let settled = false;

  const settle = (event: Extract<AssistantMessageEvent, { type: 'done' | 'error' }>) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    proxy.push(event);
  };
  const onAbort = () => {
    const message = terminalMessage('aborted', 'Native Child transport aborted.');
    settle({ type: 'error', reason: 'aborted', error: message });
  };

  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
    return proxy;
  }

  void Promise.resolve()
    .then(() => streamFn(...args))
    .then(async (source) => {
      if (settled) return;
      try {
        for await (const event of source) {
          if (settled) return;
          if (event.type === 'done' || event.type === 'error') {
            settle(event);
            return;
          }
          proxy.push(event);
        }
        const message = terminalMessage(
          'error',
          'Native Child transport ended without a terminal event.',
        );
        settle({ type: 'error', reason: 'error', error: message });
      } catch (error) {
        const message = terminalMessage(
          'error',
          error instanceof Error ? error.message : 'Native Child transport failed.',
        );
        settle({ type: 'error', reason: 'error', error: message });
      }
    })
    .catch((error: unknown) => {
      const message = terminalMessage(
        'error',
        error instanceof Error ? error.message : 'Native Child transport failed.',
      );
      settle({ type: 'error', reason: 'error', error: message });
    });

  return proxy;
}

function abortError(signal?: AbortSignal): DOMException {
  return new DOMException(
    typeof signal?.reason === 'string' ? signal.reason : 'Operation aborted',
    'AbortError',
  );
}

async function executeWithAbort<T>(execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return execute();
  if (signal.aborted) throw abortError(signal);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => settle(() => reject(abortError(signal)));
    signal.addEventListener('abort', onAbort, { once: true });

    let operation: Promise<T>;
    try {
      operation = execute();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    void operation.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

function lastAssistantMessage(messages: AgentMessage[]) {
  return messages.findLast(
    (message): message is Extract<AgentMessage, { role: 'assistant' }> =>
      message.role === 'assistant',
  );
}

function assistantText(messages: AgentMessage[]): string {
  return messages
    .filter(
      (message): message is Extract<AgentMessage, { role: 'assistant' }> =>
        message.role === 'assistant',
    )
    .flatMap((message) => message.content)
    .filter(
      (content): content is Extract<typeof content, { type: 'text' }> => content.type === 'text',
    )
    .map((content) => content.text)
    .join('')
    .trim();
}

function isDispatchedActionResult(result: AgentToolResult<unknown>): boolean {
  return Boolean(
    result.details &&
    typeof result.details === 'object' &&
    (result.details as { dispatchedAction?: unknown }).dispatchedAction === true,
  );
}

export async function runNativeChild(opts: RunNativeChildOptions): Promise<NativeChildRunResult> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error('runNativeChild requires a positive finite timeoutMs');
  }
  if (!Number.isInteger(opts.maxToolCallAttempts) || opts.maxToolCallAttempts <= 0) {
    throw new Error('runNativeChild requires a positive maxToolCallAttempts');
  }
  if (!Number.isInteger(opts.maxProviderTransports) || opts.maxProviderTransports <= 0) {
    throw new Error('runNativeChild requires a positive maxProviderTransports');
  }

  let attemptCount = 0;
  let executionCount = 0;
  let dispatchedActionCount = 0;
  let providerTransportCount = 0;
  let visibleOutput = '';
  let externallyCancelled = false;
  let timedOut = false;
  let runFinished = false;
  let internalTerminalCause: InternalTerminalCause | undefined;
  let settlementOwner: 'caller' | 'deadline' | 'internal' | undefined;
  const seenToolCallIds = new Set<string>();
  const countedDispatchedToolCallIds = new Set<string>();

  const claimInternalTerminal = (cause: InternalTerminalCause) => {
    if (settlementOwner) return false;
    settlementOwner = 'internal';
    internalTerminalCause = cause;
    child.abort();
    return true;
  };

  const trackedTools = opts.tools.map(
    (tool): AgentTool => ({
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        executionCount += 1;
        return executeWithAbort(() => tool.execute(toolCallId, params, signal, onUpdate), signal);
      },
    }),
  );

  const boundedStreamFn: StreamFn = (...args) => {
    if (args[2]?.signal?.aborted) {
      return abortAwareStream(opts.streamFn, args);
    }
    if (providerTransportCount >= opts.maxProviderTransports) {
      claimInternalTerminal('native_provider_transport_budget');
      return abortAwareStream(opts.streamFn, args);
    }
    providerTransportCount += 1;
    return abortAwareStream(opts.streamFn, args);
  };

  const child = buildAgent({
    streamFn: boundedStreamFn,
    systemPrompt: opts.systemPrompt,
    tools: trackedTools,
    allowedToolNames: opts.allowedToolNames,
    history: opts.history,
    afterToolCall: (context) => {
      if (
        !context.isError &&
        isDispatchedActionResult(context.result) &&
        !countedDispatchedToolCallIds.has(context.toolCall.id)
      ) {
        countedDispatchedToolCallIds.add(context.toolCall.id);
        dispatchedActionCount += 1;
        opts.onDispatchedAction?.();
      }
      return undefined;
    },
  });
  const initialMessageCount = child.state.messages.length;

  const unsubscribe = child.subscribe(async (event: AgentEvent, signal) => {
    if (event.type === 'agent_end') {
      runFinished = true;
      return;
    }
    if (event.type === 'tool_execution_start') {
      if (attemptCount >= opts.maxToolCallAttempts) {
        claimInternalTerminal('native_tool_attempt_budget');
        return;
      }
      attemptCount += 1;
      if (seenToolCallIds.has(event.toolCallId)) {
        claimInternalTerminal('native_duplicate_tool_call');
        return;
      }
      seenToolCallIds.add(event.toolCallId);
      return;
    }

    if (
      event.type === 'message_update' &&
      event.assistantMessageEvent.type === 'text_delta' &&
      opts.onVisibleTextDelta
    ) {
      const delta = event.assistantMessageEvent.delta;
      const forwarded = await executeWithAbort(
        () => Promise.resolve(opts.onVisibleTextDelta!(delta)),
        signal,
      );
      visibleOutput += forwarded;
    }
  });

  const abortForCaller = () => {
    if (settlementOwner || runFinished) return;
    settlementOwner = 'caller';
    externallyCancelled = true;
    child?.abort();
  };
  if (opts.abortSignal?.aborted) abortForCaller();
  else opts.abortSignal?.addEventListener('abort', abortForCaller, { once: true });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (!settlementOwner) {
    timeout = setTimeout(() => {
      if (settlementOwner || runFinished) return;
      settlementOwner = 'deadline';
      timedOut = true;
      child?.abort();
    }, opts.timeoutMs);
  }

  try {
    if (!externallyCancelled) {
      await child.prompt(opts.prompt);
      await child.waitForIdle();
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    opts.abortSignal?.removeEventListener('abort', abortForCaller);
    unsubscribe();
  }

  const messages = child.state.messages.slice(initialMessageCount);
  const finalAssistant = lastAssistantMessage(messages);
  // When the caller owns visible delivery, its returned deltas are the source of
  // truth. Falling back to the raw assistant message in that mode could report
  // text that the caller deliberately filtered and never dispatched.
  if (!visibleOutput && !opts.onVisibleTextDelta) visibleOutput = assistantText(messages);

  const base = {
    visibleOutput,
    attemptCount,
    executionCount,
    dispatchedActionCount,
    providerTransportCount,
  };
  if (externallyCancelled) {
    return { ...base, status: 'cancelled', stopReason: 'aborted' };
  }
  if (timedOut) {
    return { ...base, status: 'exhausted', stopReason: 'native_timeout' };
  }
  if (internalTerminalCause) {
    return { ...base, status: 'exhausted', stopReason: internalTerminalCause };
  }
  if (finalAssistant?.stopReason === 'length') {
    return { ...base, status: 'exhausted', stopReason: 'output_token_limit' };
  }
  if (finalAssistant?.stopReason === 'aborted') {
    return { ...base, status: 'failed', stopReason: 'native_child_aborted' };
  }
  if (!finalAssistant || finalAssistant.stopReason === 'error') {
    return {
      ...base,
      status: 'failed',
      stopReason: finalAssistant?.errorMessage || 'native_child_failed',
    };
  }
  if (!visibleOutput.trim() && dispatchedActionCount === 0) {
    return { ...base, status: 'failed', stopReason: 'native_empty_response' };
  }
  return {
    ...base,
    status: 'completed',
    stopReason: finalAssistant.stopReason ?? 'stop',
  };
}
