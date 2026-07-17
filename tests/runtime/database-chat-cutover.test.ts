import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserRuntimeStore, type KVStore, type RuntimeStore } from '@openmaic/storage';

import type { ChatSession } from '@/lib/types/chat';
import type { ChatStorageSnapshot } from '@/lib/utils/chat-storage';

if (!('IDBKeyRange' in globalThis)) {
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
}

const learnerKey = 'anon:database-cutover';

function serialLockManager(): Pick<LockManager, 'request'> {
  const tails = new Map<string, Promise<void>>();
  const manager = {
    async request<T>(
      name: string,
      optionsOrCallback: LockOptions | (() => Promise<T> | T),
      maybeCallback?: () => Promise<T> | T,
    ): Promise<T> {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(name, current);
      await previous;
      try {
        return await callback();
      } finally {
        release();
        if (tails.get(name) === current) tails.delete(name);
      }
    },
  };
  return manager as unknown as Pick<LockManager, 'request'>;
}

function fairLockManager(): Pick<LockManager, 'request'> {
  type Mode = 'shared' | 'exclusive';
  interface Waiter {
    mode: Mode;
    callback: () => Promise<unknown> | unknown;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }
  interface State {
    readers: number;
    writer: boolean;
    waiters: Waiter[];
  }

  const states = new Map<string, State>();
  const pump = (name: string): void => {
    const state = states.get(name)!;
    if (state.writer || state.waiters.length === 0) return;
    if (state.readers > 0 && state.waiters[0]!.mode === 'exclusive') return;

    const start = (waiter: Waiter): void => {
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      if (waiter.mode === 'shared') state.readers += 1;
      else state.writer = true;
      void Promise.resolve()
        .then(waiter.callback)
        .then(waiter.resolve, waiter.reject)
        .finally(() => {
          if (waiter.mode === 'shared') state.readers -= 1;
          else state.writer = false;
          pump(name);
        });
    };

    if (state.readers === 0 && state.waiters[0]!.mode === 'exclusive') {
      start(state.waiters.shift()!);
      return;
    }
    while (!state.writer && state.waiters[0]?.mode === 'shared') {
      start(state.waiters.shift()!);
    }
  };

  return {
    request<T>(
      name: string,
      optionsOrCallback: LockOptions | (() => Promise<T> | T),
      maybeCallback?: () => Promise<T> | T,
    ): Promise<T> {
      const mode: Mode =
        typeof optionsOrCallback === 'function'
          ? 'exclusive'
          : (optionsOrCallback.mode ?? 'exclusive');
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
      const signal = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback.signal;
      const state = states.get(name) ?? { readers: 0, writer: false, waiters: [] };
      states.set(name, state);
      return new Promise<T>((resolve, reject) => {
        const waiter: Waiter = {
          mode,
          callback,
          resolve: resolve as (value: unknown) => void,
          reject,
          signal,
        };
        waiter.onAbort = () => {
          const index = state.waiters.indexOf(waiter);
          if (index >= 0) state.waiters.splice(index, 1);
          reject(signal?.reason);
          pump(name);
        };
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
        state.waiters.push(waiter);
        pump(name);
      });
    },
  } as Pick<LockManager, 'request'>;
}

function chatSession(): ChatSession {
  return {
    id: 'chat-backup',
    type: 'qa',
    title: 'Persisted chat',
    status: 'completed',
    messages: [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    config: { agentIds: ['default-1'] },
    toolCalls: [],
    pendingToolCalls: [],
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

function stubMemoryLocalStorage(): void {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, String(value)),
  } satisfies Storage);
}

