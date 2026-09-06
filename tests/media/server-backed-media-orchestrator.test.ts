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
  persistReference: vi.fn(),
  serverBacked: vi.fn(),
  stageState: vi.fn(),
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
}));

vi.mock('@/lib/media/persist-media-reference', () => ({
  persistGeneratedMediaReference: mocks.persistReference,
}));

vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
}));

import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { resetProxyMediaFailureCache } from '@/lib/media/proxy-media-cache';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const stageId = 'server-stage';
const imageRef = 'gen_img_server';

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
    mocks.persistReference.mockReset().mockResolvedValue('written');
    mocks.serverBacked.mockReset().mockReturnValue(true);
    mocks.stageState.mockReset().mockReturnValue({
      stage: { id: stageId },
      scenes: [sceneWithImage(1, imageRef)],
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
    mocks.persistReference.mockRejectedValue(new Error('document write rejected'));

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
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(0);
    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(useMediaGenerationStore.getState().tasks).toEqual({});
  });

  it('still generates while the scene that will carry the placeholder does not exist yet', async () => {
    serveImage();
    mocks.stageState.mockReturnValue({ stage: { id: stageId }, scenes: [] });

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
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(1);
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
