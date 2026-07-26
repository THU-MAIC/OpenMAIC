import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyClassroomStageAndScenes,
  commitMigratedAgentConfigsToStore,
  discardRestoredMediaTasks,
  mergeLegacyAgentFallbacks,
  resetLegacyAgentFallbackProbes,
  rosterNeedsLegacyFallback,
  runClassroomLoad,
} from '@/lib/classroom/load-classroom';
import {
  claimStageSceneLoadToken,
  isCurrentStageSceneLoadToken,
  useStageStore,
} from '@/lib/store/stage';
import type { GeneratedAgentConfig, Scene, Stage } from '@/lib/types/stage';

// The store flush path imports stage-storage dynamically; mock it so a pending
// mark scheduled by commitMigratedAgentConfigsToStore can never reach a real
// (or jsdom) IndexedDB.
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: vi.fn().mockResolvedValue({ failedChanges: [] }),
  loadStageData: vi.fn().mockResolvedValue(null),
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

function makeAgentConfig(id: string, extra: Partial<GeneratedAgentConfig> = {}) {
  return {
    id,
    name: `Agent ${id}`,
    role: 'teacher',
    persona: 'Teach',
    avatar: 'A',
    color: '#000',
    priority: 1,
    ...extra,
  } satisfies GeneratedAgentConfig;
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
    loadRestoredMediaTasks: vi.fn().mockResolvedValue({}),
    applyRestoredMediaTasks: vi.fn(),
    discardRestoredMediaTasks: vi.fn(),
    loadLegacyAgentFallbacks: vi.fn().mockResolvedValue([]),
    commitMigratedAgentConfigs: vi.fn(),
    applyGeneratedAgents: vi.fn().mockReturnValue([]),
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

// The fruitless-probe memo is session-scoped module state; isolate tests.
beforeEach(() => {
  resetLegacyAgentFallbackProbes();
});

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

  it('resets caller-bound chat authority when fallback replaces the classroom', () => {
    useStageStore.setState({
      stage: makeStage('stage-old'),
      chats: [],
      chatSnapshot: { sessions: [], restoreMarker: 'chat-restore-marker:stage-old:marker' },
    });

    applyClassroomStageAndScenes(makeStage('stage-new'), [], { persist: false });

    expect(useStageStore.getState().chatSnapshot).toEqual({
      sessions: [],
      restoreMarker: null,
    });
    useStageStore.getState().clearStore();
  });

  it('commits runtime chats hydrated for a server fallback', () => {
    const hydratedChat = {
      id: 'runtime-chat',
      type: 'qa' as const,
      title: 'Runtime chat',
      status: 'completed' as const,
      messages: [],
      config: { agentIds: [] },
      toolCalls: [],
      pendingToolCalls: [],
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const chatSnapshot = { sessions: [hydratedChat], restoreMarker: null };

    applyClassroomStageAndScenes(makeStage('stage-runtime-chat'), [], {
      persist: false,
      chats: [hydratedChat],
      chatSnapshot,
    });

    expect(useStageStore.getState().chats).toEqual([hydratedChat]);
    expect(useStageStore.getState().chatSnapshot).toEqual(chatSnapshot);
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
    expect(deps.applyGeneratedAgents).not.toHaveBeenCalled();
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
    expect(deps.applyGeneratedAgents).not.toHaveBeenCalled();
    expect(deps.setLoading).not.toHaveBeenCalled();
  });

  it('stops after fallback apply when the load is superseded', async () => {
    const applied = deferred<boolean>();
    const { deps, setCurrent } = makeDeps({
      fetchClassroom: vi.fn().mockResolvedValue({
        stage: makeStage('stage-a', [makeAgentConfig('agent-a')]),
        scenes: [makeScene('scene-a', 'stage-a')],
      }),
      applyFallbackScenes: vi.fn().mockReturnValue(applied.promise),
    });

    const loading = runClassroomLoad(deps);
    await vi.waitFor(() => expect(deps.applyFallbackScenes).toHaveBeenCalled());

    setCurrent(false);
    applied.resolve(true);
    await loading;

    expect(deps.loadRestoredMediaTasks).not.toHaveBeenCalled();
    expect(deps.applyGeneratedAgents).not.toHaveBeenCalled();
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
    expect(deps.applyGeneratedAgents).not.toHaveBeenCalled();
    expect(deps.setLoading).not.toHaveBeenCalled();
  });

  it('hydrates the registry from document configs without consulting the mirror', async () => {
    const configs = [
      makeAgentConfig('agent-a', {
        voiceDesign: { identity: 'warm mentor', texture: 'low', delivery: 'calm' },
      }),
    ];
    const { deps, settings, setStage } = makeDeps({
      applyGeneratedAgents: vi.fn().mockReturnValue(['agent-a']),
      restoreAgentSelection: vi.fn().mockReturnValue({
        selection: { mode: 'auto', selectedAgentIds: ['agent-a'] },
        isUserSet: false,
      }),
    });
    setStage(makeStage('stage-a', configs));

    await runClassroomLoad(deps);

    expect(deps.loadLegacyAgentFallbacks).not.toHaveBeenCalled();
    expect(deps.commitMigratedAgentConfigs).not.toHaveBeenCalled();
    expect(deps.applyGeneratedAgents).toHaveBeenCalledExactlyOnceWith('stage-a', configs);
    expect(settings.setSelectedAgentIds).toHaveBeenCalledWith(['agent-a']);
    expect(deps.setLoading).toHaveBeenCalledWith(false);
  });

  it('backfills missing voice fields from the legacy mirror and commits the merge', async () => {
    const configs = [makeAgentConfig('agent-a')];
    const voiceDesign = { identity: 'bright', texture: 'clear', delivery: 'lively' };
    const { deps, setStage } = makeDeps({
      loadLegacyAgentFallbacks: vi
        .fn()
        .mockResolvedValue([makeAgentConfig('agent-a', { voiceDesign })]),
      applyGeneratedAgents: vi.fn().mockReturnValue(['agent-a']),
    });
    setStage(makeStage('stage-a', configs));

    await runClassroomLoad(deps);

    const merged = [makeAgentConfig('agent-a', { voiceDesign })];
    expect(deps.commitMigratedAgentConfigs).toHaveBeenCalledExactlyOnceWith('stage-a', merged);
    expect(deps.applyGeneratedAgents).toHaveBeenCalledExactlyOnceWith('stage-a', merged);
  });

  it('lifts a roster missing from the document entirely from the legacy mirror', async () => {
    const fallbacks = [
      makeAgentConfig('gen-student', { role: 'student', priority: 5 }),
      makeAgentConfig('gen-teacher', { role: 'teacher', priority: 10 }),
    ];
    const { deps, setStage } = makeDeps({
      loadLegacyAgentFallbacks: vi.fn().mockResolvedValue(fallbacks),
      applyGeneratedAgents: vi.fn().mockReturnValue(['gen-teacher', 'gen-student']),
    });
    setStage(makeStage('stage-a', []));

    await runClassroomLoad(deps);

    const lifted = [fallbacks[1], fallbacks[0]]; // priority-desc, teacher first
    expect(deps.commitMigratedAgentConfigs).toHaveBeenCalledExactlyOnceWith('stage-a', lifted);
    expect(deps.applyGeneratedAgents).toHaveBeenCalledExactlyOnceWith('stage-a', lifted);
  });

  it('remembers a fruitless mirror probe and skips it on later loads of the same classroom', async () => {
    // Server-generated classrooms have voiceless rosters by design: the probe
    // finds nothing to merge, and without the memo it would re-query the
    // mirror on every single load, forever.
    const { deps, setStage } = makeDeps({
      loadLegacyAgentFallbacks: vi.fn().mockResolvedValue([]),
      applyGeneratedAgents: vi.fn().mockReturnValue(['agent-a']),
    });
    setStage(makeStage('stage-a', [makeAgentConfig('agent-a')]));

    await runClassroomLoad(deps);
    expect(deps.loadLegacyAgentFallbacks).toHaveBeenCalledTimes(1);

    await runClassroomLoad(deps);
    expect(deps.loadLegacyAgentFallbacks).toHaveBeenCalledTimes(1);
    expect(deps.commitMigratedAgentConfigs).not.toHaveBeenCalled();
    // The roster itself still hydrates the registry on every load.
    expect(deps.applyGeneratedAgents).toHaveBeenCalledTimes(2);
  });

  it('scopes the fruitless-probe memo per classroom', async () => {
    const first = makeDeps({ loadLegacyAgentFallbacks: vi.fn().mockResolvedValue([]) });
    first.setStage(makeStage('stage-a', [makeAgentConfig('agent-a')]));
    await runClassroomLoad(first.deps);
    expect(first.deps.loadLegacyAgentFallbacks).toHaveBeenCalledTimes(1);

    const second = makeDeps({
      classroomId: 'stage-b',
      loadLegacyAgentFallbacks: vi.fn().mockResolvedValue([]),
    });
    second.setStage(makeStage('stage-b', [makeAgentConfig('agent-b')]));
    await runClassroomLoad(second.deps);
    expect(second.deps.loadLegacyAgentFallbacks).toHaveBeenCalledTimes(1);
  });

  it('keeps probing until a successful merge is durably on the document (no memo on merges)', async () => {
    // A merge that changed the roster is committed dirty; if its flush failed,
    // the next load must probe and merge again rather than being memoized.
    // This harness never updates the document copy, standing in for exactly
    // that failed-flush case.
    const voiceDesign = { identity: 'bright', texture: 'clear', delivery: 'lively' };
    const { deps, setStage } = makeDeps({
      loadLegacyAgentFallbacks: vi
        .fn()
        .mockResolvedValue([makeAgentConfig('agent-a', { voiceDesign })]),
      applyGeneratedAgents: vi.fn().mockReturnValue(['agent-a']),
    });
    setStage(makeStage('stage-a', [makeAgentConfig('agent-a')]));

    await runClassroomLoad(deps);
    await runClassroomLoad(deps);

    expect(deps.loadLegacyAgentFallbacks).toHaveBeenCalledTimes(2);
    expect(deps.commitMigratedAgentConfigs).toHaveBeenCalledTimes(2);
  });

  it('does not commit or apply a merged roster when superseded during the mirror read', async () => {
    const fallbackRead = deferred<GeneratedAgentConfig[]>();
    const { deps, setCurrent, setStage } = makeDeps({
      loadLegacyAgentFallbacks: vi.fn().mockReturnValue(fallbackRead.promise),
    });
    setStage(makeStage('stage-a', [makeAgentConfig('agent-a')]));

    const loading = runClassroomLoad(deps);
    await vi.waitFor(() => expect(deps.loadLegacyAgentFallbacks).toHaveBeenCalled());

    setCurrent(false);
    fallbackRead.resolve([
      makeAgentConfig('agent-a', {
        voiceDesign: { identity: 'x', texture: 'y', delivery: 'z' },
      }),
    ]);
    await loading;

    expect(deps.commitMigratedAgentConfigs).not.toHaveBeenCalled();
    expect(deps.applyGeneratedAgents).not.toHaveBeenCalled();
    expect(deps.setLoading).not.toHaveBeenCalled();
  });

  it('runs all phases and clears loading for the current navigation', async () => {
    const stage = makeStage('stage-a', [makeAgentConfig('agent-a')]);
    const scene = makeScene('scene-a', 'stage-a');
    const mediaTasks = { image: { elementId: 'image' } };
    const { deps, settings, setStage } = makeDeps({
      fetchClassroom: vi.fn().mockResolvedValue({ stage, scenes: [scene] }),
      loadRestoredMediaTasks: vi.fn().mockResolvedValue(mediaTasks),
      applyGeneratedAgents: vi.fn().mockReturnValue(['agent-a']),
      restoreAgentSelection: vi.fn().mockReturnValue({
        selection: { mode: 'auto', selectedAgentIds: ['agent-a'] },
        isUserSet: false,
      }),
    });
    const applyFallbackScenes = vi.fn().mockImplementation(async () => {
      // A committed fallback puts the fetched stage into the store.
      setStage(stage);
      return true;
    });
    deps.applyFallbackScenes = applyFallbackScenes;

    await runClassroomLoad(deps);

    expect(deps.loadFromStorage).toHaveBeenCalledWith('stage-a', 1);
    expect(applyFallbackScenes).toHaveBeenCalledWith({
      loadToken: 1,
      stage,
      scenes: [scene],
    });
    expect(deps.applyRestoredMediaTasks).toHaveBeenCalledWith(mediaTasks);
    expect(deps.applyGeneratedAgents).toHaveBeenCalledWith('stage-a', stage.generatedAgentConfigs);
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
    expect(deps.applyGeneratedAgents).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
    expect(deps.setLoading).not.toHaveBeenCalled();
  });
});

