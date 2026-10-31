import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The page-unload path of the stage autosave: what `beforeunload` writes, and
 * when it asks the user to confirm leaving. The storage module is mocked; the
 * request side (direct keepalive writes) is covered in
 * tests/utils/stage-unload-write.test.ts.
 */
const { aggregateSave, incrementalSave, unloadWrite } = vi.hoisted(() => ({
  aggregateSave: vi.fn(),
  incrementalSave: vi.fn(),
  unloadWrite: vi.fn(),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: (...args: unknown[]) => aggregateSave(...args),
  saveStageDataIncremental: (...args: unknown[]) => incrementalSave(...args),
  loadStageData: vi.fn().mockResolvedValue(null),
  writeStageChangesForUnload: (...args: unknown[]) => unloadWrite(...args),
}));

import {
  flushStageSave,
  handleBeforeUnload,
  useStageStore,
  writePendingChangesForUnload,
} from '@/lib/store/stage';
import type { PendingChange } from '@/lib/utils/stage-storage';
import type { Scene, Stage } from '@/lib/types/stage';

const stage: Stage = { id: 'stage-1', name: 'Stage', createdAt: 1, updatedAt: 1 };

const scene = (id: string): Scene => ({
  id,
  stageId: 'stage-1',
  type: 'slide',
  title: id,
  order: 1,
  content: {
    type: 'slide',
    canvas: {
      id: `canvas-${id}`,
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        backgroundColor: '#fff',
        themeColors: ['#000'],
        fontColor: '#000',
        fontName: 'Inter',
      },
      elements: [],
    },
  },
});

function unloadEvent() {
  const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
  return event;
}

/** The unload writer sends every scene and stage change and defers the rest. */
function sendsSceneAndStage(settled: Promise<boolean> = Promise.resolve(true)) {
  return (_stageId: string, changes: PendingChange[]) => {
    const sent = changes.filter((change) => change.kind === 'scene' || change.kind === 'stage');
    const deferred = changes.filter(
      (change) => change.kind === 'structure' || change.kind === 'outline',
    );
    return { sent, deferred, settled };
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  incrementalSave.mockReset().mockResolvedValue({ failedChanges: [] });
  aggregateSave.mockReset().mockResolvedValue(undefined);
  unloadWrite.mockReset().mockImplementation(sendsSceneAndStage());
  useStageStore.getState().clearStore();
  useStageStore.setState({
    stage,
    scenes: [scene('scene-1'), scene('scene-2')],
    currentSceneId: 'scene-1',
    chats: [],
  });
  // Opening a course loads the storage module; one ordinary save stands in.
  useStageStore.getState().updateScene('scene-1', { title: 'loaded' });
  await flushStageSave();
  incrementalSave.mockClear();
});

afterEach(() => {
  useStageStore.getState().clearStore();
  vi.useRealTimers();
});

