import { describe, expect, it, vi } from 'vitest';

const { clearCursor, deleteLegacyPlaybackRow } = vi.hoisted(() => ({
  clearCursor: vi.fn().mockResolvedValue(undefined),
  deleteLegacyPlaybackRow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/playback/cursor', () => ({ clearCursor }));
vi.mock('@/lib/document-store', () => ({
  clearCurrentScene: vi.fn().mockResolvedValue(undefined),
  mutateDocument: vi.fn(async (_stageId, work) =>
    work(null, { deleteDocument: vi.fn().mockResolvedValue(undefined) }),
  ),
  getDocumentStore: vi.fn(() => ({
    loadDocument: vi.fn().mockResolvedValue(null),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('@/lib/runtime/store', () => ({
  beginStageRuntimeDeletionSafely: vi.fn(() => ({
    completion: Promise.resolve(),
    settlement: Promise.resolve(),
  })),
}));
vi.mock('@/lib/utils/database', () => ({
  db: {
    transaction: vi.fn(async (_mode, _tables, work) => work()),
    stages: { delete: vi.fn().mockResolvedValue(undefined) },
    stageOutlines: { delete: vi.fn().mockResolvedValue(undefined) },
    playbackState: { delete: deleteLegacyPlaybackRow },
    scenes: {
      where: () => ({
        equals: () => ({
          toArray: vi.fn().mockResolvedValue([]),
          delete: vi.fn().mockResolvedValue(0),
        }),
      }),
    },
  },
}));
vi.mock('@/lib/utils/chat-storage', () => ({
  saveChatSessions: vi.fn(),
  loadChatSessions: vi.fn(),
  deleteChatSessions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/quiz/persistence', () => ({ clearAllForScene: vi.fn() }));
vi.mock('@/lib/pbl/v2/runtime/drain', () => ({
  clearStageDrainWatermarks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/utils/chat-storage-lock', () => ({
  withRuntimeStorageExclusiveLockUntilSettled: vi.fn(
    async (work: (releaseCaller: (value: unknown) => void) => Promise<unknown>) => work(() => {}),
  ),
  withRuntimeStorageSharedLock: vi.fn(),
}));

import { deleteStageData } from '@/lib/utils/stage-storage';

describe('stage deletion playback cleanup', () => {
  it('clears the device-scoped playback cursor', async () => {
    await deleteStageData('stage-delete');
    expect(clearCursor).toHaveBeenCalledExactlyOnceWith('stage-delete');
    expect(deleteLegacyPlaybackRow).toHaveBeenCalledExactlyOnceWith('stage-delete');
  });
});
