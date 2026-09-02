import type { AgentSessionUserMessage } from '@openmaic/storage';
import type { PgAgentSessionStore } from '@openmaic/storage/agent-session/pg';
import { HOST_AGENT_LIFECYCLE } from '@/lib/agent-runtime/lifecycle';

export interface AgentUserMessageWithElementRefs extends AgentSessionUserMessage {
  elementRefs?: unknown[];
}

/**
 * Read user messages from their authoritative event JSON. The storage package's
 * compatibility projection currently omits elementRefs even though it persists
 * them, so the application runner uses this adapter until that surface catches up.
 */
export async function listAgentUserMessages(
  store: Pick<PgAgentSessionStore, 'readEventsAfter' | 'listUserMessages'>,
  sessionId: string,
): Promise<AgentUserMessageWithElementRefs[]> {
  // Lightweight runner fakes and compatibility implementations may expose only
  // the old projection. Production PgAgentSessionStore always takes the event path.
  if (typeof store.readEventsAfter !== 'function') {
    return store.listUserMessages(sessionId) as Promise<AgentUserMessageWithElementRefs[]>;
  }
  const messages: AgentUserMessageWithElementRefs[] = [];
  let cursor = 0;
  for (;;) {
    const events = await store.readEventsAfter(sessionId, cursor, 500);
    for (const event of events) {
      if (event.type !== HOST_AGENT_LIFECYCLE.userMessage) continue;
      const data =
        event.data && typeof event.data === 'object' && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : {};
      messages.push({
        seq: event.id,
        ts: event.ts,
        text: String(data.text ?? ''),
        delivery: String(data.delivery ?? ''),
        materials: Array.isArray(data.materials) ? data.materials : [],
        ...(Array.isArray(data.elementRefs) ? { elementRefs: data.elementRefs } : {}),
        ...(Array.isArray(data.courseRefs) ? { courseRefs: data.courseRefs } : {}),
      });
    }
    if (events.length < 500) return messages;
    cursor = events[events.length - 1]!.id;
  }
}
