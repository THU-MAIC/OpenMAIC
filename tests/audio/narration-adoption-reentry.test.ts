// @vitest-environment jsdom

/**
 * Re-entering a course finishes the clips the last visit did not.
 *
 * The two halves of that guarantee live in different files and can cancel each
 * other out. The hook aborts on leaving and releases its per-course latch, so a
 * return schedules a fresh attempt; the module runs one adoption per course at
 * a time, because a run's tail is uncancellable and a second allocation for the
 * same clip would orphan one of them. If the second caller is handed the run
 * already in flight, it inherits a signal that was just aborted: that run stops
 * at its next clip, the caller is told the work is done, and the clips the
 * abort cut off are converted by nothing — which is the defect the latch
 * release exists to prevent, restored from the other side.
 *
 * So this suite renders the hook for real AND runs the real adoption module,
 * with only the pool and the local tables doubled. The existing latch suite
 * mocks the module under test, which lets it assert calls but not runs; a
 * re-entry defect is a fact about runs.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
vi.mock('@/lib/media/asset-pool', () => ({ putAsset: mocks.putAsset }));
vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { get: mocks.audioGet, put: mocks.audioPut } },
}));
vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
}));

import { setAssetStorageFullStoreForTests } from '@/lib/media/asset-storage-full';
import { useNarrationAdoption } from '@/lib/audio/use-narration-adoption';
import {
  noteStageGenerationOwnership,
  resetGenerationPermissionsForTests,
} from '@/lib/classroom/generation-permission';
import { useStageStore } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';

const stageId = 'course-a';
const otherStageId = 'course-b';
/** Generated action ids: `action_` plus a nanoid, so the key names one clip. */
const firstRef = 'tts_s1_action_a1b2c3d4';
const secondRef = 'tts_s1_action_b2c3d4e5';

