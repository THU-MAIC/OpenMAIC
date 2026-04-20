// ==================== Conversation Summary ====================

/**
 * OpenAI-style message used by the director.
 * Content may be a string or a multimodal content array; only the text
 * portion is summarized (images are denoted as `[image]`).
 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType?: string }>;
}

/**
 * Flatten a multimodal content to plain text for summarization.
 */
function contentToSummaryText(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : '[image]'))
    .filter(Boolean)
    .join(' ');
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
    const text = contentToSummaryText(msg.content);
    const content = text.length > maxContentLength ? text.slice(0, maxContentLength) + '...' : text;
    return `[${roleLabel}] ${content}`;
  });

  return lines.join('\n');
}
