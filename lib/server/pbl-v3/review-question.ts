import 'server-only';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Queryable } from '@openmaic/storage/agent-session/pg';

export const LEARNER_HANDOFF_EVENT = 'pbl_learner_handoff';

/** One authored message supplies both display text and the question recorded for feedback. */
export function reviewResponse(response: string): { response: string; question: string } {
  const text = response.trim();
  if (!text) throw new Error('A complete review response is required.');
  const question = text
    .split(/\r?\n[ \t]*\r?\n/)
    .at(-1)!
    .trim();
  return { response: text, question };
}

/** Presentation actions can accompany a closing or follow it before registration. */
function preservesSpokenClosing(name: string) {
  return name.startsWith('wb_') || ['cue_user', 'point_at_code', 'point_at_preview'].includes(name);
}
const handoffTools = ['request_skill_review', 'respond_to_learner', 'request_learner_help'];

export function spokenHandoffClosing() {
  let spoken: { question: string; spokenAt: number } | undefined;
  let hasCurrentSpeech = false;
  let calls: { name: string; id: string; arguments: Record<string, unknown> }[] = [];
  return {
    observe(message: AgentMessage) {
      if (message.role === 'toolResult') return;
      calls = [];
      hasCurrentSpeech = false;
      if (message.role !== 'assistant' || ['error', 'aborted'].includes(message.stopReason)) {
        spoken = undefined;
        return;
      }
      const tools = message.content.filter((part) => part.type === 'toolCall');
      calls = tools.filter((tool) => handoffTools.includes(tool.name));
      if (
        tools.some(
          (tool) => !handoffTools.includes(tool.name) && !preservesSpokenClosing(tool.name),
        )
      ) {
        calls = [];
        spoken = undefined;
        return;
      }
      const last = message.content.findLast((part) => part.type === 'text' && part.text.trim());
      if (last?.type === 'text') {
        hasCurrentSpeech = true;
        spoken = { question: reviewResponse(last.text).question, spokenAt: message.timestamp };
      }
    },
    forCall(id: string): { question: string; spokenAt?: number } | undefined {
      const call = calls.find((tool) => tool.id === id);
      if (!call) return undefined;
      // Older in-flight calls could supply both prose and a different question. Only the
      // author can distinguish an introduction from a closing invitation in arbitrary prose.
      if (call.arguments.askNewQuestion === true && !hasCurrentSpeech)
        throw new Error('Speak the missing review question before registering it.');
      if (call.arguments.deliverMissing === true && !hasCurrentSpeech)
        throw new Error('Speak the missing information before registering it.');
      const review = call.name === 'request_skill_review';
      const legacy =
        call.name === 'respond_to_learner' ? call.arguments.response : call.arguments.question;
      if (
        (review ? hasCurrentSpeech : !!spoken) &&
        typeof legacy === 'string' &&
        legacy.trim() &&
        legacy.trim() !== spoken?.question
      )
        throw new Error(
          !review
            ? 'The supplied text differs from the spoken closing. Speak any missing information once, then register it without text.'
            : 'Two different review texts were supplied. If you already asked the question, register it with an empty call. If you only gave an introduction, speak the missing question once and register it without a question argument.',
        );
      if (spoken) return spoken;
      // A tool-only call issued under the old schema can still finish after an upgrade.
      return typeof legacy === 'string' && legacy.trim() ? { question: legacy } : undefined;
    },
  };
}

/** Support-only inputs stay in history but cannot become later understanding/approval evidence. */
export async function supportTurnSequences(
  db: Queryable,
  sessionId: string,
  stageKey: string,
): Promise<Set<number>> {
  const result = await db.query<{ source: string }>(
    `SELECT data->>'sourceUserSeq' AS source FROM agent_session_events
     WHERE session_id=$1 AND type=$2 AND data->>'kind'='support' AND data->>'stageKey'=$3`,
    [sessionId, LEARNER_HANDOFF_EVENT, stageKey],
  );
  return new Set(
    result.rows
      .map((row) => Number(row.source))
      .filter((seq) => Number.isSafeInteger(seq) && seq > 0),
  );
}

/** A committed full response is the sole prose delivery for its input; tool cards stay visible. */
type ReviewReceipt = { text: string; canonical: boolean; spokenAt?: number };

function reviewReceipt(event: { type: string; data: unknown }): ReviewReceipt | null {
  if (!event.data || typeof event.data !== 'object') return null;
  if (event.type === LEARNER_HANDOFF_EVENT) {
    const data = event.data as { question?: unknown; canonical?: unknown; spokenAt?: unknown };
    return typeof data.question === 'string' && data.question.trim()
      ? {
          text: data.question,
          canonical: data.canonical === true,
          spokenAt: typeof data.spokenAt === 'number' ? data.spokenAt : undefined,
        }
      : null;
  }
  if (event.type !== 'tool_execution_end') return null;
  const data = event.data as {
    toolName?: string;
    isError?: boolean;
    result?: { content?: { type: string; text?: string }[] };
  };
  if (
    !['request_skill_review', 'request_learner_help', 'respond_to_learner'].includes(
      data.toolName ?? '',
    ) ||
    data.isError
  )
    return null;
  for (const block of data.result?.content ?? []) {
    if (block.type !== 'text' || !block.text) continue;
    try {
      const receipt = JSON.parse(block.text);
      if (
        receipt.canonical === true &&
        typeof receipt.response === 'string' &&
        receipt.response.trim()
      )
        return { text: receipt.response, canonical: true };
      if (data.toolName === 'respond_to_learner' && typeof receipt.response === 'string')
        return {
          text: receipt.response,
          canonical: false,
          spokenAt: typeof receipt.spokenAt === 'number' ? receipt.spokenAt : undefined,
        };
      if (typeof receipt.question === 'string')
        return {
          text: receipt.question,
          canonical: false,
          spokenAt: typeof receipt.spokenAt === 'number' ? receipt.spokenAt : undefined,
        };
    } catch {
      /* Malformed or unrelated output is not a teaching response. */
    }
  }
  return null;
}
/** Prefer the ordered SDK display event; the atomic handoff survives a crash before it arrives. */
export function reviewQuestions(
  events: readonly { id: number; attempt?: number; type: string; data: unknown }[],
) {
  const questions = new Map<number, ReviewReceipt>();
  const displayed = new Set<string>();
  const atomic = new Map<number, string>();
  for (const event of events) {
    const receipt = reviewReceipt(event);
    if (!receipt) continue;
    questions.set(event.id, receipt);
    const id = (event.data as { toolCallId?: unknown }).toolCallId;
    if (typeof id !== 'string') continue;
    const call = `${event.attempt ?? ''}:${id}`;
    if (event.type === 'tool_execution_end') displayed.add(call);
    else atomic.set(event.id, call);
  }
  for (const [event, call] of atomic) if (displayed.has(call)) questions.delete(event);
  return questions;
}
