import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Deletion-vs-persistence fencing at the storage layer.
 *
 * The store-level tests cover snapshots that are dropped before they reach
 * storage; these tests cover the last escape hatch: a write that already
 * entered `saveStageData` / `saveStageDataIncremental` when the stage was
 * deleted. Without the tombstone re-checks, `existing === undefined` after a
 * delete routes the incremental path into a full save that rebuilds the
 * deleted document from the in-memory snapshot.
 */

const {
  clearStoreForDeletedStage,
  discardPendingStageChanges,
  snapshotPendingStageChangesForDeletion,
  restorePendingStageChanges,
  mutateDocument,
  fakeStore,
  dbMock,
} = vi.hoisted(() => {
  const fakeStore = {
    saveDocument: vi.fn().mockResolvedValue(undefined),
    putScene: vi.fn().mockResolvedValue(undefined),
    putStage: vi.fn().mockResolvedValue(undefined),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
  };
  const generatedAgentsDelete = vi.fn().mockResolvedValue(0);
  const scenesDelete = vi.fn().mockResolvedValue(0);
  const dbMock = {
    stages: { delete: vi.fn().mockResolvedValue(undefined) },
    scenes: {
      where: () => ({
        equals: () => ({
          toArray: vi.fn().mockResolvedValue([]),
          delete: scenesDelete,
        }),
      }),
    },
    stageOutlines: { delete: vi.fn().mockResolvedValue(undefined) },
    playbackState: { delete: vi.fn().mockResolvedValue(undefined) },
    generatedAgents: {
      where: () => ({
        equals: () => ({ delete: generatedAgentsDelete }),
      }),
      _delete: generatedAgentsDelete,
    },
    transaction: vi.fn(async (_mode: string, _tables: unknown[], fn: () => Promise<void>) => fn()),
  };
  return {
    clearStoreForDeletedStage: vi.fn(),
    discardPendingStageChanges: vi.fn(),
    snapshotPendingStageChangesForDeletion: vi.fn().mockReturnValue([]),
    restorePendingStageChanges: vi.fn(),
    mutateDocument: vi.fn(),
    fakeStore,
    dbMock,
  };
});

