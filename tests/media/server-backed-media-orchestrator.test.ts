/**
 * Server-backed media Retry ordering, for a course no generation run follows.
 *
 * A durable, shared document may only ever name bytes that were already
 * stored, so the order inside one task is fixed: provider, then pool, then the
 * document, then the task. These tests pin each hinge of that order — including
 * both failure modes, where the placeholder must survive and the provider must
 * not be called a second time for bytes already held.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setModelSettingsViewForTests } from '../helpers/model-settings-view';

const mocks = vi.hoisted(() => ({
  mediaPut: vi.fn(),
  mediaDelete: vi.fn(),
  mediaGet: vi.fn(),
  mediaRows: [] as Record<string, unknown>[],
  putAsset: vi.fn(),
  removeAsset: vi.fn(),
  persistReference: vi.fn(),
  stageState: vi.fn(),
  pendingAllocation: vi.fn(),
  forgetAllocation: vi.fn(),
  takeAllocations: vi.fn(),
  mediaWhere: vi.fn(),
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: mocks.stageState },
}));

vi.mock('@/lib/device-storage/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    mediaFiles: {
      put: mocks.mediaPut,
      delete: mocks.mediaDelete,
      get: mocks.mediaGet,
      // The stage-scoped fallback the placeholder-keyed lookup falls back to.
      // A spy, because whether a retry reaches for it is the subject of one of
      // the cases below.
      where: mocks.mediaWhere,
    },
  },
}));

/** The pool is doubled at the store rather than at `putAsset`, so the real wrapper runs. */
vi.mock('@/lib/media/asset-pool-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/asset-pool-config')>();
  return {
    ...actual,
    resolveConfiguredAssetPoolStore: () =>
      ({
        put: mocks.putAsset,
      }) as unknown as import('@/lib/media/asset-pool-config').AssetPoolStore,
  };
});

vi.mock('@/lib/media/persist-media-reference', async () => {
  const actual = await vi.importActual<typeof import('@/lib/media/persist-media-reference')>(
    '@/lib/media/persist-media-reference',
  );
  return {
    ...actual,
    persistGeneratedMediaReference: mocks.persistReference,
  };
});

vi.mock('@/lib/media/pending-media-allocations', () => ({
  pendingMediaAllocation: mocks.pendingAllocation,
  forgetMediaAllocation: mocks.forgetAllocation,
  takePendingMediaAllocations: mocks.takeAllocations,
}));

import { retryMediaTask } from '@/lib/media/media-orchestrator';
import { noteStageGenerationOwnership } from '@/lib/classroom/generation-permission';
import { isRetryableMediaFailure } from '@/lib/media/media-failure';
import { MediaReferenceWriteBackError } from '@/lib/media/persist-media-reference';
import { resetProxyMediaFailureCache } from '@/lib/media/proxy-media-cache';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import type { Scene } from '@/lib/types/stage';

const stageId = 'server-stage';
const imageRef = 'gen_img_server';
const videoRef = 'gen_vid_server';

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

