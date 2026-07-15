import { describe, expect, it, vi } from 'vitest';
import {
  applyClassroomStageAndScenes,
  discardRestoredMediaTasks,
  runClassroomLoad,
  saveGeneratedAgentsForCurrentLoad,
} from '@/lib/classroom/load-classroom';
import {
  claimStageSceneLoadToken,
  isCurrentStageSceneLoadToken,
  useStageStore,
} from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

const databaseMocks = vi.hoisted(() => ({
  deleteGeneratedAgents: vi.fn(),
  bulkPutGeneratedAgents: vi.fn(),
  transaction: vi.fn(async (_mode: string, _table: unknown, work: () => Promise<void>) => work()),
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    generatedAgents: {
      where: () => ({ equals: () => ({ delete: databaseMocks.deleteGeneratedAgents }) }),
      bulkPut: databaseMocks.bulkPutGeneratedAgents,
    },
    transaction: databaseMocks.transaction,
  },
}));

function makeStage(id: string, generatedAgentConfigs: Stage['generatedAgentConfigs'] = []): Stage {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    generatedAgentConfigs,
  };
}

function makeScene(id: string, stageId: string): Scene {
  return {
    id,
    stageId,
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
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDeps(overrides: Partial<Parameters<typeof runClassroomLoad>[0]> = {}) {
  let current = true;
  let stage: Stage | null = null;
  const settings = {
    agentMode: 'auto' as const,
    selectedAgentIds: [] as string[],
    agentSelectionIsUserSet: false,
    setAgentMode: vi.fn(),
    setSelectedAgentIds: vi.fn(),
    setAgentSelectionIsUserSet: vi.fn(),
  };
  const deps: Parameters<typeof runClassroomLoad>[0] = {
    classroomId: 'stage-a',
    loadToken: 1,
    isCurrent: () => current,
    loadFromStorage: vi.fn().mockResolvedValue(undefined),
    getCurrentStage: () => stage,
    fetchClassroom: vi.fn().mockResolvedValue(null),
    applyFallbackScenes: vi.fn().mockResolvedValue(false),
    saveGeneratedAgents: vi.fn().mockResolvedValue([]),
    loadRestoredMediaTasks: vi.fn().mockResolvedValue({}),
    applyRestoredMediaTasks: vi.fn(),
    discardRestoredMediaTasks: vi.fn(),
    loadGeneratedAgentRecords: vi.fn().mockResolvedValue([]),
    applyGeneratedAgentRecords: vi.fn().mockReturnValue([]),
    getSettings: () => settings,
    getAgent: vi.fn().mockReturnValue(undefined),
    restoreAgentSelection: vi.fn().mockReturnValue({
      selection: { mode: 'preset', selectedAgentIds: ['default-1', 'default-2', 'default-3'] },
      isUserSet: false,
    }),
    setError: vi.fn(),
    setLoading: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
  return {
    deps,
    settings,
    setCurrent(next: boolean) {
      current = next;
    },
    setStage(next: Stage | null) {
      stage = next;
    },
  };
}

describe('runClassroomLoad', () => {
  it('keeps the current load token valid when fallback scenes are committed', () => {
    useStageStore.getState().clearStore();
    const loadToken = claimStageSceneLoadToken();
    const stage = makeStage('stage-a');
    const scene = makeScene('scene-a', 'stage-a');

    applyClassroomStageAndScenes(stage, [scene], { persist: false });

    expect(isCurrentStageSceneLoadToken(loadToken)).toBe(true);
    expect(useStageStore.getState().stage?.id).toBe('stage-a');
    expect(useStageStore.getState().scenes).toEqual([scene]);
    expect(useStageStore.getState().currentSceneId).toBe('scene-a');
    useStageStore.getState().clearStore();
  });

  it('does not run stale restore phases after a newer navigation wins', async () => {
    const loadStorage = deferred<void>();
    const { deps, setCurrent, setStage } = makeDeps({
      loadFromStorage: vi.fn().mockReturnValue(loadStorage.promise),
    });

    const loading = runClassroomLoad(deps);
    await vi.waitFor(() => expect(deps.loadFromStorage).toHaveBeenCalled());

    setCurrent(false);
    setStage(makeStage('stage-b'));
    loadStorage.resolve();
    await loading;

    expect(deps.fetchClassroom).not.toHaveBeenCalled();
    expect(deps.applyFallbackScenes).not.toHaveBeenCalled();
    expect(deps.loadRestoredMediaTasks).not.toHaveBeenCalled();
    expect(deps.loadGeneratedAgentRecords).not.toHaveBeenCalled();
    expect(deps.setLoading).not.toHaveBeenCalled();
  });

  it('stops after fetch when the load is superseded', async () => {
    const fetched = deferred<{ stage: Stage; scenes: Scene[] } | null>();
    const { deps, setCurrent } = makeDeps({
      fetchClassroom: vi.fn().mockReturnValue(fetched.promise),
    });

    const loading = runClassroomLoad(deps);
    await vi.waitFor(() => expect(deps.fetchClassroom).toHaveBeenCalled());

    setCurrent(false);
    fetched.resolve({ stage: makeStage('stage-a'), scenes: [makeScene('scene-a', 'stage-a')] });
    await loading;

    expect(deps.applyFallbackScenes).not.toHaveBeenCalled();
    expect(deps.loadRestoredMediaTasks).not.toHaveBeenCalled();
    expect(deps.loadGeneratedAgentRecords).not.toHaveBeenCalled();
    expect(deps.setLoading).not.toHaveBeenCalled();
  });

  it('stops after fallback apply when the load is superseded', async () => {
    const applied = deferred<boolean>();
    const { deps, setCurrent } = makeDeps({
      fetchClassroom: vi.fn().mockResolvedValue({
        stage: makeStage('stage-a', [
          {
            id: 'agent-a',
            name: 'Agent A',
            role: 'teacher',
            persona: 'Teach',
            avatar: 'A',
            color: '#000',
            priority: 1,
          },
        ]),
        scenes: [makeScene('scene-a', 'stage-a')],
      }),
      applyFallbackScenes: vi.fn().mockReturnValue(applied.promise),
    });

    const loading = runClassroomLoad(deps);
    await vi.waitFor(() => expect(deps.applyFallbackScenes).toHaveBeenCalled());

    setCurrent(false);
    applied.resolve(true);
    await loading;

    expect(deps.saveGeneratedAgents).not.toHaveBeenCalled();
    expect(deps.loadRestoredMediaTasks).not.toHaveBeenCalled();
    expect(deps.loadGeneratedAgentRecords).not.toHaveBeenCalled();
    expect(deps.setLoading).not.toHaveBeenCalled();
  });

  it('does not apply media tasks when superseded after the media read', async () => {
    const mediaRead = deferred<Record<string, unknown>>();
    const { deps, setCurrent, setStage } = makeDeps({
      loadRestoredMediaTasks: vi.fn().mockReturnValue(mediaRead.promise),
    });
    setStage(makeStage('stage-a'));

    const loading = runClassroomLoad(deps);
    await vi.waitFor(() => expect(deps.loadRestoredMediaTasks).toHaveBeenCalled());

    setCurrent(false);
    mediaRead.resolve({ image: { elementId: 'image' } });
    await loading;

    expect(deps.applyRestoredMediaTasks).not.toHaveBeenCalled();
    expect(deps.discardRestoredMediaTasks).toHaveBeenCalledWith({
      image: { elementId: 'image' },
    });
    expect(deps.loadGeneratedAgentRecords).not.toHaveBeenCalled();
    expect(deps.setLoading).not.toHaveBeenCalled();
  });

  it('does not apply generated agents when superseded after the agent record read', async () => {
    const agentRead = deferred<unknown[]>();
    const { deps, settings, setCurrent, setStage } = makeDeps({
      loadGeneratedAgentRecords: vi.fn().mockReturnValue(agentRead.promise),
    });
    setStage(makeStage('stage-a'));

    const loading = runClassroomLoad(deps);
    await vi.waitFor(() => expect(deps.loadGeneratedAgentRecords).toHaveBeenCalled());

    setCurrent(false);
    agentRead.resolve([{ id: 'agent-a' }]);
    await loading;

    expect(deps.applyGeneratedAgentRecords).not.toHaveBeenCalled();
    expect(settings.setAgentMode).not.toHaveBeenCalled();
    expect(settings.setSelectedAgentIds).not.toHaveBeenCalled();
    expect(settings.setAgentSelectionIsUserSet).not.toHaveBeenCalled();
    expect(deps.setLoading).not.toHaveBeenCalled();
  });

  it('runs all phases and clears loading for the current navigation', async () => {
    const stage = makeStage('stage-a', [
      {
        id: 'agent-a',
        name: 'Agent A',
        role: 'teacher',
        persona: 'Teach',
        avatar: 'A',
        color: '#000',
        priority: 1,
      },
    ]);
    const scene = makeScene('scene-a', 'stage-a');
    const mediaTasks = { image: { elementId: 'image' } };
    const { deps, settings } = makeDeps({
      fetchClassroom: vi.fn().mockResolvedValue({ stage, scenes: [scene] }),
      applyFallbackScenes: vi.fn().mockResolvedValue(true),
      loadRestoredMediaTasks: vi.fn().mockResolvedValue(mediaTasks),
      loadGeneratedAgentRecords: vi.fn().mockResolvedValue([{ id: 'agent-a' }]),
      applyGeneratedAgentRecords: vi.fn().mockReturnValue(['agent-a']),
      restoreAgentSelection: vi.fn().mockReturnValue({
        selection: { mode: 'auto', selectedAgentIds: ['agent-a'] },
        isUserSet: false,
      }),
    });

    await runClassroomLoad(deps);

    expect(deps.loadFromStorage).toHaveBeenCalledWith('stage-a', 1);
    expect(deps.applyFallbackScenes).toHaveBeenCalledWith({
      loadToken: 1,
      stage,
      scenes: [scene],
    });
    expect(deps.saveGeneratedAgents).toHaveBeenCalledWith('stage-a', stage.generatedAgentConfigs);
    expect(deps.applyRestoredMediaTasks).toHaveBeenCalledWith(mediaTasks);
    expect(deps.applyGeneratedAgentRecords).toHaveBeenCalledWith([{ id: 'agent-a' }]);
    expect(settings.setSelectedAgentIds).toHaveBeenCalledWith(['agent-a']);
    expect(deps.setLoading).toHaveBeenCalledWith(false);
  });

  it('stops side effects when the component unmounts while loading', async () => {
    const loadStorage = deferred<void>();
    const { deps, setCurrent } = makeDeps({
      loadFromStorage: vi.fn().mockReturnValue(loadStorage.promise),
    });

    const loading = runClassroomLoad(deps);
    await vi.waitFor(() => expect(deps.loadFromStorage).toHaveBeenCalled());

    setCurrent(false);
    loadStorage.resolve();
    await loading;

    expect(deps.loadRestoredMediaTasks).not.toHaveBeenCalled();
    expect(deps.loadGeneratedAgentRecords).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
    expect(deps.setLoading).not.toHaveBeenCalled();
  });
});

describe('saveGeneratedAgentsForCurrentLoad', () => {
  it('finishes the generated-agent replacement when the load becomes stale during deletion', async () => {
    const deletion = deferred<void>();
    let current = true;
    databaseMocks.deleteGeneratedAgents.mockReturnValueOnce(deletion.promise);
    databaseMocks.bulkPutGeneratedAgents.mockResolvedValueOnce(undefined);
    const agents = [
      {
        id: 'agent-a',
        name: 'Agent A',
        role: 'teacher',
        persona: 'Teach',
        avatar: 'A',
        color: '#000',
        priority: 1,
      },
    ];

    const saving = saveGeneratedAgentsForCurrentLoad('stage-a', agents, () => current);
    await vi.waitFor(() => expect(databaseMocks.deleteGeneratedAgents).toHaveBeenCalled());

    current = false;
    deletion.resolve();
    await saving;

    expect(databaseMocks.transaction).toHaveBeenCalledWith(
      'rw',
      expect.anything(),
      expect.any(Function),
    );
    expect(databaseMocks.bulkPutGeneratedAgents).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'agent-a', stageId: 'stage-a' }),
    ]);
  });
});

describe('discardRestoredMediaTasks', () => {
  it('revokes restored media URLs that never enter the store', () => {
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    discardRestoredMediaTasks({
      image: {
        elementId: 'image',
        type: 'image',
        status: 'done',
        prompt: 'image',
        params: {},
        objectUrl: 'blob:image',
        poster: 'blob:poster',
        retryCount: 0,
        stageId: 'stage-a',
      },
    });

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:image');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:poster');
    revokeObjectURL.mockRestore();
  });
});
