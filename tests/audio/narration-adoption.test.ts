/**
 * Pre-allocation narration converges on the owner's next load, for free.
 *
 * A course narrated before this application stored media server-side holds a
 * derived key on every speech action, and the bytes for it only in the
 * author's own browser. The document outlives that browser now, so every other
 * reader — the author's next device, every visitor — sees a reference nothing
 * can resolve. The bytes are already paid for, so the owner's browser stores
 * them and rewrites the reference; nothing here calls a provider.
 *
 * The REAL stage store and the REAL write-back funnel are loaded, because the
 * question is not only "was an asset allocated" but "does the document, and
 * the store the next save will flush, end up pointing at it".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mutateDocument: vi.fn(),
  saveStageDataIncremental: vi.fn(),
  saveStageData: vi.fn(),
  putAsset: vi.fn(),
  audioGet: vi.fn(),
  audioPut: vi.fn(),
  serverBacked: vi.fn(),
}));

vi.mock('@/lib/document-store', () => ({ mutateDocument: mocks.mutateDocument }));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageDataIncremental: mocks.saveStageDataIncremental,
  saveStageData: mocks.saveStageData,
}));
/**
 * The pool is doubled at the store rather than at `putAsset`, so the real
 * wrapper runs: retiring this course's "store is full" note on a successful
 * write lives there now, and a suite that replaced `putAsset` wholesale would
 * be asserting that behaviour against its own double.
 */
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
vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { get: mocks.audioGet, put: mocks.audioPut } },
}));
vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
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
import { useStageStore } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';

const stageId = 'narration-stage';
const derivedRef = 'tts_s1_speech-1';

function sceneWithSpeech(audioId: string | undefined): Scene {
  return {
    id: 'scene-1',
    stageId,
    title: 'Scene',
    order: 1,
    type: 'slide',
    content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
    actions: [
      { id: 'speech-1', type: 'speech', text: 'Welcome', ...(audioId ? { audioId } : {}) },
      { id: 'pause-1', type: 'pause', duration: 1 },
    ],
  } as unknown as Scene;
}

const secondRef = 'tts_s1_action_b2c3d4e5';

/** A course with two clips, so "one" and "all of them" are distinguishable. */
function twoLineScene(): Scene {
  return {
    id: 'scene-1',
    stageId,
    title: 'Scene',
    order: 1,
    type: 'slide',
    content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
    actions: [
      { id: 'speech-1', type: 'speech', text: 'Welcome', audioId: derivedRef },
      { id: 'speech-2', type: 'speech', text: 'And then', audioId: secondRef },
    ],
  } as unknown as Scene;
}

const bigRef = 'tts_s1_action_cccccccc';

/** A derived key for the nth clip of a sized deck. */
function sizedRef(index: number): string {
  return `tts_s1_action_size${String(index).padStart(4, '0')}`;
}

function sizedBlob(size: number): Blob {
  return new Blob(['z'.repeat(size)], { type: 'audio/mp3' });
}

/** The size the sized deck gives this derived key. */
function sizeOfRef(id: string, sizes: readonly number[]): number {
  const index = sizes.findIndex((_size, position) => sizedRef(position) === id);
  return index >= 0 ? sizes[index] : 1;
}

/** A course whose clips have the given byte sizes, in document order. */
function sizedScene(sizes: readonly number[]): Scene {
  return {
    id: 'scene-1',
    stageId,
    title: 'Scene',
    order: 1,
    type: 'slide',
    content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
    actions: sizes.map((_size, index) => ({
      id: `action_size${String(index).padStart(4, '0')}`,
      type: 'speech',
      text: `Line ${index}`,
      audioId: sizedRef(index),
    })),
  } as unknown as Scene;
}

/** A course whose opening clip is long and whose other two are short. */
function threeLineScene(
  first: string = bigRef,
  second: string = derivedRef,
  third: string = secondRef,
): Scene {
  return {
    id: 'scene-1',
    stageId,
    title: 'Scene',
    order: 1,
    type: 'slide',
    content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
    actions: [
      { id: 'speech-0', type: 'speech', text: 'A long opening line', audioId: first },
      { id: 'speech-1', type: 'speech', text: 'Welcome', audioId: second },
      { id: 'speech-2', type: 'speech', text: 'And then', audioId: third },
    ],
  } as unknown as Scene;
}

/** The audio ids the live store's speech actions currently carry. */
function liveAudioIds(): (string | undefined)[] {
  const [scene] = useStageStore.getState().scenes as unknown as {
    actions: { audioId?: string }[];
  }[];
  return (scene?.actions ?? []).map((action) => action.audioId);
}

