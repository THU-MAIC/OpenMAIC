/**
 * Adoption's rewrite has to survive the save queue, twice over.
 *
 * An autosave round captures the store synchronously and writes that capture,
 * so a round already in flight when the rewrite lands writes the derived id
 * back over the allocated one — that is what the dirty mark is for. A producer
 * that captures its snapshot later from an older copy (an editor-history entry
 * replayed by undo) is not reached by any mark, which is what the write
 * boundary is for. The media path learned both lessons in earlier rounds; this
 * pins them for narration, where the cost is higher: adoption never deletes the
 * derived row, so a reverted reference is adopted again on the next load and
 * allocates a fresh asset every time.
 *
 * The REAL stage store, the REAL funnel and the REAL boundary are loaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mutateDocument: vi.fn(),
  saveStageDataIncremental: vi.fn(),
  saveStageData: vi.fn(),
  serverBacked: vi.fn(),
}));

vi.mock('@/lib/document-store', () => ({ mutateDocument: mocks.mutateDocument }));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageDataIncremental: mocks.saveStageDataIncremental,
  saveStageData: mocks.saveStageData,
}));
vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
}));

import { clearNarrationAllocations } from '@/lib/audio/narration-allocations';
import { persistNarrationReference } from '@/lib/audio/persist-narration-reference';
import { applyKnownMediaAllocations } from '@/lib/media/reconcile-scene-media';
import { flushStageSave, markStagePersistenceDirty, useStageStore } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';

const stageId = 'narration-autosave-stage';
const derivedRef = 'tts_s1_speech-1';

function sceneWithSpeech(audioId: string): Scene {
  return {
    id: 'scene-1',
    stageId,
    title: 'Scene',
    order: 1,
    type: 'slide',
    content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
    actions: [{ id: 'speech-1', type: 'speech', text: 'Welcome', audioId }],
  } as unknown as Scene;
}

function audioIdOf(scene: Scene): string | undefined {
  return (scene as unknown as { actions: Array<{ audioId?: string }> }).actions[0]?.audioId;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let the flush's dynamic import and promise chain settle. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

describe('a queued autosave cannot revert narration adoption', () => {
  let saves: { scenes: readonly Scene[] }[];

  beforeEach(() => {
    vi.useFakeTimers();
    saves = [];
    clearNarrationAllocations();
    mocks.serverBacked.mockReset().mockReturnValue(true);
    mocks.saveStageDataIncremental.mockReset();
    mocks.saveStageData.mockReset().mockResolvedValue(undefined);
    mocks.mutateDocument.mockReset().mockResolvedValue(undefined);

    useStageStore.setState({
      stage: { id: stageId, name: 'Course', createdAt: 0, updatedAt: 0 } as never,
      scenes: [sceneWithSpeech(derivedRef)],
      currentSceneId: 'scene-1',
      chats: [],
      outlines: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearNarrationAllocations();
    useStageStore.setState({ stage: null, scenes: [] });
  });

  it('leaves a corrective save queued behind the round that captured the derived id', async () => {
    const firstSave = deferred<{ failedChanges: [] }>();
    mocks.saveStageDataIncremental.mockImplementation(
      async (_stageId: string, _dirty: unknown, data: { scenes: readonly Scene[] }) => {
        saves.push({ scenes: data.scenes.map((scene) => structuredClone(scene)) });
        return saves.length === 1 ? firstSave.promise : { failedChanges: [] };
      },
    );

    markStagePersistenceDirty([{ kind: 'scene', sceneId: 'scene-1' }]);
    const flushing = flushStageSave();
    await settle();
    expect(saves).toHaveLength(1);
    expect(audioIdOf(saves[0].scenes[0])).toBe(derivedRef);

    await expect(persistNarrationReference(stageId, derivedRef, 'ast_clip')).resolves.toBe(true);
    expect(audioIdOf(useStageStore.getState().scenes[0])).toBe('ast_clip');

    firstSave.resolve({ failedChanges: [] });
    await vi.runAllTimersAsync();
    await flushing;

    // Without the dirty mark there is exactly one save and the document keeps
    // the derived id forever.
    expect(saves.length).toBeGreaterThan(1);
    expect(audioIdOf(saves[saves.length - 1].scenes[0])).toBe('ast_clip');
  });

  it('rewrites a stale snapshot at the write boundary, which no mark reaches', async () => {
    await expect(persistNarrationReference(stageId, derivedRef, 'ast_clip')).resolves.toBe(true);

    // An editor-history entry replayed by undo: content captured before the
    // rewrite, handed to the boundary long afterwards.
    const stale = [sceneWithSpeech(derivedRef)];
    const applied = applyKnownMediaAllocations(stageId, null, stale);

    expect(applied).not.toBeNull();
    expect(audioIdOf(applied!.scenes[0])).toBe('ast_clip');
    // The caller's own copy is never mutated in place.
    expect(audioIdOf(stale[0])).toBe(derivedRef);
  });

  it('leaves a snapshot that is already current untouched', async () => {
    await expect(persistNarrationReference(stageId, derivedRef, 'ast_clip')).resolves.toBe(true);

    expect(applyKnownMediaAllocations(stageId, null, [sceneWithSpeech('ast_clip')])).toBeNull();
  });

  it('does not rewrite another course with the same derived key', async () => {
    await expect(persistNarrationReference(stageId, derivedRef, 'ast_clip')).resolves.toBe(true);

    expect(
      applyKnownMediaAllocations('another-course', null, [sceneWithSpeech(derivedRef)]),
    ).toBeNull();
  });
});
