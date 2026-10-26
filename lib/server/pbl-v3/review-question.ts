import 'server-only';

export const LEARNER_HANDOFF_EVENT = 'pbl_learner_handoff';

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
    !['request_skill_review', 'request_learner_help'].includes(data.toolName ?? '') ||
    data.isError
  )
    return null;
  for (const block of data.result?.content ?? []) {
    if (block.type !== 'text' || !block.text) continue;
    try {
      const receipt = JSON.parse(block.text);
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
