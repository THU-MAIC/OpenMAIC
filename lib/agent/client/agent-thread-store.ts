'use client';

/**
 * Multi-session persistence for the AgentPanel ("Edit with AI") conversation.
 *
 * One stage owns many sessions (history). Backed by IndexedDB via Dexie
 * (`db.agentEditSessions`) so large message histories don't hit the ~5MB
 * localStorage cap, matching upstream's client-storage model. The previous
 * single-thread localStorage store ('maic-agent-threads') is migrated once via
 * migrateLegacyThread(), then dropped per-stage.
 */
import { nanoid } from 'nanoid';
import { db } from '@/lib/utils/database';
import { MAX_SESSIONS_PER_STAGE, type AgentEditSessionRecord } from './agent-edit-session-types';
import type { SerializedMessage } from './serialize-thread';

const LEGACY_KEY = 'maic-agent-threads';
const ACTIVE_KEY = 'maic-agent-active-session';

/**
 * Per-stage pointer to the session the user last had open, persisted so a
 * refresh restores THAT session — including a freshly-created empty one after
 * "new conversation" (which has no IndexedDB row yet). Without it, mount would
 * fall back to the most recent archived session and the just-cleared chat would
 * reappear. Only the id (a short string) lives in localStorage; messages stay
 * in IndexedDB.
 */
export function rememberActiveSession(stageId: string, id: string): void {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[stageId] = id;
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(map));
  } catch {
    /* best-effort */
  }
}

export function recallActiveSession(stageId: string): string | undefined {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return undefined;
    const map = JSON.parse(raw);
    return typeof map?.[stageId] === 'string' ? map[stageId] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ids of sessions deleted this page-session. A settle-save can be in flight when
 * the user deletes the active session; without this guard its late `put` would
 * resurrect the just-deleted row. nanoid ids are never reused, so tombstoning is
 * permanently safe.
 */
const tombstoned = new Set<string>();

export function newId(): string {
  return nanoid();
}

/** A fresh, empty, NOT-yet-persisted session for a stage. */
export function createSession(stageId: string): AgentEditSessionRecord {
  const now = Date.now();
  return { id: newId(), stageId, title: '', messages: [], createdAt: now, updatedAt: now };
}

export async function loadSession(id: string): Promise<AgentEditSessionRecord | undefined> {
  return db.agentEditSessions.get(id);
}

/** A stage's sessions, newest-first by updatedAt. */
export async function listSessions(stageId: string): Promise<AgentEditSessionRecord[]> {
  const all = await db.agentEditSessions.where('stageId').equals(stageId).toArray();
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteSession(id: string): Promise<void> {
  tombstoned.add(id);
  await db.agentEditSessions.delete(id);
}

/** Drop sessions beyond the per-stage soft cap, oldest first. */
async function pruneStage(stageId: string): Promise<void> {
  const list = await listSessions(stageId); // newest-first
  for (const stale of list.slice(MAX_SESSIONS_PER_STAGE)) {
    await db.agentEditSessions.delete(stale.id);
  }
}

export async function saveSession(record: AgentEditSessionRecord): Promise<void> {
  // A delete that landed before this (in-flight) save wins — never resurrect.
  if (tombstoned.has(record.id)) return;
  // Read-compare-write in a single rw transaction so concurrent saves for the
  // same session can't both read a stale row and let an older write land after a
  // newer one. Inside the transaction the read sees prior committed puts.
  await db.transaction('rw', db.agentEditSessions, async () => {
    const existing = await db.agentEditSessions.get(record.id);
    // A delete may have landed during the read, or a newer save may already have
    // persisted — this (now stale) save must not resurrect or clobber it.
    if (tombstoned.has(record.id)) return;
    if (existing && existing.updatedAt > record.updatedAt) return;
    await db.agentEditSessions.put(
      existing ? { ...record, createdAt: existing.createdAt } : record,
    );
  });
  await pruneStage(record.stageId);
}

interface LegacyThread {
  messages: SerializedMessage[];
  updatedAt: number;
}

/**
 * One-time import of the old single-thread localStorage entry into a session.
 * Idempotent: removes the per-stage legacy entry after importing so it never
 * re-imports. Returns the new record, or undefined when there is nothing to
 * migrate.
 */
export async function migrateLegacyThread(
  stageId: string,
): Promise<AgentEditSessionRecord | undefined> {
  let parsed: { state?: { threads?: Record<string, LegacyThread> } } | null = null;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return undefined;
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const threads = parsed?.state?.threads;
  const legacy = threads?.[stageId];
  if (!legacy || !Array.isArray(legacy.messages) || legacy.messages.length === 0) {
    return undefined;
  }
  const ts =
    typeof legacy.updatedAt === 'number' && legacy.updatedAt > 0 ? legacy.updatedAt : Date.now();
  const record: AgentEditSessionRecord = {
    // Deterministic id so overlapping migrations (StrictMode's double mount, or
    // two tabs opening after the upgrade) import to the SAME row — an idempotent
    // put — instead of generating distinct nanoids and duplicating history.
    id: `legacy:${stageId}`,
    stageId,
    title: '',
    messages: legacy.messages,
    createdAt: ts,
    updatedAt: ts,
  };
  await saveSession(record);
  // Drop only this stage's legacy entry; keep the rest for their own migration.
  try {
    delete threads![stageId];
    if (Object.keys(threads!).length === 0) localStorage.removeItem(LEGACY_KEY);
    else localStorage.setItem(LEGACY_KEY, JSON.stringify(parsed));
  } catch {
    /* best-effort */
  }
  return record;
}
