import { describe, expect, it, vi } from 'vitest';

const { loadChatSessions } = vi.hoisted(() => ({
  loadChatSessions: vi.fn().mockRejectedValue(new Error('runtime unavailable')),
}));

vi.mock('@/lib/document-store', () => ({
  accessDocument: vi.fn().mockResolvedValue({
    document: {
      stage: { id: 'stage-1', name: 'Persisted stage', createdAt: 1_000, updatedAt: 2_000 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          type: 'slide',
          title: 'Persisted scene',
          order: 0,
          content: { type: 'slide', canvas: {} },
        },
      ],
    },
    readOnlyLegacy: false,
  }),
  loadCurrentScene: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    stages: {
      get: vi.fn().mockResolvedValue({
        id: 'stage-1',
        name: 'Persisted stage',
        createdAt: 1_000,
        updatedAt: 2_000,
      }),
    },
    scenes: {
      where: () => ({
        equals: () => ({
          sortBy: vi.fn().mockResolvedValue([
            {
              id: 'scene-1',
              stageId: 'stage-1',
              title: 'Persisted scene',
              order: 0,
              content: { type: 'slide', canvas: {} },
            },
          ]),
        }),
      }),
    },
  },
}));
vi.mock('@/lib/utils/chat-storage', () => ({
  saveChatSessions: vi.fn(),
  loadChatSessions,
  deleteChatSessions: vi.fn(),
}));
vi.mock('@/lib/quiz/persistence', () => ({
  clearAllForScene: vi.fn(),
}));
vi.mock('@/lib/runtime/store', () => ({
  beginStageRuntimeDeletionSafely: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/runtime/drain', () => ({
  clearStageDrainWatermarks: vi.fn(),
}));

import { loadStageData } from '@/lib/utils/stage-storage';

describe('loadStageData chat failure isolation', () => {
  it('keeps persisted stage and scene data available when chat storage fails', async () => {
    await expect(loadStageData('stage-1')).resolves.toMatchObject({
      stage: { id: 'stage-1', name: 'Persisted stage' },
      scenes: [{ id: 'scene-1', type: 'slide', title: 'Persisted scene' }],
      currentSceneId: 'scene-1',
      chats: [],
      chatSnapshot: { sessions: [], restoreMarker: undefined },
    });
    expect(loadChatSessions).toHaveBeenCalledExactlyOnceWith(
      'stage-1',
      expect.objectContaining({ onSnapshot: expect.any(Function) }),
    );
  });
});