function twoClipScene(firstAudioId: string, secondAudioId: string): Scene {
  return {
    id: 'scene-1',
    stageId,
    title: 'Scene',
    order: 1,
    type: 'slide',
    content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
    actions: [
      { id: 'action_a1b2c3d4', type: 'speech', text: 'Welcome', audioId: firstAudioId },
      { id: 'action_b2c3d4e5', type: 'speech', text: 'And then', audioId: secondAudioId },
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

interface Props {
  stageId: string | undefined;
  ready: boolean;
  mayGenerate: boolean;
}

function Harness({ stageId: id, ready, mayGenerate }: Props) {
  useNarrationAdoption(id, { ready, mayGenerate });
  return null;
}

const roots: Root[] = [];

function mount(props: Props): { render: (next: Props) => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(Harness, props)));
  return {
    render: (next: Props) => act(() => root.render(createElement(Harness, next))),
  };
}

/** Drain the microtasks the adoption chain and React are waiting on. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
}

/** Point the live store at a course, as a load or a switch does. */
function openCourse(id: string, scenes: Scene[]): void {
  useStageStore.setState({ stage: { id, name: 'Course' } as never, scenes });
}

describe('narration adoption across a course re-entry', () => {
  beforeEach(() => {
    const entries = new Map<string, unknown>();
    setAssetStorageFullStoreForTests({
      get: async <T>(key: string) => (entries.get(key) as T) ?? null,
      set: async (key: string, value: unknown) => {
        entries.set(key, value);
      },
      remove: async (key: string) => {
        entries.delete(key);
      },
      keys: async (prefix = '') => [...entries.keys()].filter((key) => key.startsWith(prefix)),
    });
    resetGenerationPermissionsForTests();
    noteStageGenerationOwnership(stageId, 'owner');
    mocks.saveStageData.mockReset().mockResolvedValue(undefined);
    mocks.saveStageDataIncremental.mockReset().mockResolvedValue(undefined);
    mocks.audioPut.mockReset().mockResolvedValue(undefined);
    mocks.serverBacked.mockReset().mockReturnValue(true);
    // Rows of the shape a course narrated before allocation existed actually
    // has: the derived key, and neither a stage nor the text.
    mocks.audioGet.mockReset().mockImplementation(async (id: string) => ({
      id,
      blob: new Blob([`bytes-for-${id}`], { type: 'audio/mp3' }),
      duration: 2,
      format: 'mp3',
      createdAt: 0,
    }));
    // The document holds the same two derived references the live store does.
    const documentScenes = [twoClipScene(firstRef, secondRef)];
    mocks.mutateDocument
      .mockReset()
      .mockImplementation(
        async (_id: string, work: (document: unknown, store: unknown) => Promise<void>) => {
          await work(
            { scenes: documentScenes, stage: { id: stageId } },
            { putScene: vi.fn().mockResolvedValue(undefined), putStage: vi.fn() },
          );
        },
      );
    openCourse(stageId, [twoClipScene(firstRef, secondRef)]);
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    setAssetStorageFullStoreForTests(undefined);
    resetGenerationPermissionsForTests();
    useStageStore.setState({ stage: null, scenes: [] });
  });

  // The reported sequence, with the abort landing while an upload is in the
  // air: an owner's course, a visitor's course, and back before the tail of the
  // first run has settled.
  it('converts the clips an abort cut off when the course is re-entered', async () => {
    let release!: () => void;
    let allocations = 0;
    mocks.putAsset.mockReset().mockImplementation(async () => {
      allocations += 1;
      const assetId = `ast_${allocations}`;
      if (allocations === 1) await new Promise<void>((resolve) => (release = resolve));
      return assetId;
    });

    const view = mount({ stageId, ready: true, mayGenerate: true });
    await settle();
    // The first clip's upload is in the air; the second has not been reached.
    expect(mocks.putAsset).toHaveBeenCalledTimes(1);

    // Away to a course this browser may not write to, and back.
    openCourse(otherStageId, []);
    view.render({ stageId: otherStageId, ready: true, mayGenerate: false });
    openCourse(stageId, [twoClipScene(firstRef, secondRef)]);
    view.render({ stageId, ready: true, mayGenerate: true });
    await settle();

    // Still nothing new: the second caller waits for the uncancellable tail
    // rather than starting a run alongside it.
    expect(mocks.putAsset).toHaveBeenCalledTimes(1);

    release();
    await settle();

    // One allocation per clip, and the clip the abort cut off is converted.
    expect(mocks.putAsset).toHaveBeenCalledTimes(2);
    expect(liveAudioIds()).toEqual(['ast_1', 'ast_2']);
  });

  // Mount, cleanup, mount within one commit — what an effect replay looks like.
  // Nothing has been adopted when the abort lands, so the whole course depends
  // on the second attempt.
  it('adopts everything when the effect is replayed before any clip is stored', async () => {
    let allocations = 0;
    mocks.putAsset.mockReset().mockImplementation(async () => {
      allocations += 1;
      return `ast_${allocations}`;
    });

    const view = mount({ stageId, ready: true, mayGenerate: true });
    // Synchronously, so the first run has not passed its first suspension
    // point: cleanup aborts it, and the replay has to be what does the work.
    view.render({ stageId, ready: false, mayGenerate: true });
    view.render({ stageId, ready: true, mayGenerate: true });
    await settle();

    expect(mocks.putAsset).toHaveBeenCalledTimes(2);
    expect(liveAudioIds()).toEqual(['ast_1', 'ast_2']);
  });

  // The latch is what stops a load from adopting twice, and it must still do
  // that: a run that finished without being aborted is not repeated.
  it('does not run again for a course whose adoption finished', async () => {
    let allocations = 0;
    mocks.putAsset.mockReset().mockImplementation(async () => {
      allocations += 1;
      return `ast_${allocations}`;
    });

    const view = mount({ stageId, ready: true, mayGenerate: true });
    await settle();
    expect(mocks.putAsset).toHaveBeenCalledTimes(2);

    view.render({ stageId, ready: true, mayGenerate: true });
    await settle();

    expect(mocks.putAsset).toHaveBeenCalledTimes(2);
  });
});
