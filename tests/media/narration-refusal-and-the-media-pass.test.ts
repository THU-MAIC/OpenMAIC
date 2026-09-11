/**
 * A narration clip that does not fit must not stop a course generating images.
 *
 * The two paths share one device-local flag, and for a while both of them wrote
 * it. They should not: the flag means "do not call a provider for this course",
 * which is a claim about money. The media pass is entitled to make it, because
 * every element it attempts costs a provider call. Narration adoption is not:
 * it uploads bytes this browser already holds, so a refusal costs it nothing
 * and tells it nothing about whether a slide's image would fit — the store
 * checks each write against the headroom it has left, so one over-long clip is
 * a fact about that clip.
 *
 * When adoption did write it, a single over-large narration clip stood the
 * course's whole image pass down on every later load, on a store that was
 * demonstrably accepting writes. Both halves are loaded for real here, because
 * the defect lived in what one told the other rather than in either alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mutateDocument: vi.fn(),
  saveStageData: vi.fn(),
  saveStageDataIncremental: vi.fn(),
  putAsset: vi.fn(),
  removeAsset: vi.fn(),
  audioGet: vi.fn(),
  audioPut: vi.fn(),
  mediaPut: vi.fn(),
  mediaGet: vi.fn(),
  mediaDelete: vi.fn(),
  persistReference: vi.fn(),
  placeAllocations: vi.fn(),
  pendingAllocation: vi.fn(),
  forgetAllocation: vi.fn(),
  serverBacked: vi.fn(),
  settings: vi.fn(),
}));

vi.mock('@/lib/document-store', () => ({ mutateDocument: mocks.mutateDocument }));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: mocks.saveStageData,
  saveStageDataIncremental: mocks.saveStageDataIncremental,
}));
vi.mock('@/lib/media/asset-pool', () => ({
  putAsset: mocks.putAsset,
  removeAsset: mocks.removeAsset,
}));
vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    audioFiles: { get: mocks.audioGet, put: mocks.audioPut },
    mediaFiles: {
      put: mocks.mediaPut,
      get: mocks.mediaGet,
      delete: mocks.mediaDelete,
      where: () => ({ equals: () => ({ toArray: async () => [] }) }),
    },
  },
}));
vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settings },
}));
vi.mock('@/lib/media/persist-media-reference', async () => {
  const actual = await vi.importActual<typeof import('@/lib/media/persist-media-reference')>(
    '@/lib/media/persist-media-reference',
  );
  return {
    ...actual,
    persistGeneratedMediaReference: mocks.persistReference,
    placePendingMediaAllocations: mocks.placeAllocations,
  };
});
vi.mock('@/lib/media/pending-media-allocations', () => ({
  pendingMediaAllocation: mocks.pendingAllocation,
  forgetMediaAllocation: mocks.forgetAllocation,
  takePendingMediaAllocations: vi.fn(() => []),
}));

import { adoptCachedNarration } from '@/lib/audio/adopt-cached-narration';
import {
  isAssetStorageFull,
  setAssetStorageFullStoreForTests,
} from '@/lib/media/asset-storage-full';
import {
  noteStageGenerationOwnership,
  resetGenerationPermissionsForTests,
} from '@/lib/classroom/generation-permission';
import { generateMediaForOutlines, resetMediaPassesForTests } from '@/lib/media/media-orchestrator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useStageStore } from '@/lib/store/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const stageId = 'shared-ceiling-course';
const imageRef = 'gen_img_slide_1';
/** A generated action id, so the derived key names exactly one clip. */
const longRef = 'tts_s1_action_aaaaaaaa';
const shortRef = 'tts_s1_action_bbbbbbbb';

/** The headroom the store has left: room for the short clip and the image. */
const HEADROOM = 1000;

/**
 * The short clip is named FIRST on purpose. A load that stores something and
 * then meets a clip that does not fit is the ordering in which "adoption
 * remembers a refusal" is visible whether it remembers at the refusal or at the
 * end of the load: either way the last word is a refusal.
 */
function scene(long = longRef, short = shortRef, src = imageRef): Scene {
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
        elements: [{ type: 'image', id: 'image-1', left: 0, top: 0, width: 100, height: 100, src }],
      },
    },
    actions: [
      { id: 'action_bbbbbbbb', type: 'speech', text: 'Short', audioId: short },
      { id: 'action_aaaaaaaa', type: 'speech', text: 'A long line', audioId: long },
    ],
  } as unknown as Scene;
}

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

function memoryKv() {
  const entries = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => (entries.get(key) as T) ?? null,
    set: async (key: string, value: unknown) => {
      entries.set(key, value);
    },
    remove: async (key: string) => {
      entries.delete(key);
    },
    keys: async (prefix = '') => [...entries.keys()].filter((key) => key.startsWith(prefix)),
  };
}

function providerCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([input]) => String(input) === '/api/generate/image').length;
}

