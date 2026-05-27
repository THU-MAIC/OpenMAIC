// ==================== Conversation Summary ====================

/**
 * OpenAI message format (used by director)
 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Regex used only for content stripping — removes the [senderName]: display prefix
 * that message-converter.ts adds to role:'user' messages.
 * Used cosmetically in summarizeConversation() output; NOT used for discrimination.
 */
const SENDER_PREFIX_RE = /^\[[^\]]+\]:\s*/;

/**
 * Summarize conversation history for the director agent.
 *
 * In the director path, convertMessagesToOpenAI() is called without currentAgentId,
 * so peer agent messages remain as role:'assistant'. The role field is therefore a
 * reliable discriminator:
 *   - role:'user'       → genuine human student message
 *   - role:'assistant'  → agent turn
 *
 * message-converter.ts adds a [senderName]: display prefix to role:'user' content
 * (e.g. "[You]: Can a 3D object be axisymmetric?"). This prefix is stripped from
 * the summary output for readability — it is NOT used for discrimination.
 *
 * @param messages - OpenAI-format messages from the director path
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
    let roleLabel: string;
    let content: string;

    if (msg.role === 'user') {
      // In the director path, all role:'user' messages are genuine human turns.
      // Strip the [senderName]: display prefix added by message-converter for readability.
      roleLabel = 'Student (Human)';
      content = msg.content.replace(SENDER_PREFIX_RE, '');
    } else if (msg.role === 'assistant') {
      roleLabel = 'Agent';
      content = msg.content;
    } else {
      roleLabel = 'System';
      content = msg.content;
    }

    const truncated =
      content.length > maxContentLength ? content.slice(0, maxContentLength) + '...' : content;

    return `[${roleLabel}] ${truncated}`;
  });

  return lines.join('\n');
}
