// ==================== Conversation Summary ====================

import type { StatelessChatRequest } from '@/lib/types/chat';

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

/**
 * Extract the most recent genuine human student message from the original
 * pre-conversion message list.
 *
 * Uses msg.metadata.originalRole === 'user' as the source-of-truth discriminator,
 * set by use-chat-sessions.ts on every human message. This is reliable regardless
 * of what display prefixes message-converter.ts applies to the content.
 *
 * Used by the director to surface unaddressed student questions explicitly,
 * preventing premature END when a substantive human challenge has not yet
 * been resolved (issue #511).
 *
 * @param messages - Original pre-conversion messages (StatelessChatRequest['messages'])
 * @returns The message text, or null if no human message exists.
 */
export function extractLastHumanMessage(messages: StatelessChatRequest['messages']): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.metadata?.originalRole !== 'user') continue;

    const text = (msg.parts ?? [])
      .filter((p) => (p as Record<string, unknown>).type === 'text')
      .map((p) => (p as Record<string, unknown>).text as string)
      .join('\n')
      .trim();

    return text || null;
  }
  return null;
}