vi.mock('@/lib/document-store', () => ({
  accessDocument: vi.fn(),
  clearCurrentScene: vi.fn().mockResolvedValue(undefined),
  getDocumentStore: vi.fn(),
  getLegacyDocumentStore: vi.fn(),
  loadCurrentScene: vi.fn().mockResolvedValue(null),
  mutateDocument,
  saveCurrentScene: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/utils/chat-storage', () => ({
  ChatStorageLockUnavailableError: class ChatStorageLockUnavailableError extends Error {},
  saveChatSessions: vi.fn().mockResolvedValue(undefined),
  loadChatSessions: vi.fn().mockResolvedValue([]),
  deleteChatSessions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/utils/chat-storage-lock', () => ({
  withRuntimeStorageSharedLock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withRuntimeStorageExclusiveLockUntilSettled: vi.fn(
    async (fn: (release: (value: unknown) => void) => Promise<unknown>) => fn(() => undefined),
  ),
}));
vi.mock('@/lib/utils/database', () => ({ db: dbMock }));
vi.mock('@/lib/playback/cursor', () => ({ clearCursor: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/quiz/persistence', () => ({ clearAllForScene: vi.fn() }));
vi.mock('@/lib/runtime/store', () => ({
  beginStageRuntimeDeletionSafely: vi.fn(() => ({
    completion: Promise.resolve(),
    settlement: Promise.resolve(),
  })),
}));
vi.mock('@/lib/pbl/v2/runtime/drain', () => ({
  clearStageDrainWatermarks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: vi.fn(
    async (_stageId: string, scenes: unknown[]) => scenes,
  ),
}));
vi.mock('@/lib/store/stage', () => ({
  clearStoreForDeletedStage,
  discardPendingStageChanges,
  snapshotPendingStageChangesForDeletion,
  restorePendingStageChanges,
}));

import {
  deleteStageData,
  saveStageData,
  saveStageDataIncremental,
  type PendingChange,
  type StageStoreData,
} from '@/lib/utils/stage-storage';
import {
  isStageDeleted,
  isStageWriteStale,
  markStageDeleted,
  stageDeletionEpoch,
  unmarkStageDeleted,
} from '@/lib/utils/deleted-stages';
import { saveCurrentScene } from '@/lib/document-store';
import { saveChatSessions } from '@/lib/utils/chat-storage';
import { withRuntimeStorageSharedLock } from '@/lib/utils/chat-storage-lock';
import { preparePBLScenesForDocumentPersistence } from '@/lib/pbl/v2/runtime/document-persistence';
import type { Scene } from '@/lib/types/stage';

let stageCounter = 0;
let stageId: string;

function makeData(id: string): StageStoreData {
  return {
    stage: { id, name: 'Doomed', createdAt: 1, updatedAt: 1 },
    scenes: [],
    currentSceneId: null,
    chats: [],
  };
}

function makeScene(id: string, stageId: string): Scene {
  return {
    id,
    stageId,
    type: 'text',
    title: id,
    order: 1,
    content: { type: 'text', markdown: id },
  } as unknown as Scene;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Fresh id per test: the tombstone set is session-scoped module state.
  stageCounter += 1;
  stageId = `stage-del-${stageCounter}`;
  // Default: the document is already gone (post-delete world).
  mutateDocument.mockImplementation(
    async (
      _stageId: string,
      callback: (existing: undefined, store: typeof fakeStore) => Promise<unknown>,
    ) => callback(undefined, fakeStore),
  );
});

afterEach(() => {
  unmarkStageDeleted(stageId);
});

describe('saveStageDataIncremental vs deletion', () => {
  it('full-saves when the destination is missing and the stage is NOT deleted (pinned)', async () => {
    await saveStageDataIncremental(stageId, [{ kind: 'stage' }], makeData(stageId));
    expect(fakeStore.saveDocument).toHaveBeenCalledOnce();
  });

  it('drops the write instead of rebuilding a deleted document', async () => {
    markStageDeleted(stageId);
    const result = await saveStageDataIncremental(stageId, [{ kind: 'stage' }], makeData(stageId));
    expect(result).toEqual({ failedChanges: [] });
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();
    expect(mutateDocument).not.toHaveBeenCalled();
  });

  it('re-checks the tombstone under the document lock (delete won the lock race)', async () => {
    // The flush entered mutateDocument first; the delete completes while the
    // flush waits for the per-stage lock. By the time the callback runs, the
    // tombstone exists and the full-save fallback must not fire.
    mutateDocument.mockImplementationOnce(
      async (
        id: string,
        callback: (existing: undefined, store: typeof fakeStore) => Promise<unknown>,
      ) => {
        markStageDeleted(id);
        return callback(undefined, fakeStore);
      },
    );
    await saveStageDataIncremental(stageId, [{ kind: 'stage' }], makeData(stageId));
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();
    expect(fakeStore.putStage).not.toHaveBeenCalled();
  });

  it('re-checks immediately before the full-save write (lock-free fallback: delete lands during scene preparation)', async () => {
    // Without Web Locks, mutateDocument degrades to running this callback
    // lock-free: nothing serializes a delete against the awaits between the
    // callback-entry check and the write. The write itself must re-check.
    vi.mocked(preparePBLScenesForDocumentPersistence).mockImplementationOnce(
      async (id: string, scenes: readonly Scene[]) => {
        markStageDeleted(id);
        return [...scenes];
      },
    );
    await saveStageDataIncremental(stageId, [{ kind: 'structure' }], makeData(stageId));
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();
  });

  it('re-checks immediately before each putScene on the incremental fast path', async () => {
    // Lock-free existing is stale-non-null: the fast path stays incremental
    // while a delete completes during preparation. No row may land.
    mutateDocument.mockImplementationOnce(
      async (
        _stageId: string,
        callback: (existing: unknown, store: typeof fakeStore) => Promise<unknown>,
      ) => callback({ stage: makeData(stageId).stage, scenes: [], outline: undefined }, fakeStore),
    );
    vi.mocked(preparePBLScenesForDocumentPersistence).mockImplementationOnce(
      async (id: string, scenes: readonly Scene[]) => {
        markStageDeleted(id);
        return [...scenes];
      },
    );
    const data = { ...makeData(stageId), scenes: [makeScene('scene-1', stageId)] };
    await saveStageDataIncremental(stageId, [{ kind: 'scene', sceneId: 'scene-1' }], data);
    expect(fakeStore.putScene).not.toHaveBeenCalled();
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();
  });

  it('drops the currentScene/chats tail when the delete wins during the document mutation', async () => {
    // The tail writes run after mutateDocument returns; a delete that fenced
    // the document write must also fence them, or the flush would resurrect
    // the currentScene KV row and chat sessions the cascade just cleared.
    mutateDocument.mockImplementationOnce(
      async (
        id: string,
        callback: (existing: undefined, store: typeof fakeStore) => Promise<unknown>,
      ) => {
        markStageDeleted(id);
        return callback(undefined, fakeStore);
      },
    );
    const result = await saveStageDataIncremental(
      stageId,
      [{ kind: 'stage' }, { kind: 'currentScene' }, { kind: 'chats' }],
      makeData(stageId),
    );
    expect(result).toEqual({ failedChanges: [] });
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();
    expect(vi.mocked(saveCurrentScene)).not.toHaveBeenCalled();
    expect(vi.mocked(saveChatSessions)).not.toHaveBeenCalled();
  });
});

describe('deletion epochs (delete → restore straddles)', () => {
  it('drops a round captured pre-delete even when a same-id restore lifted the deleted flag (incremental)', async () => {
    // The core epoch invariant: a boolean tombstone cannot distinguish a
    // pre-delete in-flight round from a post-restore edit once the restore
    // lifts it. The epoch can — the delete bumped it, so the old capture is
    // permanently stale and must not rebuild the restored document.
    mutateDocument.mockImplementationOnce(
      async (
        id: string,
        callback: (existing: undefined, store: typeof fakeStore) => Promise<unknown>,
      ) => {
        markStageDeleted(id); // delete wins the race while the round awaits
        unmarkStageDeleted(id); // server-copy restore lifts the deleted flag
        return callback(undefined, fakeStore);
      },
    );
    await saveStageDataIncremental(stageId, [{ kind: 'stage' }], makeData(stageId));
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();
    expect(fakeStore.putStage).not.toHaveBeenCalled();
  });

  it('drops a pre-delete aggregate save after a same-id restore', async () => {
    mutateDocument.mockImplementationOnce(
      async (
        id: string,
        callback: (existing: undefined, store: typeof fakeStore) => Promise<unknown>,
      ) => {
        markStageDeleted(id);
        unmarkStageDeleted(id);
        return callback(undefined, fakeStore);
      },
    );
    await saveStageData(stageId, makeData(stageId));
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();
  });

  it('drops the currentScene/chats tail of a pre-delete round after a restore', async () => {
    mutateDocument.mockImplementationOnce(
      async (
        id: string,
        callback: (existing: undefined, store: typeof fakeStore) => Promise<unknown>,
      ) => {
        markStageDeleted(id);
        unmarkStageDeleted(id);
        return callback(undefined, fakeStore);
      },
    );
    const result = await saveStageDataIncremental(
      stageId,
      [{ kind: 'stage' }, { kind: 'currentScene' }, { kind: 'chats' }],
      makeData(stageId),
    );
    expect(result).toEqual({ failedChanges: [] });
    expect(vi.mocked(saveCurrentScene)).not.toHaveBeenCalled();
    expect(vi.mocked(saveChatSessions)).not.toHaveBeenCalled();
  });

  it('re-checks between the two tail writes: a delete during saveCurrentScene fences the chat write', async () => {
    // No lock spans the tail. When a batch dirties both currentScene and
    // chats, a delete can start while the first tail write is awaiting; the
    // chat write must re-check independently instead of riding the earlier
    // check.
    vi.mocked(saveCurrentScene).mockImplementationOnce(async () => {
      markStageDeleted(stageId);
    });
    const result = await saveStageDataIncremental(
      stageId,
      [{ kind: 'currentScene' }, { kind: 'chats' }],
      makeData(stageId),
    );
    expect(result).toEqual({ failedChanges: [] });
    expect(vi.mocked(saveCurrentScene)).toHaveBeenCalledOnce();
    expect(vi.mocked(saveChatSessions)).not.toHaveBeenCalled();
  });

  it('persists a write whose data was captured AFTER a delete → restore cycle (new epoch)', async () => {
    // The counterpart invariant: the epoch fence must not overreach. Data
    // captured after the restore observes the current epoch and lands.
    markStageDeleted(stageId);
    unmarkStageDeleted(stageId);
    expect(stageDeletionEpoch(stageId)).toBe(1);
    await saveStageDataIncremental(stageId, [{ kind: 'stage' }], makeData(stageId));
    expect(fakeStore.saveDocument).toHaveBeenCalledOnce();
  });

  it('drops an explicitly stale captured epoch even while the stage is not deleted', async () => {
    // The scheduler passes the epoch captured with its data snapshot; a
    // mismatch alone (deleted flag already lifted) must drop the write.
    const staleEpoch = stageDeletionEpoch(stageId);
    markStageDeleted(stageId);
    unmarkStageDeleted(stageId);
    expect(isStageDeleted(stageId)).toBe(false);
    await saveStageDataIncremental(stageId, [{ kind: 'stage' }], makeData(stageId), staleEpoch);
    expect(mutateDocument).not.toHaveBeenCalled();
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();

    await saveStageData(stageId, makeData(stageId), staleEpoch);
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();
  });

  it('never rewinds the epoch: mark → unmark → mark keeps strictly increasing', () => {
    expect(stageDeletionEpoch(stageId)).toBe(0);
    markStageDeleted(stageId);
    expect(stageDeletionEpoch(stageId)).toBe(1);
    unmarkStageDeleted(stageId);
    expect(stageDeletionEpoch(stageId)).toBe(1);
    expect(isStageDeleted(stageId)).toBe(false);
    markStageDeleted(stageId);
    expect(stageDeletionEpoch(stageId)).toBe(2);
    expect(isStageWriteStale(stageId, 1)).toBe(true);
    unmarkStageDeleted(stageId);
    expect(isStageWriteStale(stageId, 1)).toBe(true);
    expect(isStageWriteStale(stageId, 2)).toBe(false);
  });
});

describe('saveStageData vs deletion', () => {
  it('drops the aggregate save for a deleted stage', async () => {
    markStageDeleted(stageId);
    const result = await saveStageData(stageId, makeData(stageId));
    expect(result).toBeUndefined();
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();
    expect(mutateDocument).not.toHaveBeenCalled();
  });

  it('re-checks the tombstone under the document lock', async () => {
    mutateDocument.mockImplementationOnce(
      async (
        id: string,
        callback: (existing: undefined, store: typeof fakeStore) => Promise<unknown>,
      ) => {
        markStageDeleted(id);
        return callback(undefined, fakeStore);
      },
    );
    await saveStageData(stageId, makeData(stageId));
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();
  });

  it('re-checks immediately before the aggregate write (delete lands inside the runtime-lock window)', async () => {
    vi.mocked(withRuntimeStorageSharedLock).mockImplementationOnce(
      async (fn: () => Promise<unknown>) => {
        markStageDeleted(stageId);
        return fn();
      },
    );
    await saveStageData(stageId, makeData(stageId));
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();
    expect(vi.mocked(saveCurrentScene)).not.toHaveBeenCalled();
  });
});

describe('deleteStageData wiring', () => {
  it('tombstones the stage BEFORE discarding pending work, then deletes', async () => {
    discardPendingStageChanges.mockImplementationOnce((id: string) => {
      // Ordering matters: an in-flight round survives the discard, so the
      // tombstone must already be visible when the discard happens.
      expect(isStageDeleted(id)).toBe(true);
    });

    await deleteStageData(stageId);

    expect(discardPendingStageChanges).toHaveBeenCalledExactlyOnceWith(stageId);
    expect(fakeStore.deleteDocument).toHaveBeenCalledExactlyOnceWith(stageId);
    expect(isStageDeleted(stageId)).toBe(true);
  });

  it('clears the legacy roster-mirror rows for the deleted stage', async () => {
    await deleteStageData(stageId);
    expect(dbMock.generatedAgents._delete).toHaveBeenCalledOnce();
  });

  it('tolerates a mirror-row cleanup failure without failing the deletion', async () => {
    dbMock.generatedAgents._delete.mockRejectedValueOnce(new Error('mirror gone wrong'));
    await expect(deleteStageData(stageId)).resolves.toBeUndefined();
    expect(dbMock.stages.delete).toHaveBeenCalledWith(stageId);
  });

  it('evicts the warm in-memory store after a successful deletion', async () => {
    // Without the eviction, a warm store keeps rendering the deleted
    // classroom: loadFromStorage short-circuits on it, the server-restore
    // path never runs, and every edit is silently dropped (back-button trap).
    await deleteStageData(stageId);
    expect(clearStoreForDeletedStage).toHaveBeenCalledExactlyOnceWith(stageId);
  });

  it('does not evict the store when the deletion fails', async () => {
    fakeStore.deleteDocument.mockRejectedValueOnce(new Error('locked'));
    await expect(deleteStageData(stageId)).rejects.toThrow('locked');
    // The stage survives — the warm copy is still the live document.
    expect(clearStoreForDeletedStage).not.toHaveBeenCalled();
  });

  it('lifts the deleted flag when the deletion fails before the document was removed, keeping the epoch bumped', async () => {
    const epochBefore = stageDeletionEpoch(stageId);
    fakeStore.deleteDocument.mockRejectedValueOnce(new Error('locked'));
    await expect(deleteStageData(stageId)).rejects.toThrow('locked');
    // The stage still exists — later edits must persist normally again…
    expect(isStageDeleted(stageId)).toBe(false);
    // …but the epoch stays bumped: writes captured before the failed delete
    // remain permanently stale (the restored dirt is re-queued as
    // descriptors, so its flush re-captures under the current epoch).
    expect(stageDeletionEpoch(stageId)).toBe(epochBefore + 1);
  });

  it('keeps the tombstone when the cascade fails after the document was removed', async () => {
    dbMock.stageOutlines.delete.mockRejectedValueOnce(new Error('partial cascade'));
    await expect(deleteStageData(stageId)).rejects.toThrow('partial cascade');
    // The document is gone; dropping later writes is what prevents resurrection.
    expect(isStageDeleted(stageId)).toBe(true);
  });

  it('snapshots the pending dirt BEFORE the tombstone exists', async () => {
    snapshotPendingStageChangesForDeletion.mockImplementationOnce((id: string) => {
      // The snapshot must see the pre-delete world: dirt queued now would be
      // refused after the tombstone, so ordering is load-bearing.
      expect(isStageDeleted(id)).toBe(false);
      return [];
    });
    await deleteStageData(stageId);
    expect(snapshotPendingStageChangesForDeletion).toHaveBeenCalledExactlyOnceWith(stageId);
  });

  it('restores the discarded dirt when the deletion fails before the document was removed', async () => {
    const discarded: PendingChange[] = [{ kind: 'stage' }, { kind: 'scene', sceneId: 'scene-1' }];
    snapshotPendingStageChangesForDeletion.mockReturnValueOnce(discarded);
    restorePendingStageChanges.mockImplementationOnce((id: string) => {
      // Ordering: the tombstone must already be lifted when the dirt is
      // re-marked, or the restore itself would be refused.
      expect(isStageDeleted(id)).toBe(false);
    });
    fakeStore.deleteDocument.mockRejectedValueOnce(new Error('locked'));

    await expect(deleteStageData(stageId)).rejects.toThrow('locked');

    // The edits the delete attempt discarded must reach durability again.
    expect(restorePendingStageChanges).toHaveBeenCalledExactlyOnceWith(stageId, discarded);
    expect(isStageDeleted(stageId)).toBe(false);
  });

  it('does not restore discarded dirt once the document is gone (tombstone stays)', async () => {
    snapshotPendingStageChangesForDeletion.mockReturnValueOnce([
      { kind: 'stage' },
    ] satisfies PendingChange[]);
    dbMock.stageOutlines.delete.mockRejectedValueOnce(new Error('partial cascade'));

    await expect(deleteStageData(stageId)).rejects.toThrow('partial cascade');

    expect(restorePendingStageChanges).not.toHaveBeenCalled();
    expect(isStageDeleted(stageId)).toBe(true);
  });
});
