import { beforeEach, describe, expect, it, vi } from 'vitest';

// localStorage stub (tests run in the node environment; no jsdom).
const lsStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (k: string) => (k in lsStore ? lsStore[k] : null),
  setItem: (k: string, v: string) => {
    lsStore[k] = String(v);
  },
  removeItem: (k: string) => {
    delete lsStore[k];
  },
  clear: () => {
    for (const k of Object.keys(lsStore)) delete lsStore[k];
  },
  key: (i: number) => Object.keys(lsStore)[i] ?? null,
  get length() {
    return Object.keys(lsStore).length;
  },
};
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

// In-memory fake of the Dexie agentEditSessions table.
interface Row {
  id: string;
  stageId: string;
  updatedAt: number;
  [k: string]: unknown;
}
const rows = new Map<string, Row>();
vi.mock('@/lib/utils/database', () => ({
  db: {
    // Run the callback directly — the in-memory map is synchronous, so this
    // faithfully serializes the read-compare-write the same way Dexie's rw tx does.
    transaction: vi.fn(async (_mode: string, _table: unknown, fn: () => Promise<void>) => fn()),
    agentEditSessions: {
      put: vi.fn(async (r: Row) => void rows.set(r.id, { ...r })),
      get: vi.fn(async (id: string) => (rows.has(id) ? { ...rows.get(id) } : undefined)),
      delete: vi.fn(async (id: string) => void rows.delete(id)),
      where: vi.fn((idx: string) => ({
        equals: (val: string) => ({
          toArray: async () =>
            [...rows.values()].filter((r) => (idx === 'stageId' ? r.stageId === val : false)),
        }),
      })),
    },
  },
}));

import {
  createSession,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  migrateLegacyThread,
  rememberActiveSession,
  recallActiveSession,
} from '@/lib/agent/client/agent-thread-store';
import { MAX_SESSIONS_PER_STAGE } from '@/lib/agent/client/agent-edit-session-types';

const userMsg = (text: string) => ({
  role: 'user' as const,
  content: [{ type: 'text' as const, text }],
});

beforeEach(() => {
  rows.clear();
  localStorage.clear();
});

describe('agent edit session store', () => {
  it('createSession returns an empty record not yet persisted', async () => {
    const s = createSession('stage-a');
    expect(s.stageId).toBe('stage-a');
    expect(s.messages).toEqual([]);
    expect(await loadSession(s.id)).toBeUndefined();
  });

  it('saveSession persists and loadSession round-trips', async () => {
    const s = { ...createSession('stage-a'), title: 't', messages: [userMsg('hi')] };
    await saveSession(s);
    expect(await loadSession(s.id)).toMatchObject({ id: s.id, title: 't' });
  });

  it('listSessions returns a stage’s sessions newest-first', async () => {
    await saveSession({ ...createSession('stage-a'), updatedAt: 100, messages: [userMsg('a')] });
    await saveSession({ ...createSession('stage-a'), updatedAt: 300, messages: [userMsg('b')] });
    await saveSession({ ...createSession('stage-b'), updatedAt: 200, messages: [userMsg('c')] });
    const list = await listSessions('stage-a');
    expect(list.map((r) => r.updatedAt)).toEqual([300, 100]);
  });

  it('deleteSession removes only that record', async () => {
    const s = { ...createSession('stage-a'), messages: [userMsg('a')] };
    await saveSession(s);
    await deleteSession(s.id);
    expect(await loadSession(s.id)).toBeUndefined();
  });

  it('saveSession ignores a stale (older updatedAt) write so a newer save is not clobbered', async () => {
    const s = createSession('stage-a');
    await saveSession({ ...s, updatedAt: 300, messages: [userMsg('newer')] });
    // A late, older in-flight save for the same session must not overwrite.
    await saveSession({ ...s, updatedAt: 100, messages: [userMsg('older')] });
    const loaded = await loadSession(s.id);
    expect(loaded?.updatedAt).toBe(300);
    expect(loaded?.messages).toEqual([userMsg('newer')]);
  });

  it('saveSession preserves the original createdAt on update', async () => {
    const s = {
      ...createSession('stage-a'),
      createdAt: 100,
      updatedAt: 100,
      messages: [userMsg('a')],
    };
    await saveSession(s);
    await saveSession({ ...s, createdAt: 999, updatedAt: 500, messages: [userMsg('a edited')] });
    const loaded = await loadSession(s.id);
    expect(loaded?.createdAt).toBe(100);
    expect(loaded?.updatedAt).toBe(500);
  });

  it('deleteSession tombstones the id so a late save cannot resurrect it', async () => {
    const s = { ...createSession('stage-a'), messages: [userMsg('a')] };
    await saveSession(s);
    await deleteSession(s.id);
    // A stale in-flight save for the just-deleted session must be a no-op.
    await saveSession({ ...s, updatedAt: 777, messages: [userMsg('late')] });
    expect(await loadSession(s.id)).toBeUndefined();
    expect((await listSessions('stage-a')).length).toBe(0);
  });

  it('saveSession prunes oldest beyond MAX_SESSIONS_PER_STAGE', async () => {
    for (let i = 0; i < MAX_SESSIONS_PER_STAGE + 5; i++) {
      await saveSession({
        ...createSession('stage-a'),
        updatedAt: i + 1,
        messages: [userMsg(`m${i}`)],
      });
    }
    const list = await listSessions('stage-a');
    expect(list.length).toBe(MAX_SESSIONS_PER_STAGE);
    expect(Math.min(...list.map((r) => r.updatedAt))).toBe(6);
  });

  it('migrateLegacyThread imports a non-empty localStorage thread once', async () => {
    localStorage.setItem(
      'maic-agent-threads',
      JSON.stringify({
        state: { threads: { 'stage-a': { messages: [userMsg('legacy')], updatedAt: 42 } } },
        version: 1,
      }),
    );
    const migrated = await migrateLegacyThread('stage-a');
    expect(migrated?.messages).toEqual([userMsg('legacy')]);
    expect((await listSessions('stage-a')).length).toBe(1);
    // idempotent: second call does nothing
    expect(await migrateLegacyThread('stage-a')).toBeUndefined();
    expect((await listSessions('stage-a')).length).toBe(1);
  });

  it('migrateLegacyThread ignores empty/absent threads', async () => {
    expect(await migrateLegacyThread('nope')).toBeUndefined();
  });

  it('remembers and recalls the active session id per stage', () => {
    expect(recallActiveSession('stage-a')).toBeUndefined();
    rememberActiveSession('stage-a', 'sess-1');
    rememberActiveSession('stage-b', 'sess-2');
    expect(recallActiveSession('stage-a')).toBe('sess-1');
    expect(recallActiveSession('stage-b')).toBe('sess-2');
    rememberActiveSession('stage-a', 'sess-3');
    expect(recallActiveSession('stage-a')).toBe('sess-3');
  });
});
