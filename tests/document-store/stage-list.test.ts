import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listDocuments, listLegacyStages, readLegacyStage } = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  listLegacyStages: vi.fn(),
  readLegacyStage: vi.fn(),
}));

vi.mock('@/lib/document-store', () => ({
  getDocumentStore: () => ({ listDocuments }),
  getLegacyDocumentStore: () => ({
    listStages: listLegacyStages,
    read: readLegacyStage,
  }),
}));

vi.mock('@/lib/utils/database', () => ({ db: {} }));
vi.mock('@/lib/utils/chat-storage', () => ({
  ChatStorageLockUnavailableError: class extends Error {},
  saveChatSessions: vi.fn(),
  loadChatSessions: vi.fn(),
  deleteChatSessions: vi.fn(),
}));
vi.mock('@/lib/playback/cursor', () => ({ clearCursor: vi.fn() }));
vi.mock('@/lib/quiz/persistence', () => ({ clearAllForScene: vi.fn() }));
vi.mock('@/lib/runtime/store', () => ({ beginStageRuntimeDeletionSafely: vi.fn() }));
vi.mock('@/lib/pbl/v2/runtime/drain', () => ({ clearStageDrainWatermarks: vi.fn() }));
vi.mock('@/lib/utils/chat-storage-lock', () => ({
  withRuntimeStorageExclusiveLockUntilSettled: vi.fn(),
  withRuntimeStorageSharedLock: vi.fn(),
}));

import { listStages } from '@/lib/utils/stage-storage';

describe('legacy stage listing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDocuments.mockResolvedValue([]);
  });

  it('drops a legacy stage concurrently deleted before its snapshot read', async () => {
    listLegacyStages.mockResolvedValue([
      { id: 'ghost-stage', name: 'Ghost', createdAt: 1_000, updatedAt: 2_000 },
    ]);
    readLegacyStage.mockResolvedValue(null);

    await expect(listStages()).resolves.toEqual([]);
    expect(readLegacyStage).toHaveBeenCalledExactlyOnceWith('ghost-stage');
  });
});
