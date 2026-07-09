import { describe, expect, it, vi } from 'vitest';

// The live classroom-deletion flow (app/page.tsx) goes through
// `deleteStageData` in stage-storage. Mock its module dependencies (the
// established pattern for database-touching code — no Dexie-in-node harness)
// and run the REAL function to prove it cascades into the runtime layer.
vi.mock('@/lib/runtime/store', () => ({
  deleteStageRuntimeSafely: vi.fn().mockResolvedValue(undefined),
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

import { deleteStageData } from '@/lib/utils/stage-storage';
import { deleteStageRuntimeSafely } from '@/lib/runtime/store';

describe('deleteStageData runtime cascade', () => {
  it('cascades into the runtime store with the deleted stageId', async () => {
    await deleteStageData('stage-7');
    expect(vi.mocked(deleteStageRuntimeSafely)).toHaveBeenCalledExactlyOnceWith('stage-7');
  });
});
