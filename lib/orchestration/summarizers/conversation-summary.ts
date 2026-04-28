// ==================== Conversation Summary ====================

/**
 * OpenAI message format (used by director)
 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Summarize conversation history for the director agent
 *
 * Produces a condensed text summary of the last N messages,
 * truncating long messages and including role labels.
 *
 * @param messages - OpenAI-format messages to summarize
 * @param maxMessages - Maximum number of recent messages to include (default 10)
 * @param maxContentLength - Maximum content length per message (default 200)
 */
export function summarizeConversation(
  messages: OpenAIMessage[],
  maxMessages = 10,
  maxContentLength = 200,
): string {
  if (messages.length === 0) {
    return 'No conversation history yet.';
  }

  const recent = messages.slice(-maxMessages);
  const lines = recent.map((msg) => {
    const roleLabel =
      msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
    const content =
      msg.content.length > maxContentLength
        ? msg.content.slice(0, maxContentLength) + '...'
        : msg.content;
    return `[${roleLabel}] ${content}`;
  });

  return lines.join('\n');
}
