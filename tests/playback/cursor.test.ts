import { describe, expect, it, vi } from 'vitest';
import { BrowserKVStore } from '@openmaic/storage';

import {
  clearCursor,
  loadCursor,
  saveCursor,
  type PlaybackLegacyStore,
} from '@/lib/playback/cursor';

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

describe('playback cursor persistence', () => {
  it('round-trips and overwrites with the last saved cursor', async () => {
    const kv = new BrowserKVStore({ storage: new MemoryStorage(), namespace: 'cursor-test' });
    const deps = { kv, legacyStore: emptyLegacyStore };

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

  it('migrates the cursor half of one legacy row once, then deletes it', async () => {
    const kv = new BrowserKVStore({ storage: new MemoryStorage(), namespace: 'migration-test' });
    const legacy = {
      stageId: 'stage-legacy',
      sceneIndex: 0,
      actionIndex: 4,
      // Volatile by decision (#869): consumed discussions do NOT migrate.
      consumedDiscussions: ['discussion-1', 'discussion-2'],
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
    const deps = { kv, legacyStore };

    await expect(loadCursor('stage-legacy', deps)).resolves.toEqual({
      sceneId: 'scene-legacy',
      actionIndex: 4,
      updatedAt: '2026-07-21T12:00:00.000Z',
    });
    await expect(loadCursor('stage-legacy', deps)).resolves.toMatchObject({ actionIndex: 4 });
    expect(legacyStore.delete).toHaveBeenCalledOnce();
  });

  it('does not overwrite a newer KV cursor with a legacy row', async () => {
    const kv = new BrowserKVStore({ storage: new MemoryStorage(), namespace: 'no-clobber-test' });
    await saveCursor(
      'stage-legacy',
      { sceneId: 'scene-new', actionIndex: 7, updatedAt: '2026-07-21T13:00:00.000Z' },
      { kv },
    );
    const legacyStore: PlaybackLegacyStore = {
      get: vi.fn(async () => ({
        stageId: 'stage-legacy',
        sceneIndex: 0,
        actionIndex: 1,
        consumedDiscussions: [],
        sceneId: 'scene-old',
        updatedAt: 1_000,
      })),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    await expect(loadCursor('stage-legacy', { kv, legacyStore })).resolves.toMatchObject({
      sceneId: 'scene-new',
      actionIndex: 7,
    });
    expect(legacyStore.delete).toHaveBeenCalledOnce();
  });
});