/** Rows whose blobs differ in size the way a deck's narration does. */
function serveSizedRows(): void {
  mocks.audioGet.mockImplementation(async (id: string) =>
    cachedRow({
      id,
      blob: new Blob([id === bigRef ? 'x'.repeat(5000) : 'y'.repeat(100)], { type: 'audio/mp3' }),
    }),
  );
}

/**
 * A store with a little headroom, refusing each write on its own size --
 * `used + addedBytes > quotaBytes`, which is the registry's actual rule.
 */
function servePartiallyFullStore(headroom = 1000): void {
  serveSizedRows();
  let used = 0;
  let stored = 0;
  mocks.putAsset.mockImplementation(async (blob: Blob) => {
    if (used + blob.size > headroom) throw quotaRefusal();
    used += blob.size;
    return `ast_small_${(stored += 1)}`;
  });
}

/** What the store answers when it has no room. */
function quotaRefusal(): Error {
  return Object.assign(new Error('asset quota exceeded for this principal'), {
    status: 507,
    code: 'ASSET_QUOTA_EXCEEDED',
  });
}

function audioIdOf(scene: Scene): string | undefined {
  const actions = (scene as unknown as { actions: Array<{ audioId?: string }> }).actions;
  return actions[0]?.audioId;
}

function cachedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: derivedRef,
    stageId,
    blob: new Blob(['narration-bytes'], { type: 'audio/mp3' }),
    duration: 2.5,
    format: 'mp3',
    text: 'Welcome',
    createdAt: 0,
    ...overrides,
  };
}

/** The device KV the storage-full marker lives in, in memory. */
function memoryKv() {
  const entries = new Map<string, unknown>();
  return {
    entries,
    store: {
      get: async <T>(key: string) => (entries.get(key) as T) ?? null,
      set: async (key: string, value: unknown) => {
        entries.set(key, value);
      },
      remove: async (key: string) => {
        entries.delete(key);
      },
      keys: async (prefix = '') => [...entries.keys()].filter((key) => key.startsWith(prefix)),
    },
  };
}

