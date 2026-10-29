import 'server-only';
import type { Queryable } from '@openmaic/storage/agent-session/pg';

export const LEARNER_HANDOFF_EVENT = 'pbl_learner_handoff';

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
function reviewReceipt(event: {
  type: string;
  data: unknown;
}): { text: string; canonical: boolean } | null {
  if (!event.data || typeof event.data !== 'object') return null;
  if (event.type === LEARNER_HANDOFF_EVENT) {
    const data = event.data as { question?: unknown; canonical?: unknown };
    return typeof data.question === 'string' && data.question.trim()
      ? { text: data.question, canonical: data.canonical === true }
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
        return { text: receipt.response, canonical: false };
      if (typeof receipt.question === 'string') return { text: receipt.question, canonical: false };
    } catch {
      /* Malformed or unrelated output is not a teaching response. */
    }
  }
  return null;
}
export function reviewQuestion(event: { type: string; data: unknown }): string | null {
  return reviewReceipt(event)?.text ?? null;
}
export function canonicalReview(event: { type: string; data: unknown }): boolean {
  return reviewReceipt(event)?.canonical === true;
}

/** Prefer the ordered SDK display event; the atomic handoff survives a crash before it arrives. */
export function reviewQuestions(events: readonly { id: number; type: string; data: unknown }[]) {
  const displayed = new Set(
    events.flatMap((event) => {
      if (event.type !== 'tool_execution_end' || !reviewQuestion(event)) return [];
      const id = (event.data as { toolCallId?: unknown }).toolCallId;
      return typeof id === 'string' ? [id] : [];
    }),
  );
  const questions = new Map<number, string>();
  for (const event of events) {
    const id = (event.data as { toolCallId?: unknown } | null)?.toolCallId;
    if (event.type === LEARNER_HANDOFF_EVENT && typeof id === 'string' && displayed.has(id))
      continue;
    const question = reviewQuestion(event);
    if (question !== null) questions.set(event.id, question);
  }
  return questions;
}
