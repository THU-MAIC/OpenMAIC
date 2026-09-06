/**
 * The write-back has to survive the save queue, not just reach the document.
 *
 * An autosave round captures the store synchronously and writes that capture,
 * so a round already in flight when the rewrite lands will write the
 * placeholder back over the allocated id — and if nothing marks the store dirty
 * again, no later round ever corrects it. This test loads the REAL stage store
 * together with the REAL write-back funnel and interleaves them in exactly that
 * order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mutateDocument: vi.fn(),
  saveStageDataIncremental: vi.fn(),
  saveStageData: vi.fn(),
}));

vi.mock('@/lib/document-store', () => ({
  mutateDocument: mocks.mutateDocument,
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageDataIncremental: mocks.saveStageDataIncremental,
  saveStageData: mocks.saveStageData,
}));

import { persistGeneratedMediaReference } from '@/lib/media/persist-media-reference';
import { flushStageSave, markStagePersistenceDirty, useStageStore } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';

const stageId = 'autosave-stage';
const placeholder = 'gen_img_A';

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

interface SaveCall {
  readonly scenes: readonly Scene[];
}

/** Let the flush's dynamic import and promise chain settle. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('a queued autosave cannot revert the write-back', () => {
  let saves: SaveCall[];

  beforeEach(() => {
    vi.useFakeTimers();
    saves = [];
    mocks.saveStageDataIncremental.mockReset();
    mocks.saveStageData.mockReset().mockResolvedValue(undefined);
    mocks.mutateDocument.mockReset().mockResolvedValue(undefined);

    useStageStore.setState({
      stage: { id: stageId, name: 'Course', createdAt: 0, updatedAt: 0 } as never,
      scenes: [sceneWithImage(placeholder)],
      currentSceneId: 'scene-1',
      chats: [],
      outlines: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    useStageStore.setState({ stage: null, scenes: [] });
  });

  it('leaves a corrective save queued behind the round that captured the placeholder', async () => {
    const firstSave = deferred<{ failedChanges: [] }>();
    mocks.saveStageDataIncremental.mockImplementation(
      async (_stageId: string, _dirty: unknown, data: { scenes: readonly Scene[] }) => {
        // Snapshot what this round would write, at the moment it was handed over.
        saves.push({ scenes: data.scenes.map((scene) => structuredClone(scene)) });
        return saves.length === 1 ? firstSave.promise : { failedChanges: [] };
      },
    );

    // An ordinary edit schedules a save; the round captures the store, which
    // still holds the placeholder, and then waits on the network.
    markStagePersistenceDirty([{ kind: 'scene', sceneId: 'scene-1' }]);
    const flushing = flushStageSave();
    await settle();
    expect(saves).toHaveLength(1);
    expect(imageSrcOf(saves[0].scenes[0])).toBe(placeholder);

    // The media commit lands while that round is still in flight.
    await expect(
      persistGeneratedMediaReference(stageId, { placeholderRef: placeholder, assetId: 'ast_A' }),
    ).resolves.toBe('written');
    expect(imageSrcOf(useStageStore.getState().scenes[0])).toBe('ast_A');

    firstSave.resolve({ failedChanges: [] });
    await vi.runAllTimersAsync();
    await flushing;

    // The stale round wrote the placeholder, and a corrective round followed it
    // with the allocated id. Without the dirty mark there would be exactly one
    // save and the document would keep the placeholder forever.
    expect(saves.length).toBeGreaterThan(1);
    expect(imageSrcOf(saves[saves.length - 1].scenes[0])).toBe('ast_A');
  });

  it('marks nothing when the rewrite matched no live scene', async () => {
    mocks.saveStageDataIncremental.mockResolvedValue({ failedChanges: [] });
    useStageStore.setState({ scenes: [sceneWithImage('ast_other')] });

    await expect(
      persistGeneratedMediaReference(stageId, { placeholderRef: placeholder, assetId: 'ast_A' }),
    ).resolves.toBe('unmatched');

    await vi.runAllTimersAsync();
    expect(mocks.saveStageDataIncremental).not.toHaveBeenCalled();
  });
});
