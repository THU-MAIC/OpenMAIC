import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { AgentSessionLeaseLostError } from '@openmaic/storage';

export interface PendingToolCall {
  id: string;
  name: string;
}

export interface ToolCallRepair {
  messages: AgentMessage[];
  repairedToolCalls: string[];
}

export type AgentContextTransform = (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<AgentMessage[]>;

const INTERRUPTED_DETAILS = { ok: false, error: 'interrupted' } as const;
const INTERRUPTED_TEXT = JSON.stringify({
  ...INTERRUPTED_DETAILS,
  message: 'This tool call was interrupted before a result was recorded.',
});

/**
 * The entry-tree adapter surfaces a lease/attempt fence loss as a storage
 * error whose cause chain bottoms out in `AgentSessionLeaseLostError`. Walk
 * the chain so the write-time settlement treats it exactly like the runner's
 * other critical writes instead of re-throwing it as an ordinary failure.
 */
function isLeaseLostError(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    if (current instanceof AgentSessionLeaseLostError) return true;
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function toolCalls(message: AgentMessage): ToolCall[] {
  if (message.role !== 'assistant') return [];
  const content = (message as Partial<AssistantMessage>).content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is ToolCall =>
      part?.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string',
  );
}

function isInterruptedAssistantFrame(message: AgentMessage): boolean {
  if (message.role !== 'assistant' || toolCalls(message).length > 0) return false;
  const frame = message as { stopReason?: unknown; errorMessage?: unknown };
  return (
    frame.stopReason === 'aborted' ||
    frame.stopReason === 'length' ||
    frame.stopReason === 'error' ||
    (typeof frame.errorMessage === 'string' && frame.errorMessage.trim().length > 0)
  );
}

export function interruptedToolResult(call: PendingToolCall, timestamp = Date.now()): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: INTERRUPTED_TEXT }],
    details: INTERRUPTED_DETAILS,
    isError: true,
    timestamp,
  } as ToolResultMessage;
}

/** Return every tool call id that has no result anywhere in the materialized context. */
export function orphanedToolCalls(messages: readonly AgentMessage[]): PendingToolCall[] {
  const answered = new Set(
    messages.flatMap((message) =>
      message.role === 'toolResult' && typeof message.toolCallId === 'string'
        ? [message.toolCallId]
        : [],
    ),
  );
  return messages.flatMap((message) =>
    toolCalls(message)
      .filter((call) => !answered.has(call.id))
      .map((call) => ({ id: call.id, name: call.name })),
  );
}

/**
 * Enforce the provider tool-call invariant at the read boundary.
 *
 * Parallel tools may finish while pi is unwinding an aborted assistant frame.
 * Their durable order can then be:
 *
 *   assistant(tool A, tool B), result(A), assistant(aborted), result(B)
 *
 * Although result(B) exists, strict providers reject that history because all
 * results for one assistant tool-call frame must be contiguous. For an invalid
 * transcript we materialize a provider-safe view: existing results move next
 * to their owning assistant (in call order), incomplete assistant unwind frames
 * are omitted, and only genuinely missing results are synthesized. The entry
 * tree itself remains an immutable audit trail.
 * A healthy transcript is returned by reference so its serialized bytes are
 * necessarily unchanged.
 */
export function repairOrphanedToolCalls(
  messages: AgentMessage[],
  now: () => number = Date.now,
): ToolCallRepair {
  const callGroups = new Map<number, ToolCall[]>();
  const knownCallIds = new Set<string>();
  const resultIndexes = new Map<string, number[]>();

  for (let index = 0; index < messages.length; index += 1) {
    const calls = toolCalls(messages[index]!);
    if (calls.length > 0) {
      callGroups.set(index, calls);
      for (const call of calls) knownCallIds.add(call.id);
    }
    const message = messages[index]!;
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      resultIndexes.set(message.toolCallId, [
        ...(resultIndexes.get(message.toolCallId) ?? []),
        index,
      ]);
    }
  }

  const repairedToolCalls: string[] = [];
  let needsRepair = false;

  for (const [index, calls] of callGroups) {
    const expected = new Set(calls.map((call) => call.id));
    const contiguous: string[] = [];
    for (let cursor = index + 1; messages[cursor]?.role === 'toolResult'; cursor += 1) {
      contiguous.push((messages[cursor] as ToolResultMessage).toolCallId);
    }
    if (
      contiguous.length !== expected.size ||
      contiguous.some((id) => !expected.has(id)) ||
      [...expected].some((id) => !contiguous.includes(id))
    ) {
      needsRepair = true;
    }

    for (const call of calls) {
      if ((resultIndexes.get(call.id) ?? []).length === 0) repairedToolCalls.push(call.id);
    }
  }

  if (!needsRepair && repairedToolCalls.length === 0) return { messages, repairedToolCalls };

  // Every result owned by a known call is emitted with that call below. This
  // also drops duplicate receipts from the model view while preserving the
  // first durable receipt verbatim.
  const ownedResultIndexes = new Set(
    [...resultIndexes.entries()]
      .filter(([id]) => knownCallIds.has(id))
      .flatMap(([, indexes]) => indexes),
  );
  const repaired: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (ownedResultIndexes.has(index)) continue;
    // Once late results move in front of the abort frame, that frame becomes
    // the tail again. It is not a completed model turn and planResume would
    // have discarded it had the race not hidden it in the middle originally.
    if (isInterruptedAssistantFrame(messages[index]!)) continue;
    repaired.push(messages[index]!);
    for (const call of callGroups.get(index) ?? []) {
      const existingIndex = resultIndexes.get(call.id)?.[0];
      repaired.push(
        existingIndex === undefined
          ? interruptedToolResult({ id: call.id, name: call.name }, now())
          : messages[existingIndex]!,
      );
    }
  }
  return { messages: repaired, repairedToolCalls };
}

/**
 * Keep the final model-facing context legal even when an intermediate
 * transform re-materializes the raw durable tree.
 *
 * A transform that rebuilds context from the raw entry tree on every turn can
 * replace an already-repaired initial state with the original orphan, because
 * read-time synthetic receipts are deliberately not persisted. Applying the
 * same normalizer after the transform makes this the last context boundary
 * before the model conversion and also fixes late parallel results that the
 * durable order split with an abort frame.
 */
export function withToolCallIntegrityRepair(
  transform: AgentContextTransform,
): AgentContextTransform {
  return async (messages, signal) =>
    repairOrphanedToolCalls(await transform(messages, signal)).messages;
}

/** Track calls whose durable assistant frame exists but whose result does not yet exist. */
export function trackToolCallMessage(
  inFlight: Map<string, PendingToolCall>,
  message: AgentMessage,
): void {
  if (message.role === 'assistant') {
    for (const call of toolCalls(message)) inFlight.set(call.id, { id: call.id, name: call.name });
    return;
  }
  if (message.role === 'toolResult') inFlight.delete(message.toolCallId);
}

interface AppendInterruptedOptions {
  append: (message: AgentMessage) => Promise<void>;
  onFenceLost: () => void;
  now?: () => number;
}

/** Append abort receipts through the same attempt-fenced storage as normal messages. */
export async function appendInterruptedToolCallResults(
  calls: readonly PendingToolCall[],
  options: AppendInterruptedOptions,
): Promise<void> {
  for (const call of calls) {
    try {
      await options.append(interruptedToolResult(call, (options.now ?? Date.now)()));
    } catch (error) {
      if (isLeaseLostError(error)) {
        options.onFenceLost();
        return;
      }
      throw error;
    }
  }
}
