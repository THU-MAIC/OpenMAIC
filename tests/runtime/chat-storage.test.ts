import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import type { RuntimeRecord } from '@openmaic/dsl';
import type { UIMessage } from 'ai';

import {
  interruptActiveChatSessions,
  nextChatUpdatedAt,
  withChatSegmentReveal,
  withChatSegmentSealed,
  withChatSessionStatus,
  type ChatMessageMetadata,
  type ChatSession,
} from '@/lib/types/chat';
import {
  loadChatSessions,
  restoreChatSessionsFromBackup,
  saveChatSessions,
  type ChatStorageSnapshot,
} from '@/lib/utils/chat-storage';

if (!('IDBKeyRange' in globalThis)) {
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
}

vi.mock('@/lib/utils/database', () => ({
  db: {
    chatSessions: {
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          delete: vi.fn().mockResolvedValue(0),
          sortBy: vi.fn().mockResolvedValue([]),
        })),
      })),
      bulkPut: vi.fn().mockResolvedValue(undefined),
    },
    transaction: vi.fn(async (_mode: string, _table: unknown, work: () => Promise<void>) => work()),
  },
}));

const STAGE_ID = 'stage-chat';
const LEARNER_KEY = 'anon:chat-test';

interface LegacyChatStore {
  load(stageId: string): Promise<ChatSession[]>;
  clear(stageId: string): Promise<void>;
}

class MemoryLegacyChatStore implements LegacyChatStore {
  clearCalls = 0;

  constructor(public sessions: ChatSession[] = []) {}

  async load(): Promise<ChatSession[]> {
    return structuredClone(this.sessions);
  }

  async clear(): Promise<void> {
    this.clearCalls += 1;
    this.sessions = [];
  }
}

class FailingClearLegacyChatStore extends MemoryLegacyChatStore {
  failNextClear = true;

  override async clear(): Promise<void> {
    if (this.failNextClear) {
      this.failNextClear = false;
      throw new Error('legacy clear failed');
    }
    await super.clear();
  }
}

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  createdAt: number,
): UIMessage<ChatMessageMetadata> {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    metadata: { createdAt, originalRole: role === 'user' ? 'user' : 'agent' },
  };
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1',
    type: 'qa',
    title: 'Q&A',
    status: 'active',
    messages: [message('message-1', 'user', 'Hello', 1_000)],
    config: { agentIds: ['default-1'], defaultAgentId: 'default-1' },
    toolCalls: [],
    pendingToolCalls: [
      {
        toolCallId: 'pending-1',
        toolName: 'spotlight',
        args: {},
        agentId: 'default-1',
        status: 'pending',
        requestedAt: 1_100,
      },
    ],
    createdAt: 900,
    updatedAt: 1_200,
    sceneId: 'scene-1',
    lastActionIndex: 3,
    ...overrides,
  };
}

function makeRuntimeStore(): RuntimeStore {
  return new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
}

