import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// IndexedDB / stage-storage modules are imported dynamically inside the
// store's save/load actions. Mock them so the debounced save doesn't try
// to talk to a real (or jsdom) IndexedDB in the test environment.
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  loadStageData: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/utils/database', () => ({
  db: { stageOutlines: { put: vi.fn(), get: vi.fn() } },
}));

import { useStageStore } from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

function makeStage(): Stage {
  return {
    id: 'stage-1',
    name: 'Test stage',
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeSlideScene(id: string, order: number, stageId = 'stage-1'): Scene {
  return {
    id,
    stageId,
    type: 'slide',
    title: id,
    order,
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
  };
}

beforeEach(() => {
  useStageStore.setState({
    stage: makeStage(),
    scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2), makeSlideScene('c', 3)],
    currentSceneId: 'a',
  });
});

afterEach(() => {
  useStageStore.getState().clearStore();
});

describe('insertSceneAfter', () => {
  it('inserts after the anchor index', () => {
    const fresh = makeSlideScene('x', 99);
    useStageStore.getState().insertSceneAfter('a', fresh);
    const ids = useStageStore.getState().scenes.map((s) => s.id);
    expect(ids).toEqual(['a', 'x', 'b', 'c']);
  });

  it('rebalances order to monotonic 1-based after insert', () => {
    const fresh = makeSlideScene('x', 999);
    useStageStore.getState().insertSceneAfter('b', fresh);
    const orders = useStageStore.getState().scenes.map((s) => s.order);
    expect(orders).toEqual([1, 2, 3, 4]);
  });

  it('rejects a scene whose stageId mismatches the current stage', () => {
    const foreign = makeSlideScene('z', 4, 'stage-9');
    useStageStore.getState().insertSceneAfter('a', foreign);
    const ids = useStageStore.getState().scenes.map((s) => s.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('falls through to append when the anchor is not found', () => {
    const fresh = makeSlideScene('x', 7);
    useStageStore.getState().insertSceneAfter('does-not-exist', fresh);
    const ids = useStageStore.getState().scenes.map((s) => s.id);
    expect(ids).toEqual(['a', 'b', 'c', 'x']);
  });

  it('does not switch currentSceneId — callers decide focus', () => {
    const fresh = makeSlideScene('x', 99);
    useStageStore.getState().insertSceneAfter('a', fresh);
    expect(useStageStore.getState().currentSceneId).toBe('a');
  });
});
