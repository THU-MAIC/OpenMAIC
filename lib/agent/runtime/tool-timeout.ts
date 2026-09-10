/**
 * Global per-tool-call execution bound for every agent built through
 * `buildAgent`.
 *
 * pi's agent loop awaits `tool.execute(...)` with no deadline: a tool await
 * that neither resolves nor rejects (a hung provider request, a database
 * write that never returns, a library call stuck on an uncancellable await)
 * wedges the session forever — the lease keeps heartbeating and no repair
 * ever runs while the process lives. This module races every tool call
 * against:
 *
 * - a hard time budget (`OPENMAIC_AGENT_TOOL_TIMEOUT_MS`, default 10 min),
 *   which also fires the AbortSignal delivered to the tool's in-flight work;
 * - the caller's own AbortSignal (session cancel / lease loss / shutdown),
 *   so even a signal-ignoring await cannot keep the session running after a
 *   cancel request lands.
 *
 * On timeout the tool call rejects with {@link AgentToolTimeoutError}; pi
 * converts the rejection into a structured error tool-result in the
 * transcript, so the agent sees the failure and can retry or proceed — the
 * session does not die.
 */
import type { AgentTool, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';

/**
 * Default budget for a single tool call. Generous on purpose: media-bearing
 * tools synthesize narration and model content per page, and known long
 * runners are given larger explicit budgets in
 * {@link AGENT_TOOL_TIMEOUT_OVERRIDES}.
 */
export const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 10 * 60_000;

/**
 * Per-tool budgets for tools with known longer (or shorter) execution
 * profiles. The map wins over the env-tunable default: it encodes the
 * deployment's own knowledge of how long a tool may legitimately run.
 */
export const AGENT_TOOL_TIMEOUT_OVERRIDES: Readonly<Record<string, number>> = {
  // Scene generation can synthesize narration audio for every speech action
  // (each provider request is itself bounded) on top of several model calls.
  generate_scene: 15 * 60_000,
  generate_actions: 15 * 60_000,
  // Material extraction may wait on a slow upstream document pipeline.
  extract_material: 15 * 60_000,
};

/** Environment variable that tunes the default tool-call budget. */
export const AGENT_TOOL_TIMEOUT_ENV = 'OPENMAIC_AGENT_TOOL_TIMEOUT_MS';

/** Resolve the execution budget for one tool call, in milliseconds. */
export function resolveAgentToolTimeoutMs(
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = AGENT_TOOL_TIMEOUT_OVERRIDES[toolName];
  if (override !== undefined) return override;
  const raw = env[AGENT_TOOL_TIMEOUT_ENV]?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_TOOL_TIMEOUT_MS;
}

/** The tool call exceeded its execution budget and was aborted. */
export class AgentToolTimeoutError extends Error {
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super(
      `Tool "${toolName}" exceeded its ${timeoutMs}ms execution budget and was aborted; ` +
        'the call did not complete. Retry the call or proceed without its result.',
    );
    this.name = 'AgentToolTimeoutError';
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

/** The tool call was aborted by the caller's signal (cancel / lease loss). */
export class AgentToolAbortedError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Tool "${toolName}" was aborted before it completed.`);
    this.name = 'AgentToolAbortedError';
    this.toolName = toolName;
  }
}

/**
 * Wrap a tool so every execution is bounded by the tool timeout and by the
 * caller's AbortSignal.
 *
 * The tool receives a derived signal that fires on timeout or when the outer
 * signal fires, so abort is actually delivered to the tool's in-flight work
 * even though the agent loop itself keeps running after a timeout. Progress
 * updates emitted by a zombie tool after the race settles are dropped.
 */
export function withAgentToolTimeout(tool: AgentTool): AgentTool {
  const timeoutMs = resolveAgentToolTimeoutMs(tool.name);
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: (toolCallId, args, signal, onUpdate) =>
      executeWithToolBound(execute, tool.name, timeoutMs, toolCallId, args, signal, onUpdate),
  };
}

type ToolExecute = AgentTool['execute'];
type ToolResult = Awaited<ReturnType<ToolExecute>>;

async function executeWithToolBound(
  execute: ToolExecute,
  toolName: string,
  timeoutMs: number,
  toolCallId: string,
  args: Parameters<ToolExecute>[1],
  signal: AbortSignal | undefined,
  onUpdate: Parameters<ToolExecute>[3],
): Promise<ToolResult> {
  // The derived signal is what the tool actually sees: the outer signal is
  // forwarded into it, and the timeout fires it as well.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', forwardAbort, { once: true });

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Abort delivery to the tool must never break the race settlement: a
  // throwing abort listener is a tool bug, not a reason to wedge the session.
  const abortWork = (reason: unknown): void => {
    try {
      controller.abort(reason);
    } catch {
      // Ignore: the race below still settles.
    }
  };

  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal) {
      signal.removeEventListener('abort', forwardAbort);
      signal.removeEventListener('abort', onCancelled);
    }
  };

  // One settlement wins: timeout, caller abort, or the tool itself. The guard
  // also makes the timeout error the race winner even when the tool rejects
  // synchronously from the abort it was just delivered.
  const finish = (apply: () => void): void => {
    if (settled) return;
    settled = true;
    cleanup();
    apply();
  };

  const onCancelled = (): void => {
    const error = new AgentToolAbortedError(toolName);
    finish(() => {
      abortWork(error);
      rejectRace(error);
    });
  };

  const onTimeout = (): void => {
    const error = new AgentToolTimeoutError(toolName, timeoutMs);
    finish(() => {
      abortWork(error);
      rejectRace(error);
    });
  };

  let resolveRace: (result: ToolResult) => void = () => {};
  let rejectRace: (error: unknown) => void = () => {};
  const race = new Promise<ToolResult>((resolve, reject) => {
    resolveRace = resolve;
    rejectRace = reject;
  });

  if (signal) {
    if (signal.aborted) {
      onCancelled();
      return race;
    }
    signal.addEventListener('abort', onCancelled, { once: true });
  }
  if (timeoutMs > 0) timer = setTimeout(onTimeout, timeoutMs);

  const guardedUpdate: AgentToolUpdateCallback | undefined = onUpdate
    ? (partial) => {
        if (!settled) onUpdate(partial);
      }
    : undefined;

  execute(toolCallId, args, controller.signal, guardedUpdate).then(
    (result) => finish(() => resolveRace(result)),
    (error) => finish(() => rejectRace(error)),
  );

  return race;
}
