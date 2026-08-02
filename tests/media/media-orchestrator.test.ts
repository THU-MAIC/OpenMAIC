import { IDBFactory } from 'fake-indexeddb';
import { BrowserAssetStore } from '@openmaic/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaTask } from '@/lib/store/media-generation';
import type { Scene, Stage } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  mediaPut: vi.fn(),
  mediaGet: vi.fn(),
  mediaDelete: vi.fn(),
  getPool: vi.fn(),
  document: null as ReturnType<typeof documentWithMedia> | null,
  stageState: { stage: null, scenes: [] } as {
    stage: ReturnType<typeof documentWithMedia>['stage'] | null;
    scenes: ReturnType<typeof documentWithMedia>['scenes'];
  },
  stageSetState: vi.fn(),
  markStagePersistenceDirty: vi.fn(),
  beforeDocumentWork: vi.fn(),
  accessDocument: vi.fn(),
  mediaRows: new Map<string, { id: string; blob: Blob; error?: string }>(),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settings },
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    mediaFiles: {
      put: mocks.mediaPut,
      get: mocks.mediaGet,
      delete: mocks.mediaDelete,
    },
  },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  getAssetPool: mocks.getPool,
  putAsset: (...args: unknown[]) => mocks.getPool().put(...args),
  replaceAsset: (...args: unknown[]) => mocks.getPool().replace(...args),
  removeAsset: (...args: unknown[]) => mocks.getPool().remove(...args),
}));

vi.mock('@/lib/document-store', () => ({
  accessDocument: mocks.accessDocument,
  mutateDocument: async (
    _stageId: string,
    work: (document: unknown, store: { saveDocument: (next: unknown) => Promise<void> }) => unknown,
  ) => (
    mocks.beforeDocumentWork(),
    work(mocks.document, {
      saveDocument: async (next) => {
        mocks.document = structuredClone(next) as ReturnType<typeof documentWithMedia>;
      },
    })
  ),
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: {
    getState: () => mocks.stageState,
    setState: mocks.stageSetState,
  },
  markStagePersistenceDirty: mocks.markStagePersistenceDirty,
}));

import {
  generateMediaForOutlines,
  reconcileCompletedMediaForScene,
  retryMediaTask,
} from '@/lib/media/media-orchestrator';
import { buildRestoredMediaTasks } from '@/lib/classroom/load-classroom';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { markStageDeleted, unmarkStageDeleted } from '@/lib/utils/deleted-stages';
import { expectDocumentAssetOwnership } from './assert-stage-asset-ownership';

const stageId = 'stage-write-path';
const placeholder = 'gen_vid_1';

function documentWithMedia(ref = placeholder, type: 'image' | 'video' = 'video') {
  const element: {
    id: string;
    type: 'image' | 'video';
    left: number;
    top: number;
    width: number;
    height: number;
    rotate: number;
    src: string;
    mediaRef?: string;
    poster?: string;
    autoplay?: boolean;
    fixedRatio?: boolean;
  } =
    type === 'video'
      ? {
          id: 'video-1',
          type: 'video',
          left: 0,
          top: 0,
          width: 100,
          height: 56,
          rotate: 0,
          src: ref,
          mediaRef: ref,
          autoplay: false,
        }
      : {
          id: 'image-1',
          type: 'image',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
          rotate: 0,
          fixedRatio: true,
          src: ref,
        };
  return {
    dslVersion: 1,
    stage: {
      id: stageId,
      name: 'Write paths',
      createdAt: 1,
      updatedAt: 1,
      ...(type === 'video'
        ? { videoManifest: { [ref]: { type: 'video', prompt: 'A short clip' } } }
        : {}),
    },
    scenes: [
      {
        id: 'scene-1',
        stageId,
        title: 'Scene',
        order: 1,
        type: 'slide',
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            background: { type: 'solid', color: '#fff' },
            theme: {
              fontName: 'Arial',
              fontColor: '#111',
              backgroundColor: '#fff',
              themeColors: ['#111'],
            },
            elements: [element],
          },
        },
      },
    ],
  };
}

