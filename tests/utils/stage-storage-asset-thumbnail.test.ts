import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accessDocument: vi.fn(),
  mediaToArray: vi.fn(),
}));

vi.mock('@/lib/document-store', () => ({
  accessDocument: mocks.accessDocument,
  clearCurrentScene: vi.fn(),
  getDocumentStore: vi.fn(),
  getLegacyDocumentStore: vi.fn(),
  loadCurrentScene: vi.fn(),
  mutateDocument: vi.fn(),
  saveCurrentScene: vi.fn(),
}));
vi.mock('@/lib/utils/database', () => ({
  db: {
    mediaFiles: {
      where: () => ({ equals: () => ({ toArray: mocks.mediaToArray }) }),
    },
  },
}));
vi.mock('@/lib/utils/chat-storage', () => ({
  ChatStorageLockUnavailableError: class extends Error {},
  saveChatSessions: vi.fn(),
  loadChatSessions: vi.fn(),
  deleteChatSessions: vi.fn(),
}));
vi.mock('@/lib/utils/chat-storage-lock', () => ({
  withRuntimeStorageSharedLock: (work: () => unknown) => work(),
  withRuntimeStorageExclusiveLockUntilSettled: (work: () => unknown) => work(),
}));
vi.mock('@/lib/playback/cursor', () => ({ clearCursor: vi.fn() }));
vi.mock('@/lib/quiz/persistence', () => ({ clearAllForScene: vi.fn() }));
vi.mock('@/lib/runtime/store', () => ({ beginStageRuntimeDeletionSafely: vi.fn() }));
vi.mock('@/lib/pbl/v2/runtime/drain', () => ({ clearStageDrainWatermarks: vi.fn() }));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: vi.fn(),
}));

import { getFirstSlideByStages } from '@/lib/utils/stage-storage';

describe('stage thumbnail allocated assets', () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:thumbnail-asset'),
      revokeObjectURL: vi.fn(),
    });
    mocks.accessDocument.mockReset().mockResolvedValue({
      document: {
        scenes: [
          {
            id: 'scene-1',
            stageId: 'stage-1',
            type: 'slide',
            title: 'Slide',
            order: 1,
            content: {
              type: 'slide',
              canvas: {
                id: 'slide-1',
                viewportSize: 1000,
                viewportRatio: 0.5625,
                elements: [
                  {
                    id: 'image-1',
                    type: 'image',
                    src: 'ast_allocated_image',
                    left: 0,
                    top: 0,
                    width: 100,
                    height: 100,
                    rotate: 0,
                    fixedRatio: true,
                  },
                ],
              },
            },
          },
        ],
      },
    });
    mocks.mediaToArray.mockReset().mockResolvedValue([
      {
        id: 'stage-1:ast_allocated_image',
        stageId: 'stage-1',
        type: 'image',
        blob: new Blob(['image'], { type: 'image/png' }),
        mimeType: 'image/png',
        size: 5,
        prompt: 'Thumbnail',
        params: '{}',
        createdAt: 1,
      },
    ]);
  });

  it('resolves an allocated ref through its same-key Dexie compatibility row', async () => {
    const slides = await getFirstSlideByStages(['stage-1']);

    expect(mocks.mediaToArray).toHaveBeenCalledOnce();
    expect(slides['stage-1'].elements[0]).toMatchObject({
      src: 'blob:thumbnail-asset',
    });
  });

  it('hydrates an allocated poster from the poster own compatibility row after reload', async () => {
    let objectUrl = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:thumbnail-${++objectUrl}`);
    mocks.accessDocument.mockResolvedValueOnce({
      document: {
        scenes: [
          {
            id: 'scene-1',
            stageId: 'stage-1',
            type: 'slide',
            title: 'Slide',
            order: 1,
            content: {
              type: 'slide',
              canvas: {
                id: 'slide-1',
                viewportSize: 1000,
                viewportRatio: 0.5625,
                elements: [
                  {
                    id: 'video-1',
                    type: 'video',
                    src: 'ast_allocated_video',
                    mediaRef: 'ast_allocated_video',
                    poster: 'ast_allocated_poster',
                    left: 0,
                    top: 0,
                    width: 100,
                    height: 56,
                    rotate: 0,
                  },
                ],
              },
            },
          },
        ],
      },
    });
    mocks.mediaToArray.mockResolvedValueOnce([
      {
        id: 'stage-1:ast_allocated_video',
        stageId: 'stage-1',
        type: 'video',
        blob: new Blob(['video'], { type: 'video/mp4' }),
        mimeType: 'video/mp4',
        size: 5,
        prompt: 'Thumbnail',
        params: '{}',
        createdAt: 1,
      },
      {
        id: 'stage-1:ast_allocated_poster',
        stageId: 'stage-1',
        type: 'image',
        blob: new Blob(['poster'], { type: 'image/jpeg' }),
        mimeType: 'image/jpeg',
        size: 6,
        prompt: 'Thumbnail',
        params: '{}',
        createdAt: 1,
      },
    ]);

    const slides = await getFirstSlideByStages(['stage-1']);

    expect(slides['stage-1'].elements[0]).toMatchObject({
      src: 'blob:thumbnail-1',
      poster: 'blob:thumbnail-2',
    });
    const posterBlob = vi.mocked(URL.createObjectURL).mock.calls[1][0] as Blob;
    expect(await posterBlob.text()).toBe('poster');
  });
});