describe('server-backed media retry', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetProxyMediaFailureCache();
    mocks.mediaPut.mockReset().mockResolvedValue(undefined);
    mocks.mediaDelete.mockReset().mockResolvedValue(undefined);
    mocks.mediaGet.mockReset().mockResolvedValue(undefined);
    mocks.mediaRows.length = 0;
    mocks.putAsset.mockReset().mockResolvedValue('ast_generated');
    mocks.removeAsset.mockReset().mockResolvedValue(undefined);
    mocks.persistReference.mockReset().mockResolvedValue('written');
    mocks.pendingAllocation.mockReset().mockReturnValue(undefined);
    mocks.forgetAllocation.mockReset();
    mocks.takeAllocations.mockReset().mockReturnValue([]);
    mocks.mediaWhere.mockReset().mockImplementation((index: string) => ({
      equals: (value: unknown) => ({
        toArray: async () =>
          mocks.mediaRows.filter((row) => (row as Record<string, unknown>)[index] === value),
      }),
    }));
    mocks.stageState.mockReset().mockReturnValue({
      stage: { id: stageId },
      scenes: [sceneWithImage(1, imageRef)],
      generationComplete: false,
    });
    // The workspace's image and video slots resolve to a provider.
    setModelSettingsViewForTests({
      image: { registryId: 'seedream' },
      video: { registryId: 'seedance' },
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

  /** The failed, retryable task a Retry acts on. */
  function failedTask() {
    return {
      elementId: imageRef,
      type: 'image' as const,
      status: 'failed' as const,
      prompt: 'A diagram',
      params: {},
      retryCount: 0,
      stageId,
      error: 'The document write failed',
    };
  }

  function providerCallCount(): number {
    return fetchMock.mock.calls.filter(([input]) => String(input) === '/api/generate/image').length;
  }

  /**
   * Generate the image element as its Retry does: the owner's Retry of a
   * failed, retryable task (one is seeded when the case has none).
   */
  async function runImageGeneration(): Promise<void> {
    noteStageGenerationOwnership(stageId, 'owner');
    if (!useMediaGenerationStore.getState().tasks[imageRef]) {
      useMediaGenerationStore.setState({ tasks: { [imageRef]: failedTask() } });
    }
    await retryMediaTask(imageRef);
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

  // A browser may not delete from the shared asset partition: the principal it
  // would scope to is the same for everyone, so allowing it would let any caller
  // destroy another author's media. An entry nothing references waits for
  // server-side reclamation instead — but the RECORD of it must go, or a later
  // save would stamp an id the document has no reason to trust and the
  // placeholder it replaced would be gone with it.
  it('forgets an allocation nothing can hold, without deleting its bytes', async () => {
    serveImage();
    mocks.persistReference.mockRejectedValue(
      new MediaReferenceWriteBackError(new Error('document write rejected'), false),
    );

    await runImageGeneration();

    expect(mocks.forgetAllocation).toHaveBeenCalledWith(stageId, imageRef);
    expect(mocks.removeAsset).not.toHaveBeenCalled();
  });

  it('leaves the failed element retryable, with its placeholder intact', async () => {
    serveImage();
    mocks.persistReference.mockRejectedValue(
      new MediaReferenceWriteBackError(new Error('document write rejected'), false),
    );

    await runImageGeneration();

    // The task carries the write-back's own error and no structured code, which
    // is what draws the Retry affordance.
    expect(useMediaGenerationStore.getState().tasks[imageRef]).toMatchObject({
      status: 'failed',
      error: 'document write rejected',
    });
    expect(useMediaGenerationStore.getState().tasks[imageRef]?.errorCode).toBeUndefined();
    expect(mocks.forgetAllocation).toHaveBeenCalledWith(stageId, imageRef);
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

  // A course generated before this application stored media server-side holds
  // placeholders in its document and its bytes only in the author's local
  // tables. Those bytes are paid for; the author's first server-backed load
  // converts them rather than buying them again.
  it('adopts locally cached bytes for a pre-existing course, with no provider call', async () => {
    serveImage();
    mocks.mediaGet.mockResolvedValue({
      id: `${stageId}:${imageRef}`,
      stageId,
      type: 'image',
      blob: new Blob(['cached-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 12,
      prompt: 'A diagram',
      params: '{}',
      createdAt: 0,
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(0);
    // Stage-scoped. A globally keyed lookup would adopt another course's bytes
    // for a placeholder id that is not unique across courses.
    expect(mocks.mediaGet).toHaveBeenCalledWith(`${stageId}:${imageRef}`);
    const [stored, meta] = mocks.putAsset.mock.calls[0] as [Blob, { contentType: string }];
    await expect(stored.text()).resolves.toBe('cached-bytes');
    expect(meta).toEqual({ contentType: 'image/png' });
    expect(mocks.persistReference).toHaveBeenCalledWith(
      expect.objectContaining({ stageId, placeholderRef: imageRef, assetId: 'ast_generated' }),
    );
    expect(useMediaGenerationStore.getState().tasks.ast_generated?.status).toBe('done');
  });

  // The bytes a placeholder's own key does not find may still be here. A
  // course generated AFTER server-backed storage keys its rows by the
  // allocated id and records the placeholder it replaced; a document that
  // carries the placeholder again -- a rollback, a restored backup -- has to
  // adopt those rather than buy them a second time.
  it('adopts cached bytes recorded under an allocated id, with no provider call', async () => {
    serveImage();
    mocks.mediaGet.mockResolvedValue(undefined);
    mocks.mediaRows.push({
      id: `${stageId}:ast_previous`,
      stageId,
      type: 'image',
      blob: new Blob(['post-upgrade-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 18,
      placeholderRef: imageRef,
      prompt: 'A diagram',
      params: '{}',
      createdAt: 0,
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(0);
    const [stored] = mocks.putAsset.mock.calls[0] as [Blob];
    await expect(stored.text()).resolves.toBe('post-upgrade-bytes');
    expect(mocks.persistReference).toHaveBeenCalledWith(
      expect.objectContaining({ stageId, placeholderRef: imageRef, assetId: 'ast_generated' }),
    );
  });

  it('ignores an allocated-id row belonging to another placeholder', async () => {
    serveImage();
    mocks.mediaGet.mockResolvedValue(undefined);
    mocks.mediaRows.push({
      id: `${stageId}:ast_previous`,
      stageId,
      type: 'image',
      blob: new Blob(['someone-elses-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 19,
      placeholderRef: 'gen_img_other',
      prompt: 'A diagram',
      params: '{}',
      createdAt: 0,
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(1);
  });

  // A full store is a refusal, not a hiccup. Offering Retry for it invites the
  // author to buy the same generation over and over, each attempt paying a
  // provider before failing in exactly the same way.
  // A full store is not the content's fault and not the configuration's: an
  // operator clears it in one environment variable. So the refusal keeps
  // everything that would otherwise have to be bought again, stops the deck
  // before the rest of it is spent on the same wall, and stays clearable.
  describe('a full asset store', () => {
    const quotaRefusal = () =>
      Object.assign(new Error('asset quota exceeded for this principal'), {
        status: 507,
        code: 'ASSET_QUOTA_EXCEEDED',
      });

    /**
     * The local media table, modelled for real.
     *
     * Several of these cases are about what the row lifecycle does BETWEEN two
     * attempts -- whether a row is removed, restored or written over -- which a
     * per-call mock cannot show.
     */
    function modelLocalMediaTable(): Map<string, Record<string, unknown>> {
      const rows = new Map<string, Record<string, unknown>>();
      mocks.mediaPut.mockImplementation(async (row: Record<string, unknown>) => {
        rows.set(row.id as string, row);
      });
      mocks.mediaGet.mockImplementation(async (id: string) => rows.get(id));
      mocks.mediaDelete.mockImplementation(async (id: string) => {
        rows.delete(id);
      });
      return rows;
    }

    /** The failed task a reload restores from a persisted refusal. */
    function restoreFailedTask(elementId: string): void {
      useMediaGenerationStore.setState({
        tasks: {
          [elementId]: {
            elementId,
            type: 'image',
            status: 'failed',
            prompt: 'A diagram',
            params: {},
            retryCount: 0,
            stageId,
            error: 'Asset storage is full; the image was not generated',
            errorCode: 'ASSET_QUOTA_EXCEEDED',
          },
        },
      });
    }

    it('keeps the bytes it refused, so nothing has to be generated twice', async () => {
      serveImage();
      noteStageGenerationOwnership(stageId, 'owner');
      mocks.putAsset.mockRejectedValue(quotaRefusal());

      await runImageGeneration();

      const failed = useMediaGenerationStore.getState().tasks[imageRef];
      expect(failed?.status).toBe('failed');
      expect(failed?.errorCode).toBe('ASSET_QUOTA_EXCEEDED');
      const [record] = mocks.mediaPut.mock.calls.at(-1) as [Record<string, unknown>];
      expect(record).toMatchObject({
        id: `${stageId}:${imageRef}`,
        errorCode: 'ASSET_QUOTA_EXCEEDED',
        placeholderRef: imageRef,
      });
      // The bytes, not an empty placeholder over them.
      await expect((record.blob as Blob).text()).resolves.toBe('server-image');
      expect(record.size).toBe((record.blob as Blob).size);
    });

    // The row this writes over IS the only copy a pre-server-backed course has
    // of its own media. Overwriting it with an empty blob would destroy media
    // that a raised ceiling could still have saved.
    it('does not destroy a legacy course\u2019s only copy of its media', async () => {
      serveImage();
      const cached = {
        id: `${stageId}:${imageRef}`,
        stageId,
        type: 'image' as const,
        blob: new Blob(['legacy-bytes'], { type: 'image/png' }),
        mimeType: 'image/png',
        size: 12,
        prompt: 'A diagram',
        params: '{}',
        createdAt: 0,
      };
      mocks.mediaGet.mockResolvedValue(cached);
      mocks.putAsset.mockRejectedValue(quotaRefusal());

      await runImageGeneration();

      expect(providerCallCount()).toBe(0);
      const [record] = mocks.mediaPut.mock.calls.at(-1) as [Record<string, unknown>];
      await expect((record.blob as Blob).text()).resolves.toBe('legacy-bytes');
    });

    // The way back. After the operator raises the ceiling, the author's Retry
    // re-attempts the upload with the bytes that were kept -- no provider, no
    // second bill -- and the document converges.
    it('converges for free on an explicit retry once the ceiling is raised', async () => {
      serveImage();
      noteStageGenerationOwnership(stageId, 'owner');
      mocks.putAsset.mockRejectedValue(quotaRefusal());
      await runImageGeneration();
      expect(providerCallCount()).toBe(1);

      // The refused row is what the retry reads back.
      const [refusedRow] = mocks.mediaPut.mock.calls.at(-1) as [Record<string, unknown>];
      mocks.mediaGet.mockResolvedValue(refusedRow);
      mocks.putAsset.mockReset().mockResolvedValue('ast_after_raise');

      await retryMediaTask(imageRef);

      expect(providerCallCount()).toBe(1);
      expect(mocks.putAsset).toHaveBeenCalledTimes(1);
      const [stored] = mocks.putAsset.mock.calls[0] as [Blob];
      await expect(stored.text()).resolves.toBe('server-image');
      expect(mocks.persistReference).toHaveBeenCalledWith(
        expect.objectContaining({ placeholderRef: imageRef, assetId: 'ast_after_raise' }),
      );
      expect(useMediaGenerationStore.getState().tasks.ast_after_raise?.status).toBe('done');
    });

    // A retry that was handed bytes and then failed for some OTHER reason must
    // not be the thing that throws them away: the next retry would go back to a
    // provider for media this browser is still holding. The local table is
    // modelled for real here, because the defect was in what the row lifecycle
    // does between the two attempts.
    it('keeps the bytes when the retry fails for an unrelated reason', async () => {
      serveImage();
      noteStageGenerationOwnership(stageId, 'owner');
      const rows = new Map<string, Record<string, unknown>>();
      mocks.mediaPut.mockImplementation(async (row: Record<string, unknown>) => {
        rows.set(row.id as string, row);
      });
      mocks.mediaGet.mockImplementation(async (id: string) => rows.get(id));
      mocks.mediaDelete.mockImplementation(async (id: string) => {
        rows.delete(id);
      });
      const rowKey = `${stageId}:${imageRef}`;

      mocks.putAsset.mockRejectedValue(quotaRefusal());
      await runImageGeneration();
      expect(providerCallCount()).toBe(1);
      await expect((rows.get(rowKey)?.blob as Blob).text()).resolves.toBe('server-image');

      // Ceiling raised, but the network drops during the upload.
      mocks.putAsset
        .mockReset()
        .mockRejectedValue(Object.assign(new Error('asset registry put failed'), { status: 500 }));
      await retryMediaTask(imageRef);

      expect(providerCallCount()).toBe(1);
      await expect((rows.get(rowKey)?.blob as Blob).text()).resolves.toBe('server-image');

      // And the next retry still uploads them rather than buying them again.
      mocks.putAsset.mockReset().mockResolvedValue('ast_third_try');
      await retryMediaTask(imageRef);

      expect(providerCallCount()).toBe(1);
      const [stored] = mocks.putAsset.mock.calls[0] as [Blob];
      await expect(stored.text()).resolves.toBe('server-image');
      expect(mocks.persistReference).toHaveBeenCalledWith(
        expect.objectContaining({ placeholderRef: imageRef, assetId: 'ast_third_try' }),
      );
      // The placeholder-keyed row was a copy of last resort; once the upload
      // landed it is a stale duplicate carrying a failure that no longer
      // happened.
      expect(rows.has(rowKey)).toBe(false);
    });

    it('falls back to one generation when the retry has no bytes to re-upload', async () => {
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
            retryCount: 0,
            stageId,
            error: 'Asset storage is full; the image was not generated',
            errorCode: 'ASSET_QUOTA_EXCEEDED',
          },
        },
      });
      mocks.mediaGet.mockResolvedValue(undefined);

      await retryMediaTask(imageRef);

      expect(providerCallCount()).toBe(1);
      expect(mocks.persistReference).toHaveBeenCalledWith(
        expect.objectContaining({ placeholderRef: imageRef, assetId: 'ast_generated' }),
      );
    });

    // Leaving the course clears the task table. A retry still in flight then
    // lands in a session that has no record of it, and "there is no failed task
    // for this element" is not evidence that anything worked -- it is evidence
    // that the table was emptied. Reading it as success deletes the row that is
    // holding the only copy of the media.
    it('keeps the retained bytes when a course switch clears the task table', async () => {
      serveImage();
      noteStageGenerationOwnership(stageId, 'owner');
      const rows = modelLocalMediaTable();
      const rowKey = `${stageId}:${imageRef}`;

      mocks.putAsset.mockRejectedValue(quotaRefusal());
      await runImageGeneration();
      await expect((rows.get(rowKey)?.blob as Blob).text()).resolves.toBe('server-image');

      // The author leaves the course while the retry's upload is in the air,
      // and the store is still full when it answers.
      mocks.putAsset.mockReset().mockImplementation(async () => {
        useMediaGenerationStore.setState({ tasks: {} });
        throw quotaRefusal();
      });

      await retryMediaTask(imageRef);

      expect(providerCallCount()).toBe(1);
      await expect((rows.get(rowKey)?.blob as Blob).text()).resolves.toBe('server-image');

      // The same switch, with the retry failing for an ordinary reason instead:
      // the attempt says it committed nothing, and nothing else is consulted.
      restoreFailedTask(imageRef);
      mocks.putAsset.mockReset().mockImplementation(async () => {
        useMediaGenerationStore.setState({ tasks: {} });
        throw Object.assign(new Error('asset registry put failed'), { status: 500 });
      });

      await retryMediaTask(imageRef);

      expect(providerCallCount()).toBe(1);
      await expect((rows.get(rowKey)?.blob as Blob).text()).resolves.toBe('server-image');
    });

    // When the bytes were kept, a Retry after the ceiling is raised costs no
    // provider call at all.
    it('retries from the kept bytes without generating again', async () => {
      serveImage();
      noteStageGenerationOwnership(stageId, 'owner');
      modelLocalMediaTable();

      mocks.putAsset.mockRejectedValue(quotaRefusal());
      await runImageGeneration();
      expect(providerCallCount()).toBe(1);

      mocks.putAsset.mockReset().mockResolvedValue('ast_after_raise');

      await retryMediaTask(imageRef);

      // No second provider call: the retry re-attempts the upload, not the
      // generation.
      expect(providerCallCount()).toBe(1);
      expect(mocks.putAsset).toHaveBeenCalledTimes(1);
      const [stored] = mocks.putAsset.mock.calls[0] as [Blob];
      await expect(stored.text()).resolves.toBe('server-image');
      expect(mocks.persistReference).toHaveBeenCalledWith(
        expect.objectContaining({ placeholderRef: imageRef, assetId: 'ast_after_raise' }),
      );
    });

    // An element with a failed task and no bytes anywhere: its Retry is one
    // ordinary generation.
    it('leaves a refused retry with no bytes to re-upload failed and retryable', async () => {
      serveImage();
      noteStageGenerationOwnership(stageId, 'owner');
      modelLocalMediaTable();
      restoreFailedTask(imageRef);
      mocks.putAsset.mockRejectedValue(quotaRefusal());

      await retryMediaTask(imageRef);

      // Exactly one: the retry is allowed to ask, once, at the author's
      // request.
      expect(providerCallCount()).toBe(1);
      expect(mocks.putAsset).toHaveBeenCalledTimes(1);

      // And the element is back where it was, with the reason and the way out.
      const task = useMediaGenerationStore.getState().tasks[imageRef];
      expect(task?.status).toBe('failed');
      expect(task?.errorCode).toBe('ASSET_QUOTA_EXCEEDED');
      expect(isRetryableMediaFailure(task!)).toBe(true);
    });

    // Two independent defences keep the retained bytes: the row is not removed
    // before the attempt, and the attempt's failure record is written around
    // whatever bytes it was given rather than over them. Together they pass any
    // test either one would pass, which is how a refactor deletes one of them
    // without a single case turning red. These two cases each need exactly one.

    // Only the first defence is in play: the failure record cannot be written
    // at all, so nothing restores a row that was removed up front.
    it('keeps the only copy when the failure record cannot be written', async () => {
      serveImage();
      noteStageGenerationOwnership(stageId, 'owner');
      const rows = modelLocalMediaTable();
      const rowKey = `${stageId}:${imageRef}`;

      mocks.putAsset.mockRejectedValue(quotaRefusal());
      await runImageGeneration();
      await expect((rows.get(rowKey)?.blob as Blob).text()).resolves.toBe('server-image');

      // The ceiling was raised, the upload failed for its own reasons, and this
      // browser can no longer write to its own cache either.
      mocks.putAsset
        .mockReset()
        .mockRejectedValue(Object.assign(new Error('asset registry put failed'), { status: 500 }));
      mocks.mediaPut.mockRejectedValue(new Error('local media cache write failed'));

      await retryMediaTask(imageRef);

      expect(providerCallCount()).toBe(1);
      await expect((rows.get(rowKey)?.blob as Blob).text()).resolves.toBe('server-image');
    });

    // Only the second defence is in play: the row survives the attempt, so what
    // matters is what the failure record does to it. Written from the bytes the
    // attempt was given, it replaces the row with itself and records the new
    // failure; written from a refusal that carries none, it replaces the media
    // with an empty blob.
    it('records the new failure around the bytes rather than over them', async () => {
      serveImage();
      noteStageGenerationOwnership(stageId, 'owner');
      const rows = modelLocalMediaTable();
      const rowKey = `${stageId}:${imageRef}`;

      mocks.putAsset.mockRejectedValue(quotaRefusal());
      await runImageGeneration();

      mocks.putAsset
        .mockReset()
        .mockRejectedValue(Object.assign(new Error('asset registry put failed'), { status: 500 }));

      await retryMediaTask(imageRef);

      expect(providerCallCount()).toBe(1);
      const row = rows.get(rowKey);
      await expect((row?.blob as Blob).text()).resolves.toBe('server-image');
      expect(row?.size).toBe((row?.blob as Blob).size);
      // And it is this attempt's failure that the reload will read, not the
      // refusal two attempts ago.
      expect(row?.error).toBe('asset registry put failed');
      expect(row?.errorCode).toBeUndefined();
    });
  });

  // Bytes reached the pool and the write-back did not reach the document, in a
  // way that kept the allocation: it is parked. Nothing is in the local media
  // table, because that row is written only after a successful write-back, so a
  // Retry that went to the provider from here would pay for the media a second
  // time and allocate a second asset for bytes the pool already holds.
  it('retries a parked write-back instead of buying the media again', async () => {
    serveImage();
    noteStageGenerationOwnership(stageId, 'owner');
    const parked = {
      stageId,
      placeholderRef: imageRef,
      assetId: 'ast_parked',
      objectUrl: 'blob:parked',
    };
    mocks.pendingAllocation.mockImplementation((stage: string, ref: string) =>
      stage === stageId && ref === imageRef ? parked : undefined,
    );
    useMediaGenerationStore.setState({ tasks: { [imageRef]: failedTask() } });

    await retryMediaTask(imageRef);

    expect(providerCallCount()).toBe(0);
    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(mocks.persistReference).toHaveBeenCalledWith(parked);
    // Drained, so a later rewrite of an already-rewritten slot cannot look
    // possible; the non-draining record stays for the write boundary.
    expect(mocks.takeAllocations).toHaveBeenCalledWith(stageId, [imageRef]);
    expect(useMediaGenerationStore.getState().tasks.ast_parked?.status).toBe('done');
  });

  it('keeps a parked allocation parked when its slide still does not exist', async () => {
    serveImage();
    noteStageGenerationOwnership(stageId, 'owner');
    mocks.pendingAllocation.mockReturnValue({
      stageId,
      placeholderRef: imageRef,
      assetId: 'ast_parked',
      objectUrl: 'blob:parked',
    });
    mocks.persistReference.mockResolvedValue('held');
    useMediaGenerationStore.setState({ tasks: { [imageRef]: failedTask() } });

    await retryMediaTask(imageRef);

    expect(providerCallCount()).toBe(0);
    expect(mocks.takeAllocations).not.toHaveBeenCalled();
    // Keyed by the placeholder the document still carries, so the request reads
    // as answered and nothing asks a provider again.
    expect(useMediaGenerationStore.getState().tasks[imageRef]?.status).toBe('done');
  });

  it('leaves a parked allocation retryable when the write-back fails again', async () => {
    serveImage();
    noteStageGenerationOwnership(stageId, 'owner');
    mocks.pendingAllocation.mockReturnValue({
      stageId,
      placeholderRef: imageRef,
      assetId: 'ast_parked',
      objectUrl: 'blob:parked',
    });
    mocks.persistReference.mockRejectedValue(
      new MediaReferenceWriteBackError(new Error('500'), true),
    );
    useMediaGenerationStore.setState({ tasks: { [imageRef]: failedTask() } });

    await retryMediaTask(imageRef);

    expect(providerCallCount()).toBe(0);
    expect(mocks.putAsset).not.toHaveBeenCalled();
    const task = useMediaGenerationStore.getState().tasks[imageRef];
    expect(task?.status).toBe('failed');
    expect(isRetryableMediaFailure(task!)).toBe(true);
  });

  it('reads the stage’s media table not at all when the element has a keyed row', async () => {
    serveImage();
    mocks.mediaGet.mockResolvedValue({
      id: `${stageId}:${imageRef}`,
      stageId,
      type: 'image' as const,
      blob: new Blob(['cached'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 6,
      prompt: 'A diagram',
      params: '{}',
      createdAt: 0,
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(0);
    expect(mocks.mediaWhere).not.toHaveBeenCalled();
  });

  it('leaves an ordinary asset failure retryable', async () => {
    serveImage();
    noteStageGenerationOwnership(stageId, 'owner');
    mocks.putAsset.mockRejectedValueOnce(
      Object.assign(new Error('asset registry put failed'), { status: 500 }),
    );

    await runImageGeneration();

    const failed = useMediaGenerationStore.getState().tasks[imageRef];
    expect(failed?.status).toBe('failed');
    expect(failed?.errorCode).toBeUndefined();
    // No permanent record: nothing about this refuses a later attempt.
    expect(mocks.mediaPut).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: `${stageId}:${imageRef}` }),
    );

    mocks.putAsset.mockResolvedValue('ast_second_try');
    await retryMediaTask(imageRef);

    expect(providerCallCount()).toBe(2);
    expect(mocks.persistReference).toHaveBeenCalledWith(
      expect.objectContaining({ placeholderRef: imageRef, assetId: 'ast_second_try' }),
    );
  });

  it('generates when the placeholder has no cached bytes', async () => {
    serveImage();
    mocks.mediaGet.mockResolvedValue(undefined);

    await runImageGeneration();

    expect(mocks.mediaGet).toHaveBeenCalledWith(`${stageId}:${imageRef}`);
    expect(providerCallCount()).toBe(1);
  });

  it.each([
    ['an empty blob', { blob: new Blob([]) }],
    ['a row that records only a hosted URL', { blob: new Blob([]), ossKey: 'https://cdn/x.png' }],
  ])('treats %s as no cached bytes', async (_name, overrides) => {
    serveImage();
    mocks.mediaGet.mockResolvedValue({
      id: `${stageId}:${imageRef}`,
      stageId,
      type: 'image',
      mimeType: 'image/png',
      size: 0,
      prompt: 'A diagram',
      params: '{}',
      createdAt: 0,
      ...overrides,
    });

    await runImageGeneration();

    expect(providerCallCount()).toBe(1);
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

    noteStageGenerationOwnership(stageId, 'owner');
    useMediaGenerationStore.setState({
      tasks: {
        [videoRef]: { ...failedTask(), elementId: videoRef, type: 'video', prompt: 'A clip' },
      },
    });
    await retryMediaTask(videoRef);

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
});
