import { IDBFactory } from 'fake-indexeddb';
import { BrowserAssetStore } from '@openmaic/storage';
import type { Slide } from '@openmaic/dsl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaTask } from '@/lib/store/media-generation';
import type { Scene, Stage } from '@/lib/types/stage';
import type { MediaFileRecord } from '@/lib/utils/database';

const mocks = vi.hoisted(() => ({
  probePresence: vi.fn(),
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
  listDocuments: vi.fn(),
  loadDocument: vi.fn(),
  otherDocuments: new Map<string, ReturnType<typeof documentWithMedia>>(),
  mediaRows: new Map<string, { id: string; blob: Blob; error?: string }>(),
  serverBacked: false,
}));

vi.mock('@/lib/media/asset-pool-config', () => ({
  isAssetPoolServerBacked: () => mocks.serverBacked,
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

// Production runs one realm unless a peer answers; individual tests override
// this to model an unavailable probe or a live peer.
vi.mock('@/lib/media/stage-realm-presence', () => ({
  probeStageRealmPresence: mocks.probePresence,
}));

vi.mock('@/lib/document-store', () => ({
  accessDocument: mocks.accessDocument,
  getDocumentStore: () => ({
    listDocuments: mocks.listDocuments,
    loadDocument: mocks.loadDocument,
  }),
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
  mediaRetryTarget,
  reconcileCompletedMediaForScene,
  retryMediaTask,
} from '@/lib/media/media-orchestrator';
import { buildRestoredMediaTasks } from '@/lib/classroom/load-classroom';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { markStageDeleted, unmarkStageDeleted } from '@/lib/utils/deleted-stages';
import { resolveSlideMediaState } from '@/components/slide-renderer/use-resolved-slide';
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

function doneTask(ref: string, type: 'image' | 'video' = 'image'): MediaTask {
  return {
    ...failedTask(ref, type),
    status: 'done',
    objectUrl: 'blob:source',
    error: undefined,
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
    mocks.probePresence.mockReset().mockResolvedValue('absent');
    mocks.serverBacked = false;
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
    mocks.otherDocuments.clear();
    mocks.listDocuments
      .mockReset()
      .mockImplementation(async () => [
        ...(mocks.document ? [{ id: mocks.document.stage.id }] : []),
        ...[...mocks.otherDocuments.keys()].map((id) => ({ id })),
      ]);
    mocks.loadDocument
      .mockReset()
      .mockImplementation(async (id) =>
        id === mocks.document?.stage.id ? mocks.document : (mocks.otherDocuments.get(id) ?? null),
      );
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

  it('runs a final document reconciliation before task re-keying when a scene lands late', async () => {
    const pendingDocument = documentWithMedia(placeholder, 'video');
    const lateScene = structuredClone(pendingDocument.scenes[0]);
    pendingDocument.scenes = [];
    mocks.document = pendingDocument;
    serveVideo('late-window-media');
    let documentScans = 0;
    mocks.beforeDocumentWork.mockImplementation(() => {
      documentScans += 1;
      if (documentScans !== 2 || !mocks.document) return;
      const pending = Object.values(useMediaGenerationStore.getState().tasks)[0];
      expect(pending).toMatchObject({
        status: 'generating',
        elementId: placeholder,
      });
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

  it('rollback layer 1: leaves the document and Dexie untouched when pool allocation fails', async () => {
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

  it('rollback layer 2: removes every fresh allocation when compatibility persistence fails', async () => {
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

  it('rollback layer 3: removes pool and compatibility writes when document commit fails', async () => {
    mocks.document = documentWithMedia(placeholder, 'image');
    const before = structuredClone(mocks.document);
    serveImage('uncommitted-image');
    const put = vi.spyOn(pool, 'put');
    mocks.beforeDocumentWork.mockImplementationOnce(() => {
      throw new Error('document write failed');
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

    const [allocated] = await Promise.all(put.mock.results.map((result) => result.value));
    expect(await pool.resolve(allocated)).toBeNull();
    expect(mocks.mediaRows.has(`${stageId}:${allocated}`)).toBe(false);
    expect(mocks.document).toEqual(before);
  });

  it('replaces exclusively owned media bytes for a production-shaped targeted retry', async () => {
    const assetId = await pool.put(new Blob(['image-old'], { type: 'image/png' }));
    mocks.document = documentWithMedia(assetId, 'image');
    const before = structuredClone(mocks.document);
    const put = vi.spyOn(pool, 'put');
    const replace = vi.spyOn(pool, 'replace');
    // The existence probe is metadata-only now: exists(), not a lease's
    // acquire/release pair.
    const exists = vi.spyOn(pool, 'exists');
    serveImage('image-replaced');
    useMediaGenerationStore.setState({ tasks: { [assetId]: failedTask(assetId) } });

    await retryMediaTask(assetId, {
      elementId: 'image-1',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });

    expect(replace).toHaveBeenCalledWith(
      assetId,
      expect.any(Blob),
      expect.objectContaining({
        prompt: 'A new image',
        dimensions: { width: 1024, height: 576 },
      }),
    );
    expect(put).not.toHaveBeenCalled();
    expect(exists).toHaveBeenCalledWith(assetId);
    expect(await resolvedText(assetId)).toBe('image-replaced');
    expect(mocks.document).toEqual(before);
    expect(mocks.mediaDelete).not.toHaveBeenCalled();
    expect(mocks.mediaPut).toHaveBeenCalledWith(
      expect.objectContaining({ id: `${stageId}:${assetId}` }),
    );
    expect(await mocks.mediaRows.get(`${stageId}:${assetId}`)?.blob.text()).toBe('image-replaced');
    expect(useMediaGenerationStore.getState().tasks[assetId]?.status).toBe('done');
    expect(mocks.listDocuments).toHaveBeenCalledTimes(2);
    expect(mocks.loadDocument).toHaveBeenCalledWith(stageId);
    await assertOwnership();
  });

  it('forks a targeted retry when peer presence cannot be probed', async () => {
    // No BroadcastChannel, binding not finished, or a constructor that threw all
    // report 'unknown'. Proving nothing about other realms must not authorize a
    // global mutation, so the write boundary itself has to fork.
    mocks.probePresence.mockResolvedValue('unknown');
    const assetId = await pool.put(new Blob(['image-old'], { type: 'image/png' }));
    mocks.document = documentWithMedia(assetId, 'image');
    const replace = vi.spyOn(pool, 'replace');
    serveImage('image-forked');
    useMediaGenerationStore.setState({ tasks: { [assetId]: failedTask(assetId) } });

    await retryMediaTask(assetId, {
      elementId: 'image-1',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });

    const rewritten = mocks.document.scenes[0].content.canvas.elements[0].src;
    expect(replace).not.toHaveBeenCalled();
    expect(rewritten).toMatch(/^ast_/);
    expect(rewritten).not.toBe(assetId);
    expect(await resolvedText(rewritten)).toBe('image-forked');
    // A peer's unflushed owner, had there been one, still resolves the old bytes.
    expect(await resolvedText(assetId)).toBe('image-old');
  });

  it('forks a targeted retry in server mode even when local ownership is exclusive', async () => {
    mocks.serverBacked = true;
    const assetId = await pool.put(new Blob(['image-old'], { type: 'image/png' }));
    mocks.document = documentWithMedia(assetId, 'image');
    const replace = vi.spyOn(pool, 'replace');
    serveImage('image-server-fork');
    useMediaGenerationStore.setState({ tasks: { [assetId]: failedTask(assetId) } });

    await retryMediaTask(assetId, {
      elementId: 'image-1',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });

    const rewritten = mocks.document.scenes[0].content.canvas.elements[0].src;
    expect(replace).not.toHaveBeenCalled();
    expect(rewritten).toMatch(/^ast_/);
    expect(rewritten).not.toBe(assetId);
    expect(await resolvedText(rewritten)).toBe('image-server-fork');
    expect(await resolvedText(assetId)).toBe('image-old');
  });

  it('forks when an exclusive ref becomes shared while generation is pending', async () => {
    const assetId = await pool.put(new Blob(['image-original'], { type: 'image/png' }));
    mocks.document = documentWithMedia(assetId, 'image');
    mocks.stageState = {
      stage: structuredClone(mocks.document.stage),
      scenes: structuredClone(mocks.document.scenes),
    };
    mocks.mediaRows.set(`${stageId}:${assetId}`, {
      id: `${stageId}:${assetId}`,
      blob: new Blob(['image-original'], { type: 'image/png' }),
    });
    useMediaGenerationStore.setState({ tasks: { [assetId]: failedTask(assetId) } });
    const replace = vi.spyOn(pool, 'replace');
    let finishGeneration!: (response: Response) => void;
    const generation = new Promise<Response>((resolve) => {
      finishGeneration = resolve;
    });
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/api/generate/image') return generation;
      if (input === '/api/proxy-media') {
        return new Response(new Blob(['image-retried'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });

    const retrying = retryMediaTask(assetId, {
      elementId: 'image-1',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });
    await vi.waitFor(() => {
      expect(useMediaGenerationStore.getState().tasks[assetId]?.status).toBe('generating');
    });

    const copy = structuredClone(mocks.document.scenes[0]);
    copy.id = 'scene-copy';
    copy.order = 2;
    copy.content.canvas.id = 'slide-copy';
    copy.content.canvas.elements[0].id = 'image-copy';
    mocks.document.scenes.push(copy);
    mocks.stageState.scenes.push(structuredClone(copy));

    finishGeneration(
      new Response(
        JSON.stringify({
          success: true,
          result: { url: 'https://media.test/image', width: 1024, height: 576 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await retrying;

    const targetRef = mocks.document.scenes[0].content.canvas.elements[0].src;
    const copiedRef = mocks.document.scenes[1].content.canvas.elements[0].src;
    expect(targetRef).toMatch(/^ast_/);
    expect(targetRef).not.toBe(assetId);
    expect(copiedRef).toBe(assetId);
    expect(await resolvedText(targetRef)).toBe('image-retried');
    expect(await resolvedText(copiedRef)).toBe('image-original');
    expect(await mocks.mediaRows.get(`${stageId}:${assetId}`)?.blob.text()).toBe('image-original');
    expect(replace).not.toHaveBeenCalled();
    expect(mocks.listDocuments).toHaveBeenCalledTimes(2);
  });

  it('forks when the duplicate exists only in the unflushed editor state', async () => {
    const assetId = await pool.put(new Blob(['image-original'], { type: 'image/png' }));
    mocks.document = documentWithMedia(assetId, 'image');
    mocks.stageState = {
      stage: structuredClone(mocks.document.stage),
      scenes: structuredClone(mocks.document.scenes),
    };
    mocks.mediaRows.set(`${stageId}:${assetId}`, {
      id: `${stageId}:${assetId}`,
      blob: new Blob(['image-original'], { type: 'image/png' }),
    });
    useMediaGenerationStore.setState({ tasks: { [assetId]: failedTask(assetId) } });
    const replace = vi.spyOn(pool, 'replace');
    let finishGeneration!: (response: Response) => void;
    const generation = new Promise<Response>((resolve) => {
      finishGeneration = resolve;
    });
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/api/generate/image') return generation;
      if (input === '/api/proxy-media') {
        return new Response(new Blob(['image-retried'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });

    const retrying = retryMediaTask(assetId, {
      elementId: 'image-1',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });
    await vi.waitFor(() => {
      expect(useMediaGenerationStore.getState().tasks[assetId]?.status).toBe('generating');
    });

    // Duplication lands in the Zustand aggregate immediately; persistence is
    // still behind its debounce, so the stored document keeps a single owner.
    const copy = structuredClone(mocks.stageState.scenes[0]);
    copy.id = 'scene-copy';
    copy.order = 2;
    copy.content.canvas.id = 'slide-copy';
    copy.content.canvas.elements[0].id = 'image-copy';
    mocks.stageState.scenes.push(copy);
    expect(mocks.document.scenes).toHaveLength(1);

    finishGeneration(
      new Response(
        JSON.stringify({
          success: true,
          result: { url: 'https://media.test/image', width: 1024, height: 576 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await retrying;

    const targetRef = mocks.document.scenes[0].content.canvas.elements[0].src;
    expect(targetRef).toMatch(/^ast_/);
    expect(targetRef).not.toBe(assetId);
    expect(await resolvedText(targetRef)).toBe('image-retried');
    // The unflushed copy still points at the original id, whose bytes are intact.
    expect(mocks.stageState.scenes[1].content.canvas.elements[0].src).toBe(assetId);
    expect(await resolvedText(assetId)).toBe('image-original');
    expect(await mocks.mediaRows.get(`${stageId}:${assetId}`)?.blob.text()).toBe('image-original');
    expect(replace).not.toHaveBeenCalled();
  });

  it('forks a targeted retry when another persisted document aliases the allocated ref', async () => {
    const assetId = await pool.put(new Blob(['shared-original'], { type: 'image/png' }));
    mocks.document = documentWithMedia(assetId, 'image');
    mocks.stageState = {
      stage: structuredClone(mocks.document.stage),
      scenes: structuredClone(mocks.document.scenes),
    };
    const other = documentWithMedia(assetId, 'image');
    other.stage.id = 'stage-other';
    other.scenes[0].stageId = 'stage-other';
    mocks.otherDocuments.set('stage-other', other);
    mocks.mediaRows.set(`${stageId}:${assetId}`, {
      id: `${stageId}:${assetId}`,
      blob: new Blob(['shared-original'], { type: 'image/png' }),
    });
    useMediaGenerationStore.setState({ tasks: { [assetId]: failedTask(assetId) } });
    const replace = vi.spyOn(pool, 'replace');
    serveImage('retried-target');

    await retryMediaTask(assetId, {
      elementId: 'image-1',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });

    const retriedRef = mocks.document.scenes[0].content.canvas.elements[0].src;
    expect(retriedRef).toMatch(/^ast_/);
    expect(retriedRef).not.toBe(assetId);
    expect(other.scenes[0].content.canvas.elements[0].src).toBe(assetId);
    expect(await resolvedText(assetId)).toBe('shared-original');
    expect(await resolvedText(retriedRef)).toBe('retried-target');
    expect(await mocks.mediaRows.get(`${stageId}:${assetId}`)?.blob.text()).toBe('shared-original');
    expect(mocks.mediaDelete).not.toHaveBeenCalledWith(`${stageId}:${assetId}`);
    expect(replace).not.toHaveBeenCalled();
  });

  it('forks instead of replacing when persisted ownership enumeration fails', async () => {
    const assetId = await pool.put(new Blob(['original-bytes'], { type: 'image/png' }));
    mocks.document = documentWithMedia(assetId, 'image');
    mocks.stageState = {
      stage: structuredClone(mocks.document.stage),
      scenes: structuredClone(mocks.document.scenes),
    };
    mocks.listDocuments.mockRejectedValueOnce(new Error('document store unavailable'));
    useMediaGenerationStore.setState({ tasks: { [assetId]: failedTask(assetId) } });
    const replace = vi.spyOn(pool, 'replace');
    serveImage('forked-bytes');

    await retryMediaTask(assetId, {
      elementId: 'image-1',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });

    const retriedRef = mocks.document.scenes[0].content.canvas.elements[0].src;
    expect(retriedRef).toMatch(/^ast_/);
    expect(retriedRef).not.toBe(assetId);
    expect(await resolvedText(assetId)).toBe('original-bytes');
    expect(await resolvedText(retriedRef)).toBe('forked-bytes');
    expect(replace).not.toHaveBeenCalled();
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

    await retryMediaTask(assetId, {
      elementId: 'video-1',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });

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

    await retryMediaTask(placeholder, {
      elementId: 'image-1',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });

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
    const sourceStatuses: Array<MediaTask['status'] | undefined> = [];
    const unsubscribe = useMediaGenerationStore.subscribe((state) => {
      sourceStatuses.push(state.tasks[sharedAssetId]?.status);
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
    unsubscribe();

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
    expect(useMediaGenerationStore.getState().tasks[sharedAssetId]).toMatchObject({
      status: 'failed',
      error: 'retry me',
      retryCount: 0,
    });
    expect(sourceStatuses.length).toBeGreaterThan(0);
    expect(sourceStatuses.every((status) => status === 'failed')).toBe(true);
    expect(mocks.beforeDocumentWork).toHaveBeenCalledTimes(1);
    await assertOwnership();
  });

  it('removes a failed fork from both key spaces after its retry succeeds', async () => {
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
    mocks.mediaRows.set(`${stageId}:${sharedAssetId}`, {
      id: `${stageId}:${sharedAssetId}`,
      blob: new Blob(['original-bytes'], { type: 'image/png' }),
    });
    useMediaGenerationStore.setState({ tasks: { [sharedAssetId]: doneTask(sharedAssetId) } });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: 'fork generation failed',
          errorCode: 'UPSTREAM_TIMEOUT',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const target = {
      elementId: 'image-copy',
      sceneId: 'scene-copy',
      slideId: 'slide-copy',
    };
    await retryMediaTask(sharedAssetId, target);

    expect(mocks.mediaRows.get(`${stageId}:image-copy`)).toMatchObject({
      error: 'fork generation failed',
    });
    expect(useMediaGenerationStore.getState().tasks['image-copy']?.status).toBe('failed');

    serveImage('recovered-fork');
    await retryMediaTask(sharedAssetId, target);

    const recoveredRef = mocks.document.scenes[1].content.canvas.elements[0].src;
    expect(recoveredRef).toMatch(/^ast_/);
    expect(mocks.mediaRows.has(`${stageId}:image-copy`)).toBe(false);
    expect(useMediaGenerationStore.getState().tasks['image-copy']).toBeUndefined();
    expect(useMediaGenerationStore.getState().tasks[recoveredRef]).toMatchObject({
      elementId: recoveredRef,
      status: 'done',
    });

    const restored = buildRestoredMediaTasks(stageId, [
      ...mocks.mediaRows.values(),
    ] as unknown as MediaFileRecord[]);
    expect(restored['image-copy']).toBeUndefined();
    expect(restored[recoveredRef]?.status).toBe('done');
    const reloaded = resolveSlideMediaState(
      mocks.document.scenes[1].content.canvas as unknown as Slide,
      stageId,
      restored,
    );
    expect(reloaded.byElementId['image-copy']).toMatchObject({
      task: { elementId: recoveredRef, status: 'done' },
      resolution: { kind: 'url' },
    });
  });

  it('restores a fork failure after its retry fails without an error code', async () => {
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
    mocks.mediaRows.set(`${stageId}:${sharedAssetId}`, {
      id: `${stageId}:${sharedAssetId}`,
      blob: new Blob(['original-bytes'], { type: 'image/png' }),
    });
    useMediaGenerationStore.setState({ tasks: { [sharedAssetId]: doneTask(sharedAssetId) } });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: 'fork generation failed',
          errorCode: 'UPSTREAM_TIMEOUT',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const target = {
      elementId: 'image-copy',
      sceneId: 'scene-copy',
      slideId: 'slide-copy',
    };
    await retryMediaTask(sharedAssetId, target);
    expect(mocks.mediaRows.get(`${stageId}:image-copy`)).toMatchObject({
      error: 'fork generation failed',
      errorCode: 'UPSTREAM_TIMEOUT',
    });

    fetchMock.mockRejectedValueOnce(new Error('unstructured retry failure'));
    await retryMediaTask(sharedAssetId, target);

    const restored = buildRestoredMediaTasks(stageId, [
      ...mocks.mediaRows.values(),
    ] as unknown as MediaFileRecord[]);
    expect(restored['image-copy']).toMatchObject({
      status: 'failed',
      error: 'fork generation failed',
      errorCode: 'UPSTREAM_TIMEOUT',
    });
    const reloaded = resolveSlideMediaState(
      mocks.document.scenes[1].content.canvas as unknown as Slide,
      stageId,
      restored,
      { assetUrls: { [sharedAssetId]: 'blob:source-pool' } },
    );
    expect(reloaded.byElementId['image-copy']).toMatchObject({
      task: { elementId: 'image-copy', status: 'failed', error: 'fork generation failed' },
      resolution: { kind: 'url', url: 'blob:source-pool', retryable: true },
    });
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
    useMediaGenerationStore.setState({ tasks: { [sharedAssetId]: doneTask(sharedAssetId) } });
    serveImage('scoped-copy');

    await retryMediaTask(sharedAssetId, {
      elementId: 'repeated-image',
      sceneId: 'scene-copy',
      slideId: 'slide-copy',
    });

    expect(mocks.document.scenes[0].content.canvas.elements[0].src).toBe(sharedAssetId);
    expect(mocks.document.scenes[1].content.canvas.elements[0].src).not.toBe(sharedAssetId);
    expect(useMediaGenerationStore.getState().tasks[sharedAssetId]).toMatchObject({
      status: 'done',
      objectUrl: 'blob:source',
      retryCount: 0,
    });
    await assertOwnership();
  });

  it('keeps sharers on source bytes while a targeted fork is generating', async () => {
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
    useMediaGenerationStore.setState({ tasks: { [sharedAssetId]: doneTask(sharedAssetId) } });
    let finishGeneration!: (response: Response) => void;
    const generation = new Promise<Response>((resolve) => {
      finishGeneration = resolve;
    });
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/api/generate/image') return generation;
      if (input === '/api/proxy-media') {
        return new Response(new Blob(['fork-bytes'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });

    const retrying = retryMediaTask(sharedAssetId, {
      elementId: 'image-copy',
      sceneId: 'scene-copy',
      slideId: 'slide-copy',
    });
    await vi.waitFor(() => {
      expect(useMediaGenerationStore.getState().tasks['image-copy']?.status).toBe('generating');
    });

    const tasks = useMediaGenerationStore.getState().tasks;
    const source = resolveSlideMediaState(
      mocks.document.scenes[0].content.canvas as unknown as Slide,
      stageId,
      tasks,
      { assetUrls: { [sharedAssetId]: 'blob:source-pool' } },
    );
    const target = resolveSlideMediaState(
      mocks.document.scenes[1].content.canvas as unknown as Slide,
      stageId,
      tasks,
      { assetUrls: { [sharedAssetId]: 'blob:source-pool' } },
    );
    expect(tasks[sharedAssetId]).toMatchObject({ status: 'done', objectUrl: 'blob:source' });
    expect(source.byElementId['image-1'].resolution).toEqual({
      kind: 'url',
      url: 'blob:source-pool',
    });
    expect(source.slide.elements[0]).toMatchObject({ src: 'blob:source-pool' });
    expect(target.byElementId['image-copy'].resolution).toEqual({ kind: 'pending' });
    expect(target.slide.elements[0]).toMatchObject({ src: '' });

    finishGeneration(
      new Response(
        JSON.stringify({
          success: true,
          result: { url: 'https://media.test/image', width: 1024, height: 576 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await retrying;
    expect(useMediaGenerationStore.getState().tasks[sharedAssetId]).toMatchObject({
      status: 'done',
      objectUrl: 'blob:source',
      retryCount: 0,
    });
  });

  it('forks a shared ref owned by a scene whiteboard despite the scene slide id', async () => {
    const sharedAssetId = await pool.put(new Blob(['original-bytes'], { type: 'image/png' }));
    mocks.document = documentWithMedia(sharedAssetId, 'image');
    const scene = mocks.document.scenes[0] as (typeof mocks.document.scenes)[number] & {
      whiteboards: Array<(typeof mocks.document.scenes)[number]['content']['canvas']>;
    };
    scene.whiteboards = [
      {
        ...structuredClone(mocks.document.scenes[0].content.canvas),
        id: 'scene-whiteboard',
        elements: [
          {
            ...structuredClone(mocks.document.scenes[0].content.canvas.elements[0]),
            id: 'whiteboard-image',
            type: 'image',
            src: sharedAssetId,
          },
        ],
      },
    ];
    mocks.stageState = {
      stage: structuredClone(mocks.document.stage),
      scenes: structuredClone(mocks.document.scenes),
    };
    mocks.mediaRows.set(`${stageId}:${sharedAssetId}`, {
      id: `${stageId}:${sharedAssetId}`,
      blob: new Blob(['original-bytes'], { type: 'image/png' }),
    });
    useMediaGenerationStore.setState({ tasks: { [sharedAssetId]: failedTask(sharedAssetId) } });
    serveImage('whiteboard-copy');

    await retryMediaTask(sharedAssetId, {
      elementId: 'whiteboard-image',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });

    expect(mocks.document.scenes[0].content.canvas.elements[0].src).toBe(sharedAssetId);
    const savedScene = mocks.document.scenes[0] as typeof scene;
    expect(savedScene.whiteboards[0].elements[0].src).not.toBe(sharedAssetId);
    expect(useMediaGenerationStore.getState().tasks[sharedAssetId]?.status).toBe('failed');
  });

  it('forks a shared ref owned by the stage whiteboard from a scene context', async () => {
    const sharedAssetId = await pool.put(new Blob(['original-bytes'], { type: 'image/png' }));
    mocks.document = documentWithMedia(sharedAssetId, 'image');
    const stage = mocks.document.stage as typeof mocks.document.stage & {
      whiteboard: Array<(typeof mocks.document.scenes)[number]['content']['canvas']>;
    };
    stage.whiteboard = [
      {
        ...structuredClone(mocks.document.scenes[0].content.canvas),
        id: 'stage-whiteboard',
        elements: [
          {
            ...structuredClone(mocks.document.scenes[0].content.canvas.elements[0]),
            id: 'stage-whiteboard-image',
            type: 'image',
            src: sharedAssetId,
          },
        ],
      },
    ];
    mocks.stageState = {
      stage: structuredClone(mocks.document.stage),
      scenes: structuredClone(mocks.document.scenes),
    };
    mocks.mediaRows.set(`${stageId}:${sharedAssetId}`, {
      id: `${stageId}:${sharedAssetId}`,
      blob: new Blob(['original-bytes'], { type: 'image/png' }),
    });
    useMediaGenerationStore.setState({ tasks: { [sharedAssetId]: failedTask(sharedAssetId) } });
    serveImage('stage-whiteboard-copy');

    await retryMediaTask(sharedAssetId, {
      elementId: 'stage-whiteboard-image',
      sceneId: 'scene-1',
      slideId: 'stage-whiteboard',
    });

    expect(mocks.document.scenes[0].content.canvas.elements[0].src).toBe(sharedAssetId);
    const savedStage = mocks.document.stage as typeof stage;
    expect(savedStage.whiteboard[0].elements[0].src).not.toBe(sharedAssetId);
    expect(useMediaGenerationStore.getState().tasks[sharedAssetId]?.status).toBe('failed');
  });

  it('does not fall back to a stage-whiteboard element id when the target slide misses', async () => {
    const sharedAssetId = await pool.put(new Blob(['original-bytes'], { type: 'image/png' }));
    mocks.document = documentWithMedia(sharedAssetId, 'image');
    const stage = mocks.document.stage as typeof mocks.document.stage & {
      whiteboard: Array<(typeof mocks.document.scenes)[number]['content']['canvas']>;
    };
    stage.whiteboard = [
      {
        ...structuredClone(mocks.document.scenes[0].content.canvas),
        id: 'stage-whiteboard',
        elements: [
          {
            ...structuredClone(mocks.document.scenes[0].content.canvas.elements[0]),
            id: 'stage-whiteboard-image',
            type: 'image',
            src: sharedAssetId,
          },
        ],
      },
    ];
    mocks.stageState = {
      stage: structuredClone(mocks.document.stage),
      scenes: structuredClone(mocks.document.scenes),
    };
    useMediaGenerationStore.setState({ tasks: { [sharedAssetId]: failedTask(sharedAssetId) } });
    serveImage('must-not-be-attached');

    await retryMediaTask(sharedAssetId, {
      elementId: 'stage-whiteboard-image',
      sceneId: 'missing-scene',
      slideId: 'missing-slide',
    });

    expect(stage.whiteboard[0].elements[0].src).toBe(sharedAssetId);
    expect(useMediaGenerationStore.getState().tasks[sharedAssetId]?.status).toBe('failed');
    expect(useMediaGenerationStore.getState().tasks['stage-whiteboard-image']).toMatchObject({
      status: 'failed',
      errorCode: 'TARGET_MISSING',
    });
  });

  it('builds a safe retry target for a non-slide scene', () => {
    expect(mediaRetryTarget('image-1', 'scene-1', { type: 'text', markdown: 'Notes' })).toEqual({
      elementId: 'image-1',
      sceneId: 'scene-1',
    });
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

  it('rollback layer 4: protects first-commit bytes when later reconciliation fails', async () => {
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

  it('protects document-committed refs when active-stage reconciliation throws', async () => {
    mocks.document = documentWithMedia(placeholder, 'image');
    mocks.stageState = {
      stage: structuredClone(mocks.document.stage),
      scenes: structuredClone(mocks.document.scenes),
    };
    mocks.stageSetState.mockImplementationOnce(() => {
      throw new Error('active-stage reconciliation failed');
    });
    serveImage('committed-before-active-stage-failure');

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
    expect(mocks.stageSetState).toHaveBeenCalledOnce();
    expect(committedRef).toMatch(/^ast_/);
    expect(await resolvedText(committedRef)).toBe('committed-before-active-stage-failure');
    expect(mocks.mediaRows.has(`${stageId}:${committedRef}`)).toBe(true);
  });

  it('rollback layer 5: final rewrite failure leaves no task that can resurrect removed bytes', async () => {
    const pendingDocument = documentWithMedia(placeholder, 'image');
    const lateScene = structuredClone(pendingDocument.scenes[0]);
    pendingDocument.scenes = [];
    mocks.document = pendingDocument;
    serveImage('removed-after-final-rewrite-failure');
    const put = vi.spyOn(pool, 'put');
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

    const [removedRef] = await Promise.all(put.mock.results.map((result) => result.value));
    expect(await pool.resolve(removedRef)).toBeNull();
    expect(mocks.mediaRows.has(`${stageId}:${removedRef}`)).toBe(false);
    expect(useMediaGenerationStore.getState().tasks).toEqual({
      [placeholder]: expect.objectContaining({
        elementId: placeholder,
        status: 'failed',
        error: 'second reconciliation failed',
      }),
    });

    const reconciled = reconcileCompletedMediaForScene(
      lateScene as unknown as Scene,
      pendingDocument.stage as unknown as Stage,
      useMediaGenerationStore.getState().tasks,
    );
    expect(reconciled.scene.content.type).toBe('slide');
    if (reconciled.scene.content.type !== 'slide') throw new Error('Expected a slide scene');
    const restoredElement = reconciled.scene.content.canvas.elements[0];
    expect(restoredElement.type).toBe('image');
    if (restoredElement.type !== 'image') throw new Error('Expected an image element');
    expect(restoredElement.src).toBe(placeholder);
  });

  it('marks the targeted fork failed without mutating its shared source task', async () => {
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
    useMediaGenerationStore.setState({ tasks: { [sharedAssetId]: doneTask(sharedAssetId) } });
    const sourceStatuses: Array<MediaTask['status'] | undefined> = [];
    const unsubscribe = useMediaGenerationStore.subscribe((state) => {
      sourceStatuses.push(state.tasks[sharedAssetId]?.status);
    });
    fetchMock.mockRejectedValue(new Error('fork generation failed'));

    await retryMediaTask(sharedAssetId, {
      elementId: 'image-copy',
      sceneId: 'scene-copy',
      slideId: 'slide-copy',
    });
    unsubscribe();

    expect(useMediaGenerationStore.getState().tasks).toEqual({
      [sharedAssetId]: expect.objectContaining({
        elementId: sharedAssetId,
        status: 'done',
        objectUrl: 'blob:source',
        retryCount: 0,
      }),
      'image-copy': expect.objectContaining({
        elementId: 'image-copy',
        status: 'failed',
        error: 'fork generation failed',
        retryCount: 1,
      }),
    });
    expect(sourceStatuses.length).toBeGreaterThan(0);
    expect(sourceStatuses.every((status) => status === 'done')).toBe(true);
    const failedTarget = resolveSlideMediaState(
      mocks.document.scenes[1].content.canvas as unknown as Slide,
      stageId,
      useMediaGenerationStore.getState().tasks,
      { assetUrls: { [sharedAssetId]: 'blob:source-pool' } },
    );
    expect(failedTarget.byElementId['image-copy']).toMatchObject({
      task: { elementId: 'image-copy', status: 'failed', error: 'fork generation failed' },
      resolution: { kind: 'url', url: 'blob:source-pool', retryable: true },
    });
    expect(mocks.document.scenes[0].content.canvas.elements[0].src).toBe(sharedAssetId);
    expect(mocks.document.scenes[1].content.canvas.elements[0].src).toBe(sharedAssetId);
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

    const target = {
      elementId: 'image-1',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    };
    await retryMediaTask(assetId, target);

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
    await retryMediaTask(assetId, target);
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
