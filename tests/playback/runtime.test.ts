import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserKVStore, BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

import {
  loadConsumedDiscussions,
  playbackSessionId,
  recordConsumedDiscussion,
  type PlaybackRuntimeDeps,
} from '@/lib/playback/runtime';
import type { PlaybackLegacyStore } from '@/lib/playback/cursor';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const emptyLegacyStore: PlaybackLegacyStore = {
  get: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
};

function makeHarness(): { store: RuntimeStore; deps: PlaybackRuntimeDeps } {
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `playback-runtime-${Math.random()}`,
  });
  const kv = new BrowserKVStore({
    storage: new MemoryStorage(),
    namespace: `playback-${Math.random()}`,
  });
  let tick = 0;
  return {
    store,
    deps: {
      store,
      kv,
      learnerKey: 'learner-1',
      legacyStore: emptyLegacyStore,
      now: () => new Date(Date.UTC(2026, 6, 21, 12, 0, tick++)).toISOString(),
      mintRecordId: () => `record-${tick}`,
    },
  };
}

function wrapStore(store: RuntimeStore, overrides: Partial<RuntimeStore>): RuntimeStore {
  return new Proxy(store, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof RuntimeStore];
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('playback runtime persistence', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'IDBKeyRange', {
      configurable: true,
      value: IDBKeyRange,
    });
    vi.clearAllMocks();
  });

  it('folds duplicate discussion facts into one consumed id', async () => {
    const { deps } = makeHarness();
    const input = {
      stageId: 'stage-1',
      sceneId: 'scene-1',
      discussionId: 'discussion-1',
    };

    await recordConsumedDiscussion(input, deps);
    await recordConsumedDiscussion(input, deps);

    await expect(loadConsumedDiscussions('stage-1', deps)).resolves.toEqual(
      new Set(['discussion-1']),
    );
  });

  it('recovers when another writer wins session creation', async () => {
    const { store, deps } = makeHarness();
    const createSession = vi.fn<RuntimeStore['createSession']>(async (init) => {
      await store.createSession(init);
      throw new Error('session already exists');
    });
    const racedStore = wrapStore(store, { createSession });
    const racedDeps = { ...deps, store: racedStore };

    await recordConsumedDiscussion(
      { stageId: 'stage-race', sceneId: 'scene-1', discussionId: 'discussion-1' },
      racedDeps,
    );

    expect(createSession).toHaveBeenCalledOnce();
    await expect(loadConsumedDiscussions('stage-race', racedDeps)).resolves.toEqual(
      new Set(['discussion-1']),
    );
    expect(await store.getSession(playbackSessionId('stage-race', 'learner-1'))).toBeDefined();
  });

  it('folds facts from every playback session left by a learner merge', async () => {
    const { store, deps } = makeHarness();
    // Simulate mergeLearner's outcome: two same-kind sessions in one partition.
    await store.createSession({
      id: 'playback-merged-anon',
      kind: 'playback',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    });
    await store.appendRecord({
      id: 'record-anon',
      sessionId: 'playback-merged-anon',
      sceneId: 'scene-1',
      createdAt: '2026-07-20T00:00:01.000Z',
      payload: { payloadVersion: 1, event: 'discussionConsumed', discussionId: 'discussion-anon' },
    });
    await recordConsumedDiscussion(
      { stageId: 'stage-1', sceneId: 'scene-1', discussionId: 'discussion-account' },
      deps,
    );

    await expect(loadConsumedDiscussions('stage-1', deps)).resolves.toEqual(
      new Set(['discussion-anon', 'discussion-account']),
    );
  });

  it('resumes an interrupted legacy migration without dropping the tail', async () => {
    const { store, deps } = makeHarness();
    const legacyRow = {
      stageId: 'stage-1',
      sceneIndex: 0,
      actionIndex: 3,
      consumedDiscussions: ['discussion-a', 'discussion-b', 'discussion-c'],
      sceneId: 'scene-1',
      updatedAt: 1_000,
    };
    let deleted = false;
    const legacyStore: PlaybackLegacyStore = {
      get: vi.fn(async () => (deleted ? undefined : legacyRow)),
      delete: vi.fn(async () => {
        deleted = true;
      }),
    };
    // First attempt: the second append fails mid-migration.
    let appends = 0;
    const failingStore = wrapStore(store, {
      appendRecord: (async (init, options) => {
        appends += 1;
        if (appends === 2) throw new Error('transient failure');
        return store.appendRecord(init, options);
      }) as RuntimeStore['appendRecord'],
    });
    await expect(
      loadConsumedDiscussions('stage-1', { ...deps, store: failingStore, legacyStore }),
    ).rejects.toThrow('transient failure');
    expect(deleted).toBe(false);

    // Retry appends only the missing facts, then deletes the row.
    await expect(loadConsumedDiscussions('stage-1', { ...deps, legacyStore })).resolves.toEqual(
      new Set(['discussion-a', 'discussion-b', 'discussion-c']),
    );
    expect(deleted).toBe(true);
    await expect(loadConsumedDiscussions('stage-1', { ...deps, legacyStore })).resolves.toEqual(
      new Set(['discussion-a', 'discussion-b', 'discussion-c']),
    );
  });

  it('reports a failed append so the caller can retry later', async () => {
    const { store, deps } = makeHarness();
    const brokenStore = wrapStore(store, {
      appendRecord: (async () => {
        throw new Error('storage offline');
      }) as RuntimeStore['appendRecord'],
    });

    await expect(
      recordConsumedDiscussion(
        { stageId: 'stage-1', sceneId: 'scene-1', discussionId: 'discussion-1' },
        { ...deps, store: brokenStore },
      ),
    ).resolves.toBe(false);
    await expect(
      recordConsumedDiscussion(
        { stageId: 'stage-1', sceneId: 'scene-1', discussionId: 'discussion-1' },
        deps,
      ),
    ).resolves.toBe(true);
  });
});
