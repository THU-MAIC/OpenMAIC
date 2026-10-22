import 'server-only';

/** Only a successful, structured teaching-review receipt is a learner-visible tool message. */
export function reviewQuestion(event: { type: string; data: unknown }): string | null {
  if (event.type !== 'tool_execution_end') return null;
  const data = event.data as {
    toolName?: string;
    isError?: boolean;
    result?: { content?: { type: string; text?: string }[] };
  };
  if (data.toolName !== 'request_skill_review' || data.isError) return null;
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
