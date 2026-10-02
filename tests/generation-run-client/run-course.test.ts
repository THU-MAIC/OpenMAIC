import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  courseFenced,
  mergeServerScenes,
  RunCourseSceneSync,
  type ManifestRead,
} from '@/lib/generation-run-client/run-course';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';

import { outline } from './fixtures';

const scene = (id: string, order: number, title = id): Scene =>
  ({ id, stageId: 'stage-1', type: 'slide', title, order, content: { type: 'slide' } }) as Scene;

describe('scenes the run appended, in the classroom', () => {
  const base = {
    scenes: [scene('s1', 1)],
    outlines: [outline(1), outline(2), outline(3)],
    currentSceneId: 's1',
    generationComplete: false,
  };

  it('join in order and leave the outlines still to come as placeholders', () => {
    const merged = mergeServerScenes(
      base,
      [scene('s3', 3), scene('s2', 2)],
      'stage-1',
      () => false,
    )!;
    expect(merged.scenes.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(merged.generatingOutlines).toEqual([]);
    expect(merged.currentSceneId).toBe('s1');
    expect(
      mergeServerScenes(base, [scene('s2', 2)], 'stage-1', () => false)!.generatingOutlines,
    ).toEqual([outline(3)]);
  });

  it('move a classroom waiting on the generating page to the first scene that arrived', () => {
    const waiting = { ...base, currentSceneId: PENDING_SCENE_ID };
    expect(
      mergeServerScenes(waiting, [scene('s3', 3), scene('s2', 2)], 'stage-1', () => false)!
        .currentSceneId,
    ).toBe('s2');
  });

  it('keep a scene this browser changed and has not saved', () => {
    const changed = { ...base, scenes: [scene('s1', 1, 'learner progress')] };
    expect(
      mergeServerScenes(changed, [scene('s1', 1, 'server')], 'stage-1', (id) => id === 's1'),
    ).toBeNull();
    const merged = mergeServerScenes(
      changed,
      [scene('s1', 1, 'server'), scene('s2', 2)],
      'stage-1',
      (id) => id === 's1',
    )!;
    expect(merged.scenes.map((s) => s.title)).toEqual(['learner progress', 's2']);
  });
});

describe('the read-only fence of a run course', () => {
  it('holds while the run is not over or not known, and lifts after the last writes are read', () => {
    const runId = 'run-AAAAAAAAAAAAAAAA';
    expect(courseFenced({ runId, status: 'loading', view: null, reconciled: false })).toBe(true);
    expect(courseFenced({ runId, status: 'error', view: null, reconciled: false })).toBe(true);
    expect(
      courseFenced({ runId, status: 'live', view: { state: 'paused' }, reconciled: false }),
    ).toBe(true);
    expect(
      courseFenced({ runId, status: 'live', view: { state: 'completed' }, reconciled: false }),
    ).toBe(true);
    expect(
      courseFenced({ runId, status: 'live', view: { state: 'completed' }, reconciled: true }),
    ).toBe(false);
    expect(courseFenced({ runId, status: 'missing', view: null, reconciled: false })).toBe(false);
    expect(courseFenced({ runId: null, status: 'loading', view: null, reconciled: false })).toBe(
      false,
    );
  });
});

describe('reading the run course', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function sync(manifests: ManifestRead[], reads: Array<Scene[] | Error>) {
    const known = ['s1'];
    const applied: string[][] = [];
    const deps = {
      fetchManifest: vi.fn(async (_stageId: string) =>
        manifests.length > 1 ? manifests.shift()! : manifests[0]!,
      ),
      fetchScenes: vi.fn(async (_stageId: string, _ids: readonly string[]) => {
        const read = reads.length > 1 ? reads.shift()! : reads[0]!;
        if (read instanceof Error) throw read;
        return read;
      }),
      knownSceneIds: () => known,
      apply: (scenes: Scene[]) => {
        applied.push(scenes.map((s) => s.id));
        for (const s of scenes) if (!known.includes(s.id)) known.push(s.id);
      },
      retryBaseMs: 100,
    };
    return { sync: new RunCourseSceneSync('stage-1', deps), deps, applied };
  }
  const manifest = (ids: string[]): ManifestRead => ({
    status: 'ok',
    manifest: { scenes: ids.map((id) => ({ id })) },
  });

  it('keeps a scene it could not read and reads it again', async () => {
    const {
      sync: s,
      deps,
      applied,
    } = sync([manifest(['s1', 's2', 's3'])], [[scene('s2', 2)], [scene('s3', 3)]]);
    expect(await s.sync()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.fetchScenes).toHaveBeenCalledTimes(2);
    expect(deps.fetchScenes.mock.calls[1]![1]).toEqual(['s3']);
    expect(applied).toEqual([['s2'], ['s3']]);
    s.close();
  });

  it('reconciles every scene until a read succeeds', async () => {
    const { sync: s, deps } = sync(
      [{ status: 'transient' }, manifest(['s1', 's2'])],
      [[scene('s1', 1), scene('s2', 2)]],
    );
    let done = false;
    void s.reconcile().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
    expect(deps.fetchScenes.mock.calls.at(-1)![1]).toEqual(['s1', 's2']);
    s.close();
  });
});
