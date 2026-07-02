import type { SerializedMessage } from './serialize-thread';

/** One AI-editing conversation, persisted in IndexedDB (Dexie `agentEditSessions`). */
export interface AgentEditSessionRecord {
  /** nanoid, globally unique. */
  id: string;
  /** Owning stage (stages.id). */
  stageId: string;
  /** Auto-derived from the first user message; never user-edited (v1). */
  title: string;
  /** Slim projection — same shape the cards re-render (see serialize-thread). */
  messages: SerializedMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Soft cap per stage; createSession/saveSession prune oldest beyond this. */
export const MAX_SESSIONS_PER_STAGE = 30;

const TITLE_MAX = 40;

/** First user message's first text part, whitespace-collapsed and truncated. */
export function deriveSessionTitle(messages: SerializedMessage[], fallback: string): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const p of m.content) {
      if (p.type === 'text' && typeof p.text === 'string') {
        const clean = p.text.replace(/\s+/g, ' ').trim();
        if (!clean) continue;
        return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX)}…` : clean;
      }
    }
  }
  return fallback;
}
