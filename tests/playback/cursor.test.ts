import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserKVStore, BrowserRuntimeStore } from '@openmaic/storage';

import {
  clearCursor,
  loadCursor,
  saveCursor,
  type PlaybackLegacyStore,
} from '@/lib/playback/cursor';
import { loadConsumedDiscussions } from '@/lib/playback/runtime';

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

describe('playback cursor persistence', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'IDBKeyRange', {
      configurable: true,
      value: IDBKeyRange,
    });
  });

  it('round-trips and overwrites with the last saved cursor', async () => {
    const kv = new BrowserKVStore({ storage: new MemoryStorage(), namespace: 'cursor-test' });
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: 'cursor-runtime-test',
    });
    const legacyStore: PlaybackLegacyStore = {
      get: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const deps = { kv, runtimeStore: store, learnerKey: 'learner-1', legacyStore };

    await saveCursor(
      'stage-1',
      { sceneId: 'scene-1', actionIndex: 2, updatedAt: '2026-07-21T12:00:00.000Z' },
      { kv },
    );
    await saveCursor(
      'stage-1',
      { sceneId: 'scene-2', actionIndex: 5, updatedAt: '2026-07-21T12:00:01.000Z' },
      { kv },
    );

    await expect(loadCursor('stage-1', deps)).resolves.toEqual({
      sceneId: 'scene-2',
      actionIndex: 5,
      updatedAt: '2026-07-21T12:00:01.000Z',
    });
    await clearCursor('stage-1', { kv });
    await expect(loadCursor('stage-1', deps)).resolves.toBeNull();
  });

  it('migrates one legacy row once, including consumed discussions, then deletes it', async () => {
    const kv = new BrowserKVStore({ storage: new MemoryStorage(), namespace: 'migration-test' });
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: 'migration-runtime-test',
    });
    const legacy = {
      stageId: 'stage-legacy',
      sceneIndex: 0,
      actionIndex: 4,
      consumedDiscussions: ['discussion-1', 'discussion-1', 'discussion-2'],
      sceneId: 'scene-legacy',
      updatedAt: Date.UTC(2026, 6, 21, 12),
    };
    let row: typeof legacy | undefined = legacy;
    const legacyStore: PlaybackLegacyStore = {
      get: vi.fn(async () => row),
      delete: vi.fn(async () => {
        row = undefined;
      }),
    };
    let recordIndex = 0;
    const runtimeDeps = {
      store,
      kv,
      learnerKey: 'learner-legacy',
      legacyStore,
      now: () => '2026-07-21T12:00:00.000Z',
      mintRecordId: () => `legacy-record-${recordIndex++}`,
    };
    const cursorDeps = { ...runtimeDeps, runtimeStore: store };

    await expect(loadCursor('stage-legacy', cursorDeps)).resolves.toEqual({
      sceneId: 'scene-legacy',
      actionIndex: 4,
      updatedAt: '2026-07-21T12:00:00.000Z',
    });
    await expect(loadConsumedDiscussions('stage-legacy', runtimeDeps)).resolves.toEqual(
      new Set(['discussion-1', 'discussion-2']),
    );
    await expect(loadCursor('stage-legacy', cursorDeps)).resolves.toMatchObject({ actionIndex: 4 });

    expect(legacyStore.delete).toHaveBeenCalledOnce();
    const sessions = await store.listSessions('stage-legacy', 'learner-legacy');
    expect(await store.listRecords(sessions[0].id)).toHaveLength(2);
  });
});