describe('database runtime chat integration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('navigator', { locks: serialLockManager() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exports RuntimeStore chats and clears them with the main database', async () => {
    const runtimeStore = new BrowserRuntimeStore({ indexedDB: globalThis.indexedDB });
    const { db, clearDatabase, exportDatabase, importDatabase } =
      await import('@/lib/utils/database');
    const { loadChatSessions, saveChatSessions } = await import('@/lib/utils/chat-storage');
    await db.stages.put({
      id: 'stage-backup',
      name: 'Backup stage',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    await saveChatSessions('stage-backup', [chatSession()], {
      store: runtimeStore,
      learnerKey,
    });
    await saveChatSessions('orphaned-runtime-stage', [{ ...chatSession(), id: 'orphaned-chat' }], {
      store: runtimeStore,
      learnerKey,
    });

    const exported = await exportDatabase({
      store: runtimeStore,
      learnerKey,
    });
    expect(exported.chatSessions).toMatchObject([
      { id: 'chat-backup', stageId: 'stage-backup', title: 'Persisted chat' },
    ]);

    await saveChatSessions(
      'stage-backup',
      [
        { ...chatSession(), title: 'Newer local chat', updatedAt: 3_000 },
        { ...chatSession(), id: 'chat-not-in-backup', title: 'Not in backup', updatedAt: 3_100 },
      ],
      { store: runtimeStore, learnerKey },
    );
    await importDatabase(exported, { store: runtimeStore, learnerKey });
    await expect(
      loadChatSessions('stage-backup', { store: runtimeStore, learnerKey }),
    ).resolves.toMatchObject([{ id: 'chat-backup', title: 'Persisted chat' }]);

    await clearDatabase(runtimeStore);
    await expect(runtimeStore.listSessions('stage-backup', learnerKey)).resolves.toEqual([]);
    await expect(runtimeStore.listSessions('orphaned-runtime-stage', learnerKey)).resolves.toEqual(
      [],
    );
  });

  it('keeps same-id legacy chats from a different stage in backup export', async () => {
    const runtimeStore = new BrowserRuntimeStore({ indexedDB: globalThis.indexedDB });
    const { db, exportDatabase, importDatabase } = await import('@/lib/utils/database');
    const { loadChatSessions, saveChatSessions } = await import('@/lib/utils/chat-storage');
    await db.stages.put({
      id: 'stage-runtime-export',
      name: 'Runtime stage',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    await saveChatSessions(
      'stage-runtime-export',
      [{ ...chatSession(), id: 'shared-chat-id', title: 'Runtime chat' }],
      { store: runtimeStore, learnerKey },
    );
    await db.chatSessions.put({
      ...chatSession(),
      id: 'shared-chat-id',
      stageId: 'stage-legacy-export',
      title: 'Legacy chat',
    });

    const exported = await exportDatabase({ store: runtimeStore, learnerKey });

    expect(exported.chatSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'shared-chat-id',
          stageId: 'stage-runtime-export',
          title: 'Runtime chat',
        }),
        expect.objectContaining({
          id: 'shared-chat-id',
          stageId: 'stage-legacy-export',
          title: 'Legacy chat',
        }),
      ]),
    );
    await importDatabase(exported, { store: runtimeStore, learnerKey });
    await expect(
      loadChatSessions('stage-runtime-export', { store: runtimeStore, learnerKey }),
    ).resolves.toMatchObject([{ title: 'Runtime chat' }]);
    await expect(
      loadChatSessions('stage-legacy-export', { store: runtimeStore, learnerKey }),
    ).resolves.toMatchObject([{ title: 'Legacy chat' }]);
    await expect(db.chatRestoreStaging.count()).resolves.toBe(0);
    await db.stages.delete('stage-runtime-export');
  });

  it('does not let a pre-restore autosave replace the restored chat snapshot', async () => {
    const indexedDB = globalThis.indexedDB;
    const staleStore = new BrowserRuntimeStore({ indexedDB, dbName: 'restore-stale-autosave' });
    const restoringStore = new BrowserRuntimeStore({
      indexedDB,
      dbName: 'restore-stale-autosave',
    });
    const freshStore = new BrowserRuntimeStore({ indexedDB, dbName: 'restore-stale-autosave' });
    const staleSnapshot = { ...chatSession(), title: 'Pre-restore chat', updatedAt: 3_000 };
    const restoredSnapshot = {
      ...chatSession(),
      stageId: 'stage-restore-stale',
      title: 'Restored chat',
      updatedAt: 2_000,
    };
    const { exportDatabase, importDatabase } = await import('@/lib/utils/database');
    const { loadChatSessions, saveChatSessions } = await import('@/lib/utils/chat-storage');
    const callerSnapshot = { sessions: [structuredClone(staleSnapshot)], restoreMarker: null };

    await saveChatSessions('stage-restore-stale', [staleSnapshot], {
      store: staleStore,
      learnerKey,
    });
    await importDatabase(
      {
        stages: [
          {
            id: 'stage-restore-stale',
            name: 'Restored stage',
            createdAt: 1_000,
            updatedAt: 2_000,
          },
        ],
        chatSessions: [restoredSnapshot],
      },
      { store: restoringStore, learnerKey },
    );

    // A backup/export read on the same RuntimeStore must not advance the
    // mounted editor's caller-bound snapshot authority.
    await expect(exportDatabase({ store: staleStore, learnerKey })).resolves.toMatchObject({
      chatSessions: [{ id: 'chat-backup', title: 'Restored chat' }],
    });

    // A mounted tab can echo the exact snapshot it observed before restore
    // when an unrelated document autosave runs.
    await saveChatSessions('stage-restore-stale', [staleSnapshot], {
      store: staleStore,
      learnerKey,
      snapshot: callerSnapshot,
    });

    await expect(
      saveChatSessions(
        'stage-restore-stale',
        [{ ...staleSnapshot, title: 'Edited stale chat', updatedAt: 3_001 }],
        { store: staleStore, learnerKey, snapshot: callerSnapshot },
      ),
    ).rejects.toThrow('invalidated by backup restore');

    let reloadedSnapshot: ChatStorageSnapshot | undefined;
    const [restored] = await loadChatSessions('stage-restore-stale', {
      store: freshStore,
      learnerKey,
      onSnapshot: (snapshot) => {
        reloadedSnapshot = snapshot;
      },
    });
    expect(restored).toMatchObject({
      id: 'chat-backup',
      title: 'Restored chat',
      updatedAt: 2_000,
    });

    await saveChatSessions(
      'stage-restore-stale',
      [{ ...restored!, title: 'Edited after reload', updatedAt: 2_001 }],
      { store: freshStore, learnerKey, snapshot: reloadedSnapshot },
    );
    await expect(
      loadChatSessions('stage-restore-stale', { store: freshStore, learnerKey }),
    ).resolves.toMatchObject([{ title: 'Edited after reload', updatedAt: 2_001 }]);
  });

  it('does not let a pre-restore autosave repopulate an empty backup', async () => {
    const indexedDB = globalThis.indexedDB;
    const staleStore = new BrowserRuntimeStore({ indexedDB, dbName: 'restore-empty-autosave' });
    const restoringStore = new BrowserRuntimeStore({ indexedDB, dbName: 'restore-empty-autosave' });
    const freshStore = new BrowserRuntimeStore({ indexedDB, dbName: 'restore-empty-autosave' });
    const staleSnapshot = { ...chatSession(), title: 'Removed by restore', updatedAt: 3_000 };
    const callerSnapshot = {
      sessions: [structuredClone(staleSnapshot)],
      restoreMarker: null,
    } satisfies ChatStorageSnapshot;
    const { importDatabase } = await import('@/lib/utils/database');
    const { loadChatSessions, saveChatSessions } = await import('@/lib/utils/chat-storage');

    await saveChatSessions('stage-restore-empty', [staleSnapshot], {
      store: staleStore,
      learnerKey,
      snapshot: callerSnapshot,
    });
    await importDatabase(
      {
        stages: [
          {
            id: 'stage-restore-empty',
            name: 'Empty restored stage',
            createdAt: 1_000,
            updatedAt: 2_000,
          },
        ],
        chatSessions: [],
      },
      { store: restoringStore, learnerKey },
    );

    await saveChatSessions('stage-restore-empty', [staleSnapshot], {
      store: staleStore,
      learnerKey,
      snapshot: callerSnapshot,
    });

    await expect(
      saveChatSessions(
        'stage-restore-empty',
        [{ ...staleSnapshot, title: 'Edited after empty restore', updatedAt: 3_001 }],
        { store: staleStore, learnerKey, snapshot: callerSnapshot },
      ),
    ).rejects.toThrow('invalidated by backup restore');

    await expect(
      loadChatSessions('stage-restore-empty', { store: freshStore, learnerKey }),
    ).resolves.toEqual([]);
  });

  it('does not let a snapshot from a failed chat load clear a later backup restore', async () => {
    const indexedDB = globalThis.indexedDB;
    const restoringStore = new BrowserRuntimeStore({ indexedDB, dbName: 'failed-load-restore' });
    const savingStore = new BrowserRuntimeStore({ indexedDB, dbName: 'failed-load-restore' });
    const { importDatabase } = await import('@/lib/utils/database');
    const { loadChatSessions, saveChatSessions } = await import('@/lib/utils/chat-storage');

    await importDatabase(
      {
        stages: [
          {
            id: 'stage-failed-load',
            name: 'Restored stage',
            createdAt: 1_000,
            updatedAt: 2_000,
          },
        ],
        chatSessions: [{ ...chatSession(), stageId: 'stage-failed-load' }],
      },
      { store: restoringStore, learnerKey },
    );

    await saveChatSessions('stage-failed-load', [], {
      store: savingStore,
      learnerKey,
      snapshot: { sessions: [], restoreMarker: undefined },
    });

    await saveChatSessions(
      'stage-failed-load',
      [{ ...chatSession(), id: 'chat-created-after-recovery', title: 'Created after recovery' }],
      {
        store: savingStore,
        learnerKey,
        snapshot: { sessions: [], restoreMarker: undefined },
      },
    );

    await expect(
      loadChatSessions('stage-failed-load', { store: savingStore, learnerKey }),
    ).resolves.toMatchObject([{ title: 'Persisted chat' }, { title: 'Created after recovery' }]);
  });

  it('rolls back imported Dexie rows when restore-marker creation fails', async () => {
    const backing = new BrowserRuntimeStore({ indexedDB: globalThis.indexedDB });
    const { db, importDatabase } = await import('@/lib/utils/database');
    const { loadChatSessions, saveChatSessions } = await import('@/lib/utils/chat-storage');
    await db.stages.put({
      id: 'stage-marker-failure',
      name: 'Original stage',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    await saveChatSessions(
      'stage-marker-failure',
      [{ ...chatSession(), title: 'Original runtime chat' }],
      { store: backing, learnerKey },
    );
    const markerFailureStore = new Proxy(backing, {
      get(target, property) {
        if (property === 'createSession') {
          return async (init: Parameters<RuntimeStore['createSession']>[0]) => {
            if (init.id.startsWith('chat-restore-marker:')) {
              throw new Error('restore marker failed');
            }
            return target.createSession(init);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(
      importDatabase(
        {
          stages: [
            {
              id: 'stage-marker-failure',
              name: 'Imported stage',
              createdAt: 1_000,
              updatedAt: 3_000,
            },
          ],
          chatSessions: [
            { ...chatSession(), stageId: 'stage-marker-failure', title: 'Imported chat' },
          ],
        },
        { store: markerFailureStore, learnerKey },
      ),
    ).rejects.toThrow('restore marker failed');

    await expect(db.stages.get('stage-marker-failure')).resolves.toMatchObject({
      name: 'Original stage',
    });
    await expect(
      loadChatSessions('stage-marker-failure', { store: backing, learnerKey }),
    ).resolves.toMatchObject([{ title: 'Original runtime chat' }]);
  });

  it('finishes an interrupted runtime clear from the durable restore marker', async () => {
    const backing = new BrowserRuntimeStore({ indexedDB: globalThis.indexedDB });
    const { db, importDatabase } = await import('@/lib/utils/database');
    const { loadChatSessions, saveChatSessions } = await import('@/lib/utils/chat-storage');
    await saveChatSessions(
      'stage-interrupted-restore',
      [{ ...chatSession(), title: 'Pre-restore runtime chat' }],
      { store: backing, learnerKey },
    );
    const [oldRuntime] = (
      await backing.listSessions('stage-interrupted-restore', learnerKey)
    ).filter((session) => session.kind === 'chat');
    const failingDeleteStore = new Proxy(backing, {
      get(target, property) {
        if (property === 'deleteSession') {
          return async (runtimeSessionId: string) => {
            if (runtimeSessionId === oldRuntime?.id) throw new Error('restore delete failed');
            return target.deleteSession(runtimeSessionId);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(
      importDatabase(
        {
          stages: [
            {
              id: 'stage-interrupted-restore',
              name: 'Imported stage',
              createdAt: 1_000,
              updatedAt: 3_000,
            },
          ],
          chatSessions: [
            {
              ...chatSession(),
              stageId: 'stage-interrupted-restore',
              title: 'Restored backup chat',
            },
          ],
        },
        { store: failingDeleteStore, learnerKey },
      ),
    ).rejects.toThrow('restore delete failed');
    await expect(db.stages.get('stage-interrupted-restore')).resolves.toMatchObject({
      name: 'Imported stage',
    });

    await expect(
      loadChatSessions('stage-interrupted-restore', { store: backing, learnerKey }),
    ).resolves.toMatchObject([{ title: 'Restored backup chat' }]);
  });

  it('fails backup export instead of returning legacy-only chats after a runtime read error', async () => {
    const runtimeStore = new BrowserRuntimeStore({ indexedDB: globalThis.indexedDB });
    const failingStore = new Proxy(runtimeStore, {
      get(target, property) {
        if (property === 'listSessions') {
          return async () => {
            throw new Error('runtime read failed');
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BrowserRuntimeStore;
    const { db, exportDatabase } = await import('@/lib/utils/database');
    await db.stages.put({
      id: 'stage-backup',
      name: 'Backup stage',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    await db.chatSessions.put({ ...chatSession(), stageId: 'stage-backup' });

    await expect(exportDatabase({ store: failingStore, learnerKey })).rejects.toThrow(
      'runtime read failed',
    );
  });

  it('upgrades past the abandoned lease schema and adds compound chat restore staging', async () => {
    const { default: Dexie } = await import('dexie');
    const intermediate = new Dexie('MAIC-Database', {
      indexedDB: globalThis.indexedDB,
      IDBKeyRange: globalThis.IDBKeyRange,
    });
    intermediate.version(13).stores({ chatStorageLocks: 'key, expiresAt' });
    await intermediate.open();
    await intermediate.table('chatStorageLocks').put({
      key: 'stage-old-lock',
      owner: 'old-tab',
      expiresAt: Date.now() + 30_000,
    });
    intermediate.close();

    const { db } = await import('@/lib/utils/database');
    await db.open();

    expect(db.verno).toBe(15);
    expect([...db.backendDB().objectStoreNames]).not.toContain('chatStorageLocks');
    expect([...db.backendDB().objectStoreNames]).toContain('chatRestoreStaging');
  });

  it('waits for active and locally queued chat writers before clearing all runtime data', async () => {
    const indexedDB = globalThis.indexedDB;
    const dbName = 'clear-writer-lock';
    const writerBacking = new BrowserRuntimeStore({ indexedDB, dbName });
    const clearingStore = new BrowserRuntimeStore({ indexedDB, dbName });
    let writerStarted!: () => void;
    const didStartWriter = new Promise<void>((resolve) => {
      writerStarted = resolve;
    });
    let releaseWriter!: () => void;
    const writerMayContinue = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writerStore = new Proxy(writerBacking, {
      get(target, property) {
        if (property === 'createSession') {
          return async (...args: Parameters<BrowserRuntimeStore['createSession']>) => {
            writerStarted();
            await writerMayContinue;
            return writerBacking.createSession(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BrowserRuntimeStore;
    const { clearDatabase } = await import('@/lib/utils/database');
    const { saveChatSessions } = await import('@/lib/utils/chat-storage');

    const firstSave = saveChatSessions('stage-clear-race', [chatSession()], {
      store: writerStore,
      learnerKey,
    });
    await didStartWriter;
    const secondSave = saveChatSessions(
      'stage-clear-race',
      [{ ...chatSession(), title: 'Queued chat save', updatedAt: 3_000 }],
      {
        store: writerStore,
        learnerKey,
      },
    );
    await Promise.resolve();
    const clearing = clearDatabase(clearingStore);
    const earlyOutcome = await Promise.race([
      clearing.then(() => 'cleared' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);

    expect(earlyOutcome).toBe('blocked');
    releaseWriter();
    await expect(firstSave).resolves.toBeUndefined();
    await expect(secondSave).resolves.toBeUndefined();
    await expect(clearing).resolves.toBeUndefined();
    await expect(clearingStore.listSessions('stage-clear-race', learnerKey)).resolves.toEqual([]);
  });

  it('keeps backup staging and runtime clearing in the same cross-tab lock', async () => {
    const indexedDB = globalThis.indexedDB;
    const importingStore = new BrowserRuntimeStore({ indexedDB, dbName: 'restore-lock' });
    const loadingStore = new BrowserRuntimeStore({ indexedDB, dbName: 'restore-lock' });
    const { db, exportDatabase, importDatabase } = await import('@/lib/utils/database');
    const { loadChatSessions, saveChatSessions } = await import('@/lib/utils/chat-storage');
    await db.stages.bulkPut([
      {
        id: 'stage-backup',
        name: 'Backup stage',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
      {
        id: 'stage-z-backup',
        name: 'Later backup stage',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    ]);
    await saveChatSessions('stage-backup', [chatSession()], {
      store: importingStore,
      learnerKey,
    });
    await saveChatSessions(
      'stage-z-backup',
      [{ ...chatSession(), id: 'chat-z-backup', title: 'Later persisted chat' }],
      { store: importingStore, learnerKey },
    );
    const exported = await exportDatabase({ store: importingStore, learnerKey });
    await saveChatSessions(
      'stage-backup',
      [{ ...chatSession(), title: 'Newer local chat', updatedAt: 3_000 }],
      { store: importingStore, learnerKey },
    );
    await saveChatSessions(
      'stage-z-backup',
      [
        {
          ...chatSession(),
          id: 'chat-z-backup',
          title: 'Later newer local chat',
          updatedAt: 3_000,
        },
      ],
      { store: importingStore, learnerKey },
    );

    const originalTransaction = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
    let transactionCommitted!: () => void;
    const didCommit = new Promise<void>((resolve) => {
      transactionCommitted = resolve;
    });
    let releaseImport!: () => void;
    const importMayContinue = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) =>
      originalTransaction(...args).then(async (result) => {
        if (!Array.isArray(args[1])) return result;
        transactionCommitted();
        await importMayContinue;
        return result;
      })) as typeof db.transaction);

    const importing = importDatabase(exported, { store: importingStore, learnerKey });
    await didCommit;
    const loading = loadChatSessions('stage-z-backup', { store: loadingStore, learnerKey });
    const earlyOutcome = await Promise.race([
      loading.then(() => 'read' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);
    expect(earlyOutcome).toBe('blocked');

    releaseImport();
    await importing;
    await expect(loading).resolves.toMatchObject([{ title: 'Later persisted chat' }]);
    await expect(
      loadChatSessions('stage-backup', { store: loadingStore, learnerKey }),
    ).resolves.toMatchObject([{ title: 'Persisted chat' }]);
  });

  it('does not deadlock backup restore behind a queued maintenance lock and later autosave', async () => {
    vi.stubGlobal('navigator', { locks: fairLockManager() });
    const runtimeBacking = new BrowserRuntimeStore({
      indexedDB: globalThis.indexedDB,
      dbName: 'restore-queue-order',
    });
    let firstSaveStarted!: () => void;
    const didStartFirstSave = new Promise<void>((resolve) => {
      firstSaveStarted = resolve;
    });
    let releaseFirstSave!: () => void;
    const firstSaveMayContinue = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const runtimeStore = new Proxy(runtimeBacking, {
      get(target, property) {
        if (property === 'createSession') {
          return async (...args: Parameters<BrowserRuntimeStore['createSession']>) => {
            if (args[0].stageId === 'stage-a') {
              firstSaveStarted();
              await firstSaveMayContinue;
            }
            return runtimeBacking.createSession(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BrowserRuntimeStore;
    const { withRuntimeStorageExclusiveLock } = await import('@/lib/utils/chat-storage-lock');
    const { restoreChatSessionsFromBackup, saveChatSessions } =
      await import('@/lib/utils/chat-storage');

    const firstSave = saveChatSessions('stage-a', [chatSession()], {
      store: runtimeStore,
      learnerKey,
    });
    await didStartFirstSave;
    const restoring = restoreChatSessionsFromBackup(['stage-a', 'stage-b'], async () => {}, {
      store: runtimeStore,
      learnerKey,
    });
    await Promise.resolve();
    const maintaining = withRuntimeStorageExclusiveLock(async () => {});
    const laterSave = saveChatSessions('stage-b', [], {
      store: runtimeStore,
      learnerKey,
      snapshot: { sessions: [], restoreMarker: null },
    });

    releaseFirstSave();
    const outcome = await Promise.race([
      Promise.all([firstSave, restoring, maintaining, laterSave]).then(() => 'completed' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);

    expect(outcome).toBe('completed');
  });

  it('enrolls a stage save before document writes so maintenance cannot overtake it', async () => {
    stubMemoryLocalStorage();
    const { db } = await import('@/lib/utils/database');
    const { saveStageData } = await import('@/lib/utils/stage-storage');
    const { withRuntimeStorageExclusiveLock } = await import('@/lib/utils/chat-storage-lock');
    const originalPut = db.stages.put.bind(db.stages);
    let documentWriteStarted!: () => void;
    const didStartDocumentWrite = new Promise<void>((resolve) => {
      documentWriteStarted = resolve;
    });
    let releaseDocumentWrite!: () => void;
    const documentWriteMayContinue = new Promise<void>((resolve) => {
      releaseDocumentWrite = resolve;
    });
    vi.spyOn(db.stages, 'put').mockImplementation((async (record, key) => {
      documentWriteStarted();
      await documentWriteMayContinue;
      return originalPut(record, key);
    }) as typeof db.stages.put);

    const saving = saveStageData('stage-save-enrollment', {
      stage: {
        id: 'stage-save-enrollment',
        name: 'Enrolled save',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
      scenes: [],
      currentSceneId: null,
      chats: [chatSession()],
    });
    await didStartDocumentWrite;
    let maintenanceStarted = false;
    const maintenance = withRuntimeStorageExclusiveLock(async () => {
      maintenanceStarted = true;
    });
    await Promise.resolve();

    expect(maintenanceStarted).toBe(false);
    releaseDocumentWrite();
    await Promise.all([saving, maintenance]);
  });

  it('does not wait inside a shared epoch for a partition read queued after maintenance', async () => {
    vi.stubGlobal('navigator', { locks: fairLockManager() });
    stubMemoryLocalStorage();
    const { db } = await import('@/lib/utils/database');
    const { loadChatSessions } = await import('@/lib/utils/chat-storage');
    const { withRuntimeStorageExclusiveLock } = await import('@/lib/utils/chat-storage-lock');
    const { saveStageData } = await import('@/lib/utils/stage-storage');
    const originalPut = db.stages.put.bind(db.stages);
    let documentWriteStarted!: () => void;
    const didStartDocumentWrite = new Promise<void>((resolve) => {
      documentWriteStarted = resolve;
    });
    let releaseDocumentWrite!: () => void;
    const documentWriteMayContinue = new Promise<void>((resolve) => {
      releaseDocumentWrite = resolve;
    });
    vi.spyOn(db.stages, 'put').mockImplementation((async (record, key) => {
      documentWriteStarted();
      await documentWriteMayContinue;
      return originalPut(record, key);
    }) as typeof db.stages.put);

    const saving = saveStageData('stage-epoch-order', {
      stage: {
        id: 'stage-epoch-order',
        name: 'Epoch ordering',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
      scenes: [],
      currentSceneId: null,
      chats: [chatSession()],
    });
    await didStartDocumentWrite;
    const boundedExclusive = withRuntimeStorageExclusiveLock as <T>(
      work: () => Promise<T>,
      options: { acquireTimeoutMs: number },
    ) => Promise<T>;
    const maintenance = boundedExclusive(async () => {}, { acquireTimeoutMs: 50 });
    await Promise.resolve();
    const loading = loadChatSessions('stage-epoch-order');

    releaseDocumentWrite();
    const [, , loaded] = await Promise.all([saving, maintenance, loading]);
    expect(loaded).toMatchObject([{ id: 'chat-backup' }]);
  });

  it('bounds maintenance lock acquisition without running delayed destructive work', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { locks: fairLockManager() });
    const { withRuntimeStorageExclusiveLock, withRuntimeStorageSharedLock } =
      await import('@/lib/utils/chat-storage-lock');
    let sharedStarted!: () => void;
    const didStartShared = new Promise<void>((resolve) => {
      sharedStarted = resolve;
    });
    let releaseShared!: () => void;
    const sharedMayContinue = new Promise<void>((resolve) => {
      releaseShared = resolve;
    });
    const shared = withRuntimeStorageSharedLock(async () => {
      sharedStarted();
      await sharedMayContinue;
    });
    await didStartShared;
    let maintenanceRan = false;
    const boundedExclusive = withRuntimeStorageExclusiveLock as <T>(
      work: () => Promise<T>,
      options: { acquireTimeoutMs: number },
    ) => Promise<T>;
    const maintenance = boundedExclusive(
      async () => {
        maintenanceRan = true;
      },
      { acquireTimeoutMs: 50 },
    );
    const outcome = Promise.race([
      maintenance.then(
        () => 'completed' as const,
        () => 'rejected' as const,
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 51)),
    ]);

    try {
      await vi.advanceTimersByTimeAsync(51);
      await expect(outcome).resolves.toBe('rejected');
      let laterSharedStarted = false;
      const laterShared = withRuntimeStorageSharedLock(async () => {
        laterSharedStarted = true;
      });
      await Promise.resolve();
      expect(laterSharedStarted).toBe(true);
      await laterShared;
    } finally {
      releaseShared();
      await shared;
      await maintenance.catch(() => {});
      vi.useRealTimers();
    }
    expect(maintenanceRan).toBe(false);
  });

  it('enrolls backup import before learner context setup', async () => {
    const runtimeStore = new BrowserRuntimeStore({
      indexedDB: globalThis.indexedDB,
      dbName: 'import-setup-enrollment',
    });
    let learnerLookupStarted!: () => void;
    const didStartLearnerLookup = new Promise<void>((resolve) => {
      learnerLookupStarted = resolve;
    });
    let releaseLearnerLookup!: () => void;
    const learnerLookupMayContinue = new Promise<void>((resolve) => {
      releaseLearnerLookup = resolve;
    });
    const kv: KVStore = {
      async get<T>() {
        learnerLookupStarted();
        await learnerLookupMayContinue;
        return learnerKey as T;
      },
      async set() {},
      async remove() {},
      async keys() {
        return [];
      },
    };
    const { importDatabase } = await import('@/lib/utils/database');
    const { withRuntimeStorageExclusiveLock } = await import('@/lib/utils/chat-storage-lock');
    const importing = importDatabase(
      {
        stages: [
          {
            id: 'stage-import-enrollment',
            name: 'Imported stage',
            createdAt: 1_000,
            updatedAt: 2_000,
          },
        ],
        chatSessions: [
          {
            ...chatSession(),
            stageId: 'stage-import-enrollment',
          },
        ],
      },
      { store: runtimeStore, kv },
    );
    await didStartLearnerLookup;
    let maintenanceStarted = false;
    const maintenance = withRuntimeStorageExclusiveLock(async () => {
      maintenanceStarted = true;
    });
    await Promise.resolve();

    expect(maintenanceStarted).toBe(false);
    releaseLearnerLookup();
    await Promise.all([importing, maintenance]);
  });

  it('waits for an active runtime writer before deleting a stage cascade', async () => {
    const { getRuntimeStore } = await import('@/lib/runtime/store');
    const backing = getRuntimeStore() as BrowserRuntimeStore;
    let writerStarted!: () => void;
    const didStartWriter = new Promise<void>((resolve) => {
      writerStarted = resolve;
    });
    let releaseWriter!: () => void;
    const writerMayContinue = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writerStore = new Proxy(backing, {
      get(target, property) {
        if (property === 'createSession') {
          return async (...args: Parameters<BrowserRuntimeStore['createSession']>) => {
            writerStarted();
            await writerMayContinue;
            return backing.createSession(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BrowserRuntimeStore;
    const { db, deleteStageWithRelatedData } = await import('@/lib/utils/database');
    const { saveChatSessions } = await import('@/lib/utils/chat-storage');
    await db.stages.put({
      id: 'stage-delete-race',
      name: 'Delete race',
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    const saving = saveChatSessions('stage-delete-race', [chatSession()], {
      store: writerStore,
      learnerKey,
    });
    await didStartWriter;
    const deleting = deleteStageWithRelatedData('stage-delete-race');
    const earlyOutcome = await Promise.race([
      deleting.then(() => 'deleted' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);

    expect(earlyOutcome).toBe('blocked');
    releaseWriter();
    await saving;
    await deleting;
    await expect(backing.listSessions('stage-delete-race', learnerKey)).resolves.toEqual([]);
  });

  it('deletes interrupted-restore staging rows with the stage cascade', async () => {
    stubMemoryLocalStorage();
    const { db, deleteStageWithRelatedData, exportDatabase } = await import('@/lib/utils/database');
    await db.stages.put({
      id: 'stage-delete-staging',
      name: 'Delete staged restore',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    await db.chatRestoreStaging.put({
      ...chatSession(),
      stageId: 'stage-delete-staging',
    });

    await deleteStageWithRelatedData('stage-delete-staging');

    await expect(
      db.chatRestoreStaging.where('stageId').equals('stage-delete-staging').count(),
    ).resolves.toBe(0);
    const exported = await exportDatabase();
    expect(
      exported.chatSessions.some((session) => session.stageId === 'stage-delete-staging'),
    ).toBe(false);
  });

  it('keeps the maintenance lock until a timed-out stage cascade actually settles', async () => {
    vi.stubGlobal('navigator', { locks: fairLockManager() });
    stubMemoryLocalStorage();
    const { getRuntimeStore } = await import('@/lib/runtime/store');
    const backing = getRuntimeStore() as BrowserRuntimeStore;
    const originalDelete = backing.deleteStageRuntime.bind(backing);
    let cascadeStarted!: () => void;
    const didStartCascade = new Promise<void>((resolve) => {
      cascadeStarted = resolve;
    });
    let releaseCascade!: () => void;
    const cascadeMayContinue = new Promise<void>((resolve) => {
      releaseCascade = resolve;
    });
    vi.spyOn(backing, 'deleteStageRuntime').mockImplementation(async (stageId) => {
      cascadeStarted();
      await cascadeMayContinue;
      await originalDelete(stageId);
    });
    const { db } = await import('@/lib/utils/database');
    const { deleteStageData } = await import('@/lib/utils/stage-storage');
    const { loadChatSessions, saveChatSessions } = await import('@/lib/utils/chat-storage');
    await db.stages.put({
      id: 'stage-timeout-delete',
      name: 'Timed-out delete',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    await saveChatSessions('stage-timeout-delete', [chatSession()], {
      store: backing,
      learnerKey,
    });
    await Promise.resolve();

    const deleting = deleteStageData('stage-timeout-delete');
    await didStartCascade;
    await expect(deleting).resolves.toBeUndefined();

    let replacementStarted!: () => void;
    const didStartReplacement = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });
    let replacementReadStarted = false;
    const replacementStore = new Proxy(backing, {
      get(target, property) {
        if (property === 'listSessions') {
          return async (...args: Parameters<BrowserRuntimeStore['listSessions']>) => {
            if (!replacementReadStarted) {
              replacementReadStarted = true;
              replacementStarted();
            }
            return backing.listSessions(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BrowserRuntimeStore;
    const replacement = saveChatSessions(
      'stage-timeout-delete',
      [{ ...chatSession(), title: 'Saved after timeout', updatedAt: 4_000 }],
      { store: replacementStore, learnerKey },
    );
    const replacementOutcome = await Promise.race([
      didStartReplacement.then(() => 'started' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);

    releaseCascade();
    await replacement;
    expect(replacementOutcome).toBe('blocked');
    await expect(
      loadChatSessions('stage-timeout-delete', { store: backing, learnerKey }),
    ).resolves.toMatchObject([{ title: 'Saved after timeout', updatedAt: 4_000 }]);
  }, 10_000);

  it('acquires both the stage-wide and legacy partition Web Lock names', async () => {
    const requested: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        async request<T>(
          name: string,
          optionsOrCallback: LockOptions | (() => Promise<T> | T),
          maybeCallback?: () => Promise<T> | T,
        ): Promise<T> {
          requested.push(name);
          const callback =
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
          return callback();
        },
      },
    });
    const runtimeStore = new BrowserRuntimeStore({
      indexedDB: globalThis.indexedDB,
      dbName: 'compatible-restore-lock',
    });
    const { loadChatSessions } = await import('@/lib/utils/chat-storage');

    await loadChatSessions('stage-compatible-lock', { store: runtimeStore, learnerKey });

    expect(requested).toEqual([
      'openmaic:chat-storage:all',
      `openmaic:chat-storage:${encodeURIComponent('stage-compatible-lock')}`,
      `openmaic:chat-storage:${encodeURIComponent(`stage-compatible-lock\0${learnerKey}`)}`,
    ]);
  });

  it('keeps the global maintenance lock disjoint from a stage named all', async () => {
    const runtimeStore = new BrowserRuntimeStore({
      indexedDB: globalThis.indexedDB,
      dbName: 'stage-all-lock',
    });
    const { saveChatSessions } = await import('@/lib/utils/chat-storage');

    const outcome = await Promise.race([
      saveChatSessions('all', [chatSession()], { store: runtimeStore, learnerKey }).then(
        () => 'saved' as const,
      ),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);

    expect(outcome).toBe('saved');
  });

  it('fails before mutating backup data when the default legacy store has no Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    const runtimeStore = new BrowserRuntimeStore({
      indexedDB: globalThis.indexedDB,
      dbName: 'missing-web-locks',
    });
    const { db, importDatabase } = await import('@/lib/utils/database');
    await db.stages.put({
      id: 'stage-no-lock',
      name: 'Existing stage',
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    await expect(
      importDatabase(
        {
          stages: [
            {
              id: 'stage-no-lock',
              name: 'Restored stage',
              createdAt: 3_000,
              updatedAt: 4_000,
            },
          ],
          chatSessions: [{ ...chatSession(), stageId: 'stage-no-lock' }],
        },
        { store: runtimeStore, learnerKey },
      ),
    ).rejects.toThrow(/Web Locks/);
    await expect(db.stages.get('stage-no-lock')).resolves.toMatchObject({
      name: 'Existing stage',
    });
    await expect(
      db.chatSessions.where('stageId').equals('stage-no-lock').toArray(),
    ).resolves.toEqual([]);
  });

  it('keeps empty-chat document saves available without Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    stubMemoryLocalStorage();
    const { db } = await import('@/lib/utils/database');
    const { saveStageData } = await import('@/lib/utils/stage-storage');

    await expect(
      saveStageData('stage-no-chat', {
        stage: {
          id: 'stage-no-chat',
          name: 'No chat stage',
          createdAt: 1_000,
          updatedAt: 2_000,
        },
        scenes: [],
        currentSceneId: null,
        chats: [],
      }),
    ).resolves.toBeUndefined();
    await expect(db.stages.get('stage-no-chat')).resolves.toMatchObject({
      name: 'No chat stage',
    });
  });

  it('keeps legacy chats visible without Web Locks without migrating them', async () => {
    vi.stubGlobal('navigator', {});
    stubMemoryLocalStorage();
    const { db } = await import('@/lib/utils/database');
    const { loadChatSessions } = await import('@/lib/utils/chat-storage');
    await db.chatSessions.put({
      ...chatSession(),
      stageId: 'stage-legacy-no-lock',
    });

    await expect(loadChatSessions('stage-legacy-no-lock')).resolves.toMatchObject([
      { id: 'chat-backup', title: 'Persisted chat' },
    ]);
    await expect(
      db.chatSessions.where('stageId').equals('stage-legacy-no-lock').count(),
    ).resolves.toBe(1);
  });

  it('keeps unrelated document saves available for an unchanged read-only legacy snapshot', async () => {
    vi.stubGlobal('navigator', {});
    stubMemoryLocalStorage();
    const { db } = await import('@/lib/utils/database');
    const { loadStageData, saveStageData } = await import('@/lib/utils/stage-storage');
    await db.stages.put({
      id: 'stage-legacy-autosave',
      name: 'Existing stage',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    await db.chatSessions.put({
      ...chatSession(),
      stageId: 'stage-legacy-autosave',
    });
    const loaded = await loadStageData('stage-legacy-autosave');

    await expect(
      saveStageData('stage-legacy-autosave', {
        ...loaded!,
        stage: { ...loaded!.stage, name: 'Updated stage' },
      }),
    ).resolves.toBeUndefined();
    await expect(db.stages.get('stage-legacy-autosave')).resolves.toMatchObject({
      name: 'Updated stage',
    });
    await expect(
      db.chatSessions.where('stageId').equals('stage-legacy-autosave').count(),
    ).resolves.toBe(1);

    vi.stubGlobal('navigator', { locks: serialLockManager() });
    await expect(loadStageData('stage-legacy-autosave')).resolves.toMatchObject({
      chats: [{ id: 'chat-backup', title: 'Persisted chat' }],
    });
    await expect(
      db.chatSessions.where('stageId').equals('stage-legacy-autosave').count(),
    ).resolves.toBe(0);
  });

  it('still fails edits to a read-only legacy snapshot without Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    stubMemoryLocalStorage();
    const { db } = await import('@/lib/utils/database');
    const { loadStageData, saveStageData } = await import('@/lib/utils/stage-storage');
    await db.stages.put({
      id: 'stage-legacy-edit',
      name: 'Existing stage',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    await db.chatSessions.put({
      ...chatSession(),
      stageId: 'stage-legacy-edit',
    });
    const loaded = await loadStageData('stage-legacy-edit');

    await expect(
      saveStageData('stage-legacy-edit', {
        ...loaded!,
        chats: [{ ...loaded!.chats[0]!, title: 'Unsaved edit', updatedAt: 3_000 }],
      }),
    ).rejects.toThrow(/Web Locks/);
  });

  it('still fails deletion of a read-only legacy snapshot without Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    stubMemoryLocalStorage();
    const { db } = await import('@/lib/utils/database');
    const { loadStageData, saveStageData } = await import('@/lib/utils/stage-storage');
    await db.stages.put({
      id: 'stage-legacy-delete',
      name: 'Existing stage',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    await db.chatSessions.put({
      ...chatSession(),
      stageId: 'stage-legacy-delete',
    });
    const loaded = await loadStageData('stage-legacy-delete');

    await expect(saveStageData('stage-legacy-delete', { ...loaded!, chats: [] })).rejects.toThrow(
      /Web Locks/,
    );
  });

  it('still fails non-empty chat document saves without Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    stubMemoryLocalStorage();
    const { saveStageData } = await import('@/lib/utils/stage-storage');

    await expect(
      saveStageData('stage-with-chat', {
        stage: {
          id: 'stage-with-chat',
          name: 'Chat stage',
          createdAt: 1_000,
          updatedAt: 2_000,
        },
        scenes: [],
        currentSceneId: null,
        chats: [chatSession()],
      }),
    ).rejects.toThrow(/Web Locks/);
  });

  it('clears document and runtime databases without Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    const runtimeStore = new BrowserRuntimeStore({
      indexedDB: globalThis.indexedDB,
      dbName: 'clear-without-web-locks',
    });
    const { clearDatabase, db } = await import('@/lib/utils/database');
    await db.stages.put({
      id: 'stage-clear-no-lock',
      name: 'Clear without locks',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    await runtimeStore.createSession({
      id: 'runtime-clear-no-lock',
      kind: 'chat',
      stageId: 'stage-clear-no-lock',
      learnerKey,
      status: 'active',
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(2_000).toISOString(),
    });

    await expect(clearDatabase(runtimeStore)).resolves.toBeUndefined();
    await expect(runtimeStore.listSessions('stage-clear-no-lock', learnerKey)).resolves.toEqual([]);
    await db.open();
    await expect(db.stages.count()).resolves.toBe(0);
  });

  it('fails loud without deleting documents when the runtime-wide clear fails', async () => {
    const { clearDatabase, db } = await import('@/lib/utils/database');
    await db.stages.put({
      id: 'stage-retained',
      name: 'Retained stage',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    const runtimeStore = {
      deleteAllRuntime: vi.fn().mockRejectedValue(new Error('runtime clear failed')),
    } as unknown as BrowserRuntimeStore;

    await expect(clearDatabase(runtimeStore)).rejects.toThrow('runtime clear failed');
    await expect(db.stages.get('stage-retained')).resolves.toMatchObject({ id: 'stage-retained' });
  });
});
