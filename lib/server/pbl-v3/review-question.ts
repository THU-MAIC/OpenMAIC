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

/** Extract committed handoffs and successful, structured teaching-tool questions. */
export function reviewQuestion(event: { type: string; data: unknown }): string | null {
  if (!event.data || typeof event.data !== 'object') return null;
  if (event.type === LEARNER_HANDOFF_EVENT) {
    const question = (event.data as { question?: unknown }).question;
    return typeof question === 'string' && question.trim() ? question : null;
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
      if (data.toolName === 'respond_to_learner' && typeof receipt.response === 'string')
        return receipt.response;
      if (typeof receipt.question === 'string') return receipt.question;
    } catch {
      // Other tool output and malformed receipts are not teaching conversation.
    }
  }
  return null;
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