describe('a narration clip that does not fit, and the course that still needs images', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setAssetStorageFullStoreForTests(memoryKv());
    resetGenerationPermissionsForTests();
    resetMediaPassesForTests();
    noteStageGenerationOwnership(stageId, 'owner');
    mocks.serverBacked.mockReset().mockReturnValue(true);
    mocks.saveStageData.mockReset().mockResolvedValue(undefined);
    mocks.saveStageDataIncremental.mockReset().mockResolvedValue(undefined);
    mocks.audioPut.mockReset().mockResolvedValue(undefined);
    mocks.mediaPut.mockReset().mockResolvedValue(undefined);
    mocks.mediaGet.mockReset().mockResolvedValue(undefined);
    mocks.mediaDelete.mockReset().mockResolvedValue(undefined);
    mocks.removeAsset.mockReset().mockResolvedValue(undefined);
    mocks.persistReference.mockReset().mockResolvedValue('written');
    mocks.placeAllocations.mockReset().mockReturnValue(false);
    mocks.pendingAllocation.mockReset().mockReturnValue(undefined);
    mocks.forgetAllocation.mockReset();
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

    // The rows a course narrated before allocation existed actually has: the
    // derived key, no stage, no text -- and wildly different sizes.
    mocks.audioGet.mockReset().mockImplementation(async (id: string) => ({
      id,
      blob: new Blob([id === longRef ? 'x'.repeat(5000) : 'y'.repeat(100)], { type: 'audio/mp3' }),
      duration: 2,
      format: 'mp3',
      createdAt: 0,
    }));
    mocks.mutateDocument
      .mockReset()
      .mockImplementation(
        async (_id: string, work: (document: unknown, store: unknown) => Promise<void>) => {
          await work(
            { scenes: [scene()], stage: { id: stageId } },
            { putScene: vi.fn().mockResolvedValue(undefined), putStage: vi.fn() },
          );
        },
      );

    // The store's real rule: `used + addedBytes > quotaBytes`, per write.
    let used = 0;
    let allocated = 0;
    mocks.putAsset.mockReset().mockImplementation(async (blob: Blob) => {
      if (used + blob.size > HEADROOM) {
        throw Object.assign(new Error('asset quota exceeded for this principal'), {
          status: 507,
          code: 'ASSET_QUOTA_EXCEEDED',
        });
      }
      used += blob.size;
      return `ast_${(allocated += 1)}`;
    });

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:generated'),
      revokeObjectURL: vi.fn(),
    });
    fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/generate/image') {
        return new Response(
          JSON.stringify({ success: true, result: { url: 'https://media.test/image' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(input) === '/api/proxy-media') {
        return new Response(new Blob(['tiny-image'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    useStageStore.setState({
      stage: { id: stageId, name: 'Course' } as never,
      scenes: [scene()],
      generationComplete: false,
    } as never);
  });

  afterEach(() => {
    setAssetStorageFullStoreForTests(undefined);
    resetGenerationPermissionsForTests();
    resetMediaPassesForTests();
    useStageStore.setState({ stage: null, scenes: [] });
    vi.unstubAllGlobals();
  });

  it('leaves the image pass free to run on the next load', async () => {
    // Load one: the short clip is stored, the long one does not fit.
    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 1, unbacked: 1 });
    await expect(isAssetStorageFull(stageId)).resolves.toBe(false);

    // Load two: the pass has no reason to stand down, and the image is small
    // enough for the room that is left.
    resetMediaPassesForTests();
    useMediaGenerationStore.setState({ tasks: {} });

    await generateMediaForOutlines([outline()], stageId);

    expect(providerCalls(fetchMock)).toBe(1);
    expect(mocks.persistReference).toHaveBeenCalledWith(
      expect.objectContaining({ stageId, placeholderRef: imageRef }),
    );
    const tasks = useMediaGenerationStore.getState().tasks;
    expect(Object.values(tasks).some((task) => task.status === 'done')).toBe(true);
  });

  // The other direction, which is the one the flag is for: a refusal that DID
  // cost a provider call is remembered, and adoption does not clear it by
  // failing to store something.
  it('still lets a refused image stand the next pass down', async () => {
    // No room for anything: the image is refused after it was generated.
    mocks.putAsset.mockReset().mockRejectedValue(
      Object.assign(new Error('asset quota exceeded for this principal'), {
        status: 507,
        code: 'ASSET_QUOTA_EXCEEDED',
      }),
    );

    await generateMediaForOutlines([outline()], stageId);
    expect(providerCalls(fetchMock)).toBe(1);
    await expect(isAssetStorageFull(stageId)).resolves.toBe(true);

    // Adoption runs anyway -- it is free -- and its own refusals leave the
    // media pass's memory of a paid-for refusal exactly as it was.
    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 2 });
    await expect(isAssetStorageFull(stageId)).resolves.toBe(true);

    resetMediaPassesForTests();
    useMediaGenerationStore.setState({ tasks: {} });
    await generateMediaForOutlines([outline()], stageId);

    // Still one: the pass stood down rather than buying a second refusal.
    expect(providerCalls(fetchMock)).toBe(1);
  });
});
