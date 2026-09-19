import { describe, it, expect } from 'vitest';
import { createSceneAPI } from '@/lib/api/stage-api-scene';
import type { StageStore } from '@/lib/api/stage-api-types';
import type { Scene, Stage, StageMode } from '@/lib/types/stage';

function mockStore() {
  const state = {
    stage: { id: 'stage-1', name: 'S', createdAt: 1, updatedAt: 1 } as Stage,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'edit' as StageMode,
  };
  const store: StageStore = {
    getState: () => state,
    setState: (partial) => Object.assign(state, partial),
    subscribe: () => () => {},
  };
  return { api: createSceneAPI(store), scenes: () => state.scenes };
}

describe('stage api scene.create — type/content authority', () => {
  it('keeps params.type authoritative and pins content.type to it', () => {
    const { api, scenes } = mockStore();
    const r = api.create({ type: 'slide', title: 'T' });
    expect(r.success).toBe(true);
    const scene = scenes()[0];
    expect(scene.type).toBe('slide');
    expect(scene.content.type).toBe('slide');
  });

  it('rejects a content.type that disagrees with the scene type (no silent override)', () => {
    const { api, scenes } = mockStore();
    const r = api.create({
      type: 'slide',
      title: 'T',
      content: { type: 'interactive', html: 'x' },
    });
    expect(r.success).toBe(false);
    expect(scenes()).toHaveLength(0);
  });
});
