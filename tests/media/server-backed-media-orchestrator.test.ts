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
  forgetAllocation: vi.fn(),
  placeAllocations: vi.fn(),
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
  return {
    ...actual,
    persistGeneratedMediaReference: mocks.persistReference,
    placePendingMediaAllocations: mocks.placeAllocations,
  };
});

vi.mock('@/lib/media/pending-media-allocations', () => ({
  pendingMediaAllocation: mocks.pendingAllocation,
  forgetMediaAllocation: mocks.forgetAllocation,
}));

vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
}));

import {
  generateMediaForOutlines,
  resetMediaPassesForTests,
  retryMediaTask,
} from '@/lib/media/media-orchestrator';
import { noteStageGenerationOwnership } from '@/lib/classroom/generation-permission';
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
    resetMediaPassesForTests();
    resetProxyMediaFailureCache();
    mocks.mediaPut.mockReset().mockResolvedValue(undefined);
    mocks.mediaDelete.mockReset().mockResolvedValue(undefined);
    mocks.putAsset.mockReset().mockResolvedValue('ast_generated');
    mocks.removeAsset.mockReset().mockResolvedValue(undefined);
    mocks.persistReference.mockReset().mockResolvedValue('written');
    mocks.pendingAllocation.mockReset().mockReturnValue(undefined);
    mocks.forgetAllocation.mockReset();
    mocks.placeAllocations.mockReset().mockReturnValue(false);
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
    resetMediaPassesForTests();
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

    expect(mocks.persistReference).toHaveBeenCalledWith(
      expect.objectContaining({ stageId, placeholderRef: imageRef, assetId: 'ast_generated' }),
    );

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

  // The document is the authority, and here it cannot be read: the live store
  // has moved to another course. Falling back to the task table would demote
  // "the document decides" to "this browser's table decides" on exactly the
  // path where that table has just been cleared, so every element the previous
  // pass committed would be generated again. Not deciding is the safe answer.
  it('stands down when it cannot read the document for its own stage', async () => {
    serveImage();
    mocks.stageState.mockReturnValue({
      stage: { id: 'another-stage' },
      scenes: [sceneWithImage(1, 'ast_already_generated')],
      generationComplete: false,
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(0);
    expect(mocks.putAsset).not.toHaveBeenCalled();
    // Nothing was seeded into the arriving course's task table either.
    expect(useMediaGenerationStore.getState().tasks).toEqual({});
  });

  // A pass deferred behind its predecessor can wake up after the user has left.
  // Enqueueing then would seed the ARRIVING course's table — placeholder ids
  // are not unique across courses — with tasks carrying this course's stage id,
  // and a Retry routes by that id, into the wrong document.
  it('touches nothing when it wakes up aborted', async () => {
    serveImage();
    const aborted = new AbortController();
    aborted.abort();

    await generateMediaForOutlines(
      [outlineWith(1, { type: 'image', prompt: 'A diagram', elementId: imageRef })],
      stageId,
      aborted.signal,
    );

    expect(providerCallCount()).toBe(0);
    expect(useMediaGenerationStore.getState().tasks).toEqual({});
  });

  it('reclaims the allocation only when the funnel says nothing can hold it', async () => {
    serveImage();
    mocks.persistReference.mockRejectedValue(
      new MediaReferenceWriteBackError(new Error('document write rejected'), false),
    );

    await runImageGeneration();

    // The registry row would otherwise outlive every reference to it, and the
    // byte collector only reclaims blobs that no row names.
    expect(mocks.removeAsset).toHaveBeenCalledWith('ast_generated');
    // ...and the record goes with the bytes, or a later save would stamp an id
    // that no longer resolves and the placeholder would be gone with it.
    expect(mocks.forgetAllocation).toHaveBeenCalledWith(stageId, imageRef);
  });

  // A refused deletion — the normal case in a deployment that has not opted into
  // the development authenticator — must cost the task nothing. The refusal is
  // swallowed by `reclaimAsset`, not by the caller's own catch, so a rejection
  // that escaped it would surface as the task's error instead of the
  // write-back's, and the retryable state would be about the wrong failure.
  it('does not fail the task when the deployment refuses the reclaim', async () => {
    serveImage();
    mocks.persistReference.mockRejectedValue(
      new MediaReferenceWriteBackError(new Error('document write rejected'), false),
    );
    mocks.removeAsset.mockRejectedValue(new Error('403 forbidden'));

    await runImageGeneration();

    expect(mocks.removeAsset).toHaveBeenCalledWith('ast_generated');
    // The task keeps the write-back's own error, not the reclaim's.
    expect(useMediaGenerationStore.getState().tasks[imageRef]).toMatchObject({
      status: 'failed',
      error: 'document write rejected',
    });
    expect(useMediaGenerationStore.getState().tasks[imageRef]?.errorCode).toBeUndefined();
    // Forgotten before the deletion is attempted, so a refusal still leaves the
    // placeholder intact and the request open.
    expect(mocks.forgetAllocation).toHaveBeenCalledWith(stageId, imageRef);
    expect(mocks.forgetAllocation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeAsset.mock.invocationCallOrder[0],
    );
  });

  it('keeps an allocation the funnel says it retained', async () => {
    serveImage();
    mocks.persistReference.mockRejectedValue(
      new MediaReferenceWriteBackError(new Error('stage write rejected'), true),
    );

    await runImageGeneration();

    expect(mocks.removeAsset).not.toHaveBeenCalled();
  });

  it('leaves a held allocation keyed by the placeholder the document still carries', async () => {
    serveImage();
    mocks.persistReference.mockResolvedValue('held');

    await runImageGeneration();

    // Re-keying would hide the request from the very lookup that answers it.
    expect(Object.keys(useMediaGenerationStore.getState().tasks)).toEqual([imageRef]);
    expect(useMediaGenerationStore.getState().tasks[imageRef]?.status).toBe('done');
  });

  it('hands parked allocations to their slides before deciding what to generate', async () => {
    serveImage();

    await runImageGeneration();

    expect(mocks.placeAllocations).toHaveBeenCalledWith(stageId);
  });

  // Passes for one course are serial, and serialization is an ordering property:
  // the assertion is that a second pass issues nothing at all while the first
  // is still working. Counting calls at the end cannot distinguish waiting from
  // being skipped for some other reason, so this observes the timing directly.
  it('issues nothing while another pass for the same course is still working', async () => {
    const refs = ['gen_img_1', 'gen_img_2'];
    mocks.stageState.mockReturnValue({
      stage: { id: stageId },
      scenes: refs.map((ref, index) => sceneWithImage(index + 1, ref)),
      generationComplete: false,
    });
    const outlines = refs.map((ref, index) =>
      outlineWith(index + 1, { type: 'image', prompt: `p${index}`, elementId: ref }),
    );
    serveImage();

    let releaseCommit: (() => void) | undefined;
    const commitInFlight = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let overlapping: Promise<void> | undefined;
    let callsWhenOverlappingStarted = 0;
    // The retry path re-enters generation while the first pass is mid-commit.
    mocks.putAsset.mockImplementation(async () => {
      if (!overlapping) {
        // Captured BEFORE the second pass is launched: without serialization its
        // collection loop is synchronous and would have fired by the time the
        // call returns.
        callsWhenOverlappingStarted = providerCallCount();
        overlapping = generateMediaForOutlines(outlines, stageId);
        await commitInFlight;
      }
      return 'ast_generated';
    });

    const first = generateMediaForOutlines(outlines, stageId);
    // Give the second pass every chance to run: if it were not waiting, its
    // collection loop is synchronous and element two is only `pending`, so it
    // would have called the provider by now.
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
    expect(providerCallCount()).toBe(callsWhenOverlappingStarted);

    releaseCommit?.();
    await first;
    await overlapping;
  });

  // The handoff the retry path actually performs: abort the live pass and start
  // its replacement in the same synchronous block, long before the aborted
  // pass's cleanup can run. Kept alongside the timing test above because it
  // catches a different rule — `pending` being read as answered, which is what
  // stranded elements in earlier designs and which nothing else here covers.
  it('picks up every element an aborted pass never reached', async () => {
    const refs = ['gen_img_1', 'gen_img_2', 'gen_img_3'];
    mocks.stageState.mockReturnValue({
      stage: { id: stageId },
      scenes: refs.map((ref, index) => sceneWithImage(index + 1, ref)),
      generationComplete: false,
    });
    const outlines = refs.map((ref, index) =>
      outlineWith(index + 1, { type: 'image', prompt: 'A diagram', elementId: ref }),
    );

    let allocated = 0;
    mocks.putAsset.mockImplementation(async () => `ast_${(allocated += 1)}`);
    let releaseFirst: (() => void) | undefined;
    const firstInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/generate/image') {
        calls += 1;
        if (calls === 1) {
          await firstInFlight;
          throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        }
        return new Response(
          JSON.stringify({ success: true, result: { url: 'https://media.test/image' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/proxy-media') {
        return new Response(new Blob(['image'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const first = new AbortController();
    const pass1 = generateMediaForOutlines(outlines, stageId, first.signal).catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    // Verbatim what the retry path does, in one synchronous block.
    first.abort();
    const second = new AbortController();
    const pass2 = generateMediaForOutlines(outlines, stageId, second.signal).catch(() => undefined);

    releaseFirst?.();
    await pass1;
    await pass2;

    // The replacement waited for the aborted pass to settle, then took the two
    // elements it never reached. The one whose call was actually cancelled is
    // failed and retryable — an affordance, not a strand — and nothing is left
    // waiting on a pass that no longer exists.
    expect(mocks.putAsset).toHaveBeenCalledTimes(2);
    const tasks = useMediaGenerationStore.getState().tasks;
    expect(Object.values(tasks).some((task) => task.status === 'pending')).toBe(false);
    expect(tasks[refs[0]]).toMatchObject({ status: 'failed' });
    expect(tasks[refs[0]]?.errorCode).toBeUndefined();
  });

  it('honours a Retry clicked while the pass that failed the element is still running', async () => {
    const refs = ['gen_img_1', 'gen_img_2'];
    mocks.stageState.mockReturnValue({
      stage: { id: stageId },
      scenes: refs.map((ref, index) => sceneWithImage(index + 1, ref)),
      generationComplete: false,
    });
    let allocated = 0;
    mocks.putAsset.mockImplementation(async () => `ast_${(allocated += 1)}`);
    noteStageGenerationOwnership(stageId, 'owner');

    let releaseSecond: (() => void) | undefined;
    const secondInFlight = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const prompts: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/generate/image') {
        const { prompt } = JSON.parse(String(init?.body)) as { prompt: string };
        prompts.push(prompt);
        // The first element fails transiently; the second holds the pass open.
        if (prompt === 'one' && prompts.filter((p) => p === 'one').length === 1) {
          return new Response(JSON.stringify({ success: false, error: 'transient' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (prompt === 'two') await secondInFlight;
        return new Response(
          JSON.stringify({ success: true, result: { url: 'https://media.test/image' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/proxy-media') {
        return new Response(new Blob(['image'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const pass = generateMediaForOutlines(
      [
        outlineWith(1, { type: 'image', prompt: 'one', elementId: refs[0] }),
        outlineWith(2, { type: 'image', prompt: 'two', elementId: refs[1] }),
      ],
      stageId,
    );
    // Let element one fail and element two start.
    for (let tick = 0; tick < 40; tick += 1) await Promise.resolve();
    expect(useMediaGenerationStore.getState().tasks[refs[0]]?.status).toBe('failed');

    const retried = retryMediaTask(refs[0]);
    releaseSecond?.();
    await Promise.all([pass, retried]);

    // The click produced exactly one extra provider call, and the element ended
    // stored rather than stuck.
    expect(prompts.filter((prompt) => prompt === 'one')).toHaveLength(2);
    const tasks = useMediaGenerationStore.getState().tasks;
    expect(Object.values(tasks).some((task) => task.status === 'pending')).toBe(false);
    expect(Object.values(tasks).filter((task) => task.status === 'done')).toHaveLength(2);
  });

  // The retry reads the task again after its own await, and refuses BEFORE
  // touching it. Marking first and refusing afterwards destroys the failed
  // state that draws the affordance, leaving the element pending with nothing
  // able to recover it.
  it('refuses a stale retry without destroying the state that offers it', async () => {
    serveImage();
    noteStageGenerationOwnership(stageId, 'owner');
    useMediaGenerationStore.setState({
      tasks: {
        [imageRef]: {
          elementId: imageRef,
          type: 'image',
          status: 'failed',
          prompt: 'A diagram',
          params: {},
          error: 'transient',
          retryCount: 0,
          stageId,
        },
      },
    });
    // Something else takes the element while the retry is clearing its row.
    mocks.mediaDelete.mockImplementation(async () => {
      useMediaGenerationStore.getState().markGenerating(imageRef);
    });

    await retryMediaTask(imageRef);

    expect(providerCallCount()).toBe(0);
    // Untouched: still owned by whoever is generating it.
    expect(useMediaGenerationStore.getState().tasks[imageRef]?.status).toBe('generating');
  });

  // A retry that is actually running must be visible to a pass starting
  // alongside it, or both call the provider for the same element.
  it('does not let an overlapping pass duplicate a retry already in flight', async () => {
    let releaseRetry: (() => void) | undefined;
    const retryInFlight = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let calls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/generate/image') {
        calls += 1;
        await retryInFlight;
        return new Response(
          JSON.stringify({ success: true, result: { url: 'https://media.test/image' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/proxy-media') {
        return new Response(new Blob(['image'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    useMediaGenerationStore.setState({
      tasks: {
        [imageRef]: {
          elementId: imageRef,
          type: 'image',
          status: 'failed',
          prompt: 'A diagram',
          params: {},
          error: 'transient',
          retryCount: 0,
          stageId,
        },
      },
    });
    noteStageGenerationOwnership(stageId, 'owner');

    const retrying = retryMediaTask(imageRef);
    await Promise.resolve();
    await Promise.resolve();

    await runImageGeneration();
    releaseRetry?.();
    await retrying;

    expect(calls).toBe(1);
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
    expect(mocks.persistReference).toHaveBeenCalledWith(
      expect.objectContaining({ stageId, placeholderRef: videoRef, assetId: 'ast_video' }),
    );
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
