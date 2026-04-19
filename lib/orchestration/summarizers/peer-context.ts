import type { AgentTurnSummary } from '../types';

// ==================== Peer Context ====================

/**
 * Build a context section summarizing what other agents said this round.
 * Returns empty string if no agents have spoken yet.
 */
export function buildPeerContextSection(
  agentResponses: AgentTurnSummary[] | undefined,
  currentAgentName: string,
): string {
  if (!agentResponses || agentResponses.length === 0) return '';

  // Filter out self (defensive — director shouldn't dispatch same agent twice)
  const peers = agentResponses.filter((r) => r.agentName !== currentAgentName);
  if (peers.length === 0) return '';

  const peerLines = peers.map((r) => `- ${r.agentName}: "${r.contentPreview}"`).join('\n');

  return `
# This Round's Context (CRITICAL — READ BEFORE RESPONDING)
The following agents have already spoken in this discussion round:
${peerLines}

You are ${currentAgentName}, responding AFTER the agents above. You MUST:
1. NOT repeat greetings or introductions — they have already been made
2. NOT restate what previous speakers already explained
3. Add NEW value from YOUR unique perspective as ${currentAgentName}
4. Build on, question, or extend what was said — do not echo it
5. If you agree with a previous point, say so briefly and then ADD something new
`;
}