describe('beforeunload', () => {
  it('neither writes nor asks when nothing is pending', () => {
    const event = unloadEvent();
    handleBeforeUnload(event);
    expect(unloadWrite).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.returnValue).toBeUndefined();
  });

  it('writes a pending edit directly, without the regular read-then-write save, and lets the page go', async () => {
    useStageStore.getState().updateScene('scene-2', { title: 'edited' });
    const event = unloadEvent();

    handleBeforeUnload(event);

    expect(unloadWrite).toHaveBeenCalledOnce();
    const [stageId, changes, data] = unloadWrite.mock.calls[0]!;
    expect(stageId).toBe('stage-1');
    expect(changes).toEqual([{ kind: 'scene', sceneId: 'scene-2' }]);
    expect(data.scenes.find((s: Scene) => s.id === 'scene-2').title).toBe('edited');
    expect(event.preventDefault).not.toHaveBeenCalled();
    // The sent change left the queue: the regular save has nothing left to do.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(incrementalSave).not.toHaveBeenCalled();
  });

  it('asks before leaving when a change cannot be written on the way out', () => {
    useStageStore.getState().addScene(scene('scene-3'));
    const event = unloadEvent();

    handleBeforeUnload(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe('');
  });

  it('asks before leaving when the write does not fit the keepalive budget', () => {
    unloadWrite.mockImplementation((_stageId: string, changes: PendingChange[]) => ({
      sent: [],
      deferred: changes,
      settled: Promise.resolve(true),
    }));
    useStageStore.getState().updateScene('scene-2', { title: 'a large edit' });
    const event = unloadEvent();

    handleBeforeUnload(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    // The edit is still queued, so staying on the page saves it.
    return vi.advanceTimersByTimeAsync(5_000).then(() => {
      expect(incrementalSave).toHaveBeenCalled();
      expect(incrementalSave.mock.calls.at(-1)![1]).toEqual([
        { kind: 'scene', sceneId: 'scene-2' },
      ]);
    });
  });

  it('asks before leaving when a regular save of an older copy is still in flight', async () => {
    let finishSave!: () => void;
    incrementalSave.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ failedChanges: [] });
        }),
    );
    useStageStore.getState().updateScene('scene-2', { title: 'first' });
    const inFlight = flushStageSave();
    await vi.advanceTimersByTimeAsync(0);
    expect(incrementalSave).toHaveBeenCalledOnce();

    // A newer edit of the same scene, then an immediate reload.
    useStageStore.getState().updateScene('scene-2', { title: 'second' });
    const event = unloadEvent();
    handleBeforeUnload(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    finishSave();
    await inFlight;
  });

  it('keeps a newer edit queued when the user stays after an older save overtook it', async () => {
    let finishSave!: () => void;
    incrementalSave.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ failedChanges: [] });
        }),
    );
    useStageStore.getState().updateScene('scene-2', { title: 'copy1' });
    const inFlight = flushStageSave();
    await vi.advanceTimersByTimeAsync(0);
    useStageStore.getState().updateScene('scene-2', { title: 'copy2' });

    const event = unloadEvent();
    handleBeforeUnload(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(unloadWrite).toHaveBeenCalledOnce();

    // The user stays. The older save lands after the keepalive write...
    finishSave();
    await inFlight;
    await vi.advanceTimersByTimeAsync(5_000);
    // ...and the newer edit, still queued, is written again after it.
    const lastCall = incrementalSave.mock.calls.at(-1)!;
    expect(lastCall[1]).toEqual([{ kind: 'scene', sceneId: 'scene-2' }]);
    expect(lastCall[2].scenes.find((s: Scene) => s.id === 'scene-2').title).toBe('copy2');
  });

  it('does not send the same revision twice while a save keeps it queued', async () => {
    let finishSave!: () => void;
    let finishKeepalive!: (ok: boolean) => void;
    unloadWrite.mockImplementation(
      sendsSceneAndStage(
        new Promise<boolean>((resolve) => {
          finishKeepalive = resolve;
        }),
      ),
    );
    incrementalSave.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ failedChanges: [] });
        }),
    );
    useStageStore.getState().updateScene('scene-1', { title: 'in flight' });
    const inFlight = flushStageSave();
    await vi.advanceTimersByTimeAsync(0);
    useStageStore.getState().updateScene('scene-2', { title: 'queued' });

    handleBeforeUnload(unloadEvent());
    writePendingChangesForUnload();
    expect(unloadWrite).toHaveBeenCalledOnce();

    finishKeepalive(true);
    finishSave();
    await inFlight;
  });

  it('does not ask when the save in flight writes only other rows', async () => {
    let finishSave!: () => void;
    incrementalSave.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ failedChanges: [] });
        }),
    );
    useStageStore.getState().updateScene('scene-1', { title: 'in flight' });
    const inFlight = flushStageSave();
    await vi.advanceTimersByTimeAsync(0);
    useStageStore.getState().updateScene('scene-2', { title: 'other scene' });

    const event = unloadEvent();
    handleBeforeUnload(event);
    expect(unloadWrite).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
    finishSave();
    await inFlight;
  });

  it('asks when the save in flight rewrites the whole document', async () => {
    let finishSave!: () => void;
    incrementalSave.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ failedChanges: [] });
        }),
    );
    useStageStore.getState().addScene(scene('scene-3'));
    const inFlight = flushStageSave();
    await vi.advanceTimersByTimeAsync(0);
    useStageStore.getState().updateScene('scene-2', { title: 'after the structure change' });

    const event = unloadEvent();
    handleBeforeUnload(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    finishSave();
    await inFlight;
  });

  it('asks, and keeps the change queued, while an aggregate save of the course is in flight', async () => {
    let finishAggregate!: () => void;
    aggregateSave.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishAggregate = () => resolve(undefined);
        }),
    );
    const aggregate = useStageStore.getState().saveToStorage();
    await vi.advanceTimersByTimeAsync(0);
    useStageStore.getState().updateScene('scene-2', { title: 'during the aggregate save' });

    const event = unloadEvent();
    handleBeforeUnload(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(unloadWrite).toHaveBeenCalledOnce();

    finishAggregate();
    await aggregate;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(incrementalSave.mock.calls.at(-1)![1]).toEqual([{ kind: 'scene', sceneId: 'scene-2' }]);
  });

  it('does not ask when the save in flight already carries exactly the pending change', async () => {
    let finishSave!: () => void;
    incrementalSave.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ failedChanges: [] });
        }),
    );
    useStageStore.getState().updateScene('scene-2', { title: 'only' });
    const inFlight = flushStageSave();
    await vi.advanceTimersByTimeAsync(0);

    const event = unloadEvent();
    handleBeforeUnload(event);

    expect(unloadWrite).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
    finishSave();
    await inFlight;
  });

  it('queues the change again when the page stays and the direct write failed', async () => {
    unloadWrite.mockImplementation(sendsSceneAndStage(Promise.resolve(false)));
    useStageStore.getState().updateScene('scene-2', { title: 'retry me' });

    handleBeforeUnload(unloadEvent());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(incrementalSave).toHaveBeenCalled();
    expect(incrementalSave.mock.calls.at(-1)![1]).toEqual([{ kind: 'scene', sceneId: 'scene-2' }]);
  });

  it('does not write the same change twice when pagehide follows beforeunload', () => {
    useStageStore.getState().updateScene('scene-2', { title: 'once' });
    handleBeforeUnload(unloadEvent());
    expect(writePendingChangesForUnload()).toBe(false);
    expect(unloadWrite).toHaveBeenCalledOnce();
  });
});
