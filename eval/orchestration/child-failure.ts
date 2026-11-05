/** Forced child failures with a real Director; all spend limits live in this eval. */
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { AGENT_TOOL_TIMEOUT_ENV } from '@/lib/agent/runtime/tool-timeout';
import type { PiStreamFnFactory } from '@/lib/chat/pi/types';
import type { ChildRuntimeMode } from '@/lib/chat/pi/child-runtime';
import type { StatelessChatRequest } from '@/lib/types/chat';
import { runPiClassroomRequest, type EvalModel } from './pi-harness';

export type ChildFailureScenario =
  | 'error'
  | 'timeout'
  | 'empty'
  | 'teacher-error'
  | 'teacher-error-student'
  | 'partial';

/** Only the teacher fails; other agents use the real model. */
const teacherOnly = (scenario: ChildFailureScenario) =>
  scenario === 'teacher-error' || scenario === 'teacher-error-student';

function terminalMessage(stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    api: 'eval',
    provider: 'eval',
    model: 'forced-child',
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [],
    stopReason,
  };
}

function injectedStream(
  scenario: ChildFailureScenario,
  signal: AbortSignal | undefined,
): ReturnType<StreamFn> {
  const stream = createAssistantMessageEventStream();
  // A timeout stream never answers; the shared tool timeout aborts it.
  if (scenario === 'timeout') {
    signal?.addEventListener(
      'abort',
      () => {
        const message = terminalMessage('aborted');
        stream.push({ type: 'error', reason: 'aborted', error: message });
      },
      { once: true },
    );
    return stream;
  }
  const partial = scenario === 'partial';
  const error = scenario === 'error' || teacherOnly(scenario);
  const message: AssistantMessage = {
    ...terminalMessage(error ? 'error' : partial ? 'length' : 'stop'),
    content: partial ? [{ type: 'text', text: 'Here is the first part of the explanation.' }] : [],
    ...(error ? { errorMessage: 'Injected provider failure (private diagnostic)' } : {}),
  };
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message });
    if (partial) {
      stream.push({ type: 'text_start', contentIndex: 0, partial: message });
      const text = message.content[0];
      if (text.type === 'text')
        stream.push({ type: 'text_delta', contentIndex: 0, delta: text.text, partial: message });
    }
    if (error) stream.push({ type: 'error', reason: 'error', error: message });
    else
      stream.push({
        type: 'done',
        reason: message.stopReason as 'stop' | 'length',
        message,
      });
  });
  return stream;
}

export async function runChildFailureEval(
  request: StatelessChatRequest,
  model: EvalModel,
  scenario: ChildFailureScenario,
  mode: ChildRuntimeMode,
  limits = { providerCalls: 30, childCalls: 10, timeoutMs: 120_000, toolTimeoutMs: 1_000 },
) {
  for (const value of Object.values(limits)) {
    if (!Number.isInteger(value) || value <= 0)
      throw new Error('Eval limits must be positive integers');
  }
  const controller = new AbortController();
  const calls: string[] = [];
  let teacherCalls = 0;
  const childResults: Array<{ toolCallId: string; isError: boolean; text: string }> = [];
  let providerCalls = 0;
  let injectedTransports = 0;
  let capped = false;
  let error: string | undefined;
  const cap = () => {
    capped = true;
    controller.abort();
  };
  const timer = setTimeout(cap, limits.timeoutMs);
  const factory: PiStreamFnFactory = (options, agent) => {
    const realStream = createCallLlmStreamFn(options);
    if (agent) {
      // Count delegations, not transports: a Native child may make several.
      if (calls.length >= limits.childCalls) cap();
      else {
        calls.push(agent.id);
        if (agent.role === 'teacher') teacherCalls += 1;
      }
    }
    return ((...args: Parameters<StreamFn>) => {
      controller.signal.throwIfAborted();
      if (agent && (!teacherOnly(scenario) || agent.role === 'teacher')) {
        injectedTransports += 1;
        return injectedStream(scenario, args[2]?.signal);
      }
      if (!agent) {
        // Capture model-visible results even when a later eval cap prevents done.
        for (const message of args[1].messages) {
          if (
            message.role === 'toolResult' &&
            message.toolName === 'call_agent' &&
            !childResults.some((result) => result.toolCallId === message.toolCallId)
          ) {
            childResults.push({
              toolCallId: message.toolCallId,
              isError: message.isError,
              text: message.content
                .map((part) => (part.type === 'text' ? part.text : '[image]'))
                .join('\n'),
            });
          }
        }
      }
      if (providerCalls >= limits.providerCalls) {
        cap();
        controller.signal.throwIfAborted();
      }
      providerCalls += 1;
      return realStream(...args);
    }) as StreamFn;
  };
  let run: Awaited<ReturnType<typeof runPiClassroomRequest>> | undefined;
  // Both runtimes are bounded only by the shared tool timeout. Shorten it for
  // this run instead of waiting for the default budget.
  const previousToolTimeout = process.env[AGENT_TOOL_TIMEOUT_ENV];
  if (scenario === 'timeout') process.env[AGENT_TOOL_TIMEOUT_ENV] = String(limits.toolTimeoutMs);
  try {
    run = await runPiClassroomRequest(request, model, controller.signal, {
      childRuntimeMode: mode,
      streamFnFactory: factory,
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    clearTimeout(timer);
    if (scenario === 'timeout') {
      if (previousToolTimeout === undefined) delete process.env[AGENT_TOOL_TIMEOUT_ENV];
      else process.env[AGENT_TOOL_TIMEOUT_ENV] = previousToolTimeout;
    }
  }
  const perAgent = Object.fromEntries(
    [...new Set(calls)].map((id) => [id, calls.filter((call) => call === id).length]),
  );
  // The Director picks its own delegations, so a sample may never reach the
  // injected failure (or, for teacher-only scenarios, never try another agent).
  const reachedFailure = injectedTransports > 0;
  const covered = teacherOnly(scenario)
    ? reachedFailure && calls.length > teacherCalls
    : reachedFailure;
  // The Director may call cue_user itself, or finish and let the runtime cue.
  const explicitCue = run?.done.directorToolTrace?.some(
    (entry) =>
      entry.toolName === 'cue_user' && (entry.details as { emitted?: boolean })?.emitted === true,
  );
  return {
    scenario,
    mode,
    providerCalls,
    injectedTransports,
    childCalls: calls.length,
    perAgent,
    repeatedCalls: calls.length - Object.keys(perAgent).length,
    ending: !run
      ? 'no_done'
      : run.done.sessionClosed
        ? 'close'
        : run.done.cueUserReceived
          ? explicitCue
            ? 'explicit_cue'
            : 'auto_cue'
          : 'plain_finish',
    covered,
    agentHadContent: run?.done.agentHadContent,
    teachingAgentFailedOrEmpty: run?.done.teachingAgentFailedOrEmpty,
    capped,
    error,
    childResults,
    done: run?.done,
  };
}
