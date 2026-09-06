/**
 * Media routinely finishes before the slide that asked for it exists.
 *
 * Images are generated from outlines in parallel with scene content and are
 * usually done first, so the write-back has no slot to rewrite. That is the
 * ordinary path of a first pass, not a tail case: if the allocation were
 * dropped there, every course would finish with placeholders in its document
 * and pay for the same media again on the next load. These tests drive that
 * ordering end to end — orchestrator, allocation registry, and the real stage
 * store's scene commit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  mediaPut: vi.fn(),
  mediaDelete: vi.fn(),
  putAsset: vi.fn(),
  removeAsset: vi.fn(),
  mutateDocument: vi.fn(),
  serverBacked: vi.fn(),
  saveStageDataIncremental: vi.fn(),
  saveStageData: vi.fn(),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settings },
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: { mediaFiles: { put: mocks.mediaPut, delete: mocks.mediaDelete } },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  putAsset: mocks.putAsset,
  removeAsset: mocks.removeAsset,
}));

// The write-back funnel itself is REAL here: its own decision is what parks the
// allocation, and the ordering between that decision and a scene arriving is
// exactly what these tests exist to pin. Only the document store is doubled.
vi.mock('@/lib/document-store', () => ({
  mutateDocument: mocks.mutateDocument,
}));

vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageDataIncremental: mocks.saveStageDataIncremental,
  saveStageData: mocks.saveStageData,
}));

import { generateMediaForOutlines, retryMediaTask } from '@/lib/media/media-orchestrator';
import { noteStageGenerationOwnership } from '@/lib/classroom/generation-permission';
import { clearPendingMediaAllocations } from '@/lib/media/pending-media-allocations';
import { applyKnownMediaAllocations } from '@/lib/media/reconcile-scene-media';
import { resetProxyMediaFailureCache } from '@/lib/media/proxy-media-cache';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useStageStore } from '@/lib/store/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const stageId = 'first-pass-stage';
const imageRef = 'gen_img_first';

function outline(): SceneOutline {
  return {
    id: 'outline-1',
    type: 'slide',
    title: 'Scene',
    description: 'Scene',
    keyPoints: ['media'],
    order: 1,
    mediaGenerations: [{ type: 'image', prompt: 'A diagram', elementId: imageRef }],
  };
}

function sceneWithImage(src: string): Scene {
  return {
    id: 'scene-1',
    stageId,
    title: 'Scene',
    order: 1,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: 'slide-1',
        elements: [{ type: 'image', id: 'image-1', left: 0, top: 0, width: 10, height: 10, src }],
      },
    },
  } as unknown as Scene;
}

function imageSrcOf(scene: Scene): string {
  return (scene as unknown as { content: { canvas: { elements: Array<{ src: string }> } } }).content
    .canvas.elements[0].src;
}

describe('media that finishes before its scene exists', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetProxyMediaFailureCache();
    clearPendingMediaAllocations();
    mocks.mediaPut.mockReset().mockResolvedValue(undefined);
    mocks.mediaDelete.mockReset().mockResolvedValue(undefined);
    mocks.putAsset.mockReset().mockResolvedValue('ast_first');
    mocks.removeAsset.mockReset().mockResolvedValue(undefined);
    // No document yet: the funnel finds nothing to rewrite, exactly as it does
    // while the first pass is still building the deck.
    mocks.mutateDocument
      .mockReset()
      .mockImplementation(
        async (_stageId: string, work: (doc: null, store: unknown) => Promise<void>) =>
          work(null, { putScene: vi.fn(), putStage: vi.fn() }),
      );
    mocks.serverBacked.mockReset().mockReturnValue(true);
    mocks.saveStageDataIncremental.mockReset().mockResolvedValue({ failedChanges: [] });
    mocks.saveStageData.mockReset().mockResolvedValue(undefined);
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
    useStageStore.setState({
      stage: { id: stageId, name: 'Course', createdAt: 0, updatedAt: 0 } as never,
      scenes: [],
      outlines: [],
      generatingOutlines: [],
      currentSceneId: null,
      generationComplete: false,
    });

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:first-1'),
      revokeObjectURL: vi.fn(),
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/generate/image') {
        return new Response(
          JSON.stringify({ success: true, result: { url: 'https://media.test/image' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(input) === '/api/proxy-media') {
        return new Response(new Blob(['first-image'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    clearPendingMediaAllocations();
    resetProxyMediaFailureCache();
    useStageStore.setState({ stage: null, scenes: [] });
    vi.unstubAllGlobals();
  });

  function providerCalls(): number {
    return fetchMock.mock.calls.filter(([input]) => String(input) === '/api/generate/image').length;
  }

  it('holds the allocation instead of dropping it, and refuses to pay twice', async () => {
    await generateMediaForOutlines([outline()], stageId);
    expect(providerCalls()).toBe(1);
    expect(mocks.putAsset).toHaveBeenCalledTimes(1);

    // A second pass in the same run — the retry path re-enters generation with
    // every outline — must recognise the request as already answered.
    await generateMediaForOutlines([outline()], stageId);
    expect(providerCalls()).toBe(1);
    expect(mocks.putAsset).toHaveBeenCalledTimes(1);
  });

  it('rewrites the scene when it is committed, before its first save', async () => {
    await generateMediaForOutlines([outline()], stageId);

    const scene = sceneWithImage(imageRef);
    useStageStore.getState().addScene(scene);

    // The store holds the allocated id, so the structure save that follows this
    // commit can only ever write the id.
    expect(imageSrcOf(useStageStore.getState().scenes[0])).toBe('ast_first');
    // The task moved onto the allocated id, exactly as it does when the slot
    // already existed at write-back time.
    const tasks = useMediaGenerationStore.getState().tasks;
    expect(Object.keys(tasks)).toEqual(['ast_first']);
    expect(tasks.ast_first).toMatchObject({ status: 'done', placeholderRef: imageRef });
  });

  // The reported interleaving: the scene is committed while the commit is still
  // inside its awaited cache write, so its own reconciliation ran against a
  // registry that did not hold the entry yet.
  it('reconciles a scene that arrives during the commit itself', async () => {
    mocks.mediaPut.mockImplementation(async () => {
      useStageStore.getState().addScene(sceneWithImage(imageRef));
    });

    await generateMediaForOutlines([outline()], stageId);

    expect(providerCalls()).toBe(1);
    expect(imageSrcOf(useStageStore.getState().scenes[0])).toBe('ast_first');
    // Nothing is left parked for a scene that will never be added again.
    await generateMediaForOutlines([outline()], stageId);
    expect(providerCalls()).toBe(1);
  });

  // The other half of the same race: the scene lands while the document round
  // trip is in flight, so its own reconciliation runs before the allocation
  // exists. The funnel's live check, which runs after the round trip, is what
  // catches it — the allocation is placed rather than parked.
  it('places the allocation on a scene that arrived while the round trip was in flight', async () => {
    mocks.mutateDocument.mockImplementation(
      async (_stageId: string, work: (doc: null, store: unknown) => Promise<void>) => {
        useStageStore.getState().addScene(sceneWithImage(imageRef));
        await work(null, { putScene: vi.fn(), putStage: vi.fn() });
      },
    );

    await generateMediaForOutlines([outline()], stageId);

    expect(imageSrcOf(useStageStore.getState().scenes[0])).toBe('ast_first');
    await generateMediaForOutlines([outline()], stageId);
    expect(providerCalls()).toBe(1);
  });

  it('leaves the allocation alone for a scene that does not carry its placeholder', async () => {
    await generateMediaForOutlines([outline()], stageId);

    useStageStore
      .getState()
      .addScene({ ...sceneWithImage('gen_img_other'), id: 'scene-2' } as Scene);

    expect(imageSrcOf(useStageStore.getState().scenes[0])).toBe('gen_img_other');
    // Still held, so the slide it belongs to can still claim it.
    await generateMediaForOutlines([outline()], stageId);
    expect(providerCalls()).toBe(1);
  });

  // An ambiguous write failure parks the allocation for a scene that already
  // exists, so no `addScene` will ever drain it. The next pass's entry drain is
  // what places it — and the provider is not asked again on the way.
  it('places an allocation parked by a failed write-back on the next pass', async () => {
    // The document holds the slide, so a write IS issued; its response is lost.
    // A rejection proves nothing about what the server applied, so the id must
    // survive.
    mocks.mutateDocument.mockImplementation(
      async (
        _stageId: string,
        work: (doc: unknown, store: unknown) => Promise<void>,
      ): Promise<void> =>
        work(
          { stage: { id: stageId, whiteboard: [] }, scenes: [sceneWithImage(imageRef)] },
          {
            putScene: vi.fn().mockRejectedValue(new Error('socket hang up')),
            putStage: vi.fn(),
          },
        ),
    );
    useStageStore.setState({ scenes: [] });

    await generateMediaForOutlines([outline()], stageId);
    expect(providerCalls()).toBe(1);
    // Nothing was reclaimed: the write may well have landed.
    expect(mocks.removeAsset).not.toHaveBeenCalled();

    // The slide exists by the time the next pass runs.
    useStageStore.setState({ scenes: [sceneWithImage(imageRef)] });
    mocks.mutateDocument.mockImplementation(
      async (_stageId: string, work: (doc: null, store: unknown) => Promise<void>) =>
        work(null, { putScene: vi.fn(), putStage: vi.fn() }),
    );

    await generateMediaForOutlines([outline()], stageId);

    expect(imageSrcOf(useStageStore.getState().scenes[0])).toBe('ast_first');
    expect(providerCalls()).toBe(1);
  });

  // The record outlives the parked queue, so a record left behind after a
  // reclaim would let the write boundary stamp an id whose bytes are gone —
  // and the placeholder it replaced would be gone with it, which reads as
  // "already generated" and stops anything from retrying.
  it('forgets an allocation whose bytes it reclaimed, so the placeholder survives', async () => {
    // Nothing was ever written, and no slide exists, so the commit reclaims.
    mocks.mutateDocument.mockRejectedValue(new Error('document lock unavailable'));
    useStageStore.setState({ scenes: [] });

    await generateMediaForOutlines([outline()], stageId);
    expect(mocks.removeAsset).toHaveBeenCalledWith('ast_first');

    // The slide arrives afterwards and is committed, then saved.
    const scene = sceneWithImage(imageRef);
    useStageStore.getState().addScene(scene);
    const applied = applyKnownMediaAllocations(stageId, null, [scene]);

    // Neither the commit nor the write boundary may resurrect the deleted id.
    expect(imageSrcOf(useStageStore.getState().scenes[0])).toBe(imageRef);
    expect(applied).toBeNull();

    // And the request is recoverable: the task is failed without a structured
    // code, which is what draws the Retry affordance.
    const task = useMediaGenerationStore.getState().tasks[imageRef];
    expect(task?.status).toBe('failed');
    expect(task?.errorCode).toBeUndefined();

    mocks.mutateDocument.mockImplementation(
      async (_stageId: string, work: (doc: null, store: unknown) => Promise<void>) =>
        work(null, { putScene: vi.fn(), putStage: vi.fn() }),
    );
    noteStageGenerationOwnership(stageId, 'owner');
    await retryMediaTask(imageRef);

    expect(providerCalls()).toBe(2);
  });

  it('does nothing in browser-only mode', async () => {
    mocks.serverBacked.mockReturnValue(false);
    useStageStore.getState().addScene(sceneWithImage(imageRef));
    expect(imageSrcOf(useStageStore.getState().scenes[0])).toBe(imageRef);
  });
});
