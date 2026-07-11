import { beforeEach, describe, expect, it, vi } from 'vitest';

const { saveStageDataMock } = vi.hoisted(() => ({
  saveStageDataMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: (...args: unknown[]) => saveStageDataMock(...args),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

import { onStageSaved, type StageSavedPayload } from '@/lib/store/stage-save-signal';
import { useStageStore } from '@/lib/store/stage';
import { makeScene, type Scene, type Stage } from '@/lib/types/stage';
import type { PBLProjectConfig } from '@/lib/pbl/types';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

function makeStage(): Stage {
  return {
    id: 'stage-1',
    name: 'Test stage',
    createdAt: 1,
    updatedAt: 1,
  };
}

function makePblProject(title: string): PBLProjectV2 {
  return { title } as PBLProjectV2;
}

function makePblScene(id: string, order: number, projectV2?: PBLProjectV2): Scene {
  return makeScene(
    {
      id,
      stageId: 'stage-1',
      title: id,
      order,
    },
    {
      type: 'pbl',
      projectConfig: {} as PBLProjectConfig,
      ...(projectV2 ? { projectV2 } : {}),
    },
  );
}

function makeSlideScene(id: string, order: number): Scene {
  return makeScene(
    {
      id,
      stageId: 'stage-1',
      title: id,
      order,
    },
    {
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
  );
}

beforeEach(() => {
  saveStageDataMock.mockReset();
  saveStageDataMock.mockResolvedValue(undefined);
  useStageStore.getState().clearStore();
  useStageStore.setState({ stage: makeStage(), scenes: [], currentSceneId: null, chats: [] });
});

describe('stage save signal', () => {
  it('fires only after saveToStorage succeeds and unsubscribes cleanly', async () => {
    let resolveSave!: () => void;
    saveStageDataMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );
    const savedPayloads: StageSavedPayload[] = [];
    const unsubscribe = onStageSaved((payload) => {
      savedPayloads.push(payload);
    });

    const save = useStageStore.getState().saveToStorage();
    expect(savedPayloads).toEqual([]);

    resolveSave();
    await save;
    expect(savedPayloads).toEqual([{ stageId: 'stage-1', pblScenes: [] }]);

    unsubscribe();
    await useStageStore.getState().saveToStorage();
    expect(savedPayloads).toEqual([{ stageId: 'stage-1', pblScenes: [] }]);
  });

  it('emits the PBL v2 scenes from the persisted snapshot', async () => {
    const projectA = makePblProject('Project A');
    const projectB = makePblProject('Project B');
    useStageStore.setState({
      scenes: [
        makePblScene('pbl-a', 1, projectA),
        makeSlideScene('slide-1', 2),
        makePblScene('pbl-legacy', 3),
        makePblScene('pbl-b', 4, projectB),
      ],
    });
    const savedPayloads: StageSavedPayload[] = [];
    const unsubscribe = onStageSaved((payload) => {
      savedPayloads.push(payload);
    });

    await useStageStore.getState().saveToStorage();

    expect(savedPayloads).toEqual([
      {
        stageId: 'stage-1',
        pblScenes: [
          { sceneId: 'pbl-a', project: projectA },
          { sceneId: 'pbl-b', project: projectB },
        ],
      },
    ]);
    expect(saveStageDataMock).toHaveBeenCalledWith(
      'stage-1',
      expect.objectContaining({
        scenes: [
          makePblScene('pbl-a', 1, projectA),
          makeSlideScene('slide-1', 2),
          makePblScene('pbl-legacy', 3),
          makePblScene('pbl-b', 4, projectB),
        ],
      }),
    );

    unsubscribe();
  });
});
