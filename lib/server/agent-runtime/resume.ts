/**
 * Resume semantics: turn a crash-truncated transcript back into one that pi's
 * `agent.continue()` will accept.
 *
 * The durable checkpoint is the pi `AgentMessage[]` transcript, re-written after
 * every message/turn/tool boundary. An aborted/failed/length-truncated
 * generation may append a suffix of interrupted assistant frames, including
 * already-streamed thinking or text; content-less assistant frames can also be
 * left while unwinding.
 * Those incomplete frames are removed first. The remaining tail is in one of
 * these states:
 *
 *   empty                        -> nothing ran yet; start with `prompt()`
 *   ends with `user`             -> the prompt was recorded, no assistant turn
 *                                   completed; `continue()` picks it up
 *   ends with `toolResult`       -> a tool committed but the next LLM turn never
 *                                   finished; `continue()` resumes there — EXCEPT
 *                                   a trailing successful `ask_user` result,
 *                                   which is the run's terminal "waiting for the
 *                                   user's answer" state and settles as
 *                                   already-complete (the agent must not answer
 *                                   its own question)
 *   ends with `assistant` + calls-> we died DURING tool execution. The calls have
 *                                   no results, so the transcript is not a legal
 *                                   continuation point. We report the dangling
 *                                   ids; the shared read-boundary repair adds
 *                                   provider-safe interrupted results.
 *   ends with non-empty
 *   `assistant`, none            -> the model had already stopped calling tools;
 *                                   the run was effectively complete.
 *
 * The interrupted-result repair is what makes tool execution AT-LEAST-ONCE: a
 * tool that ran but whose result never got persisted will be re-issued by the
 * model. Every tool in this system must therefore be idempotent — `putScene` is,
 * on (stageId, sceneId), and `generate_scene` derives its scene id from the
 * outline entry rather than minting one.
 *
 * Ported verbatim (semantics) from the runtime spike prototype.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';

export type ResumeAction =
  | { kind: 'start' }
  | { kind: 'continue'; messages: AgentMessage[]; repairedToolCalls: string[] }
  | { kind: 'already-complete'; messages: AgentMessage[] };

function isEmptyAssistantMessage(message: AgentMessage): boolean {
  if (message.role !== 'assistant') return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return true;
  return !content.some((part: unknown) => {
    // Unknown/future block shapes are content, not emptiness. Preserving an
    // image/audio/custom output is safer than silently deleting it.
    if (!part || typeof part !== 'object') return true;
    const block = part as { type?: unknown; text?: unknown; thinking?: unknown };
    if (block.type === 'toolCall') return true;
    if (block.type === 'text') {
      // A known block is empty only when its payload is a valid string that
      // trims to nothing. Missing/malformed payloads are preserved just like
      // unknown future blocks: deleting evidence we do not understand is the
      // unsafe direction for crash recovery.
      return typeof block.text !== 'string' || block.text.trim().length > 0;
    }
    if (block.type === 'thinking') {
      return typeof block.thinking !== 'string' || block.thinking.trim().length > 0;
    }
    return true;
  });
}

function isInterruptedAssistantMessage(message: AgentMessage): boolean {
  if (message.role !== 'assistant') return false;
  const frame = message as { stopReason?: unknown; errorMessage?: unknown };
  return (
    frame.stopReason === 'aborted' ||
    frame.stopReason === 'length' ||
    frame.stopReason === 'error' ||
    (typeof frame.errorMessage === 'string' && frame.errorMessage.trim().length > 0)
  );
}

function isDiscardableAssistantTail(message: AgentMessage): boolean {
  if (message.role !== 'assistant') return false;
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  // `stop` proves that the model completed normally. A worker may die after
  // checkpointing this frame but before finishSession; stripping it would
  // rerun an answer that should instead early-settle.
  if (stopReason === 'stop') return false;
  return isEmptyAssistantMessage(message) || isInterruptedAssistantMessage(message);
}

export function planResume(transcript: AgentMessage[] | null): ResumeAction {
  if (!transcript || transcript.length === 0) return { kind: 'start' };

  const messages = [...transcript];
  // pi's abort finalizer keeps already-streamed thinking/text but removes
  // executable tool calls, so content alone cannot prove a completed turn.
  // Remove the whole incomplete suffix before classifying the durable tail;
  // this also keeps empty assistant context away from strict providers.
  while (messages.length > 0 && isDiscardableAssistantTail(messages[messages.length - 1])) {
    messages.pop();
  }
  if (messages.length === 0) return { kind: 'start' };

  const last = messages[messages.length - 1];

  if (last.role === 'user' || last.role === 'toolResult') {
    // A trailing SUCCESSFUL ask_user is terminal: the runner's afterToolCall
    // stopped the loop on it and the question was already emitted as a durable
    // `user_question` event — the run is waiting for the user's answer, and the
    // worker dying between the transcript checkpoint and finishSession must not
    // let a takeover `continue()` the agent past that gate (it would answer its
    // own question). Settle as already-complete: the runner early-settles
    // `succeeded` with no pending message, or — when the user HAS answered —
    // drives the new run with that answer as the prompt, exactly the normal
    // follow-up path. The check is precise: `toolName === 'ask_user'` AND a
    // non-error result, and it scans the whole trailing tool-result run so a
    // batch (ask_user issued together with another tool — a mixed trailing batch) is caught even
    // when another result landed last. An ERRORING ask_user is a plain tool
    // result the model must recover from, so it stays a normal continuation.
    const trailingToolResults = [];
    for (let i = messages.length - 1; i >= 0 && messages[i].role === 'toolResult'; i -= 1) {
      trailingToolResults.push(messages[i] as ToolResultMessage);
    }
    const terminalSideEffectComplete = trailingToolResults.some(
      (result) =>
        (result.toolName === 'ask_user' || result.toolName === 'create_skill') && !result.isError,
    );
    if (terminalSideEffectComplete) return { kind: 'already-complete', messages };
    return { kind: 'continue', messages, repairedToolCalls: [] };
  }

  if (last.role === 'assistant') {
    const calls = (last as AssistantMessage).content.filter(
      (c): c is ToolCall => c.type === 'toolCall',
    );
    if (calls.length === 0) return { kind: 'already-complete', messages };

    // Results for this assistant turn can only appear after it, so any call id
    // not already answered is dangling.
    const answered = new Set(
      messages
        .filter((m): m is ToolResultMessage => m.role === 'toolResult')
        .map((m) => m.toolCallId),
    );
    const dangling = calls.filter((c) => !answered.has(c.id));
    if (dangling.length === 0) {
      // Every call was answered but the results were re-ordered before the
      // assistant message; treat as a normal continuation point.
      return { kind: 'continue', messages, repairedToolCalls: [] };
    }
    // Keep planResume deterministic and limited to durable-tail
    // classification. The shared read-boundary normalizer owns synthetic
    // receipts for both tail and middle-of-history orphans.
    return { kind: 'continue', messages, repairedToolCalls: dangling.map((c) => c.id) };
  }

  // Unknown/custom trailing role: safest legal continuation point is the
  // longest prefix ending in a user or toolResult message.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' || messages[i].role === 'toolResult') {
      return { kind: 'continue', messages: messages.slice(0, i + 1), repairedToolCalls: [] };
    }
  }
  return { kind: 'start' };
}
