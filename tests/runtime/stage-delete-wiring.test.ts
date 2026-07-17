import { describe, expect, it, vi } from 'vitest';

// The live classroom-deletion flow (app/page.tsx) goes through
// `deleteStageData` in stage-storage. Mock its module dependencies (the
// established pattern for database-touching code — no Dexie-in-node harness)
// and run the REAL function to prove it cascades into the runtime layer.
vi.mock('@/lib/runtime/store', () => ({
  beginStageRuntimeDeletionSafely: vi.fn(() => ({
    completion: Promise.resolve(),
    settlement: Promise.resolve(),
  })),
}));
vi.mock('@/lib/utils/database', () => ({
  db: {
    stages: { delete: vi.fn().mockResolvedValue(undefined) },
    scenes: {
      where: () => ({
        equals: () => ({
          toArray: vi.fn().mockResolvedValue([{ id: 'scene-1' }]),
          delete: vi.fn().mockResolvedValue(1),
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
vi.mock('@/lib/utils/playback-storage', () => ({
  clearPlaybackState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/quiz/persistence', () => ({
  clearAllForScene: vi.fn(),
}));
vi.mock('@/lib/utils/chat-storage-lock', () => ({
  withRuntimeStorageExclusiveLockUntilSettled: vi.fn(
    async (work: (releaseCaller: (value: unknown) => void) => Promise<unknown>) => work(() => {}),
  ),
}));

import { deleteStageData } from '@/lib/utils/stage-storage';
import { beginStageRuntimeDeletionSafely } from '@/lib/runtime/store';
import { withRuntimeStorageExclusiveLockUntilSettled } from '@/lib/utils/chat-storage-lock';

describe('deleteStageData runtime cascade', () => {
  it('cascades into the runtime store with the deleted stageId', async () => {
    await deleteStageData('stage-7');
    expect(vi.mocked(beginStageRuntimeDeletionSafely)).toHaveBeenCalledExactlyOnceWith('stage-7');
    expect(vi.mocked(withRuntimeStorageExclusiveLockUntilSettled)).toHaveBeenCalledOnce();
  });
});