describe('adopting cached narration', () => {
  let kv: ReturnType<typeof memoryKv>;

  beforeEach(() => {
    kv = memoryKv();
    setAssetStorageFullStoreForTests(kv.store);
    resetGenerationPermissionsForTests();
    mocks.mutateDocument.mockReset();
    mocks.saveStageData.mockReset().mockResolvedValue(undefined);
    mocks.saveStageDataIncremental.mockReset().mockResolvedValue(undefined);
    mocks.putAsset.mockReset().mockResolvedValue('ast_narration');
    mocks.audioGet.mockReset().mockResolvedValue(undefined);
    mocks.audioPut.mockReset().mockResolvedValue(undefined);
    mocks.serverBacked.mockReset().mockReturnValue(true);
    noteStageGenerationOwnership(stageId, 'owner');
    useStageStore.setState({
      stage: { id: stageId, name: 'Course' } as never,
      scenes: [sceneWithSpeech(derivedRef)],
    });
  });

  afterEach(() => {
    setAssetStorageFullStoreForTests(undefined);
    useStageStore.setState({ stage: null, scenes: [] });
    resetGenerationPermissionsForTests();
  });

  /** Run the funnel against a document that holds the same derived reference. */
  function serveDocument(ref: string = derivedRef): {
    putScene: ReturnType<typeof vi.fn>;
    scenes: Scene[];
  } {
    const scenes = [sceneWithSpeech(ref)];
    const putScene = vi.fn().mockResolvedValue(undefined);
    mocks.mutateDocument.mockImplementation(
      async (_stageId: string, work: (document: unknown, store: unknown) => Promise<void>) => {
        await work({ scenes, stage: { id: stageId } }, { putScene, putStage: vi.fn() });
      },
    );
    return { putScene, scenes };
  }

  it('stores the cached clip and rewrites the reference, without a provider call', async () => {
    const { putScene, scenes } = serveDocument();
    mocks.audioGet.mockResolvedValue(cachedRow());

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 1, unbacked: 0 });

    // Bytes first: a document may never name narration that was not stored.
    const [stored, meta] = mocks.putAsset.mock.calls[0] as [Blob, Record<string, unknown>];
    await expect(stored.text()).resolves.toBe('narration-bytes');
    expect(meta).toEqual({ contentType: 'audio/mp3', durationSeconds: 2.5 });

    // The derived id IS the local key: that is what made it usable before
    // allocation existed.
    expect(mocks.audioGet).toHaveBeenCalledWith(derivedRef);
    expect(putScene).toHaveBeenCalledTimes(1);
    expect(audioIdOf(scenes[0])).toBe('ast_narration');
    // And the live store, whose snapshot the next save flushes.
    expect(audioIdOf(useStageStore.getState().scenes[0])).toBe('ast_narration');
    // Mirrored locally under the new id so this browser needs no download.
    expect(mocks.audioPut).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ast_narration', originAudioId: derivedRef, stageId }),
    );
  });

  // The derived key contains no stage id and `audioFiles` is keyed by id alone,
  // so two courses can mint the same key -- a PPTX import numbers its scenes
  // and actions deterministically, which gives every imported deck's first
  // slide `tts_s1_speech-scene-p1`. Locally that means one course plays
  // another's clip in one browser. Adopting it would write that clip into the
  // shared document permanently, for every device and every visitor.
  it('refuses a row that belongs to another course', async () => {
    serveDocument();
    mocks.audioGet.mockResolvedValue(cachedRow({ stageId: 'another-course' }));

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 1 });

    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(mocks.mutateDocument).not.toHaveBeenCalled();
    expect(audioIdOf(useStageStore.getState().scenes[0])).toBe(derivedRef);
  });

  // Rows written before the stage column existed are the population this
  // feature exists for, so they cannot simply be refused. They are admitted on
  // the other evidence the row carries.
  it('adopts a legacy row with no stage whose text matches the action', async () => {
    serveDocument();
    mocks.audioGet.mockResolvedValue(cachedRow({ stageId: undefined, text: 'Welcome' }));

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 1, unbacked: 0 });

    expect(audioIdOf(useStageStore.getState().scenes[0])).toBe('ast_narration');
  });

  // The shape a real pre-allocation row actually has. `stageId` and `text` were
  // added to these rows by the very change that moved narration onto allocated
  // ids, so a row still carrying a derived key has neither -- which is the
  // whole population this feature exists for. What the row cannot say, the key
  // can: `action_<nanoid>` is minted by the generator and cannot be produced
  // twice.
  it('adopts a row of the real legacy shape when its key cannot collide', async () => {
    const uniqueRef = 'tts_s1_action_a1b2c3d4';
    useStageStore.setState({ scenes: [sceneWithSpeech(uniqueRef)] });
    serveDocument(uniqueRef);
    mocks.audioGet.mockResolvedValue({
      id: uniqueRef,
      blob: new Blob(['real-legacy-narration'], { type: 'audio/mp3' }),
      duration: 2.5,
      format: 'mp3',
      createdAt: 1_752_000_000_000,
    });

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 1, unbacked: 0 });

    expect(audioIdOf(useStageStore.getState().scenes[0])).toBe('ast_narration');
    const [stored] = mocks.putAsset.mock.calls[0] as [Blob];
    await expect(stored.text()).resolves.toBe('real-legacy-narration');
  });

  // An import numbers its actions by slide position, so the first slide of
  // every imported deck carries the same key. A text-less row under one of
  // those could be any of them.
  it('refuses a text-less legacy row whose key an import could have minted', async () => {
    const importedRef = 'tts_s1_speech-scene-p1';
    useStageStore.setState({ scenes: [sceneWithSpeech(importedRef)] });
    serveDocument(importedRef);
    mocks.audioGet.mockResolvedValue({
      id: importedRef,
      blob: new Blob(['someone-elses-narration'], { type: 'audio/mp3' }),
      duration: 2.5,
      format: 'mp3',
      createdAt: 1_752_000_000_000,
    });

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 1 });

    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(audioIdOf(useStageStore.getState().scenes[0])).toBe(importedRef);
  });

  it('adopts a collidable key when the row does record the matching text', async () => {
    const importedRef = 'tts_s1_speech-scene-p1';
    useStageStore.setState({ scenes: [sceneWithSpeech(importedRef)] });
    serveDocument(importedRef);
    mocks.audioGet.mockResolvedValue(
      cachedRow({ id: importedRef, stageId: undefined, text: 'Welcome' }),
    );

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 1, unbacked: 0 });

    expect(audioIdOf(useStageStore.getState().scenes[0])).toBe('ast_narration');
  });

  it.each([
    ['whose text is another line', { text: 'A different line entirely' }],
    ['whose text is blank', { text: '   ' }],
  ])('refuses a collidable legacy row %s', async (_name, overrides) => {
    const importedRef = 'tts_s1_speech-scene-p1';
    useStageStore.setState({ scenes: [sceneWithSpeech(importedRef)] });
    serveDocument(importedRef);
    mocks.audioGet.mockResolvedValue(
      cachedRow({ id: importedRef, stageId: undefined, ...overrides }),
    );

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 1 });

    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(audioIdOf(useStageStore.getState().scenes[0])).toBe(importedRef);
  });

  // Ownership still wins over the key's shape: a row that names another course
  // is refused however unique its key looks.
  it('refuses another course\u2019s row even under an uncollidable key', async () => {
    const uniqueRef = 'tts_s1_action_a1b2c3d4';
    useStageStore.setState({ scenes: [sceneWithSpeech(uniqueRef)] });
    serveDocument(uniqueRef);
    mocks.audioGet.mockResolvedValue(cachedRow({ id: uniqueRef, stageId: 'another-course' }));

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 1 });

    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(audioIdOf(useStageStore.getState().scenes[0])).toBe(uniqueRef);
  });

  it('leaves a concrete address alone rather than treating it as a local key', async () => {
    serveDocument();
    useStageStore.setState({ scenes: [sceneWithSpeech('/classroom-media/course/clip.mp3')] });

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 0 });

    expect(mocks.audioGet).not.toHaveBeenCalled();
  });

  // Allocation is uncancellable and its write-back cannot be half-undone, so
  // the loop stops between clips: a course left mid-adoption must not have the
  // rest of its deck allocated against it, or its document lock taken for them.
  it('stops between clips when the course is left', async () => {
    serveDocument();
    mocks.audioGet.mockResolvedValue(cachedRow());
    const controller = new AbortController();
    controller.abort();

    await expect(adoptCachedNarration(stageId, controller.signal)).resolves.toEqual({
      adopted: 0,
      unbacked: 0,
    });

    expect(mocks.putAsset).not.toHaveBeenCalled();
  });

  it('does not write back a clip whose course was switched during the upload', async () => {
    serveDocument();
    mocks.audioGet.mockResolvedValue(cachedRow());
    mocks.putAsset.mockImplementation(async () => {
      // The author moved on while the bytes were in flight.
      useStageStore.setState({ stage: { id: 'another-course' } as never });
      return 'ast_narration';
    });

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 1 });

    expect(mocks.mutateDocument).not.toHaveBeenCalled();
  });

  it('leaves a line whose bytes this browser does not have', async () => {
    serveDocument();
    mocks.audioGet.mockResolvedValue(undefined);

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 1 });

    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(audioIdOf(useStageStore.getState().scenes[0])).toBe(derivedRef);
  });

  it('does nothing for a viewer who is not the owner', async () => {
    serveDocument();
    mocks.audioGet.mockResolvedValue(cachedRow());
    noteStageGenerationOwnership(stageId, 'not-owner');

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 0 });

    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(mocks.mutateDocument).not.toHaveBeenCalled();
  });

  it('does nothing while ownership is still unresolved', async () => {
    serveDocument();
    mocks.audioGet.mockResolvedValue(cachedRow());
    noteStageGenerationOwnership(stageId, 'unresolved');

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 0 });

    expect(mocks.putAsset).not.toHaveBeenCalled();
  });

  it('does nothing in browser-only mode, where the derived id is a complete address', async () => {
    serveDocument();
    mocks.audioGet.mockResolvedValue(cachedRow());
    mocks.serverBacked.mockReturnValue(false);

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 0 });

    expect(mocks.putAsset).not.toHaveBeenCalled();
  });

  it('reads nothing for a course whose narration is already allocated', async () => {
    serveDocument();
    useStageStore.setState({ scenes: [sceneWithSpeech('ast_already')] });

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 0 });

    expect(mocks.audioGet).not.toHaveBeenCalled();
    expect(mocks.putAsset).not.toHaveBeenCalled();
  });

  it('refuses to write into a course this browser no longer has open', async () => {
    serveDocument();
    mocks.audioGet.mockResolvedValue(cachedRow());
    useStageStore.setState({ stage: { id: 'another-course' } as never });

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 0 });

    expect(mocks.putAsset).not.toHaveBeenCalled();
  });

  // Leaving a course aborts the loop between clips, which is what keeps the
  // rest of a deck from being allocated against a course nobody is looking at.
  // The clips it did not reach still have to be converted eventually, and
  // adoption is the only path a finished speech action has.
  it('finishes the clips a previous run was cut off before reaching', async () => {
    const secondRef = 'tts_s1_speech-2';
    const twoLines = {
      id: 'scene-1',
      stageId,
      title: 'Scene',
      order: 1,
      type: 'slide',
      content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
      actions: [
        { id: 'speech-1', type: 'speech', text: 'Welcome', audioId: derivedRef },
        { id: 'speech-2', type: 'speech', text: 'And then', audioId: secondRef },
      ],
    } as unknown as Scene;
    const documentScenes = [structuredClone(twoLines)];
    const putScene = vi.fn().mockResolvedValue(undefined);
    mocks.mutateDocument.mockImplementation(
      async (_stageId: string, work: (document: unknown, store: unknown) => Promise<void>) => {
        await work({ scenes: documentScenes, stage: { id: stageId } }, { putScene });
      },
    );
    useStageStore.setState({ scenes: [twoLines] });
    mocks.audioGet.mockImplementation(async (id: string) =>
      cachedRow({ id, text: id === derivedRef ? 'Welcome' : 'And then' }),
    );
    let allocated = 0;
    mocks.putAsset.mockImplementation(async () => `ast_clip_${(allocated += 1)}`);

    // The author leaves as the first clip is stored.
    const controller = new AbortController();
    mocks.putAsset.mockImplementationOnce(async () => {
      controller.abort();
      return `ast_clip_${(allocated += 1)}`;
    });

    await expect(adoptCachedNarration(stageId, controller.signal)).resolves.toEqual({
      adopted: 1,
      unbacked: 0,
    });
    expect(mocks.putAsset).toHaveBeenCalledTimes(1);

    // Coming back finishes the rest.
    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 1, unbacked: 0 });

    expect(mocks.putAsset).toHaveBeenCalledTimes(2);
    const audioIds = (
      useStageStore.getState().scenes[0] as unknown as {
        actions: Array<{ audioId?: string }>;
      }
    ).actions.map((action) => action.audioId);
    expect(audioIds).toEqual(['ast_clip_1', 'ast_clip_2']);
  });

  // A run's tail is uncancellable, so a second run started while it settles
  // could hand the same clip a second allocation and orphan one of them. The
  // second caller therefore queues behind the tail and then looks again --
  // rather than being handed the first run, whose signal may be the one that
  // was just aborted.
  it('queues a second caller behind the run in flight', async () => {
    serveDocument();
    mocks.audioGet.mockResolvedValue(cachedRow());
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.putAsset.mockImplementation(async () => {
      await inFlight;
      return 'ast_narration';
    });

    const first = adoptCachedNarration(stageId);
    const second = adoptCachedNarration(stageId);
    release();

    await expect(first).resolves.toEqual({ adopted: 1, unbacked: 0 });
    // The rescan finds the action already allocated, so there is nothing left
    // to do and nothing is allocated twice.
    await expect(second).resolves.toEqual({ adopted: 0, unbacked: 0 });
    expect(mocks.putAsset).toHaveBeenCalledTimes(1);
  });

  // One rescan is all any number of waiting callers need: the first converts
  // whatever the run in flight left, and every later one would find an
  // allocated id on every action. A chain of them would also turn one stalled
  // upload -- which this loop deliberately cannot cancel -- into a course that
  // never adopts again for the rest of the session.
  it('queues one rescan however many callers arrive behind a run', async () => {
    useStageStore.setState({ scenes: [twoLineScene()] });
    serveDocument();
    mocks.audioGet.mockImplementation(async (id: string) =>
      cachedRow({ id, text: id === derivedRef ? 'Welcome' : 'And then' }),
    );
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The author leaves as the first clip is stored, so the rescan has real
    // work: the second clip is still carrying its derived id.
    const controller = new AbortController();
    mocks.putAsset.mockImplementationOnce(async () => {
      await inFlight;
      controller.abort();
      return 'ast_clip_1';
    });
    mocks.putAsset.mockImplementation(async () => 'ast_clip_2');

    const first = adoptCachedNarration(stageId, controller.signal);
    const waiting = [
      adoptCachedNarration(stageId),
      adoptCachedNarration(stageId),
      adoptCachedNarration(stageId),
    ];
    release();

    await expect(first).resolves.toEqual({ adopted: 1, unbacked: 0 });
    const [a, b, c] = await Promise.all(waiting);
    // One rescan, and it finished the course.
    expect(a).toEqual({ adopted: 1, unbacked: 0 });
    expect(mocks.putAsset).toHaveBeenCalledTimes(2);
    // Literally the same run, not three equal ones: a chain of rescans would
    // give each caller its own, and one stalled upload would then block every
    // later caller for the rest of the session rather than just the first.
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  // Sharing one rescan means the callers' signals have to be composed, not
  // overwritten: the caller that arrived last is not necessarily the caller
  // that is still there. A surface that opens a course and closes it again must
  // not stop the rescan a surface still showing that course is waiting for --
  // and that surface is latched, so it would never ask again.
  it('runs the shared rescan while any of its callers is still there', async () => {
    useStageStore.setState({ scenes: [twoLineScene()] });
    serveDocument();
    mocks.audioGet.mockImplementation(async (id: string) =>
      cachedRow({ id, text: id === derivedRef ? 'Welcome' : 'And then' }),
    );
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The run in flight is cut off after its first clip, so the rescan has work.
    const first = new AbortController();
    mocks.putAsset.mockImplementationOnce(async () => {
      await inFlight;
      first.abort();
      return 'ast_clip_1';
    });
    mocks.putAsset.mockImplementation(async () => 'ast_clip_2');

    const running = adoptCachedNarration(stageId, first.signal);
    // Two surfaces wait for the rescan, and the one that closes is the one that
    // arrived LAST -- otherwise "take the newest signal" would pass this too.
    const staying = new AbortController();
    const leaving = new AbortController();
    const stayed = adoptCachedNarration(stageId, staying.signal);
    const left = adoptCachedNarration(stageId, leaving.signal);
    leaving.abort();
    release();

    await expect(running).resolves.toEqual({ adopted: 1, unbacked: 0 });
    await expect(stayed).resolves.toEqual({ adopted: 1, unbacked: 0 });
    await expect(left).resolves.toEqual({ adopted: 1, unbacked: 0 });
    expect(mocks.putAsset).toHaveBeenCalledTimes(2);
    expect(liveAudioIds().slice(0, 2)).toEqual(['ast_clip_1', 'ast_clip_2']);
  });

  it('stops the shared rescan once every caller has left', async () => {
    useStageStore.setState({ scenes: [twoLineScene()] });
    serveDocument();
    mocks.audioGet.mockImplementation(async (id: string) =>
      cachedRow({ id, text: id === derivedRef ? 'Welcome' : 'And then' }),
    );
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = new AbortController();
    mocks.putAsset.mockImplementationOnce(async () => {
      await inFlight;
      first.abort();
      return 'ast_clip_1';
    });
    mocks.putAsset.mockImplementation(async () => 'ast_clip_2');

    const running = adoptCachedNarration(stageId, first.signal);
    const one = new AbortController();
    const two = new AbortController();
    const waiting = [
      adoptCachedNarration(stageId, one.signal),
      adoptCachedNarration(stageId, two.signal),
    ];
    one.abort();
    two.abort();
    release();

    await expect(running).resolves.toEqual({ adopted: 1, unbacked: 0 });
    await expect(Promise.all(waiting)).resolves.toEqual([
      { adopted: 0, unbacked: 0 },
      { adopted: 0, unbacked: 0 },
    ]);
    // Nobody is looking at the course, so nothing more is allocated against it.
    expect(mocks.putAsset).toHaveBeenCalledTimes(1);
  });

  // A store that refuses everything used to cost one upload per clip per load,
  // for ever -- thirty clips, thirty full POSTs, on every load. The bound comes
  // from the store's own arithmetic rather than from anything remembered: usage
  // only grows during a run, so a clip refused for room implies every clip at
  // least that large is refused for the rest of it.
  it('stops re-uploading clips a refusal in the same load already answered for', async () => {
    // Sizes in document order. Each successive minimum is one upload; the
    // clips behind it that are no smaller are skipped without one.
    const sizes = [5000, 5000, 4000, 6000, 3000, 3000];
    useStageStore.setState({ scenes: [sizedScene(sizes)] });
    serveDocument();
    mocks.audioGet.mockImplementation(async (id: string) =>
      cachedRow({ id, blob: sizedBlob(sizeOfRef(id, sizes)) }),
    );
    mocks.putAsset.mockRejectedValue(quotaRefusal());

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({
      adopted: 0,
      unbacked: sizes.length,
    });

    const attempted = mocks.putAsset.mock.calls.map(([blob]) => (blob as Blob).size);
    expect(attempted).toEqual([5000, 4000, 3000]);
    // Every clip the bound skipped is still counted and still carries its
    // derived id, so the next load -- or a bigger ceiling -- picks it up.
    expect(liveAudioIds()).toEqual(sizes.map((_size, index) => sizedRef(index)));
  });

  // The bound must not become a stand-down: a clip smaller than anything that
  // has been refused may well fit, and on the store this branch exists for it
  // usually does.
  it('still attempts a clip smaller than the one that was refused', async () => {
    const sizes = [900, 100, 950];
    useStageStore.setState({ scenes: [sizedScene(sizes)] });
    serveDocument();
    mocks.audioGet.mockImplementation(async (id: string) =>
      cachedRow({ id, blob: sizedBlob(sizeOfRef(id, sizes)) }),
    );
    // Room for the small clip and nothing else.
    let used = 0;
    mocks.putAsset.mockImplementation(async (blob: Blob) => {
      if (used + blob.size > 500) throw quotaRefusal();
      used += blob.size;
      return 'ast_small';
    });

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 1, unbacked: 2 });

    // 900 refused, 100 attempted and stored, 950 skipped: it is no smaller than
    // the 900 that was already refused.
    expect(mocks.putAsset.mock.calls.map(([blob]) => (blob as Blob).size)).toEqual([900, 100]);
    expect(liveAudioIds()).toEqual([sizedRef(0), 'ast_small', sizedRef(2)]);
  });

  // Only a refusal for room says anything about how much room there is.
  it('does not let an unrelated failure stop the next clip being attempted', async () => {
    const sizes = [500, 900];
    useStageStore.setState({ scenes: [sizedScene(sizes)] });
    serveDocument();
    mocks.audioGet.mockImplementation(async (id: string) =>
      cachedRow({ id, blob: sizedBlob(sizeOfRef(id, sizes)) }),
    );
    mocks.putAsset.mockRejectedValueOnce(new Error('asset registry put failed'));
    mocks.putAsset.mockResolvedValue('ast_second');

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 1, unbacked: 1 });

    // The larger clip is attempted, and stored: a dropped connection is not
    // evidence about the ceiling.
    expect(mocks.putAsset.mock.calls.map(([blob]) => (blob as Blob).size)).toEqual([500, 900]);
    expect(liveAudioIds()).toEqual([sizedRef(0), 'ast_second']);
  });

  // Adoption reads no marker and writes none. It spends no provider money, so
  // it has nothing to protect with a deck-wide memory of a refusal -- and the
  // marker it used to write is the media pass's instruction not to spend, which
  // adoption is in no position to give. One over-large clip is not evidence
  // that a slide's image will not fit.
  it('never tells the media pass a store is full', async () => {
    useStageStore.setState({ scenes: [twoLineScene()] });
    serveDocument();
    mocks.audioGet.mockImplementation(async (id: string) => cachedRow({ id, text: 'Welcome' }));
    mocks.putAsset.mockRejectedValue(quotaRefusal());

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 2 });

    // One upload: the two clips are the same size, so the first refusal already
    // answers for the second. Nothing is remembered past the load, so the next
    // one asks again and the media pass is left to discover its own conditions.
    expect(mocks.putAsset).toHaveBeenCalledTimes(1);
    await expect(isAssetStorageFull(stageId)).resolves.toBe(false);
  });

  // A marker the media pass DID set does not gate adoption either. Adoption is
  // free, so standing it down buys nothing, and standing it down was what left
  // narration-only courses unrecoverable.
  it('attempts its clips on a course the media pass marked, and lifts the marker', async () => {
    useStageStore.setState({ scenes: [twoLineScene()] });
    serveDocument();
    mocks.audioGet.mockImplementation(async (id: string) =>
      cachedRow({ id, text: id === derivedRef ? 'Welcome' : 'And then' }),
    );
    let allocations = 0;
    mocks.putAsset.mockImplementation(async () => `ast_narration_${(allocations += 1)}`);
    await kv.store.set(`asset-storage-full:${stageId}`, Date.now());

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 2, unbacked: 0 });

    expect(mocks.putAsset).toHaveBeenCalledTimes(2);
    // A write that went through is a fact, and it is the one the media pass
    // needs: it disproves the condition it stood down on.
    await expect(isAssetStorageFull(stageId)).resolves.toBe(false);
  });

  // The ordering hazard the end-of-load write created: a media commit clears
  // the marker while adoption is running, and adoption then ends with a clip it
  // could not fit. Writing a marker at that point would clobber a fact a
  // successful media write had just established.
  it('does not re-arm a marker a media write cleared mid-load', async () => {
    useStageStore.setState({ scenes: [twoLineScene()] });
    serveDocument();
    await kv.store.set(`asset-storage-full:${stageId}`, Date.now());
    // The first clip is long and is refused for room; the second is short
    // enough to still be worth attempting. A media commit lands in between and
    // clears the marker; the short clip is then refused too.
    //
    // Both rows state their text rather than leaning on the fixture's default.
    // The first clip's key is import-shaped, so a stage-less row under it is
    // admitted only when its recorded text is the text of the action being
    // converted -- and the default happens to be that text, which would leave
    // this case passing on a coincidence that the fixture's first line could
    // break at any time.
    mocks.audioGet.mockImplementation(async (id: string) =>
      cachedRow({
        id,
        text: id === derivedRef ? 'Welcome' : 'And then',
        blob: new Blob([id === derivedRef ? 'x'.repeat(500) : 'y'.repeat(50)], {
          type: 'audio/mp3',
        }),
      }),
    );
    mocks.putAsset.mockImplementationOnce(async () => {
      throw quotaRefusal();
    });
    mocks.putAsset.mockImplementationOnce(async () => {
      await kv.store.remove(`asset-storage-full:${stageId}`);
      throw quotaRefusal();
    });

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 2 });

    await expect(isAssetStorageFull(stageId)).resolves.toBe(false);
  });

  it('converts the whole course on the first load after the ceiling is raised', async () => {
    useStageStore.setState({ scenes: [twoLineScene()] });
    serveDocument();
    mocks.audioGet.mockImplementation(async (id: string) => cachedRow({ id, text: 'Welcome' }));
    mocks.putAsset.mockRejectedValue(quotaRefusal());
    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 2 });

    // The operator raises the ceiling. Nothing tells this browser; the next
    // load simply asks again, which is all it ever does.
    let allocations = 0;
    mocks.putAsset
      .mockReset()
      .mockImplementation(async () => `ast_narration_${(allocations += 1)}`);

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 2, unbacked: 0 });

    expect(mocks.putAsset).toHaveBeenCalledTimes(2);
  });

  // The population the deck-wide reading lost: a store with a little headroom
  // refuses the long opening clip and holds every short one behind it.
  it('converts the clips that fit behind one that does not', async () => {
    useStageStore.setState({ scenes: [threeLineScene()] });
    serveDocument();
    servePartiallyFullStore();

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 2, unbacked: 1 });

    expect(mocks.putAsset).toHaveBeenCalledTimes(3);
    const ids = liveAudioIds();
    expect(ids[0]).toBe(bigRef);
    expect(ids[1]).toBe('ast_small_1');
    expect(ids[2]).toBe('ast_small_2');
    // And the one clip that did not fit is not turned into a claim about the
    // deck, or about the course's images.
    await expect(isAssetStorageFull(stageId)).resolves.toBe(false);
  });

  // The clip left outstanding is attempted again, once, on the next load --
  // which after the first load is normally the whole cost of a full store.
  it('re-attempts only the clip that did not fit, once per load', async () => {
    useStageStore.setState({ scenes: [threeLineScene()] });
    serveDocument();
    servePartiallyFullStore();
    await adoptCachedNarration(stageId);
    mocks.putAsset.mockClear();

    // A reload: the same document, minus the two clips that converted.
    useStageStore.setState({
      scenes: [threeLineScene(bigRef, 'ast_small_1', 'ast_small_2')],
    });

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 1 });

    expect(mocks.putAsset).toHaveBeenCalledTimes(1);
    const [attempted] = mocks.putAsset.mock.calls[0] as [Blob];
    expect(attempted.size).toBe(5000);
  });

  // A row the ownership rule refuses never reaches the store at all, so the
  // clips behind it are unaffected by it.
  it('skips a clip that belongs elsewhere and converts the rest', async () => {
    useStageStore.setState({ scenes: [twoLineScene()] });
    serveDocument();
    // The first clip's row names another course; the second is this course's.
    mocks.audioGet.mockImplementation(async (id: string) =>
      cachedRow({ id, stageId: id === derivedRef ? 'another-course' : stageId }),
    );

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 1, unbacked: 1 });

    expect(mocks.putAsset).toHaveBeenCalledTimes(1);
  });

  // The marker is set before the run, or this asserts nothing: a fresh device
  // KV answers "not full" whether or not anything lifted it.
  it('lifts the marker as soon as a clip is stored', async () => {
    serveDocument();
    mocks.audioGet.mockResolvedValue(cachedRow());
    await kv.store.set(`asset-storage-full:${stageId}`, Date.now());
    await expect(isAssetStorageFull(stageId)).resolves.toBe(true);

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 1, unbacked: 0 });

    // Lifted for the media pass too, which has no other way to learn it.
    await expect(isAssetStorageFull(stageId)).resolves.toBe(false);
  });

  it('counts a clip whose storage fails as unbacked, and keeps its derived id', async () => {
    serveDocument();
    mocks.audioGet.mockResolvedValue(cachedRow());
    mocks.putAsset.mockRejectedValue(new Error('the store is full'));

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 0, unbacked: 1 });

    expect(audioIdOf(useStageStore.getState().scenes[0])).toBe(derivedRef);
  });
});
