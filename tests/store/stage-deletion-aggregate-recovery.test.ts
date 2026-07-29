import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Failed-deletion recovery for content that only ever lived in a direct
 * aggregate save.
 *
 * A `saveToStorage` call (generation completion, server-restore hydration) is
 * tracked in neither the pending map nor a flush round, so the deletion
 * snapshot cannot describe it. When a deletion bumps the epoch while such a
 * save is in flight, the save is fenced (`'stale-dropped'`); if the deletion
 * then fails before removing the document, the memory state is newer than
 * storage with no descriptor anywhere to retry from — the recovery must
 * re-mark the full aggregate so the next flush recaptures the current store
 * state and lands it. These tests drive the REAL store scheduler and the REAL
 * storage layer end to end (only the device stores underneath are mocked).
 */

const { fakeStore, dbMock, prepareMock } = vi.hoisted(() => {
  const fakeStore = {
    saveDocument: vi.fn().mockResolvedValue(undefined),
    putScene: vi.fn().mockResolvedValue(undefined),
    putStage: vi.fn().mockResolvedValue(undefined),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
  };
  const dbMock = {
    stages: { delete: vi.fn().mockResolvedValue(undefined) },
    scenes: {
      where: () => ({
        equals: () => ({
          toArray: vi.fn().mockResolvedValue([]),
          delete: vi.fn().mockResolvedValue(0),
        }),
      }),
    },
    stageOutlines: { delete: vi.fn().mockResolvedValue(undefined) },
    playbackState: { delete: vi.fn().mockResolvedValue(undefined) },
    generatedAgents: {
      where: () => ({
        equals: () => ({ delete: vi.fn().mockResolvedValue(0) }),
      }),
    },
    transaction: vi.fn(async (_mode: string, _tables: unknown[], fn: () => Promise<void>) => fn()),
  };
  return {
    fakeStore,
    dbMock,
    prepareMock: vi.fn(),
  };
});

vi.mock('@/lib/document-store', () => ({
  accessDocument: vi.fn(),
  clearCurrentScene: vi.fn().mockResolvedValue(undefined),
  getDocumentStore: vi.fn(),
  getLegacyDocumentStore: vi.fn(),
  loadCurrentScene: vi.fn().mockResolvedValue(null),
  mutateDocument: vi.fn(
    async (
      _stageId: string,
      callback: (existing: undefined, store: typeof fakeStore) => Promise<unknown>,
    ) => callback(undefined, fakeStore),
  ),
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
  preparePBLScenesForDocumentPersistence: prepareMock,
}));
vi.mock('@/lib/pbl/v2/runtime/hydration', () => ({
  hydratePBLScenesFromRuntime: vi.fn(async (_stageId: string, scenes: unknown[]) => scenes),
}));

import {
  flushStageSave,
  snapshotPendingStageChangesForDeletion,
  useStageStore,
} from '@/lib/store/stage';
import { deleteStageData } from '@/lib/utils/stage-storage';
import { isStageDeleted, unmarkStageDeleted } from '@/lib/utils/deleted-stages';
import { saveCurrentScene } from '@/lib/document-store';
import type { Scene, Stage } from '@/lib/types/stage';

let stageCounter = 0;
let stageId: string;

function makeStage(id: string): Stage {
  return { id, name: 'Recoverable', createdAt: 1, updatedAt: 1 };
}

function makeScene(id: string, stageId: string, title = id): Scene {
  return {
    id,
    stageId,
    type: 'text',
    title,
    order: 1,
    content: { type: 'text', markdown: id },
  } as unknown as Scene;
}

beforeEach(() => {
  vi.clearAllMocks();
  prepareMock.mockImplementation(async (_stageId: string, scenes: Scene[]) => scenes);
  // Fresh id per test: deletion epochs are session-scoped module state.
  stageCounter += 1;
  stageId = `stage-agg-${stageCounter}`;
  useStageStore.getState().clearStore();
  useStageStore.setState({
    stage: makeStage(stageId),
    scenes: [makeScene('scene-1', stageId)],
    currentSceneId: 'scene-1',
    chats: [],
    outlines: [],
    generationComplete: false,
  });
});

