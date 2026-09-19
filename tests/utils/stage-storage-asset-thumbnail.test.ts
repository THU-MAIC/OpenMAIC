import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accessDocument: vi.fn(),
  mediaToArray: vi.fn(),
  withAssetUrl: vi.fn(async (_ref: string, fn: (url: string | null) => unknown) => fn(null)),
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
vi.mock('@/lib/media/use-asset-url', () => ({
  withAssetUrl: mocks.withAssetUrl,
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

import { getFirstSlideByStages, revokeThumbnailSlideMediaUrls } from '@/lib/utils/stage-storage';

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
    mocks.withAssetUrl.mockReset().mockImplementation(async (_ref, fn) => fn(null));
  });

  it('resolves an allocated ref through its same-key Dexie compatibility row', async () => {
    const slides = await getFirstSlideByStages(['stage-1']);

    expect(mocks.mediaToArray).toHaveBeenCalledOnce();
    expect(slides['stage-1'].elements[0]).toMatchObject({
      src: 'blob:thumbnail-asset',
    });
  });

  it('hydrates and revokes an allocated image background', async () => {
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
                background: {
                  type: 'image',
                  image: { src: 'ast_background', size: 'cover' },
                },
                elements: [],
              },
            },
          },
        ],
      },
    });
    mocks.mediaToArray.mockResolvedValueOnce([
      {
        id: 'stage-1:ast_background',
        stageId: 'stage-1',
        type: 'image',
        blob: new Blob(['background'], { type: 'image/png' }),
        mimeType: 'image/png',
        size: 10,
        prompt: 'Background',
        params: '{}',
        createdAt: 1,
      },
    ]);

    const slides = await getFirstSlideByStages(['stage-1']);

    expect(slides['stage-1'].background?.image?.src).toBe('blob:thumbnail-asset');
    revokeThumbnailSlideMediaUrls(slides);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumbnail-asset');
  });

  it('prefers replaced pool bytes over a stale compatibility row', async () => {
    mocks.withAssetUrl.mockImplementationOnce(async (_ref, fn) =>
      fn('https://pool.test/replaced-thumbnail'),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['pool-new'], { type: 'image/png' }))),
    );

    const slides = await getFirstSlideByStages(['stage-1']);

    expect(slides['stage-1'].elements[0]).toMatchObject({ src: 'blob:thumbnail-asset' });
    const hydrated = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(await hydrated.text()).toBe('pool-new');
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

  it('hydrates a legacy sequential video ref from the sole successful stage video row', async () => {
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
                    src: 'gen_vid_1',
                    mediaRef: 'gen_vid_1',
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
        id: 'stage-1:gen_vid_unique_legacy',
        stageId: 'stage-1',
        type: 'video',
        blob: new Blob(['video'], { type: 'video/mp4' }),
        mimeType: 'video/mp4',
        size: 5,
        poster: new Blob(['poster'], { type: 'image/png' }),
        prompt: 'Thumbnail',
        params: '{}',
        createdAt: 1,
      },
    ]);

    const slides = await getFirstSlideByStages(['stage-1']);

    expect(slides['stage-1'].elements[0]).toMatchObject({
      src: 'blob:thumbnail-asset',
      poster: 'blob:thumbnail-asset',
      mediaRef: 'gen_vid_1',
    });
  });

  it('does not hydrate either of two unmatched legacy videos from one stored row', async () => {
    const first = {
      id: 'video-1',
      type: 'video',
      src: 'gen_vid_1',
      mediaRef: 'gen_vid_1',
      left: 0,
      top: 0,
      width: 100,
      height: 56,
      rotate: 0,
    };
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
                  first,
                  { ...first, id: 'video-2', src: 'gen_vid_2', mediaRef: 'gen_vid_2' },
                ],
              },
            },
          },
        ],
      },
    });
    mocks.mediaToArray.mockResolvedValueOnce([
      {
        id: 'stage-1:gen_vid_unique_legacy',
        stageId: 'stage-1',
        type: 'video',
        blob: new Blob(['video'], { type: 'video/mp4' }),
        mimeType: 'video/mp4',
        size: 5,
        prompt: 'Thumbnail',
        params: '{}',
        createdAt: 1,
      },
    ]);

    const slides = await getFirstSlideByStages(['stage-1']);

    expect(slides['stage-1'].elements).toMatchObject([
      { src: '', mediaRef: 'gen_vid_1' },
      { src: '', mediaRef: 'gen_vid_2' },
    ]);
  });

  it('keeps an exact legacy video failure authoritative over another stored row', async () => {
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
                    src: 'gen_vid_1',
                    mediaRef: 'gen_vid_1',
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
        id: 'stage-1:gen_vid_1',
        stageId: 'stage-1',
        type: 'video',
        blob: new Blob([], { type: 'video/mp4' }),
        mimeType: 'video/mp4',
        size: 0,
        prompt: 'Thumbnail',
        params: '{}',
        error: 'Generation failed',
        createdAt: 1,
      },
      {
        id: 'stage-1:gen_vid_other_success',
        stageId: 'stage-1',
        type: 'video',
        blob: new Blob(['video'], { type: 'video/mp4' }),
        mimeType: 'video/mp4',
        size: 5,
        prompt: 'Thumbnail',
        params: '{}',
        createdAt: 2,
      },
    ]);

    const slides = await getFirstSlideByStages(['stage-1']);

    expect(slides['stage-1'].elements[0]).toMatchObject({
      src: '',
      mediaRef: 'gen_vid_1',
    });
  });
});
