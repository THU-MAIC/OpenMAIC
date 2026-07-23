import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { incrementalSave } = vi.hoisted(() => ({
  incrementalSave: vi.fn().mockResolvedValue({ failedChanges: [] }),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: (...args: unknown[]) => incrementalSave(...args),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

import { createStageAPI } from '@/lib/api/stage-api';
import { flushStageSave, useStageStore } from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

const stage: Stage = {
  id: 'stage-1',
  name: 'Stage',
  createdAt: 1,
  updatedAt: 1,
};

const scene: Scene = {
  id: 'scene-1',
  stageId: stage.id,
  type: 'slide',
  title: 'Scene',
  order: 1,
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-1',
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

beforeEach(() => {
  vi.useFakeTimers();
  incrementalSave.mockReset().mockResolvedValue({ failedChanges: [] });
  useStageStore.getState().clearStore();
  useStageStore.setState({
    stage,
    scenes: [scene],
    currentSceneId: 'scene-1',
  });
});

afterEach(() => {
  useStageStore.getState().clearStore();
  vi.useRealTimers();
});

describe('Stage API persistence injection', () => {
  it('classifies production raw setState mutations by persisted owner', async () => {
    const api = createStageAPI(useStageStore);

    expect(
      api.element.add('scene-1', {
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        content: 'hello',
      }).success,
    ).toBe(true);
    await flushStageSave();
    expect(incrementalSave.mock.calls[0]![1]).toEqual([{ kind: 'scene', sceneId: 'scene-1' }]);

    expect(api.whiteboard.create().success).toBe(true);
    await flushStageSave();
    expect(incrementalSave.mock.calls[1]![1]).toEqual([{ kind: 'stage' }]);

    expect(api.scene.create({ type: 'slide', title: 'New scene' }).success).toBe(true);
    await flushStageSave();
    expect(incrementalSave.mock.calls[2]![1]).toEqual([{ kind: 'structure' }]);
  });

  it('routes every raw-setState Stage API module through the guarded store', () => {
    const apiDir = path.join(process.cwd(), 'lib/api');
    const modules = [
      ['stage-api-scene.ts', 'createSceneAPI'],
      ['stage-api-element.ts', 'createElementAPI'],
      ['stage-api-canvas.ts', 'createCanvasAPI'],
      ['stage-api-mode.ts', 'createModeAPI'],
      ['stage-api-mode.ts', 'createStageMetaAPI'],
      ['stage-api-navigation.ts', 'createNavigationAPI'],
      ['stage-api-whiteboard.ts', 'createWhiteboardAPI'],
    ] as const;
    const composition = fs.readFileSync(path.join(apiDir, 'stage-api.ts'), 'utf8');

    for (const [file, factory] of modules) {
      const source = fs.readFileSync(path.join(apiDir, file), 'utf8');
      expect(source, `${file} must remain covered by this inventory`).toContain('store.setState(');
      expect(composition, `${factory} must receive the persistence wrapper`).toContain(
        `${factory}(persistenceStore)`,
      );
    }
    expect(composition).toContain('markStagePersistenceDirty(changes)');
  });
});
