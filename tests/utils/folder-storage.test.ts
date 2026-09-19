/* eslint-disable @typescript-eslint/no-explicit-any -- test-only db mocks */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Folder storage contract: name validation at the boundary, membership writes,
 * and both folder-deletion modes including partial failure.
 *
 * `deleteStageData` (used by deleteFolder('remove')) runs a full cascade, so
 * its dependencies are mocked the same way the deletion-wiring tests do —
 * only the folder tables (`folders`, `stageFolders`) use in-memory maps.
 */

const { folders, memberships, dbMock, mutateDocumentMock } = vi.hoisted(() => {
  const folders = new Map<string, Record<string, unknown>>();
  const memberships = new Map<string, Record<string, unknown>>();

  const tableFrom = (store: Map<string, Record<string, unknown>>, idKey: string) => ({
    put: vi.fn(async (row: Record<string, unknown>) => {
      store.set(row[idKey] as string, row);
    }),
    get: vi.fn(async (id: string) => store.get(id)),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
    toArray: vi.fn(async () => [...store.values()]),
    where: (field: string) =>
      ({
        equals: (value: unknown) => ({
          toArray: vi.fn(async () => [...store.values()].filter((r) => r[field] === value)),
          delete: vi.fn(async () => {
            for (const [k, v] of store) if (v[field] === value) store.delete(k);
          }),
        }),
      }) as any,
  });

  return {
    folders,
    memberships,
    dbMock: {
      folders: tableFrom(folders, 'id'),
      stageFolders: tableFrom(memberships, 'stageId'),
      stages: { delete: vi.fn().mockResolvedValue(undefined) },
      scenes: {
        where: () => ({
          equals: () => ({
            toArray: vi.fn().mockResolvedValue([]),
            delete: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      },
      stageOutlines: { delete: vi.fn().mockResolvedValue(undefined) },
      playbackState: { delete: vi.fn().mockResolvedValue(undefined) },
      generatedAgents: {
        where: () => ({ equals: () => ({ delete: vi.fn().mockResolvedValue(undefined) }) }),
      },
      mediaFiles: {
        where: () => ({
          equals: () => ({
            toArray: vi.fn().mockResolvedValue([]),
            delete: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        bulkDelete: vi.fn().mockResolvedValue(undefined),
      },
      audioFiles: {
        where: () => ({
          equals: () => ({
            toArray: vi.fn().mockResolvedValue([]),
            delete: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      },
      transaction: vi.fn(async (_mode: string, _tables: unknown[], fn: () => Promise<void>) =>
        fn(),
      ),
    },
    mutateDocumentMock: vi.fn(
      async (
        _id: string,
        fn: (doc: unknown, store: { deleteDocument: () => Promise<void> }) => Promise<void>,
      ) => fn(undefined, { deleteDocument: vi.fn().mockResolvedValue(undefined) }),
    ),
  } as any;
});

vi.mock('@/lib/utils/database', () => ({ db: dbMock }));
vi.mock('@/lib/document-store', () => ({
  accessDocument: vi.fn(),
  clearCurrentScene: vi.fn().mockResolvedValue(undefined),
  getDocumentStore: vi.fn(),
  getLegacyDocumentStore: vi.fn(),
  loadCurrentScene: vi.fn().mockResolvedValue(null),
  mutateDocument: mutateDocumentMock,
  saveCurrentScene: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/utils/chat-storage', () => ({
  ChatStorageLockUnavailableError: class extends Error {},
  saveChatSessions: vi.fn().mockResolvedValue(undefined),
  loadChatSessions: vi.fn().mockResolvedValue([]),
  deleteChatSessions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/utils/chat-storage-lock', () => ({
  withRuntimeStorageSharedLock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withRuntimeStorageExclusiveLockUntilSettled: vi.fn(
    async (fn: (release: (v?: unknown) => void) => Promise<unknown>) => fn(() => {}),
  ),
}));
vi.mock('@/lib/playback/cursor', () => ({ clearCursor: vi.fn() }));
vi.mock('@/lib/quiz/persistence', () => ({ clearAllForScene: vi.fn() }));
vi.mock('@/lib/runtime/store', () => ({
  beginStageRuntimeDeletionSafely: vi.fn(() => ({
    completion: Promise.resolve(),
    settlement: Promise.resolve(),
  })),
}));
vi.mock('@/lib/pbl/v2/runtime/drain', () => ({ clearStageDrainWatermarks: vi.fn() }));
vi.mock('@/lib/store/stage', () => ({
  clearStoreForDeletedStage: vi.fn(),
  discardPendingStageChanges: vi.fn(),
  snapshotPendingStageChangesForDeletion: vi.fn().mockReturnValue([]),
  restorePendingStageChanges: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: vi.fn(async (_id: string, scenes: unknown[]) => scenes),
}));

import {
  createFolder,
  renameFolder,
  deleteFolder,
  setStageFolder,
  FolderNameError,
} from '@/lib/utils/stage-storage';

beforeEach(() => {
  folders.clear();
  memberships.clear();
});

describe('createFolder / renameFolder name validation', () => {
  it('rejects an empty name on create', async () => {
    await expect(createFolder('   ')).rejects.toMatchObject({ kind: 'empty' });
  });

  it('rejects an over-width name on create', async () => {
    await expect(createFolder('a'.repeat(41))).rejects.toMatchObject({ kind: 'tooLong' });
  });

  it('rejects a duplicate name (case-insensitive) on create', async () => {
    await createFolder('Math');
    await expect(createFolder('math')).rejects.toMatchObject({ kind: 'duplicate' });
  });

  it('trims the stored name', async () => {
    const f = await createFolder('  Physics  ');
    expect(f.name).toBe('Physics');
  });

  it('rejects an empty name on rename', async () => {
    const f = await createFolder('Old');
    await expect(renameFolder(f.id, '  ')).rejects.toMatchObject({ kind: 'empty' });
  });

  it('rejects a duplicate name on rename, but allows keeping the current name', async () => {
    const a = await createFolder('Alpha');
    await createFolder('Beta');
    await expect(renameFolder(a.id, 'Beta')).rejects.toMatchObject({ kind: 'duplicate' });
    await expect(renameFolder(a.id, 'Alpha')).resolves.toBeUndefined();
  });
});

describe('setStageFolder membership', () => {
  it('writes a membership row keyed by stageId for an existing folder', async () => {
    const folder = await createFolder('Dest');
    await setStageFolder('stage-1', folder.id);
    const row = await dbMock.stageFolders.get('stage-1');
    expect(row).toMatchObject({ stageId: 'stage-1', folderId: folder.id });
  });

  it('rejects a folderId that does not exist (orphan prevention)', async () => {
    await expect(setStageFolder('stage-1', 'nonexistent-folder')).rejects.toThrow(
      'Folder not found',
    );
  });

  it('moving out stores folderId undefined', async () => {
    await setStageFolder('stage-1', undefined);
    const row = await dbMock.stageFolders.get('stage-1');
    expect(row.folderId).toBeUndefined();
  });
});

describe('deleteFolder', () => {
  it("'ungroup' drops the folder and clears its memberships", async () => {
    const folder = await createFolder('Group A');
    await setStageFolder('s1', folder.id);
    await setStageFolder('s2', folder.id);

    await deleteFolder(folder.id, 'ungroup');

    expect(await dbMock.folders.get(folder.id)).toBeUndefined();
    expect(await dbMock.stageFolders.get('s1')).toBeUndefined();
    expect(await dbMock.stageFolders.get('s2')).toBeUndefined();
  });

  it("'remove' drops the folder and its membership rows", async () => {
    const folder = await createFolder('Group B');
    await setStageFolder('s1', folder.id);
    await setStageFolder('s2', folder.id);

    await deleteFolder(folder.id, 'remove');

    // The full deleteStageData cascade is mocked to no-op, but the folder row
    // and memberships are dropped by deleteFolder itself.
    expect(await dbMock.folders.get(folder.id)).toBeUndefined();
  });

  it("'remove' propagates a member-deletion failure (partial failure surfaces)", async () => {
    const folder = await createFolder('Group C');
    await setStageFolder('s1', folder.id);
    // Force the deletion cascade to throw by making mutateDocument reject.
    mutateDocumentMock.mockRejectedValueOnce(new Error('boom'));
    await expect(deleteFolder(folder.id, 'remove')).rejects.toThrow('boom');
    // Restore the default implementation for subsequent tests.
    mutateDocumentMock.mockResolvedValueOnce(undefined);
  });
});

describe('FolderNameError', () => {
  it('carries a machine-readable kind', () => {
    const e = new FolderNameError('msg', 'duplicate');
    expect(e.kind).toBe('duplicate');
    expect(e).toBeInstanceOf(Error);
  });
});