function withCreateRace(backing: RuntimeStore): RuntimeStore {
  const createSession = vi.fn(async (init: Parameters<RuntimeStore['createSession']>[0]) => {
    await backing.createSession(init);
    throw new Error('session already exists');
  });
  return new Proxy(backing, {
    get(target, property) {
      if (property === 'createSession') return createSession;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function runtimeChatRecords(store: RuntimeStore): Promise<RuntimeRecord[]> {
  const sessions = (await store.listSessions(STAGE_ID, LEARNER_KEY)).filter(
    (candidate) => candidate.kind === 'chat',
  );
  return (await Promise.all(sessions.map((candidate) => store.listRecords(candidate.id)))).flat();
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chat RuntimeStore cutover', () => {
  it('persists chat sessions as replayable RuntimeStore records and loads them back', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const input = session();

    await saveChatSessions(STAGE_ID, [input], { store, learnerKey: LEARNER_KEY, legacyStore });

    const runtimeSessions = await store.listSessions(STAGE_ID, LEARNER_KEY);
    expect(runtimeSessions).toHaveLength(1);
    expect(runtimeSessions[0]).toMatchObject({ kind: 'chat', status: 'active' });
    const records = await store.listRecords(runtimeSessions[0]!.id);
    expect(records.map((record) => (record.payload as { kind?: string }).kind)).toEqual([
      'chat_message',
      'chat_session_state',
    ]);
    expect(records[0]).toMatchObject({ sceneId: 'scene-1', actionIndex: 3 });
    expect(records[0]?.payload).toMatchObject({ role: 'user', content: 'Hello' });

    const loaded = await loadChatSessions(STAGE_ID, {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    expect(loaded).toEqual([
      {
        ...input,
        status: 'interrupted',
        pendingToolCalls: [],
      },
    ]);
  });

  it('finishes an empty save when a JavaScript caller passes no session array', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore([session()]);

    await saveChatSessions(STAGE_ID, undefined as unknown as ChatSession[], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    expect(await store.listSessions(STAGE_ID, LEARNER_KEY)).toEqual([]);
    expect(legacyStore.sessions).toEqual([]);
    expect(legacyStore.clearCalls).toBe(1);
  });

  it('keeps the lecture not-started sentinel out of runtime action anchors', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const lecture = session({
      type: 'lecture',
      lastActionIndex: -1,
      messages: [message('lecture-message', 'assistant', '', 1_000)],
    });

    await saveChatSessions(STAGE_ID, [lecture], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    const records = await runtimeChatRecords(store);
    expect(records).not.toHaveLength(0);
    expect(records.every((record) => record.actionIndex === undefined)).toBe(true);
    expect(
      await loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).toMatchObject([{ type: 'lecture', lastActionIndex: -1 }]);
  });

  it('writes only changed records and ignores an older save that arrives later', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const latest = session({ title: 'Latest title', updatedAt: 2_000 });

    await saveChatSessions(STAGE_ID, [latest], { store, learnerKey: LEARNER_KEY, legacyStore });
    const recordCount = (await runtimeChatRecords(store)).length;
    await saveChatSessions(STAGE_ID, [latest], { store, learnerKey: LEARNER_KEY, legacyStore });
    await saveChatSessions(STAGE_ID, [session({ title: 'Stale title', updatedAt: 1_000 })], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    expect(await runtimeChatRecords(store)).toHaveLength(recordCount);
    expect(
      await loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).toMatchObject([{ title: 'Latest title', updatedAt: 2_000 }]);
  });

  it('preserves a real edit when the local wall clock moves behind persisted state', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const editedAt = nextChatUpdatedAt({ updatedAt: 10_000 }, 9_000);
    expect(editedAt).toBe(10_001);
    await saveChatSessions(
      STAGE_ID,
      [session({ title: 'Future persisted title', updatedAt: 10_000 })],
      { store, learnerKey: LEARNER_KEY, legacyStore },
    );

    await saveChatSessions(
      STAGE_ID,
      [
        session({
          title: 'Edited after clock rollback',
          messages: [message('message-2', 'user', 'New edit', 9_000)],
          updatedAt: editedAt,
        }),
      ],
      { store, learnerKey: LEARNER_KEY, legacyStore },
    );

    await expect(
      loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).resolves.toMatchObject([
      {
        title: 'Edited after clock rollback',
        messages: [{ id: 'message-2' }],
        updatedAt: 10_001,
      },
    ]);
  });

  it('rebases an explicitly observed edit when another tab advances the conflict clock', async () => {
    const indexedDB = new IDBFactory();
    const firstTab = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-clock-rollback' });
    const secondTab = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-clock-rollback' });
    const legacyStore = new MemoryLegacyChatStore();

    await saveChatSessions(STAGE_ID, [session({ updatedAt: 1_000 })], {
      store: firstTab,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    const [observed] = await loadChatSessions(STAGE_ID, {
      store: firstTab,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    await saveChatSessions(STAGE_ID, [session({ title: 'Other tab edit', updatedAt: 10_000 })], {
      store: secondTab,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    // A normal stage autosave still carries the caller-visible old snapshot.
    // It may preserve the newer runtime value, but must not pretend the caller
    // observed that value or the next deliberate local edit will look stale.
    await saveChatSessions(STAGE_ID, [observed], {
      store: firstTab,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    await saveChatSessions(
      STAGE_ID,
      [
        {
          ...observed,
          title: 'Local edit after rollback',
          messages: [...observed.messages, message('message-2', 'user', 'New edit', 900)],
          updatedAt: nextChatUpdatedAt(observed, 900),
        },
      ],
      { store: firstTab, learnerKey: LEARNER_KEY, legacyStore },
    );

    await expect(
      loadChatSessions(STAGE_ID, { store: firstTab, learnerKey: LEARNER_KEY, legacyStore }),
    ).resolves.toMatchObject([
      {
        title: 'Local edit after rollback',
        messages: [{ id: 'message-1' }, { id: 'message-2' }],
        updatedAt: 10_001,
      },
    ]);
  });

  it('advances conflict order when completing or reactivating a session', () => {
    const completed = withChatSessionStatus(session({ updatedAt: 10_000 }), 'completed', 9_000);
    const reactivated = withChatSessionStatus(completed, 'active', 9_000);

    expect(completed).toMatchObject({ status: 'completed', updatedAt: 10_001 });
    expect(reactivated).toMatchObject({ status: 'active', updatedAt: 10_002 });
  });

  it('advances conflict order when a streamed message segment is sealed', () => {
    expect(withChatSegmentSealed(session({ updatedAt: 10_000 }), 9_000)).toMatchObject({
      updatedAt: 10_001,
    });
  });

  it('advances streamed conflict order only after the segment is fully revealed', () => {
    const partial = withChatSegmentReveal(session({ updatedAt: 10_000 }), false, 9_000);
    const complete = withChatSegmentReveal(partial, true, 9_000);

    expect(partial.updatedAt).toBe(10_000);
    expect(complete.updatedAt).toBe(10_001);
  });

  it('advances conflict order when reload interrupts active sessions', () => {
    const active = session({ id: 'active', status: 'active', updatedAt: 10_000 });
    const completed = session({ id: 'completed', status: 'completed', updatedAt: 20_000 });

    expect(interruptActiveChatSessions([active, completed], 9_000)).toMatchObject([
      { id: 'active', status: 'interrupted', updatedAt: 10_001 },
      { id: 'completed', status: 'completed', updatedAt: 20_000 },
    ]);
  });

  it('compares structured-clone tool results without losing Map or BigInt updates', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const withResult = (result: unknown) =>
      session({
        toolCalls: [
          {
            toolCallId: 'tool-1',
            toolName: 'grade',
            args: {},
            agentId: 'default-1',
            result,
            status: 'completed',
            requestedAt: 1_000,
            completedAt: 1_100,
          },
        ],
      });

    await saveChatSessions(STAGE_ID, [withResult(new Map([['score', BigInt(1)]]))], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    const initialRecordCount = (await runtimeChatRecords(store)).length;

    const updated = {
      ...withResult(new Map([['score', BigInt(2)]])),
      updatedAt: 1_300,
    };
    await saveChatSessions(STAGE_ID, [updated], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    const updatedRecordCount = (await runtimeChatRecords(store)).length;
    expect(updatedRecordCount).toBe(initialRecordCount);
    expect(
      (
        await loadChatSessions(STAGE_ID, {
          store,
          learnerKey: LEARNER_KEY,
          legacyStore,
        })
      )[0].toolCalls[0].result,
    ).toEqual(new Map([['score', BigInt(2)]]));

    await saveChatSessions(STAGE_ID, [updated], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    expect(await runtimeChatRecords(store)).toHaveLength(updatedRecordCount);
  });

  it('does not rescan the fallback partition for empty retirement sets', async () => {
    const backing = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    let listRecordCalls = 0;
    const store = new Proxy(backing, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === 'listRecords') {
          return async (...args: Parameters<RuntimeStore['listRecords']>) => {
            listRecordCalls += 1;
            return backing.listRecords(...args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const sessions = [
      session({ id: 'session-1' }),
      session({ id: 'session-2', createdAt: 950, updatedAt: 1_300 }),
    ];
    await saveChatSessions(STAGE_ID, sessions, {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    listRecordCalls = 0;

    await saveChatSessions(STAGE_ID, sessions, {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    expect(listRecordCalls).toBe(6);
  });

  it('recovers when another tab wins the deterministic session create race', async () => {
    const backing = makeRuntimeStore();
    const store = withCreateRace(backing);
    const legacyStore = new MemoryLegacyChatStore();

    await expect(
      saveChatSessions(STAGE_ID, [session()], {
        store,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ).resolves.toBeUndefined();

    expect(
      await loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).toMatchObject([{ id: 'session-1', title: 'Q&A' }]);
  });

  it('does not hide a create failure when the re-read session belongs to another partition', async () => {
    const createError = new Error('runtime unavailable');
    const store = {
      listSessions: vi.fn().mockResolvedValue([]),
      createSession: vi.fn().mockRejectedValue(createError),
      getSession: vi.fn().mockResolvedValue({
        id: 'chat:stage-chat:anon%3Achat-test:session-1',
        kind: 'chat',
        stageId: 'another-stage',
        learnerKey: LEARNER_KEY,
      }),
    } as unknown as RuntimeStore;
    const legacyStore = new MemoryLegacyChatStore();

    await expect(
      saveChatSessions(STAGE_ID, [session()], {
        store,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ).rejects.toBe(createError);
  });

  it('projects the newest logical state when a stale cross-tab record has a later seq', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const latest = session({ title: 'Latest title', updatedAt: 2_000 });
    await saveChatSessions(STAGE_ID, [latest], { store, learnerKey: LEARNER_KEY, legacyStore });
    const [runtimeSession] = (await store.listSessions(STAGE_ID, LEARNER_KEY)).filter(
      (candidate) => candidate.kind === 'chat',
    );

    await store.appendRecord({
      id: 'stale-cross-tab-state',
      sessionId: runtimeSession!.id,
      createdAt: new Date(1_000).toISOString(),
      payload: {
        kind: 'chat_session_state',
        payloadVersion: 1,
        role: 'system',
        content: 'Stale title',
        chatSessionId: latest.id,
        type: latest.type,
        title: 'Stale title',
        status: 'interrupted',
        config: latest.config,
        toolCalls: latest.toolCalls,
        messageIds: latest.messages.map((candidate) => candidate.id),
        createdAt: latest.createdAt,
        updatedAt: 1_000,
      },
    });

    expect(
      await loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).toMatchObject([{ title: 'Latest title', updatedAt: 2_000 }]);
  });

  it('keeps only the latest 200 messages without rewriting unchanged message records', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const messages = Array.from({ length: 202 }, (_, index) =>
      message(`message-${index}`, index % 2 === 0 ? 'user' : 'assistant', `Text ${index}`, index),
    );

    await saveChatSessions(STAGE_ID, [session({ messages, updatedAt: 5_000 })], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    const firstRecordCount = (await runtimeChatRecords(store)).length;
    await saveChatSessions(STAGE_ID, [session({ messages, updatedAt: 5_000 })], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    const [loaded] = await loadChatSessions(STAGE_ID, {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    expect(loaded?.messages).toHaveLength(200);
    expect(loaded?.messages[0]?.id).toBe('message-2');
    expect(await runtimeChatRecords(store)).toHaveLength(firstRecordCount);
  });

  it('bounds stored and scanned records across a long-lived chat session', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const listRecords = store.listRecords.bind(store);
    let maxRecordsRead = 0;
    vi.spyOn(store, 'listRecords').mockImplementation(async (...args) => {
      const result = await listRecords(...args);
      maxRecordsRead = Math.max(maxRecordsRead, result.length);
      return result;
    });

    for (let index = 0; index < 300; index += 1) {
      await saveChatSessions(
        STAGE_ID,
        [session({ title: `Q&A ${index}`, updatedAt: 2_000 + index })],
        { store, learnerKey: LEARNER_KEY, legacyStore },
      );
    }

    const runtimeSessions = (await store.listSessions(STAGE_ID, LEARNER_KEY)).filter(
      (candidate) => candidate.kind === 'chat',
    );
    expect(runtimeSessions).toHaveLength(1);
    expect((await store.listRecords(runtimeSessions[0]!.id)).length).toBeLessThanOrEqual(256);
    expect(maxRecordsRead).toBeLessThanOrEqual(256);
    expect(
      await loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).toMatchObject([{ title: 'Q&A 299', updatedAt: 2_299 }]);
  });

  it('preserves the newer cross-tab write when another tab rolls the generation', async () => {
    const indexedDB = new IDBFactory();
    const firstTab = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-rollover-race' });
    const secondTab = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-rollover-race' });
    const legacyStore = new MemoryLegacyChatStore();

    for (let index = 0; index < 255; index += 1) {
      await saveChatSessions(
        STAGE_ID,
        [session({ title: `Base ${index}`, updatedAt: 1_000 + index })],
        { store: firstTab, learnerKey: LEARNER_KEY, legacyStore },
      );
    }
    const staleMessages = Array.from({ length: 10 }, (_, index) =>
      message(`stale-${index}`, 'user', `Stale ${index}`, index),
    );

    await Promise.all([
      saveChatSessions(STAGE_ID, [session({ title: 'Newer', updatedAt: 5_000 })], {
        store: firstTab,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
      saveChatSessions(
        STAGE_ID,
        [session({ title: 'Stale', messages: staleMessages, updatedAt: 4_000 })],
        { store: secondTab, learnerKey: LEARNER_KEY, legacyStore },
      ),
    ]);

    const runtimeSessions = (await firstTab.listSessions(STAGE_ID, LEARNER_KEY)).filter(
      (candidate) => candidate.kind === 'chat',
    );
    const generations = await Promise.all(
      runtimeSessions.map(async (candidate) => ({
        records: await firstTab.listRecords(candidate.id),
      })),
    );
    expect(runtimeSessions.some((candidate) => candidate.id.includes(':generation:'))).toBe(true);
    expect(
      Math.max(...generations.map((candidate) => candidate.records.length)),
    ).toBeLessThanOrEqual(256);

    expect(
      await loadChatSessions(STAGE_ID, {
        store: firstTab,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ).toMatchObject([{ title: 'Newer', updatedAt: 5_000 }]);
  });

  it('keeps the record bound when two tabs roll the same full generation', async () => {
    const indexedDB = new IDBFactory();
    const firstTab = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-double-rollover' });
    const secondTab = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-double-rollover' });
    const legacyStore = new MemoryLegacyChatStore();
    for (let index = 0; index < 254; index += 1) {
      await saveChatSessions(
        STAGE_ID,
        [session({ title: `Base ${index}`, updatedAt: 1_000 + index })],
        { store: firstTab, learnerKey: LEARNER_KEY, legacyStore },
      );
    }

    await Promise.all([
      saveChatSessions(STAGE_ID, [session({ title: 'First tab', updatedAt: 5_000 })], {
        store: firstTab,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
      saveChatSessions(STAGE_ID, [session({ title: 'Second tab', updatedAt: 6_000 })], {
        store: secondTab,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ]);

    const runtimeSessions = (await firstTab.listSessions(STAGE_ID, LEARNER_KEY)).filter(
      (candidate) => candidate.kind === 'chat',
    );
    const recordCounts = await Promise.all(
      runtimeSessions.map(async (candidate) => (await firstTab.listRecords(candidate.id)).length),
    );
    expect(Math.max(...recordCounts)).toBeLessThanOrEqual(256);
    expect(
      await loadChatSessions(STAGE_ID, {
        store: firstTab,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ).toMatchObject([{ title: 'Second tab', updatedAt: 6_000 }]);
  });

  it('keeps the record bound when concurrent fallback writers append large batches', async () => {
    const indexedDB = new IDBFactory();
    const firstBacking = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-batch-race' });
    const secondBacking = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-batch-race' });
    const legacyStore = new MemoryLegacyChatStore();
    for (let index = 0; index < 239; index += 1) {
      await saveChatSessions(
        STAGE_ID,
        [session({ title: `Base ${index}`, updatedAt: 1_000 + index })],
        { store: firstBacking, learnerKey: LEARNER_KEY, legacyStore },
      );
    }

    let readers = 0;
    let releaseReaders!: () => void;
    const readersReleased = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });
    function concurrentTab(backing: RuntimeStore): RuntimeStore {
      let delayFirstRecordRead = true;
      return new Proxy(backing, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property === 'listRecords') {
            return async (...args: Parameters<RuntimeStore['listRecords']>) => {
              const records = await backing.listRecords(...args);
              if (delayFirstRecordRead) {
                delayFirstRecordRead = false;
                readers += 1;
                if (readers === 2) releaseReaders();
                await readersReleased;
              }
              return records;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    const firstTab = concurrentTab(firstBacking);
    const secondTab = concurrentTab(secondBacking);
    const firstMessages = Array.from({ length: 14 }, (_, index) =>
      message(`first-${index}`, 'user', `First ${index}`, 5_000 + index),
    );
    const secondMessages = Array.from({ length: 14 }, (_, index) =>
      message(`second-${index}`, 'user', `Second ${index}`, 6_000 + index),
    );
    vi.resetModules();
    const secondRealm = await import('@/lib/utils/chat-storage');

    await Promise.all([
      secondRealm.saveChatSessions(
        STAGE_ID,
        [session({ title: 'First batch', messages: firstMessages, updatedAt: 5_000 })],
        { store: firstTab, learnerKey: LEARNER_KEY, legacyStore },
      ),
      saveChatSessions(
        STAGE_ID,
        [session({ title: 'Second batch', messages: secondMessages, updatedAt: 6_000 })],
        { store: secondTab, learnerKey: LEARNER_KEY, legacyStore },
      ),
    ]);

    const runtimeSessions = (await firstBacking.listSessions(STAGE_ID, LEARNER_KEY)).filter(
      (candidate) => candidate.kind === 'chat',
    );
    expect(runtimeSessions.length).toBeGreaterThan(0);
    expect(runtimeSessions.every((candidate) => /:generation:\d+:[\w-]+$/.test(candidate.id))).toBe(
      true,
    );
    const recordCounts = await Promise.all(
      runtimeSessions.map(
        async (candidate) => (await firstBacking.listRecords(candidate.id)).length,
      ),
    );
    expect(Math.max(...recordCounts)).toBeLessThanOrEqual(256);
    expect(
      await loadChatSessions(STAGE_ID, {
        store: firstBacking,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ).toMatchObject([{ title: 'Second batch', updatedAt: 6_000 }]);
  });

  it('retires superseded fallback snapshots when streamed content keeps the same timestamp', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();

    for (let index = 0; index < 20; index += 1) {
      await saveChatSessions(
        STAGE_ID,
        [
          session({
            messages: [message('message-1', 'assistant', `Streamed ${index}`, 1_000)],
            updatedAt: 2_000,
          }),
        ],
        { store, learnerKey: LEARNER_KEY, legacyStore },
      );
    }

    const runtimeSessions = (await store.listSessions(STAGE_ID, LEARNER_KEY)).filter(
      (candidate) => candidate.kind === 'chat',
    );
    expect(runtimeSessions).toHaveLength(1);
    expect(
      await loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).toMatchObject([
      {
        messages: [{ parts: [{ type: 'text', text: 'Streamed 19' }] }],
        updatedAt: 2_000,
      },
    ]);
  });

  it('uses the runtime id tie-break when loading concurrent equal-generation snapshots', async () => {
    const indexedDB = new IDBFactory();
    const initialStore = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-equal-generation' });
    const legacyStore = new MemoryLegacyChatStore();
    await saveChatSessions(STAGE_ID, [session({ title: 'Base', updatedAt: 1_000 })], {
      store: initialStore,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    let readers = 0;
    let releaseReaders!: () => void;
    const readersReleased = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });
    function concurrentTab(backing: RuntimeStore): RuntimeStore {
      let delayFirstRecordRead = true;
      return new Proxy(backing, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property === 'listRecords') {
            return async (...args: Parameters<RuntimeStore['listRecords']>) => {
              const records = await backing.listRecords(...args);
              if (delayFirstRecordRead) {
                delayFirstRecordRead = false;
                readers += 1;
                if (readers === 2) releaseReaders();
                await readersReleased;
              }
              return records;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    const firstBacking = new BrowserRuntimeStore({
      indexedDB,
      dbName: 'chat-equal-generation',
    });
    const secondBacking = new BrowserRuntimeStore({
      indexedDB,
      dbName: 'chat-equal-generation',
    });
    vi.resetModules();
    const secondRealm = await import('@/lib/utils/chat-storage');

    await Promise.all([
      saveChatSessions(STAGE_ID, [session({ title: 'First', updatedAt: 2_000 })], {
        store: concurrentTab(firstBacking),
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
      secondRealm.saveChatSessions(STAGE_ID, [session({ title: 'Second', updatedAt: 2_000 })], {
        store: concurrentTab(secondBacking),
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ]);

    const runtimeSessions = (await initialStore.listSessions(STAGE_ID, LEARNER_KEY)).filter(
      (candidate) => candidate.kind === 'chat',
    );
    expect(runtimeSessions).toHaveLength(2);
    const winner = [...runtimeSessions].sort((left, right) => right.id.localeCompare(left.id))[0]!;
    const winnerState = (await initialStore.listRecords(winner.id)).find(
      (record) => (record.payload as { kind?: string }).kind === 'chat_session_state',
    );

    expect(
      await loadChatSessions(STAGE_ID, {
        store: initialStore,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ).toMatchObject([{ title: (winnerState!.payload as { title: string }).title }]);
  });

  it('removes a partial isolated generation after a successful retry', async () => {
    const backing = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    let appendCalls = 0;
    const store = new Proxy(backing, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === 'appendRecord') {
          return async (...args: Parameters<RuntimeStore['appendRecord']>) => {
            appendCalls += 1;
            if (appendCalls === 2) throw new Error('transient append failure');
            return backing.appendRecord(...args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await saveChatSessions(STAGE_ID, [session()], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    await saveChatSessions(STAGE_ID, [session()], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    const runtimeSessions = (await backing.listSessions(STAGE_ID, LEARNER_KEY)).filter(
      (candidate) => candidate.kind === 'chat',
    );
    expect(runtimeSessions).toHaveLength(1);
    expect(await backing.listRecords(runtimeSessions[0]!.id)).toHaveLength(2);
  });

  it('does not retain partial isolated generations when appends keep failing', async () => {
    const backing = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const appendError = new Error('append storage unavailable');
    const store = new Proxy(backing, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === 'appendRecord') {
          return async () => {
            throw appendError;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(
      saveChatSessions(STAGE_ID, [session()], {
        store,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ).rejects.toBe(appendError);

    expect(
      (await backing.listSessions(STAGE_ID, LEARNER_KEY)).filter(
        (candidate) => candidate.kind === 'chat',
      ),
    ).toHaveLength(0);
  });

  it('does not expose partially appended messages when a locked snapshot save fails', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        request: async (
          _name: string,
          optionsOrWork: LockOptions | (() => Promise<unknown>),
          maybeWork?: () => Promise<unknown>,
        ) => (typeof optionsOrWork === 'function' ? optionsOrWork : maybeWork!)(),
      },
    });
    const backing = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const original = session({
      title: 'Original title',
      messages: [message('message-1', 'user', 'Original message', 1_000)],
      updatedAt: 2_000,
    });
    await saveChatSessions(STAGE_ID, [original], {
      store: backing,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    const appendError = new Error('state append failed');
    const failingStore = new Proxy(backing, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === 'appendRecord') {
          return async (...args: Parameters<RuntimeStore['appendRecord']>) => {
            if ((args[0].payload as { kind?: string }).kind === 'chat_session_state') {
              throw appendError;
            }
            return backing.appendRecord(...args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(
      saveChatSessions(
        STAGE_ID,
        [
          session({
            title: 'Updated title',
            messages: [message('message-1', 'user', 'Updated message', 2_000)],
            updatedAt: 3_000,
          }),
        ],
        { store: failingStore, learnerKey: LEARNER_KEY, legacyStore },
      ),
    ).rejects.toBe(appendError);

    await expect(
      loadChatSessions(STAGE_ID, { store: backing, learnerKey: LEARNER_KEY, legacyStore }),
    ).resolves.toEqual([{ ...original, status: 'interrupted', pendingToolCalls: [] }]);
    await expect(backing.listSessions(STAGE_ID, LEARNER_KEY)).resolves.toHaveLength(1);
  });

  it('retries an unchanged fallback save when a concurrent writer retires its destination', async () => {
    const indexedDB = new IDBFactory();
    const initialStore = new BrowserRuntimeStore({
      indexedDB,
      dbName: 'chat-unchanged-retired-destination',
    });
    const legacyStore = new MemoryLegacyChatStore();
    const completed = session({ status: 'completed', updatedAt: 2_000 });
    await saveChatSessions(STAGE_ID, [completed], {
      store: initialStore,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    const [destination] = (await initialStore.listSessions(STAGE_ID, LEARNER_KEY)).filter(
      (candidate) => candidate.kind === 'chat',
    );
    await initialStore.setSessionStatus(
      destination!.id,
      'active',
      new Date(completed.updatedAt).toISOString(),
    );

    const delayedBacking = new BrowserRuntimeStore({
      indexedDB,
      dbName: 'chat-unchanged-retired-destination',
    });
    let releaseStatusWrite!: () => void;
    const statusWriteGate = new Promise<void>((resolve) => {
      releaseStatusWrite = resolve;
    });
    let statusWriteReached!: () => void;
    const statusWriteReady = new Promise<void>((resolve) => {
      statusWriteReached = resolve;
    });
    let delayed = false;
    const delayedStore = new Proxy(delayedBacking, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === 'setSessionStatus') {
          return async (...args: Parameters<RuntimeStore['setSessionStatus']>) => {
            if (!delayed && args[0] === destination!.id && args[1] === 'completed') {
              delayed = true;
              statusWriteReached();
              await statusWriteGate;
            }
            return delayedBacking.setSessionStatus(...args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const unchangedSave = saveChatSessions(STAGE_ID, [completed], {
      store: delayedStore,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    await statusWriteReady;

    const concurrentStore = new BrowserRuntimeStore({
      indexedDB,
      dbName: 'chat-unchanged-retired-destination',
    });
    const newer = session({
      title: 'Concurrent newer',
      status: 'completed',
      updatedAt: 3_000,
    });
    await saveChatSessions(STAGE_ID, [newer], {
      store: concurrentStore,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    expect(await initialStore.getSession(destination!.id)).toBeUndefined();

    releaseStatusWrite();
    await expect(unchangedSave).resolves.toBeUndefined();
    expect(
      await loadChatSessions(STAGE_ID, {
        store: initialStore,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ).toMatchObject([{ title: 'Concurrent newer', updatedAt: 3_000 }]);
  });

  it('does not hide a real unchanged fallback status-write failure', async () => {
    const backing = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const completed = session({ status: 'completed', updatedAt: 2_000 });
    await saveChatSessions(STAGE_ID, [completed], {
      store: backing,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    const [destination] = (await backing.listSessions(STAGE_ID, LEARNER_KEY)).filter(
      (candidate) => candidate.kind === 'chat',
    );
    await backing.setSessionStatus(
      destination!.id,
      'active',
      new Date(completed.updatedAt).toISOString(),
    );
    const writeError = new Error('status storage unavailable');
    const store = new Proxy(backing, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === 'setSessionStatus') {
          return async () => {
            throw writeError;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(
      saveChatSessions(STAGE_ID, [completed], {
        store,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ).rejects.toBe(writeError);
  });

  it('does not let a stale isolated writer retire a newly completed newer snapshot', async () => {
    const indexedDB = new IDBFactory();
    const initialStore = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-stale-retire' });
    const legacyStore = new MemoryLegacyChatStore();
    const chat = (title: string, updatedAt: number) =>
      session({
        title,
        updatedAt,
        messages: [message('message-1', 'assistant', title, updatedAt)],
      });
    await saveChatSessions(STAGE_ID, [chat('Base', 1_000)], {
      store: initialStore,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    const newerBacking = new BrowserRuntimeStore({
      indexedDB,
      dbName: 'chat-stale-retire',
    });
    let releaseNewerState!: () => void;
    const newerStateGate = new Promise<void>((resolve) => {
      releaseNewerState = resolve;
    });
    let newerStateReached!: () => void;
    const newerStateReady = new Promise<void>((resolve) => {
      newerStateReached = resolve;
    });
    const newerStore = new Proxy(newerBacking, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === 'appendRecord') {
          return async (...args: Parameters<RuntimeStore['appendRecord']>) => {
            if ((args[0].payload as { kind?: string }).kind === 'chat_session_state') {
              newerStateReached();
              await newerStateGate;
            }
            return newerBacking.appendRecord(...args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const newerSave = saveChatSessions(STAGE_ID, [chat('Newer', 3_000)], {
      store: newerStore,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    await newerStateReady;

    const staleBacking = new BrowserRuntimeStore({
      indexedDB,
      dbName: 'chat-stale-retire',
    });
    let releaseStaleSnapshot!: () => void;
    const staleSnapshotGate = new Promise<void>((resolve) => {
      releaseStaleSnapshot = resolve;
    });
    let staleSnapshotTaken!: () => void;
    const staleSnapshotReady = new Promise<void>((resolve) => {
      staleSnapshotTaken = resolve;
    });
    let delayedPartialSnapshot = false;
    const staleStore = new Proxy(staleBacking, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === 'listRecords') {
          return async (...args: Parameters<RuntimeStore['listRecords']>) => {
            const records = await staleBacking.listRecords(...args);
            if (
              !delayedPartialSnapshot &&
              records.some((record) =>
                ['chat_message'].includes((record.payload as { kind?: string }).kind ?? ''),
              ) &&
              !records.some(
                (record) => (record.payload as { kind?: string }).kind === 'chat_session_state',
              )
            ) {
              delayedPartialSnapshot = true;
              staleSnapshotTaken();
              await staleSnapshotGate;
            }
            return records;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const staleSave = saveChatSessions(STAGE_ID, [chat('Stale', 2_000)], {
      store: staleStore,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    await staleSnapshotReady;

    releaseNewerState();
    await newerSave;
    releaseStaleSnapshot();
    await staleSave;

    expect(
      await loadChatSessions(STAGE_ID, {
        store: initialStore,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ).toMatchObject([{ title: 'Newer', updatedAt: 3_000 }]);
  });

  it('re-resolves the successor when a delayed writer targets a retired generation', async () => {
    const indexedDB = new IDBFactory();
    const firstTab = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-retired-generation' });
    const delayedBacking = new BrowserRuntimeStore({
      indexedDB,
      dbName: 'chat-retired-generation',
    });
    const legacyStore = new MemoryLegacyChatStore();
    for (let index = 0; index < 254; index += 1) {
      await saveChatSessions(
        STAGE_ID,
        [session({ title: `Base ${index}`, updatedAt: 1_000 + index })],
        { store: firstTab, learnerKey: LEARNER_KEY, legacyStore },
      );
    }

    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let snapshotTaken!: () => void;
    const snapshotReady = new Promise<void>((resolve) => {
      snapshotTaken = resolve;
    });
    let delayFirstRecordRead = true;
    const delayedTab = new Proxy(delayedBacking, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === 'listRecords') {
          return async (...args: Parameters<RuntimeStore['listRecords']>) => {
            const records = await delayedBacking.listRecords(...args);
            if (delayFirstRecordRead) {
              delayFirstRecordRead = false;
              snapshotTaken();
              await snapshotGate;
            }
            return records;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const delayedSave = saveChatSessions(
      STAGE_ID,
      [session({ title: 'Delayed newer', updatedAt: 6_000 })],
      { store: delayedTab, learnerKey: LEARNER_KEY, legacyStore },
    );
    await snapshotReady;

    await saveChatSessions(STAGE_ID, [session({ title: 'Rollover', updatedAt: 5_000 })], {
      store: firstTab,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    await saveChatSessions(STAGE_ID, [session({ title: 'Cleanup', updatedAt: 5_001 })], {
      store: firstTab,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    releaseSnapshot();

    await expect(delayedSave).resolves.toBeUndefined();
    expect(
      await loadChatSessions(STAGE_ID, {
        store: firstTab,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ).toMatchObject([{ title: 'Delayed newer', updatedAt: 6_000 }]);
  });

  it.each([
    { label: 'base', updates: 1, generated: false },
    { label: 'generated', updates: 260, generated: true },
  ])(
    'loads a $label runtime id after its learner partition is merged',
    async ({ updates, generated }) => {
      if (!generated) {
        vi.stubGlobal('navigator', {
          ...globalThis.navigator,
          locks: {
            request: async (
              _name: string,
              optionsOrWork: LockOptions | (() => Promise<unknown>),
              maybeWork?: () => Promise<unknown>,
            ) => (typeof optionsOrWork === 'function' ? optionsOrWork : maybeWork!)(),
          },
        });
      }
      const store = makeRuntimeStore();
      const legacyStore = new MemoryLegacyChatStore();
      try {
        for (let index = 0; index < updates; index += 1) {
          await saveChatSessions(
            STAGE_ID,
            [session({ title: `Before merge ${index}`, updatedAt: 2_000 + index })],
            { store, learnerKey: LEARNER_KEY, legacyStore },
          );
        }
        const [beforeMerge] = (await store.listSessions(STAGE_ID, LEARNER_KEY)).filter(
          (candidate) => candidate.kind === 'chat',
        );
        expect(beforeMerge?.id.includes(':generation:')).toBe(generated);

        const accountLearnerKey = 'user:chat-test';
        await store.mergeLearner(LEARNER_KEY, accountLearnerKey);

        expect(
          await loadChatSessions(STAGE_ID, { store, learnerKey: accountLearnerKey, legacyStore }),
        ).toMatchObject([{ title: `Before merge ${updates - 1}` }]);
      } finally {
        if (!generated) vi.unstubAllGlobals();
      }
    },
  );

  it('backfills legacy Dexie sessions before clearing the legacy rows', async () => {
    const store = makeRuntimeStore();
    const legacy = session({ status: 'completed', updatedAt: 3_000 });
    const legacyStore = new MemoryLegacyChatStore([legacy]);

    const loaded = await loadChatSessions(STAGE_ID, {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    expect(loaded).toEqual([{ ...legacy, pendingToolCalls: [] }]);
    expect(legacyStore.sessions).toEqual([]);
    expect(legacyStore.clearCalls).toBe(1);
    expect(
      (await store.listSessions(STAGE_ID, LEARNER_KEY)).filter(
        (candidate) => candidate.kind === 'chat',
      ),
    ).toHaveLength(1);
  });

  it('keeps a restore marker visible after the learner partition is merged', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    await saveChatSessions(STAGE_ID, [session()], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    await restoreChatSessionsFromBackup([STAGE_ID], async () => {}, {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    const accountLearnerKey = 'user:restored-chat-test';
    await store.mergeLearner(LEARNER_KEY, accountLearnerKey);
    let snapshot: ChatStorageSnapshot | undefined;
    await loadChatSessions(STAGE_ID, {
      store,
      learnerKey: accountLearnerKey,
      legacyStore,
      onSnapshot: (loaded) => {
        snapshot = loaded;
      },
    });

    expect(snapshot?.restoreMarker).toMatch(/^chat-restore-marker:/);
  });

  it('retains migrated observations when clearing legacy rows fails', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new FailingClearLegacyChatStore([session({ title: 'Legacy chat' })]);
    const options = { store, learnerKey: LEARNER_KEY, legacyStore };

    await expect(loadChatSessions(STAGE_ID, options)).resolves.toMatchObject([
      { title: 'Legacy chat' },
    ]);
    await saveChatSessions(STAGE_ID, [], options);

    await expect(loadChatSessions(STAGE_ID, options)).resolves.toEqual([]);
  });

  it('does not delete runtime-only chats after a legacy clear failure', async () => {
    const store = makeRuntimeStore();
    await saveChatSessions(STAGE_ID, [session({ id: 'runtime-only', title: 'Runtime only' })], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore: new MemoryLegacyChatStore(),
    });
    const legacyStore = new FailingClearLegacyChatStore([
      session({ id: 'legacy-only', title: 'Legacy only' }),
    ]);
    const options = { store, learnerKey: LEARNER_KEY, legacyStore };

    await expect(loadChatSessions(STAGE_ID, options)).resolves.toMatchObject([
      { id: 'legacy-only' },
    ]);
    await saveChatSessions(STAGE_ID, [], options);

    await expect(loadChatSessions(STAGE_ID, options)).resolves.toMatchObject([
      { id: 'runtime-only', title: 'Runtime only' },
    ]);
  });

  it('does not resurrect a legacy snapshot when a concurrent save removes it', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore([session({ status: 'completed' })]);
    let captured!: () => void;
    const didCapture = new Promise<void>((resolve) => {
      captured = resolve;
    });
    let release!: () => void;
    const mayReturn = new Promise<void>((resolve) => {
      release = resolve;
    });
    legacyStore.load = async () => {
      const snapshot = structuredClone(legacyStore.sessions);
      captured();
      await mayReturn;
      return snapshot;
    };
    const options = { store, learnerKey: LEARNER_KEY, legacyStore };

    const loading = loadChatSessions(STAGE_ID, options);
    await didCapture;
    const saving = saveChatSessions(STAGE_ID, [], options);
    release();
    await Promise.all([loading, saving]);

    expect(legacyStore.sessions).toEqual([]);
    expect(await loadChatSessions(STAGE_ID, options)).toEqual([]);
  });

  it('keeps legacy rows authoritative when the first RuntimeStore migration attempt fails', async () => {
    const legacy = session({ status: 'completed' });
    const legacyStore = new MemoryLegacyChatStore([legacy]);
    const store = {
      listSessions: vi.fn().mockRejectedValue(new Error('runtime unavailable')),
    } as unknown as RuntimeStore;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = await loadChatSessions(STAGE_ID, {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    expect(loaded).toEqual([{ ...legacy, pendingToolCalls: [] }]);
    expect(legacyStore.sessions).toEqual([legacy]);
    expect(legacyStore.clearCalls).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fails loud after cutover when RuntimeStore is unavailable', async () => {
    const legacyStore = new MemoryLegacyChatStore();
    const store = {
      listSessions: vi.fn().mockRejectedValue(new Error('runtime unavailable')),
    } as unknown as RuntimeStore;

    await expect(
      loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).rejects.toThrow('runtime unavailable');
  });

  it('does not treat a failed reload as authority to delete previously observed chats', async () => {
    const backing = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    let failLists = false;
    const store = new Proxy(backing, {
      get(target, property) {
        if (property === 'listSessions') {
          return (...args: Parameters<RuntimeStore['listSessions']>) =>
            failLists
              ? Promise.reject(new Error('runtime unavailable'))
              : backing.listSessions(...args);
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const persisted = session();

    await saveChatSessions(STAGE_ID, [persisted], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    await expect(
      loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).resolves.toHaveLength(1);

    failLists = true;
    await expect(
      loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).rejects.toThrow('runtime unavailable');
    failLists = false;

    await saveChatSessions(STAGE_ID, [], { store, learnerKey: LEARNER_KEY, legacyStore });
    await expect(
      loadChatSessions(STAGE_ID, { store, learnerKey: LEARNER_KEY, legacyStore }),
    ).resolves.toMatchObject([{ id: persisted.id }]);
  });

  it('deletes omitted chat sessions without touching other runtime kinds', async () => {
    const store = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: 'pbl-session',
      kind: 'pbl',
      stageId: STAGE_ID,
      learnerKey: LEARNER_KEY,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    const first = session({ id: 'session-1' });
    const second = session({ id: 'session-2', createdAt: 950, updatedAt: 1_300 });
    await saveChatSessions(STAGE_ID, [first, second], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    await saveChatSessions(STAGE_ID, [second], {
      store,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });

    const runtimeSessions = await store.listSessions(STAGE_ID, LEARNER_KEY);
    expect(runtimeSessions.filter((candidate) => candidate.kind === 'chat')).toHaveLength(1);
    expect(runtimeSessions.filter((candidate) => candidate.kind === 'pbl')).toHaveLength(1);
  });

  it('does not let a stale tab resurrect a chat deleted by another tab', async () => {
    const indexedDB = new IDBFactory();
    const deletingStore = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-delete-tombstone' });
    const staleStore = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-delete-tombstone' });
    const freshStore = new BrowserRuntimeStore({ indexedDB, dbName: 'chat-delete-tombstone' });
    const deletingLegacy = new MemoryLegacyChatStore();
    const staleLegacy = new MemoryLegacyChatStore();
    const original = session({ status: 'completed' });
    await saveChatSessions(STAGE_ID, [original], {
      store: deletingStore,
      learnerKey: LEARNER_KEY,
      legacyStore: deletingLegacy,
    });

    let deletingSnapshot: ChatStorageSnapshot | undefined;
    let staleSnapshot: ChatStorageSnapshot | undefined;
    await loadChatSessions(STAGE_ID, {
      store: deletingStore,
      learnerKey: LEARNER_KEY,
      legacyStore: deletingLegacy,
      onSnapshot: (snapshot) => {
        deletingSnapshot = snapshot;
      },
    });
    const staleSessions = await loadChatSessions(STAGE_ID, {
      store: staleStore,
      learnerKey: LEARNER_KEY,
      legacyStore: staleLegacy,
      onSnapshot: (snapshot) => {
        staleSnapshot = snapshot;
      },
    });

    await saveChatSessions(STAGE_ID, [], {
      store: deletingStore,
      learnerKey: LEARNER_KEY,
      legacyStore: deletingLegacy,
      snapshot: deletingSnapshot,
    });
    await saveChatSessions(STAGE_ID, staleSessions, {
      store: staleStore,
      learnerKey: LEARNER_KEY,
      legacyStore: staleLegacy,
      snapshot: staleSnapshot,
    });
    await expect(
      saveChatSessions(
        STAGE_ID,
        [{ ...staleSessions[0]!, title: 'Edited stale chat', updatedAt: 5_000 }],
        {
          store: staleStore,
          learnerKey: LEARNER_KEY,
          legacyStore: staleLegacy,
          snapshot: staleSnapshot,
        },
      ),
    ).rejects.toThrow(/deleted by another caller/);

    await expect(
      loadChatSessions(STAGE_ID, {
        store: freshStore,
        learnerKey: LEARNER_KEY,
        legacyStore: new MemoryLegacyChatStore(),
      }),
    ).resolves.toEqual([]);
  });

  it('honors a deletion tombstone when deleting the old runtime session fails', async () => {
    const backing = makeRuntimeStore();
    const legacyStore = new MemoryLegacyChatStore();
    await saveChatSessions(STAGE_ID, [session()], {
      store: backing,
      learnerKey: LEARNER_KEY,
      legacyStore,
    });
    const [runtimeChat] = (await backing.listSessions(STAGE_ID, LEARNER_KEY)).filter(
      (candidate) => candidate.kind === 'chat',
    );
    let snapshot: ChatStorageSnapshot | undefined;
    const failingDeleteStore = new Proxy(backing, {
      get(target, property) {
        if (property === 'deleteSession') {
          return async (runtimeSessionId: string) => {
            if (runtimeSessionId === runtimeChat?.id) throw new Error('chat delete failed');
            return target.deleteSession(runtimeSessionId);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await loadChatSessions(STAGE_ID, {
      store: failingDeleteStore,
      learnerKey: LEARNER_KEY,
      legacyStore,
      onSnapshot: (loaded) => {
        snapshot = loaded;
      },
    });

    await expect(
      saveChatSessions(STAGE_ID, [], {
        store: failingDeleteStore,
        learnerKey: LEARNER_KEY,
        legacyStore,
        snapshot,
      }),
    ).rejects.toThrow('chat delete failed');
    await expect(
      loadChatSessions(STAGE_ID, {
        store: backing,
        learnerKey: LEARNER_KEY,
        legacyStore,
      }),
    ).resolves.toEqual([]);

    const accountLearnerKey = 'user:deleted-chat-test';
    await backing.mergeLearner(LEARNER_KEY, accountLearnerKey);
    await expect(
      loadChatSessions(STAGE_ID, {
        store: backing,
        learnerKey: accountLearnerKey,
        legacyStore,
      }),
    ).resolves.toEqual([]);
  });

  it('does not let an unobserved stale snapshot delete a newer tab session', async () => {
    const sharedIndexedDB = new IDBFactory();
    const staleStore = new BrowserRuntimeStore({ indexedDB: sharedIndexedDB });
    const freshStore = new BrowserRuntimeStore({ indexedDB: sharedIndexedDB });
    const staleLegacy = new MemoryLegacyChatStore();
    const freshLegacy = new MemoryLegacyChatStore();
    const fresh = session({ id: 'fresh-session', updatedAt: 2_000 });

    await saveChatSessions(STAGE_ID, [fresh], {
      store: freshStore,
      learnerKey: LEARNER_KEY,
      legacyStore: freshLegacy,
    });

    await saveChatSessions(STAGE_ID, [], {
      store: staleStore,
      learnerKey: LEARNER_KEY,
      legacyStore: staleLegacy,
    });

    await expect(
      loadChatSessions(STAGE_ID, {
        store: freshStore,
        learnerKey: LEARNER_KEY,
        legacyStore: freshLegacy,
      }),
    ).resolves.toEqual([{ ...fresh, status: 'interrupted', pendingToolCalls: [] }]);
  });
});