afterEach(() => {
  useStageStore.getState().clearStore();
  unmarkStageDeleted(stageId);
});

describe('failed-deletion recovery of direct aggregate saves', () => {
  it('re-persists a fenced in-flight aggregate save after the deletion fails before removing the document', async () => {
    // The aggregate save is mid-flight (parked in scene preparation, epoch
    // already captured) when the deletion starts. Nothing about it is in the
    // pending map or a flush round.
    let releasePrepare!: () => void;
    prepareMock.mockImplementationOnce(async (_stageId: string, scenes: Scene[]) => {
      await new Promise<void>((resolve) => {
        releasePrepare = resolve;
      });
      return scenes;
    });
    // The setGenerationComplete path: flag flips in memory, then a direct
    // aggregate save carries it (completion barrier and scenes together).
    useStageStore.setState({ generationComplete: true });
    const inFlightSave = useStageStore.getState().saveToStorage();

    // The deletion fails before deleteDocument removed anything; its failure
    // path lifts the flag and runs the recovery re-mark.
    fakeStore.deleteDocument.mockRejectedValueOnce(new Error('delete failed'));
    await expect(deleteStageData(stageId)).rejects.toThrow('delete failed');
    expect(isStageDeleted(stageId)).toBe(false);

    // The released save walks into the real epoch fence and drops.
    releasePrepare();
    await expect(inFlightSave).resolves.toBe(false);
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();

    // Recovery: the re-marked aggregate flushes the CURRENT store state under
    // the CURRENT epoch, so the fenced save's content becomes durable.
    await flushStageSave();
    expect(fakeStore.saveDocument).toHaveBeenCalledOnce();
    const [savedDocument] = fakeStore.saveDocument.mock.calls[0]! as [
      { stage: Stage; scenes: Scene[]; outline: { generationComplete?: boolean } },
    ];
    expect(savedDocument.stage.id).toBe(stageId);
    expect(savedDocument.outline.generationComplete).toBe(true);
    expect(savedDocument.scenes.map((scene) => scene.id)).toEqual(['scene-1']);
    // The re-mark spans the whole aggregate: the cursor tail flushes too.
    expect(saveCurrentScene).toHaveBeenCalledWith(stageId, 'scene-1');
  });

  it('re-persists an edit refused during the deletion window after the deletion fails', async () => {
    // Edits inside the deletion window are refused by the scheduler and are
    // in no snapshot; they live only in the store state. The full-aggregate
    // re-mark recaptures that state, so they reach durability with it.
    let rejectDelete!: (error: Error) => void;
    fakeStore.deleteDocument.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectDelete = reject;
        }),
    );
    const deletion = deleteStageData(stageId);
    await vi.waitFor(() => expect(fakeStore.deleteDocument).toHaveBeenCalled());

    useStageStore.getState().updateScene('scene-1', { title: 'edited during deletion' });

    rejectDelete(new Error('delete failed'));
    await expect(deletion).rejects.toThrow('delete failed');
    expect(isStageDeleted(stageId)).toBe(false);

    await flushStageSave();
    expect(fakeStore.saveDocument).toHaveBeenCalledOnce();
    const [savedDocument] = fakeStore.saveDocument.mock.calls[0]! as [{ scenes: Scene[] }];
    expect(savedDocument.scenes[0]?.title).toBe('edited during deletion');
  });

  it('does not re-mark anything when the deletion succeeds (control)', async () => {
    useStageStore.setState({ generationComplete: true });

    await deleteStageData(stageId);

    // Success path: the store is evicted, nothing is queued, and no later
    // flush resurrects the deleted document.
    expect(useStageStore.getState().stage).toBeNull();
    expect(snapshotPendingStageChangesForDeletion(stageId)).toEqual([]);
    await flushStageSave();
    expect(fakeStore.saveDocument).not.toHaveBeenCalled();
    expect(fakeStore.putStage).not.toHaveBeenCalled();
    expect(fakeStore.putScene).not.toHaveBeenCalled();
    expect(saveCurrentScene).not.toHaveBeenCalled();
  });
});