function failedTask(ref: string, type: 'image' | 'video' = 'image'): MediaTask {
  return {
    elementId: ref,
    type,
    status: 'failed',
    prompt: type === 'image' ? 'A new image' : 'A short clip',
    params: { aspectRatio: '16:9' },
    retryCount: 0,
    stageId,
    error: 'retry me',
  };
}

describe('media orchestrator asset write paths', () => {
  let pool: BrowserAssetStore;
  let objectUrls: Map<string, Blob>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pool = new BrowserAssetStore({
      indexedDB: new IDBFactory(),
      dbName: `orchestrator-${crypto.randomUUID()}`,
    });
    mocks.getPool.mockReset();
    mocks.getPool.mockReturnValue(pool);
    mocks.mediaRows.clear();
    mocks.mediaPut.mockReset().mockImplementation(async (row) => {
      mocks.mediaRows.set(row.id, row);
    });
    mocks.mediaGet.mockReset().mockImplementation(async (id) => mocks.mediaRows.get(id));
    mocks.mediaDelete.mockReset().mockImplementation(async (id) => {
      mocks.mediaRows.delete(id);
    });
    mocks.stageSetState.mockReset();
    mocks.markStagePersistenceDirty.mockReset();
    mocks.beforeDocumentWork.mockReset();
    mocks.accessDocument.mockReset().mockImplementation(async () => ({
      document: mocks.document,
      readOnlyLegacy: false,
    }));
    mocks.stageState = { stage: null, scenes: [] };
    mocks.settings.mockReset().mockReturnValue({
      imageGenerationEnabled: true,
      videoGenerationEnabled: true,
      imageProviderId: 'image-provider',
      imageModelId: 'image-model',
      imageProvidersConfig: {},
      videoProviderId: 'video-provider',
      videoModelId: 'video-model',
      videoProvidersConfig: {},
    });
    useMediaGenerationStore.setState({ tasks: {} });

    objectUrls = new Map();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        const url = `blob:test-${objectUrls.size + 1}`;
        objectUrls.set(url, blob);
        return url;
      }),
      revokeObjectURL: vi.fn(),
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await pool.close();
    vi.unstubAllGlobals();
  });

  function serveVideo(bytes = 'video-new') {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/generate/video') {
        return new Response(
          JSON.stringify({
            success: true,
            result: {
              url: 'https://media.test/video',
              poster: 'https://media.test/poster',
              width: 1280,
              height: 720,
              duration: 5,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (input === '/api/proxy-media') {
        const requested = JSON.parse(String(init?.body)).url as string;
        return requested.endsWith('/poster')
          ? new Response(new Blob(['poster-new'], { type: 'image/jpeg' }), { status: 200 })
          : new Response(new Blob([bytes], { type: 'video/mp4' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });
  }

  function serveImage(bytes = 'image-new') {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/api/generate/image') {
        return new Response(
          JSON.stringify({
            success: true,
            result: { url: 'https://media.test/image', width: 1024, height: 576 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (input === '/api/proxy-media') {
        return new Response(new Blob([bytes], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });
  }

  async function resolvedText(ref: string): Promise<string | null> {
    const url = await pool.resolve(ref);
    return url ? ((await objectUrls.get(url)?.text()) ?? null) : null;
  }

  async function assertOwnership(): Promise<void> {
    if (!mocks.document) throw new Error('Expected a document');
    await expectDocumentAssetOwnership({
      document: mocks.document as unknown as Parameters<
        typeof expectDocumentAssetOwnership
      >[0]['document'],
      mediaRowIds: new Set(mocks.mediaRows.keys()),
      audioRowIds: new Set(),
      poolHas: async (ref) => {
        const url = await pool.resolve(ref);
        if (!url) return false;
        await pool.release(ref);
        return true;
      },
    });
  }

  it('converges when the scene is inserted before media completes', async () => {
    mocks.document = documentWithMedia();
    const put = vi.spyOn(pool, 'put');
    serveVideo();

    await generateMediaForOutlines(
      [
        {
          id: 'outline-1',
          type: 'slide',
          title: 'Scene',
          description: 'Scene',
          keyPoints: ['video'],
          order: 1,
          mediaGenerations: [
            { type: 'video', prompt: 'A short clip', elementId: placeholder, aspectRatio: '16:9' },
          ],
        },
      ],
      stageId,
    );

    const element = mocks.document.scenes[0].content.canvas.elements[0];
    const assetId = element.mediaRef as string;
    const posterAssetId = element.poster;
    expect(assetId).toMatch(/^ast_/);
    expect(element.src).toBe(assetId);
    expect(posterAssetId).toMatch(/^ast_/);
    expect(mocks.document.stage.videoManifest).toEqual({
      [assetId]: { type: 'video', prompt: 'A short clip' },
    });
    expect(await resolvedText(assetId)).toBe('video-new');
    expect(await resolvedText(posterAssetId as string)).toBe('poster-new');
    expect(put).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({
        contentType: 'video/mp4',
        prompt: 'A short clip',
        dimensions: { width: 1280, height: 720 },
        duration: 5,
      }),
    );
    expect(mocks.mediaPut).toHaveBeenCalledWith(
      expect.objectContaining({ id: `${stageId}:${assetId}`, stageId, type: 'video' }),
    );
    expect(mocks.mediaPut).toHaveBeenCalledWith(
      expect.objectContaining({ id: `${stageId}:${posterAssetId}`, stageId, type: 'image' }),
    );
    expect(useMediaGenerationStore.getState().tasks[placeholder]).toBeUndefined();
    expect(useMediaGenerationStore.getState().tasks[assetId]).toMatchObject({
      elementId: assetId,
      status: 'done',
    });
    await assertOwnership();
  });

  it('converges when media completes before the generated scene is inserted', async () => {
    const pendingDocument = documentWithMedia(placeholder, 'video');
    const lateScene = structuredClone(pendingDocument.scenes[0]);
    pendingDocument.scenes = [];
    mocks.document = pendingDocument;
    serveVideo('early-media');

    await generateMediaForOutlines(
      [
        {
          id: 'outline-1',
          type: 'slide',
          title: 'Scene',
          description: 'Scene',
          keyPoints: ['video'],
          order: 1,
          mediaGenerations: [
            { type: 'video', prompt: 'A short clip', elementId: placeholder, aspectRatio: '16:9' },
          ],
        },
      ],
      stageId,
    );

    const completed = Object.values(useMediaGenerationStore.getState().tasks)[0];
    expect(completed).toMatchObject({
      status: 'done',
      placeholderRef: placeholder,
      elementId: expect.stringMatching(/^ast_/),
    });
    const reconciled = reconcileCompletedMediaForScene(
      lateScene as unknown as Scene,
      pendingDocument.stage as unknown as Stage,
      useMediaGenerationStore.getState().tasks,
    );
    mocks.document = {
      ...pendingDocument,
      stage: reconciled.stage,
      scenes: [reconciled.scene],
    } as unknown as ReturnType<typeof documentWithMedia>;

    const insertedDocument = mocks.document;
    if (!insertedDocument) throw new Error('Expected the reconciled document');
    const insertedRef = insertedDocument.scenes[0].content.canvas.elements[0].src;
    expect(insertedRef).toBe(completed.elementId);
    expect(insertedDocument.scenes[0].content.canvas.elements[0].poster).toBe(
      completed.posterAssetId,
    );
    expect(insertedDocument.stage.videoManifest).toEqual({
      [completed.elementId]: { type: 'video', prompt: 'A short clip' },
    });
    expect(await resolvedText(completed.elementId)).toBe('early-media');
    expect(mocks.mediaPut).toHaveBeenCalledWith(
      expect.objectContaining({ id: `${stageId}:${completed.elementId}` }),
    );
  });

  it('makes zero API calls and zero allocations when a restored document no longer owns the placeholder', async () => {
    const assetId = await pool.put(new Blob(['persisted-image'], { type: 'image/png' }));
    const put = vi.spyOn(pool, 'put');
    put.mockClear();
    mocks.document = documentWithMedia(assetId, 'image');
    useMediaGenerationStore.setState({
      tasks: buildRestoredMediaTasks(stageId, [
        {
          id: `${stageId}:${assetId}`,
          stageId,
          placeholderRef: placeholder,
          type: 'image',
          blob: new Blob(['persisted-image'], { type: 'image/png' }),
          mimeType: 'image/png',
          size: 15,
          prompt: 'A new image',
          params: '{}',
          createdAt: 1,
        },
      ]),
    });

    await generateMediaForOutlines(
      [
        {
          id: 'outline-1',
          type: 'slide',
          title: 'Scene',
          description: 'Scene',
          keyPoints: ['image'],
          order: 1,
          mediaGenerations: [{ type: 'image', prompt: 'A new image', elementId: placeholder }],
        },
      ],
      stageId,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(mocks.document.scenes[0].content.canvas.elements[0].src).toBe(assetId);
  });

  it('runs a final document reconciliation when a scene lands after task re-keying', async () => {
    const pendingDocument = documentWithMedia(placeholder, 'video');
    const lateScene = structuredClone(pendingDocument.scenes[0]);
    pendingDocument.scenes = [];
    mocks.document = pendingDocument;
    serveVideo('late-window-media');
    let documentScans = 0;
    mocks.beforeDocumentWork.mockImplementation(() => {
      documentScans += 1;
      if (documentScans !== 2 || !mocks.document) return;
      const completed = Object.values(useMediaGenerationStore.getState().tasks)[0];
      expect(completed).toMatchObject({ status: 'done', placeholderRef: placeholder });
      mocks.document.scenes = [lateScene];
    });

    await generateMediaForOutlines(
      [
        {
          id: 'outline-1',
          type: 'slide',
          title: 'Scene',
          description: 'Scene',
          keyPoints: ['video'],
          order: 1,
          mediaGenerations: [
            { type: 'video', prompt: 'A short clip', elementId: placeholder, aspectRatio: '16:9' },
          ],
        },
      ],
      stageId,
    );

    const completed = Object.values(useMediaGenerationStore.getState().tasks)[0];
    expect(mocks.document.scenes[0].content.canvas.elements[0]).toMatchObject({
      src: completed.elementId,
      mediaRef: completed.elementId,
      poster: completed.posterAssetId,
    });
  });

  it('leaves the document and Dexie untouched when pool allocation fails', async () => {
    mocks.document = documentWithMedia(placeholder, 'image');
    const before = structuredClone(mocks.document);
    serveImage();
    mocks.getPool.mockReturnValueOnce({
      put: vi.fn().mockRejectedValue(new Error('pool write failed')),
    });

    await generateMediaForOutlines(
      [
        {
          id: 'outline-1',
          type: 'slide',
          title: 'Scene',
          description: 'Scene',
          keyPoints: ['image'],
          order: 1,
          mediaGenerations: [{ type: 'image', prompt: 'A new image', elementId: placeholder }],
        },
      ],
      stageId,
    );

    expect(mocks.document).toEqual(before);
    expect(mocks.mediaPut).not.toHaveBeenCalled();
    expect(useMediaGenerationStore.getState().tasks[placeholder]?.status).toBe('failed');
  });

  it('rolls back every fresh pool allocation when generation fails before document commit', async () => {
    mocks.document = documentWithMedia(placeholder, 'video');
    serveVideo('uncommitted-video');
    const put = vi.spyOn(pool, 'put');
    mocks.mediaPut.mockRejectedValueOnce(new Error('compatibility write failed'));

    await generateMediaForOutlines(
      [
        {
          id: 'outline-1',
          type: 'slide',
          title: 'Scene',
          description: 'Scene',
          keyPoints: ['video'],
          order: 1,
          mediaGenerations: [
            { type: 'video', prompt: 'A short clip', elementId: placeholder, aspectRatio: '16:9' },
          ],
        },
      ],
      stageId,
    );

    const allocated = await Promise.all(put.mock.results.map((result) => result.value));
    expect(allocated).toHaveLength(2);
    for (const ref of allocated) expect(await pool.resolve(ref)).toBeNull();
    expect(mocks.mediaRows.size).toBe(0);
    expect(mocks.document.scenes[0].content.canvas.elements[0].src).toBe(placeholder);
  });

  it('replaces allocated media bytes without changing the document reference', async () => {
    const assetId = await pool.put(new Blob(['image-old'], { type: 'image/png' }));
    mocks.document = documentWithMedia(assetId, 'image');
    const before = structuredClone(mocks.document);
    const replace = vi.spyOn(pool, 'replace');
    const release = vi.spyOn(pool, 'release');
    serveImage('image-replaced');
    useMediaGenerationStore.setState({ tasks: { [assetId]: failedTask(assetId) } });

    await retryMediaTask(assetId);

    expect(replace).toHaveBeenCalledWith(
      assetId,
      expect.any(Blob),
      expect.objectContaining({
        prompt: 'A new image',
        dimensions: { width: 1024, height: 576 },
      }),
    );
    expect(release).toHaveBeenCalledWith(assetId);
    expect(await resolvedText(assetId)).toBe('image-replaced');
    expect(mocks.document).toEqual(before);
    expect(mocks.mediaDelete).not.toHaveBeenCalled();
    expect(mocks.mediaPut).toHaveBeenCalledWith(
      expect.objectContaining({ id: `${stageId}:${assetId}` }),
    );
    expect(useMediaGenerationStore.getState().tasks[assetId]?.status).toBe('done');
    await assertOwnership();
  });

  it('replaces an allocated video and its referenced poster without rewriting the document', async () => {
    const assetId = await pool.put(new Blob(['video-old'], { type: 'video/mp4' }));
    const posterAssetId = await pool.put(new Blob(['poster-old'], { type: 'image/jpeg' }));
    mocks.document = documentWithMedia(assetId, 'video');
    mocks.document.scenes[0].content.canvas.elements[0].poster = posterAssetId;
    mocks.stageState = {
      stage: structuredClone(mocks.document.stage),
      scenes: structuredClone(mocks.document.scenes),
    };
    const before = structuredClone(mocks.document);
    serveVideo('video-replaced');
    useMediaGenerationStore.setState({
      tasks: { [assetId]: failedTask(assetId, 'video') },
    });

    await retryMediaTask(assetId);

    expect(await resolvedText(assetId)).toBe('video-replaced');
    expect(await resolvedText(posterAssetId)).toBe('poster-new');
    expect(mocks.document).toEqual(before);
    expect(mocks.mediaPut).toHaveBeenCalledWith(
      expect.objectContaining({ id: `${stageId}:${assetId}`, poster: expect.any(Blob) }),
    );
    await assertOwnership();
  });

  it('upgrades a legacy retry through the allocating path', async () => {
    mocks.document = documentWithMedia(placeholder, 'image');
    const put = vi.spyOn(pool, 'put');
    const replace = vi.spyOn(pool, 'replace');
    serveImage('legacy-upgraded');
    useMediaGenerationStore.setState({ tasks: { [placeholder]: failedTask(placeholder) } });
    mocks.mediaRows.set(`${stageId}:${placeholder}`, {
      id: `${stageId}:${placeholder}`,
      blob: new Blob(),
      error: 'legacy failure',
    });

    await retryMediaTask(placeholder);

    const assetId = mocks.document.scenes[0].content.canvas.elements[0].src as string;
    expect(assetId).toMatch(/^ast_/);
    expect(put).toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(mocks.mediaDelete).toHaveBeenCalledWith(`${stageId}:${placeholder}`);
    expect(await resolvedText(assetId)).toBe('legacy-upgraded');
    await assertOwnership();
  });

  it('forks a duplicated media ref on targeted regeneration', async () => {
    const sharedAssetId = await pool.put(new Blob(['original-bytes'], { type: 'image/png' }));
    mocks.document = documentWithMedia(sharedAssetId, 'image');
    const copy = structuredClone(mocks.document.scenes[0]);
    copy.id = 'scene-copy';
    copy.order = 2;
    copy.content.canvas.id = 'slide-copy';
    copy.content.canvas.elements[0].id = 'image-copy';
    mocks.document.scenes.push(copy);
    mocks.stageState = {
      stage: structuredClone(mocks.document.stage),
      scenes: structuredClone(mocks.document.scenes),
    };
    useMediaGenerationStore.setState({
      tasks: { [sharedAssetId]: failedTask(sharedAssetId) },
    });
    serveImage('copy-bytes');

    mocks.mediaRows.set(`${stageId}:${sharedAssetId}`, {
      id: `${stageId}:${sharedAssetId}`,
      blob: new Blob(['original-bytes'], { type: 'image/png' }),
    });
    await retryMediaTask(sharedAssetId, {
      elementId: 'image-copy',
      sceneId: 'scene-copy',
      slideId: 'slide-copy',
    });

    const [originalScene, copiedScene] = mocks.document.scenes;
    const originalRef = originalScene.content.canvas.elements[0].src;
    const copiedRef = copiedScene.content.canvas.elements[0].src;
    expect(originalRef).toBe(sharedAssetId);
    expect(copiedRef).toMatch(/^ast_/);
    expect(copiedRef).not.toBe(sharedAssetId);
    expect(await resolvedText(originalRef)).toBe('original-bytes');
    expect(await resolvedText(copiedRef)).toBe('copy-bytes');
    expect(mocks.mediaRows.has(`${stageId}:${sharedAssetId}`)).toBe(true);
    expect(useMediaGenerationStore.getState().tasks[copiedRef]?.placeholderRef).toBeUndefined();
    await assertOwnership();
  });

  it('scopes a shared retry to the scene and slide when element ids recur', async () => {
    const sharedAssetId = await pool.put(new Blob(['original-bytes'], { type: 'image/png' }));
    mocks.document = documentWithMedia(sharedAssetId, 'image');
    mocks.document.scenes[0].content.canvas.elements[0].id = 'repeated-image';
    const copy = structuredClone(mocks.document.scenes[0]);
    copy.id = 'scene-copy';
    copy.order = 2;
    copy.content.canvas.id = 'slide-copy';
    mocks.document.scenes.push(copy);
    mocks.stageState = {
      stage: structuredClone(mocks.document.stage),
      scenes: structuredClone(mocks.document.scenes),
    };
    mocks.mediaRows.set(`${stageId}:${sharedAssetId}`, {
      id: `${stageId}:${sharedAssetId}`,
      blob: new Blob(['original-bytes'], { type: 'image/png' }),
    });
    useMediaGenerationStore.setState({ tasks: { [sharedAssetId]: failedTask(sharedAssetId) } });
    serveImage('scoped-copy');

    await retryMediaTask(sharedAssetId, {
      elementId: 'repeated-image',
      sceneId: 'scene-copy',
      slideId: 'slide-copy',
    });

    expect(mocks.document.scenes[0].content.canvas.elements[0].src).toBe(sharedAssetId);
    expect(mocks.document.scenes[1].content.canvas.elements[0].src).not.toBe(sharedAssetId);
    await assertOwnership();
  });

  it('refuses to fork a shared ref without the owning slide instance', async () => {
    const sharedAssetId = await pool.put(new Blob(['original-bytes'], { type: 'image/png' }));
    mocks.document = documentWithMedia(sharedAssetId, 'image');
    const copy = structuredClone(mocks.document.scenes[0]);
    copy.id = 'scene-copy';
    copy.order = 2;
    copy.content.canvas.id = 'slide-copy';
    mocks.document.scenes.push(copy);
    mocks.stageState = {
      stage: structuredClone(mocks.document.stage),
      scenes: structuredClone(mocks.document.scenes),
    };
    mocks.mediaRows.set(`${stageId}:${sharedAssetId}`, {
      id: `${stageId}:${sharedAssetId}`,
      blob: new Blob(['original-bytes'], { type: 'image/png' }),
    });
    useMediaGenerationStore.setState({ tasks: { [sharedAssetId]: failedTask(sharedAssetId) } });

    await retryMediaTask(sharedAssetId, {
      elementId: mocks.document.scenes[0].content.canvas.elements[0].id,
      sceneId: mocks.document.scenes[0].id,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.document.scenes[0].content.canvas.elements[0].src).toBe(sharedAssetId);
    expect(mocks.document.scenes[1].content.canvas.elements[0].src).toBe(sharedAssetId);
    await assertOwnership();
  });

  it('keeps first-commit bytes when the second reconciliation fails', async () => {
    mocks.document = documentWithMedia(placeholder, 'image');
    serveImage('committed-before-reconciliation-failure');
    let documentWrites = 0;
    mocks.beforeDocumentWork.mockImplementation(() => {
      documentWrites += 1;
      if (documentWrites === 2) throw new Error('second reconciliation failed');
    });

    await generateMediaForOutlines(
      [
        {
          id: 'outline-1',
          type: 'slide',
          title: 'Scene',
          description: 'Scene',
          keyPoints: ['image'],
          order: 1,
          mediaGenerations: [{ type: 'image', prompt: 'A new image', elementId: placeholder }],
        },
      ],
      stageId,
    );

    const committedRef = mocks.document.scenes[0].content.canvas.elements[0].src;
    expect(committedRef).toMatch(/^ast_/);
    expect(await resolvedText(committedRef)).toBe('committed-before-reconciliation-failure');
    await assertOwnership();
  });

  it('falls back to task-based resume filtering when legacy document access is locked', async () => {
    mocks.document = documentWithMedia(placeholder, 'image');
    mocks.accessDocument.mockRejectedValueOnce(new Error('legacy lock unavailable'));
    serveImage('generated-after-read-failure');

    await generateMediaForOutlines(
      [
        {
          id: 'outline-1',
          type: 'slide',
          title: 'Scene',
          description: 'Scene',
          keyPoints: ['image'],
          order: 1,
          mediaGenerations: [{ type: 'image', prompt: 'A new image', elementId: placeholder }],
        },
      ],
      stageId,
    );

    expect(fetchMock).toHaveBeenCalledWith('/api/generate/image', expect.any(Object));
    expect(mocks.document.scenes[0].content.canvas.elements[0].src).toMatch(/^ast_/);
    await assertOwnership();
  });

  it('persists a retryable failure when pool replacement succeeds before Dexie fails', async () => {
    const assetId = await pool.put(new Blob(['image-old'], { type: 'image/png' }));
    mocks.document = documentWithMedia(assetId, 'image');
    useMediaGenerationStore.setState({ tasks: { [assetId]: failedTask(assetId) } });
    serveImage('pool-new-dexie-missed');
    mocks.mediaPut.mockRejectedValueOnce(new Error('Dexie write failed'));
    mocks.mediaGet.mockResolvedValue({
      id: `${stageId}:${assetId}`,
      stageId,
      type: 'image',
      blob: new Blob(['image-old'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 9,
      prompt: 'A new image',
      params: '{}',
      createdAt: 1,
    });

    await retryMediaTask(assetId);

    expect(await resolvedText(assetId)).toBe('pool-new-dexie-missed');
    expect(useMediaGenerationStore.getState().tasks[assetId]).toMatchObject({
      status: 'failed',
      errorCode: 'MEDIA_COMPATIBILITY_STORE_LAGGED',
      error: expect.stringContaining('compatibility media store lagged'),
    });
    expect(mocks.mediaPut).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'MEDIA_COMPATIBILITY_STORE_LAGGED' }),
    );

    serveImage('stores-converged');
    await retryMediaTask(assetId);
    expect(await resolvedText(assetId)).toBe('stores-converged');
    expect(useMediaGenerationStore.getState().tasks[assetId]?.status).toBe('done');
    expect(mocks.mediaPut).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: `${stageId}:${assetId}`, blob: expect.any(Blob) }),
    );
  });

  it('drops a document rewrite fenced by a stage deletion epoch change', async () => {
    mocks.document = documentWithMedia(placeholder, 'image');
    const before = structuredClone(mocks.document);
    serveImage();
    mocks.beforeDocumentWork.mockImplementationOnce(() => markStageDeleted(stageId));

    try {
      await generateMediaForOutlines(
        [
          {
            id: 'outline-1',
            type: 'slide',
            title: 'Scene',
            description: 'Scene',
            keyPoints: ['image'],
            order: 1,
            mediaGenerations: [{ type: 'image', prompt: 'A new image', elementId: placeholder }],
          },
        ],
        stageId,
      );
      expect(mocks.document).toEqual(before);
    } finally {
      unmarkStageDeleted(stageId);
    }
  });
});
