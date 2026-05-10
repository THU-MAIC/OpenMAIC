// ==================== Conversation Summary ====================

/**
 * OpenAI message format (used by director)
 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Regex that matches the [AgentName]: prefix added by convertMessagesToOpenAI()
 * when a peer agent's message is re-encoded as role:'user'.
 *
 * Matches: "[Some Agent Name]: ..." — one or more words, spaces allowed inside.
 * Does NOT match bare user messages like "Can a 3D object be axisymmetric?".
 */
const AGENT_PREFIX_RE = /^\[([^\]]+)\]:\s*/;

/**
 * Detect whether a user-role message is actually a peer agent message.
 * convertMessagesToOpenAI() re-encodes other agents' turns as role:'user'
 * with a "[AgentName]: " prefix. Without this check, the director sees
 * both human student questions and agent replies as identical "[User]" lines,
 * causing role confusion and premature END decisions.
 */
function parseAgentPrefix(content: string): { isAgent: boolean; agentName: string; body: string } {
  const match = content.match(AGENT_PREFIX_RE);
  if (match) {
    return { isAgent: true, agentName: match[1], body: content.slice(match[0].length) };
  }
  return { isAgent: false, agentName: '', body: content };
}

/**
 * Summarize conversation history for the director agent.
 *
 * Produces a condensed text summary of the last N messages with role labels
 * that correctly distinguish:
 *   - [Student (Human)] — genuine messages from the human user
 *   - [Agent: Name]     — peer agent turns re-encoded as role:'user' by
 *                         convertMessagesToOpenAI()
 *   - [Assistant]       — the current agent's own prior turns
 *
 * Without this distinction the director cannot tell apart a substantive
 * human challenge ("Can a 3D structure really be called axisymmetric?")
 * from a brief agent acknowledgment, causing off-topic replies and
 * premature discussion termination (issue #511).
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
    let roleLabel: string;
    let content: string;

    if (msg.role === 'user') {
      const parsed = parseAgentPrefix(msg.content);
      if (parsed.isAgent) {
        // Peer agent turn re-encoded as user role — preserve attribution
        roleLabel = `Agent: ${parsed.agentName}`;
        content = parsed.body;
      } else {
        // Genuine human student message
        roleLabel = 'Student (Human)';
        content = msg.content;
      }
    } else if (msg.role === 'assistant') {
      roleLabel = 'Assistant';
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
 * Extract the most recent genuine human student message from a message list.
 *
 * Scans backwards through messages to find the last role:'user' message that
 * does NOT carry an [AgentName]: prefix — i.e., a real message from the human,
 * not a peer agent turn that was re-encoded as user role.
 *
 * Used by the director to surface unaddressed student questions explicitly,
 * preventing premature END when a substantive human challenge has not yet
 * been resolved (issue #511).
 *
 * @returns The message content string, or null if no human message exists.
 */
export function extractLastHumanMessage(messages: OpenAIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const parsed = parseAgentPrefix(msg.content);
    if (!parsed.isAgent) {
      return msg.content.trim() || null;
    }
  }
  return null;
}
