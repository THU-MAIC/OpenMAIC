/**
 * Server-backed generation ordering.
 *
 * A durable, shared document may only ever name bytes that were already
 * stored, so the order inside one task is fixed: provider, then pool, then the
 * document, then the task. These tests pin each hinge of that order — including
 * both failure modes, where the placeholder must survive and the provider must
 * not be called a second time within the run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  mediaPut: vi.fn(),
  mediaDelete: vi.fn(),
  putAsset: vi.fn(),
  removeAsset: vi.fn(),
  persistReference: vi.fn(),
  serverBacked: vi.fn(),
  stageState: vi.fn(),
  pendingAllocation: vi.fn(),
  recordPendingAllocation: vi.fn(),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settings },
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: mocks.stageState },
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    mediaFiles: {
      put: mocks.mediaPut,
      delete: mocks.mediaDelete,
    },
  },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  putAsset: mocks.putAsset,
  removeAsset: mocks.removeAsset,
}));

vi.mock('@/lib/media/persist-media-reference', async () => {
  const actual = await vi.importActual<typeof import('@/lib/media/persist-media-reference')>(
    '@/lib/media/persist-media-reference',
  );
  return { ...actual, persistGeneratedMediaReference: mocks.persistReference };
});

vi.mock('@/lib/media/pending-media-allocations', () => ({
  pendingMediaAllocation: mocks.pendingAllocation,
  recordPendingMediaAllocation: mocks.recordPendingAllocation,
}));

vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
}));

import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { MediaReferenceWriteBackError } from '@/lib/media/persist-media-reference';
import { resetProxyMediaFailureCache } from '@/lib/media/proxy-media-cache';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const stageId = 'server-stage';
const imageRef = 'gen_img_server';
const videoRef = 'gen_vid_server';

function outlineWith(
  order: number,
  ...mediaGenerations: NonNullable<SceneOutline['mediaGenerations']>
): SceneOutline {
  return {
    id: `outline-${order}`,
    type: 'slide',
    title: 'Scene',
    description: 'Scene',
    keyPoints: ['media'],
    order,
    mediaGenerations,
  };
}

function sceneWithImage(order: number, src: string): Scene {
  return {
    id: `scene-${order}`,
    stageId,
    title: 'Scene',
    order,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: `slide-${order}`,
        elements: [
          {
            type: 'image',
            id: 'image-1',
            left: 0,
            top: 0,
            width: 100,
            height: 100,
            src,
            fixedRatio: false,
          },
        ],
      },
    },
  } as unknown as Scene;
}

describe('server-backed classic media orchestrator', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetProxyMediaFailureCache();
    mocks.mediaPut.mockReset().mockResolvedValue(undefined);
    mocks.mediaDelete.mockReset().mockResolvedValue(undefined);
    mocks.putAsset.mockReset().mockResolvedValue('ast_generated');
    mocks.removeAsset.mockReset().mockResolvedValue(undefined);
    mocks.persistReference.mockReset().mockResolvedValue('written');
    mocks.pendingAllocation.mockReset().mockReturnValue(undefined);
    mocks.recordPendingAllocation.mockReset();
    mocks.serverBacked.mockReset().mockReturnValue(true);
    mocks.stageState.mockReset().mockReturnValue({
      stage: { id: stageId },
      scenes: [sceneWithImage(1, imageRef)],
      generationComplete: false,
    });
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

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:server-1'),
      revokeObjectURL: vi.fn(),
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resetProxyMediaFailureCache();
    vi.unstubAllGlobals();
  });

  function serveImage(): void {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/generate/image') {
        return new Response(
          JSON.stringify({ success: true, result: { url: 'https://media.test/image' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(input) === '/api/proxy-media') {
        return new Response(new Blob(['server-image'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
  }

  function serveVideo(): void {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/generate/video') {
        return new Response(
          JSON.stringify({
            success: true,
            result: { url: 'https://media.test/video', poster: 'https://media.test/poster' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(input) === '/api/proxy-media') {
        const requested = JSON.parse(String(init?.body)) as { url: string };
        return requested.url.endsWith('/poster')
          ? new Response(new Blob(['poster'], { type: 'image/jpeg' }), { status: 200 })
          : new Response(new Blob(['video'], { type: 'video/mp4' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
  }

  function providerCallCount(): number {
    return fetchMock.mock.calls.filter(([input]) => String(input) === '/api/generate/image').length;
  }

  async function runImageGeneration(): Promise<void> {
    await generateMediaForOutlines(
      [outlineWith(1, { type: 'image', prompt: 'A diagram', elementId: imageRef })],
      stageId,
    );
  }

  it('stores bytes, then the reference, then finishes the task', async () => {
    serveImage();

    await runImageGeneration();

    expect(mocks.putAsset).toHaveBeenCalledTimes(1);
    const [storedBlob, storedMeta] = mocks.putAsset.mock.calls[0] as [
      Blob,
      { contentType: string },
    ];
    await expect(storedBlob.text()).resolves.toBe('server-image');
    expect(storedMeta).toEqual({ contentType: 'image/png' });

    expect(mocks.persistReference).toHaveBeenCalledWith(stageId, {
      placeholderRef: imageRef,
      assetId: 'ast_generated',
    });

    // The document holds the allocated id, so the task is re-keyed to it while
    // keeping the placeholder as the address the document used to carry.
    const tasks = useMediaGenerationStore.getState().tasks;
    expect(Object.keys(tasks)).toEqual(['ast_generated']);
    expect(tasks.ast_generated).toMatchObject({
      status: 'done',
      placeholderRef: imageRef,
      objectUrl: 'blob:server-1',
    });
  });

  it('caches the bytes locally under the allocated id, and survives a cache failure', async () => {
    serveImage();
    mocks.mediaPut.mockRejectedValue(new Error('quota exceeded'));

    await runImageGeneration();

    const row = mocks.mediaPut.mock.calls[0]![0] as { id: string; placeholderRef?: string };
    expect(row.id).toBe(`${stageId}:ast_generated`);
    expect(row.placeholderRef).toBe(imageRef);
    expect(useMediaGenerationStore.getState().tasks.ast_generated?.status).toBe('done');
  });

  it('writes no reference and keeps the placeholder when the pool rejects', async () => {
    serveImage();
    mocks.putAsset.mockRejectedValue(new Error('asset store unavailable'));

    await runImageGeneration();

    expect(mocks.persistReference).not.toHaveBeenCalled();
    expect(mocks.mediaPut).not.toHaveBeenCalled();
    expect(providerCallCount()).toBe(1);
    expect(useMediaGenerationStore.getState().tasks[imageRef]).toMatchObject({
      status: 'failed',
      error: 'asset store unavailable',
    });
    // Retryable: no structured error code, so nothing is persisted as a
    // permanent refusal and the next owner load tries again.
    expect(useMediaGenerationStore.getState().tasks[imageRef]?.errorCode).toBeUndefined();
  });

  it('keeps the placeholder and the task unfinished when the document write rejects', async () => {
    serveImage();
    mocks.persistReference.mockRejectedValue(
      new MediaReferenceWriteBackError(new Error('document write rejected'), false),
    );

    await runImageGeneration();

    expect(mocks.putAsset).toHaveBeenCalledTimes(1);
    expect(mocks.mediaPut).not.toHaveBeenCalled();
    expect(providerCallCount()).toBe(1);
    const tasks = useMediaGenerationStore.getState().tasks;
    expect(Object.keys(tasks)).toEqual([imageRef]);
    expect(tasks[imageRef]).toMatchObject({
      status: 'failed',
      error: 'document write rejected',
    });
  });

  it('issues no generation call for a scene whose reference is already allocated', async () => {
    serveImage();
    mocks.stageState.mockReturnValue({
      stage: { id: stageId },
      scenes: [sceneWithImage(1, 'ast_already_generated')],
      generationComplete: false,
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(0);
    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(useMediaGenerationStore.getState().tasks).toEqual({});
  });

  it('still generates while the scene that will carry the placeholder does not exist yet', async () => {
    serveImage();
    mocks.stageState.mockReturnValue({
      stage: { id: stageId },
      scenes: [],
      generationComplete: false,
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(1);
    expect(mocks.putAsset).toHaveBeenCalledTimes(1);
  });

  it('ignores a locally completed task whose document reference is still a placeholder', async () => {
    serveImage();
    useMediaGenerationStore.setState({
      tasks: {
        [imageRef]: {
          elementId: imageRef,
          type: 'image',
          status: 'done',
          prompt: 'A diagram',
          params: {},
          retryCount: 0,
          stageId,
        },
      },
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(1);
    expect(mocks.persistReference).toHaveBeenCalledTimes(1);
  });

  it('does not let another open course answer for this stage', async () => {
    serveImage();
    mocks.stageState.mockReturnValue({
      stage: { id: 'another-stage' },
      scenes: [sceneWithImage(1, 'ast_already_generated')],
      generationComplete: false,
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(1);
  });

  it('reclaims the allocation when nothing of the write-back reached the document', async () => {
    serveImage();
    mocks.persistReference.mockRejectedValue(
      new MediaReferenceWriteBackError(new Error('document write rejected'), false),
    );

    await runImageGeneration();

    // The registry row would otherwise outlive every reference to it, and the
    // byte collector only reclaims blobs that no row names.
    expect(mocks.removeAsset).toHaveBeenCalledWith('ast_generated');
  });

  it('keeps an allocation a partial write-back already put into the document', async () => {
    serveImage();
    mocks.persistReference.mockRejectedValue(
      new MediaReferenceWriteBackError(new Error('stage write rejected'), true),
    );

    await runImageGeneration();

    expect(mocks.removeAsset).not.toHaveBeenCalled();
  });

  it('holds the allocation when no slot for it exists yet', async () => {
    serveImage();
    mocks.persistReference.mockResolvedValue('unmatched');

    await runImageGeneration();

    expect(mocks.recordPendingAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ stageId, placeholderRef: imageRef, assetId: 'ast_generated' }),
    );
    // The task stays under the placeholder: the document still holds it, so
    // re-keying would hide the request from the very lookup that answers it.
    expect(Object.keys(useMediaGenerationStore.getState().tasks)).toEqual([imageRef]);
  });

  it('does not call the provider again for a placeholder whose bytes are already held', async () => {
    serveImage();
    mocks.pendingAllocation.mockReturnValue({
      stageId,
      placeholderRef: imageRef,
      assetId: 'ast_generated',
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(0);
    expect(mocks.putAsset).not.toHaveBeenCalled();
  });

  it('keeps a stored video when only its poster fails to store', async () => {
    serveVideo();
    mocks.stageState.mockReturnValue({
      stage: { id: stageId },
      scenes: [sceneWithImage(1, videoRef)],
      generationComplete: false,
    });
    mocks.putAsset.mockImplementation(async (blob: Blob) =>
      (await blob.text()) === 'poster'
        ? Promise.reject(new Error('poster store unavailable'))
        : 'ast_video',
    );

    await generateMediaForOutlines(
      [outlineWith(1, { type: 'video', prompt: 'A clip', elementId: videoRef })],
      stageId,
    );

    // The most expensive call in the system must not be thrown away by a
    // decorative poster.
    expect(mocks.persistReference).toHaveBeenCalledWith(stageId, {
      placeholderRef: videoRef,
      assetId: 'ast_video',
    });
    expect(useMediaGenerationStore.getState().tasks.ast_video?.status).toBe('done');
    expect(mocks.removeAsset).not.toHaveBeenCalled();
  });

  it('records a specific media type rather than a generic transfer type', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/generate/image') {
        return new Response(
          JSON.stringify({ success: true, result: { url: 'https://media.test/image' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(input) === '/api/proxy-media') {
        return new Response(new Blob(['bytes'], { type: 'application/octet-stream' }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    await runImageGeneration();

    expect(mocks.putAsset.mock.calls[0]![1]).toEqual({ contentType: 'image/png' });
  });

  it('honours a permanently failed task as a refusal to call the provider again', async () => {
    serveImage();
    useMediaGenerationStore.setState({
      tasks: {
        [imageRef]: {
          elementId: imageRef,
          type: 'image',
          status: 'failed',
          errorCode: 'CONTENT_SENSITIVE',
          prompt: 'A diagram',
          params: {},
          retryCount: 0,
          stageId,
        },
      },
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(0);
    expect(mocks.putAsset).not.toHaveBeenCalled();
  });
});
