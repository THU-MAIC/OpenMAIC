import type { AgentSessionUserMessage } from '@openmaic/storage';
import type { PgAgentSessionStore } from '@openmaic/storage/agent-session/pg';
import { HOST_AGENT_LIFECYCLE } from '@/lib/agent-runtime/lifecycle';

export interface AgentUserMessageWithElementRefs extends AgentSessionUserMessage {
  elementRefs?: unknown[];
}

export interface DetachedSessionSkill {
  skillName: string;
  throughMessageSeq: number;
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
  return (await readAgentMessageLog(store, sessionId)).messages;
}

/** Read recovery receipts with their message boundary, including after a restart. */
export async function readAgentMessageLog(
  store: Pick<PgAgentSessionStore, 'readEventsAfter' | 'listUserMessages'>,
  sessionId: string,
): Promise<{
  messages: AgentUserMessageWithElementRefs[];
  detachedSkills: DetachedSessionSkill[];
  openingMessageSeq?: number;
}> {
  // Lightweight runner fakes and compatibility implementations may expose only
  // the old projection. Production PgAgentSessionStore always takes the event path.
  if (typeof store.readEventsAfter !== 'function') {
    return { messages: await store.listUserMessages(sessionId), detachedSkills: [] };
  }
  const messages: AgentUserMessageWithElementRefs[] = [];
  const detachedSkills: DetachedSessionSkill[] = [];
  let priorRunSeen = false;
  let openingMessageSeq: number | undefined;
  let cursor = 0;
  for (;;) {
    const events = await store.readEventsAfter(sessionId, cursor, 500);
    for (const event of events) {
      if (
        event.type === HOST_AGENT_LIFECYCLE.sessionStart ||
        event.type === HOST_AGENT_LIFECYCLE.sessionResumed ||
        event.type === HOST_AGENT_LIFECYCLE.sessionEnd ||
        event.type === HOST_AGENT_LIFECYCLE.sessionInterrupted
      )
        priorRunSeen = true;
      const data =
        event.data && typeof event.data === 'object' && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : {};
      if (
        event.type === HOST_AGENT_LIFECYCLE.skillDetached &&
        typeof data.skillName === 'string' &&
        typeof data.throughMessageSeq === 'number' &&
        Number.isSafeInteger(data.throughMessageSeq) &&
        data.throughMessageSeq >= 0
      ) {
        detachedSkills.push({
          skillName: data.skillName,
          throughMessageSeq: data.throughMessageSeq,
        });
      }
      if (event.type !== HOST_AGENT_LIFECYCLE.userMessage) continue;
      // A text-only opener can live solely in session metadata. In that case
      // the first durable user message, posted after a run, is a fresh follow-up.
      if (!priorRunSeen && messages.length === 0) openingMessageSeq = event.id;
      messages.push({
        seq: event.id,
        ts: event.ts,
        text: String(data.text ?? ''),
        delivery: String(data.delivery ?? ''),
        materials: Array.isArray(data.materials) ? data.materials : [],
        ...(Array.isArray(data.elementRefs) ? { elementRefs: data.elementRefs } : {}),
        ...(Array.isArray(data.courseRefs) ? { courseRefs: data.courseRefs } : {}),
        ...(typeof data.locale === 'string' && data.locale ? { locale: data.locale } : {}),
      });
    }
    if (events.length < 500)
      return {
        messages,
        detachedSkills,
        ...(openingMessageSeq !== undefined ? { openingMessageSeq } : {}),
      };
    cursor = events[events.length - 1]!.id;
  }
}