describe('rosterNeedsLegacyFallback', () => {
  it('is true for an empty roster (the document may predate roster persistence)', () => {
    expect(rosterNeedsLegacyFallback([])).toBe(true);
  });

  it('is true when any agent lacks both voice fields', () => {
    expect(
      rosterNeedsLegacyFallback([
        makeAgentConfig('a', { voiceConfig: { providerId: 'p', voiceId: 'v' } }),
        makeAgentConfig('b'),
      ]),
    ).toBe(true);
  });

  it('is false once every agent carries a voice field', () => {
    expect(
      rosterNeedsLegacyFallback([
        makeAgentConfig('a', { voiceConfig: { providerId: 'p', voiceId: 'v' } }),
        makeAgentConfig('b', {
          voiceDesign: { identity: 'i', texture: 't', delivery: 'd' },
        }),
      ]),
    ).toBe(false);
  });
});

describe('mergeLegacyAgentFallbacks', () => {
  const voiceDesign = { identity: 'i', texture: 't', delivery: 'd' };
  const voiceConfig = { providerId: 'p', voiceId: 'v' };

  it('backfills voice fields by id and reports the change', () => {
    const { configs, changed } = mergeLegacyAgentFallbacks(
      [makeAgentConfig('a'), makeAgentConfig('b')],
      [makeAgentConfig('a', { voiceDesign, voiceConfig })],
    );
    expect(changed).toBe(true);
    expect(configs[0]).toEqual(makeAgentConfig('a', { voiceDesign, voiceConfig }));
    expect(configs[1]).toEqual(makeAgentConfig('b'));
  });

  it('never overwrites document-held voice fields', () => {
    const docConfig = makeAgentConfig('a', { voiceDesign });
    const { configs, changed } = mergeLegacyAgentFallbacks(
      [docConfig],
      [makeAgentConfig('a', { voiceDesign: { identity: 'x', texture: 'y', delivery: 'z' } })],
    );
    expect(changed).toBe(false);
    expect(configs[0]).toBe(docConfig);
  });

  it('is idempotent: a second merge over the committed result changes nothing', () => {
    const fallbacks = [makeAgentConfig('a', { voiceDesign })];
    const first = mergeLegacyAgentFallbacks([makeAgentConfig('a')], fallbacks);
    expect(first.changed).toBe(true);
    const second = mergeLegacyAgentFallbacks(first.configs, fallbacks);
    expect(second.changed).toBe(false);
    expect(second.configs).toEqual(first.configs);
  });

  it('lifts a full roster when the document has none, priority-descending', () => {
    const { configs, changed } = mergeLegacyAgentFallbacks(
      [],
      [makeAgentConfig('low', { priority: 3 }), makeAgentConfig('high', { priority: 9 })],
    );
    expect(changed).toBe(true);
    expect(configs.map((c) => c.id)).toEqual(['high', 'low']);
  });

  it('reports no change when both sides are empty', () => {
    expect(mergeLegacyAgentFallbacks([], [])).toEqual({ configs: [], changed: false });
  });
});

describe('commitMigratedAgentConfigsToStore', () => {
  it('commits onto the matching stage and leaves a different stage untouched', () => {
    const configs = [makeAgentConfig('agent-a')];
    useStageStore.setState({ stage: makeStage('stage-a') });

    commitMigratedAgentConfigsToStore('stage-a', configs);
    expect(useStageStore.getState().stage?.generatedAgentConfigs).toEqual(configs);

    // Simulate a classroom switch racing the commit: the stale commit no-ops.
    useStageStore.setState({ stage: makeStage('stage-b') });
    commitMigratedAgentConfigsToStore('stage-a', [makeAgentConfig('stale')]);
    expect(useStageStore.getState().stage?.id).toBe('stage-b');
    expect(useStageStore.getState().stage?.generatedAgentConfigs).toEqual([]);

    useStageStore.getState().clearStore();
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
