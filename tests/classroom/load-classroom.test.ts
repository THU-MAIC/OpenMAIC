import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commitMigratedAgentConfigsToStore,
  discardRestoredMediaTasks,
  mergeLegacyAgentFallbacks,
  resetLegacyAgentFallbackProbes,
  rosterNeedsLegacyFallback,
  runClassroomLoad,
} from '@/lib/classroom/load-classroom';
import {
  claimStageSceneLoadToken,
  clearStoreForDeletedStage,
  discardPendingStageChanges,
  flushStageSave,
  restorePendingStageChanges,
  snapshotPendingStageChangesForDeletion,
  useStageStore,
} from '@/lib/store/stage';
import {
  beginStageDeletionCascade,
  markStageDeleted,
  settleStageDeletionCascade,
  unmarkStageDeleted,
} from '@/lib/utils/deleted-stages';
import { loadStageData, saveStageDataIncremental } from '@/lib/utils/stage-storage';
import type { GeneratedAgentConfig, Scene, Stage } from '@/lib/types/stage';
import { restoreAgentSelection } from '@/lib/orchestration/registry/agent-selection';

// The store flush path imports stage-storage dynamically; mock it so a pending
// mark scheduled by commitMigratedAgentConfigsToStore can never reach a real
// (or jsdom) IndexedDB.
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: vi.fn().mockResolvedValue({ failedChanges: [] }),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

// Omitting `generatedAgentConfigs` models a document written before roster
// persistence existed (field absent) — distinct from an explicit `[]`, which
// is an authoritative empty roster.
function makeStage(id: string, generatedAgentConfigs?: Stage['generatedAgentConfigs']): Stage {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    ...(generatedAgentConfigs !== undefined ? { generatedAgentConfigs } : {}),
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

/** Put a classroom in the stage store, as a completed load leaves it. */
function seedStage(stage: Stage, scenes: Scene[]) {
  useStageStore.setState({ stage, scenes, currentSceneId: scenes[0]?.id ?? null });
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
  it('discards the warm ghost of a deleted classroom and reports it absent (back-button path)', async () => {
    // Open classroom -> navigate home -> delete -> browser Back. The warm
    // store must not short-circuit the load: the ghost is discarded, the cold
    // load finds nothing on the server, and the load is a positive absence.
    useStageStore.getState().clearStore();
    vi.mocked(loadStageData).mockClear();
    seedStage(makeStage('stage-warm-ghost'), [makeScene('scene-w', 'stage-warm-ghost')]);
    markStageDeleted('stage-warm-ghost');
    try {
      const { deps } = makeDeps({
        classroomId: 'stage-warm-ghost',
        loadFromStorage: (id, token) => useStageStore.getState().loadFromStorage(id, token),
        getCurrentStage: () => useStageStore.getState().stage,
      });

      await expect(runClassroomLoad(deps)).resolves.toEqual({ outcome: 'absent' });

      expect(loadStageData).toHaveBeenCalledWith('stage-warm-ghost');
      expect(useStageStore.getState().stage).toBeNull();
    } finally {
      unmarkStageDeleted('stage-warm-ghost');
      useStageStore.getState().clearStore();
    }
  });
  it('discards a deleted classroom whose warm ghost has ZERO scenes (identity, not scene count, gates the ghost handling)', async () => {
    // A scene-less classroom whose cascade failed after removing the document
    // leaves a warm ghost with zero scenes. Gating the deleted-warm handling
    // on `scenes.length > 0` would leave the ghost in the store as a fully
    // editable classroom whose every edit is silently dropped.
    useStageStore.getState().clearStore();
    vi.mocked(loadStageData).mockClear();
    seedStage(makeStage('stage-zero-ghost'), []);
    markStageDeleted('stage-zero-ghost');
    try {
      const { deps } = makeDeps({
        classroomId: 'stage-zero-ghost',
        loadFromStorage: (id, token) => useStageStore.getState().loadFromStorage(id, token),
        getCurrentStage: () => useStageStore.getState().stage,
      });

      await expect(runClassroomLoad(deps)).resolves.toEqual({ outcome: 'absent' });

      expect(loadStageData).toHaveBeenCalledWith('stage-zero-ghost');
      expect(useStageStore.getState().stage).toBeNull();
    } finally {
      unmarkStageDeleted('stage-zero-ghost');
      useStageStore.getState().clearStore();
    }
  });
  it('parks a mid-cascade Back until the deletion settles; a failed delete keeps the warm classroom editable', async () => {
    // Browser Back lands while the home-page delete is still mid-cascade. The
    // warm state (plus the deletion path's dirt snapshot) is the only copy of
    // the pre-delete edits — but completing the load before the outcome is
    // known would expose a classroom whose edits are refused and unrecorded.
    // The load must WAIT for settlement, then keep the warm state when the
    // delete failed (flag lifted, dirt restored).
    useStageStore.getState().clearStore();
    vi.mocked(saveStageDataIncremental).mockClear();
    vi.mocked(loadStageData).mockClear();
    seedStage(makeStage('stage-mid-delete'), [makeScene('scene-m', 'stage-mid-delete')]);
    // A pre-delete edit sitting in the debounce window.
    useStageStore.getState().setCurrentSceneId('scene-m');
    try {
      // Same ordering as deleteStageData: snapshot → mark → begin → discard.
      const discarded = snapshotPendingStageChangesForDeletion('stage-mid-delete');
      expect(discarded).toEqual([{ kind: 'currentScene' }]);
      markStageDeleted('stage-mid-delete');
      beginStageDeletionCascade('stage-mid-delete');
      discardPendingStageChanges('stage-mid-delete');

      // Back lands mid-cascade: the load parks on settlement instead of
      // completing (no resolution, warm state untouched, no IndexedDB read).
      const token = claimStageSceneLoadToken();
      let loadSettled = false;
      const loading = useStageStore
        .getState()
        .loadFromStorage('stage-mid-delete', token)
        .then(() => {
          loadSettled = true;
        });
      await Promise.resolve();
      await Promise.resolve();
      expect(loadSettled).toBe(false);
      expect(useStageStore.getState().stage?.id).toBe('stage-mid-delete');
      expect(loadStageData).not.toHaveBeenCalled();

      // The cascade fails before removing the document — deleteStageData's
      // failure path lifts the flag, restores the dirt, then settles.
      unmarkStageDeleted('stage-mid-delete');
      restorePendingStageChanges('stage-mid-delete', discarded);
      settleStageDeletionCascade('stage-mid-delete');

      // The parked load resumes and keeps the warm (live again) classroom.
      await loading;
      expect(useStageStore.getState().stage?.id).toBe('stage-mid-delete');
      expect(loadStageData).not.toHaveBeenCalled();

      // The pre-delete edit reaches durability again through the scheduler.
      await flushStageSave();
      expect(saveStageDataIncremental).toHaveBeenCalledWith(
        'stage-mid-delete',
        expect.arrayContaining([{ kind: 'currentScene' }]),
        expect.anything(),
        expect.any(Number),
      );
    } finally {
      settleStageDeletionCascade('stage-mid-delete');
      unmarkStageDeleted('stage-mid-delete');
      useStageStore.getState().clearStore();
    }
  });

  it('completes a mid-cascade Back as absent when the deletion succeeds', async () => {
    // Back during delete -> the deletion succeeds. The parked load must
    // observe the settled outcome, let the settlement eviction stand, and run
    // the full cold load, which finds the course gone.
    useStageStore.getState().clearStore();
    vi.mocked(loadStageData).mockClear();
    seedStage(makeStage('stage-del-success'), [makeScene('scene-s', 'stage-del-success')]);
    markStageDeleted('stage-del-success');
    beginStageDeletionCascade('stage-del-success');
    try {
      const token = claimStageSceneLoadToken();
      const { deps } = makeDeps({
        classroomId: 'stage-del-success',
        loadToken: token,
        loadFromStorage: (id, t) => useStageStore.getState().loadFromStorage(id, t),
        getCurrentStage: () => useStageStore.getState().stage,
      });

      const loading = runClassroomLoad(deps);
      await Promise.resolve();
      await Promise.resolve();
      // Parked: the classroom is not handed over mid-window.
      expect(loadStageData).not.toHaveBeenCalled();
      expect(useStageStore.getState().stage?.id).toBe('stage-del-success');

      // The cascade completes: deleteStageData settles, then evicts — same
      // synchronous ordering as its finally + success tail.
      settleStageDeletionCascade('stage-del-success');
      clearStoreForDeletedStage('stage-del-success');
      expect(useStageStore.getState().stage).toBeNull();

      await expect(loading).resolves.toEqual({ outcome: 'absent' });
      expect(loadStageData).toHaveBeenCalledWith('stage-del-success');
      expect(useStageStore.getState().stage).toBeNull();
      expect(deps.setLoading).toHaveBeenCalledWith(false);
    } finally {
      settleStageDeletionCascade('stage-del-success');
      unmarkStageDeleted('stage-del-success');
      useStageStore.getState().clearStore();
    }
  });
  it('does not land the parked load when navigation moves on during deletion settlement', async () => {
    // The user hits Back mid-cascade (load parks on settlement), then
    // navigates to another classroom before the deletion settles. When the
    // settlement releases the parked load, the token guard must keep it from
    // touching the store the newer navigation now owns.
    useStageStore.getState().clearStore();
    vi.mocked(loadStageData).mockClear();
    seedStage(makeStage('stage-await-nav'), [makeScene('scene-n', 'stage-await-nav')]);
    markStageDeleted('stage-await-nav');
    beginStageDeletionCascade('stage-await-nav');
    try {
      const token = claimStageSceneLoadToken();
      const loading = useStageStore.getState().loadFromStorage('stage-await-nav', token);

      // A newer navigation claims the token and owns the store.
      claimStageSceneLoadToken();
      seedStage(makeStage('stage-other'), [makeScene('scene-o', 'stage-other')]);

      // The deletion settles successfully (flag kept) — releasing the parked
      // load, which must now be a no-op.
      settleStageDeletionCascade('stage-await-nav');
      await loading;

      expect(useStageStore.getState().stage?.id).toBe('stage-other');
      expect(useStageStore.getState().scenes.map((s) => s.id)).toEqual(['scene-o']);
      expect(loadStageData).not.toHaveBeenCalled();
    } finally {
      settleStageDeletionCascade('stage-await-nav');
      unmarkStageDeleted('stage-await-nav');
      useStageStore.getState().clearStore();
    }
  });

  it('cold-loads after a failed delete when the store was replaced during the park (no false keep-warm)', async () => {
    // Back parks on stage A's deletion settlement; while parked, a tokenless
    // store writer (another classroom applied to the store directly) replaces
    // the store contents WITHOUT
    // claiming the load token. When the deletion then FAILS, there is no warm
    // state of A left to keep — the keep-warm branch must re-verify store
    // identity (mirroring the success path) and fall through to the cold
    // load, instead of reporting the imported classroom as A's live state.
    useStageStore.getState().clearStore();
    vi.mocked(loadStageData).mockClear();
    const localStage = makeStage('stage-park-replaced');
    const localScene = makeScene('scene-p', 'stage-park-replaced');
    seedStage(localStage, [localScene]);
    markStageDeleted('stage-park-replaced');
    beginStageDeletionCascade('stage-park-replaced');
    try {
      // The failed delete leaves A's document in place: the cold path re-reads it.
      vi.mocked(loadStageData).mockResolvedValueOnce({
        stage: localStage,
        scenes: [localScene],
        currentSceneId: localScene.id,
        chats: [],
      });
      const token = claimStageSceneLoadToken();
      const loading = useStageStore.getState().loadFromStorage('stage-park-replaced', token);
      await Promise.resolve();
      await Promise.resolve();
      // Parked: no IndexedDB read yet.
      expect(loadStageData).not.toHaveBeenCalled();

      // An import applies ANOTHER stage mid-park, leaving the token untouched.
      seedStage(makeStage('stage-imported'), [makeScene('scene-i', 'stage-imported')]);

      // The deletion fails before removing the document: flag lifted, settled.
      unmarkStageDeleted('stage-park-replaced');
      settleStageDeletionCascade('stage-park-replaced');
      await loading;

      // Not a false keep-warm of the imported stage: the parked load fell
      // through to the cold path and handed the route back to A.
      expect(loadStageData).toHaveBeenCalledExactlyOnceWith('stage-park-replaced');
      expect(useStageStore.getState().stage?.id).toBe('stage-park-replaced');
      expect(useStageStore.getState().scenes.map((s) => s.id)).toEqual(['scene-p']);
    } finally {
      settleStageDeletionCascade('stage-park-replaced');
      unmarkStageDeleted('stage-park-replaced');
      useStageStore.getState().clearStore();
    }
  });

  it('does not evict a classroom restored (and unmarked) during the cascade tail', () => {
    // Cascade-tail race: deleteStageData succeeded, and before its synchronous
    // continuation ran the eviction, a same-id restore completed and unmarked
    // the deletion. The eviction must recognize the warm state as the RESTORED
    // classroom, not the deleted ghost.
    useStageStore.getState().clearStore();
    markStageDeleted('stage-tail-restore');
    try {
      unmarkStageDeleted('stage-tail-restore');
      seedStage(makeStage('stage-tail-restore'), [makeScene('scene-t', 'stage-tail-restore')]);

      clearStoreForDeletedStage('stage-tail-restore');

      expect(useStageStore.getState().stage?.id).toBe('stage-tail-restore');
    } finally {
      unmarkStageDeleted('stage-tail-restore');
      useStageStore.getState().clearStore();
    }
  });

  it('keeps dropping in-flight writes for a deleted classroom that was NOT restored', async () => {
    useStageStore.getState().clearStore();
    vi.mocked(saveStageDataIncremental).mockClear();
    seedStage(makeStage('stage-doomed'), [makeScene('scene-d', 'stage-doomed')]);
    try {
      markStageDeleted('stage-doomed');
      useStageStore.getState().setCurrentSceneId('scene-d');
      await flushStageSave();
      expect(saveStageDataIncremental).not.toHaveBeenCalled();
    } finally {
      unmarkStageDeleted('stage-doomed');
      useStageStore.getState().clearStore();
    }
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
    // No roster field at all: the document predates roster persistence.
    setStage(makeStage('stage-a'));

    await runClassroomLoad(deps);

    const lifted = [fallbacks[1], fallbacks[0]]; // priority-desc, teacher first
    expect(deps.commitMigratedAgentConfigs).toHaveBeenCalledExactlyOnceWith('stage-a', lifted);
    expect(deps.applyGeneratedAgents).toHaveBeenCalledExactlyOnceWith('stage-a', lifted);
  });

  it('treats an explicitly persisted empty roster as authoritative: stale mirror rows are not resurrected', async () => {
    // The mirror is never cleaned except on stage deletion, so a device can
    // hold stale rows for a stage whose document explicitly carries `[]`.
    // Collapsing absent and empty would lift the whole stale roster back on
    // every load (the merge reports `changed: true`, so not even the
    // fruitless-probe memo would stop it). The explicit `[]` must win.
    const { deps, setStage } = makeDeps({
      loadLegacyAgentFallbacks: vi.fn().mockResolvedValue([makeAgentConfig('stale-mirror-row')]),
      applyGeneratedAgents: vi.fn().mockReturnValue([]),
    });
    setStage(makeStage('stage-a', []));

    await runClassroomLoad(deps);

    expect(deps.loadLegacyAgentFallbacks).not.toHaveBeenCalled();
    expect(deps.commitMigratedAgentConfigs).not.toHaveBeenCalled();
    expect(deps.applyGeneratedAgents).toHaveBeenCalledExactlyOnceWith('stage-a', []);
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

  it('does not memoize a FAILED mirror read: the next load retries the probe', async () => {
    // `null` = the read failed (vs. `[]` = mirror confirmed empty). A transient
    // IndexedDB error must not become a session-long migration skip.
    const { deps, setStage } = makeDeps({
      loadLegacyAgentFallbacks: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue([] as GeneratedAgentConfig[]),
      applyGeneratedAgents: vi.fn().mockReturnValue(['agent-a']),
    });
    setStage(makeStage('stage-a', [makeAgentConfig('agent-a')]));

    // First load: the read fails — nothing merged, nothing memoized.
    await runClassroomLoad(deps);
    expect(deps.loadLegacyAgentFallbacks).toHaveBeenCalledTimes(1);
    expect(deps.commitMigratedAgentConfigs).not.toHaveBeenCalled();

    // Second load: retried; the read now succeeds empty — memoized.
    await runClassroomLoad(deps);
    expect(deps.loadLegacyAgentFallbacks).toHaveBeenCalledTimes(2);

    // Third load: the successful empty probe is remembered.
    await runClassroomLoad(deps);
    expect(deps.loadLegacyAgentFallbacks).toHaveBeenCalledTimes(2);
  });

  it('still hydrates the registry from document configs when the mirror read fails', async () => {
    const configs = [makeAgentConfig('agent-a')];
    const { deps, setStage } = makeDeps({
      loadLegacyAgentFallbacks: vi.fn().mockResolvedValue(null),
      applyGeneratedAgents: vi.fn().mockReturnValue(['agent-a']),
    });
    setStage(makeStage('stage-a', configs));

    await runClassroomLoad(deps);

    expect(deps.applyGeneratedAgents).toHaveBeenCalledExactlyOnceWith('stage-a', configs);
    expect(deps.setLoading).toHaveBeenCalledWith(false);
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
    const mediaTasks = { image: { elementId: 'image' } };
    const { deps, settings, setStage } = makeDeps({
      loadRestoredMediaTasks: vi.fn().mockResolvedValue(mediaTasks),
      applyGeneratedAgents: vi.fn().mockReturnValue(['agent-a']),
      restoreAgentSelection: vi.fn().mockReturnValue({
        selection: { mode: 'auto', selectedAgentIds: ['agent-a'] },
        isUserSet: false,
      }),
    });
    deps.loadFromStorage = vi.fn().mockImplementation(async () => {
      // A completed storage load puts the course into the store.
      setStage(stage);
    });

    await expect(runClassroomLoad(deps)).resolves.toEqual({ outcome: 'ready' });

    expect(deps.loadFromStorage).toHaveBeenCalledWith('stage-a', 1);
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

  it('returns absent when storage has no course under the id', async () => {
    const { deps } = makeDeps();

    await expect(runClassroomLoad(deps)).resolves.toEqual({ outcome: 'absent' });
    expect(deps.loadRestoredMediaTasks).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
  });

  it('fails, not absent, when the storage load throws', async () => {
    const { deps } = makeDeps({
      loadFromStorage: vi.fn().mockRejectedValue(new Error('HTTP 503')),
    });

    await expect(runClassroomLoad(deps)).resolves.toEqual({ outcome: 'failed' });
    expect(deps.setError).toHaveBeenCalledWith('HTTP 503');
  });
});

describe('rosterNeedsLegacyFallback', () => {
  it('is true when the document carries no roster field (it may predate roster persistence)', () => {
    expect(rosterNeedsLegacyFallback(undefined)).toBe(true);
  });

  it('is false for an explicitly persisted empty roster (authoritative; never lifted)', () => {
    expect(rosterNeedsLegacyFallback([])).toBe(false);
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
    expect(useStageStore.getState().stage?.generatedAgentConfigs).toBeUndefined();

    useStageStore.getState().clearStore();
  });
});

describe('discardRestoredMediaTasks', () => {
  it('revokes restored media URLs that never enter the store', () => {
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    discardRestoredMediaTasks({
      stageId: 'stage-a',
      tasks: {
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
      },
      deferred: [],
    });

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:image');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:poster');
    revokeObjectURL.mockRestore();
  });
});

describe('runClassroomLoad before the custom agents arrived', () => {
  function userSetSelection(agentsKnown: boolean) {
    const { deps, settings, setStage } = makeDeps({
      getAgent: (id) => (id === 'default-1' ? { isGenerated: false } : undefined),
      agentsReady: vi.fn().mockResolvedValue(agentsKnown),
      restoreAgentSelection,
    });
    settings.agentMode = 'preset' as never;
    settings.selectedAgentIds = ['default-1', 'my-tutor'];
    settings.agentSelectionIsUserSet = true;
    setStage(makeStage('stage-a', []));
    return { deps, settings };
  }

  it('keeps a user-set selection naming a custom agent it cannot see yet', async () => {
    const { deps, settings } = userSetSelection(false);
    await expect(runClassroomLoad(deps)).resolves.toEqual({ outcome: 'ready' });
    expect(deps.agentsReady).toHaveBeenCalledOnce();
    expect(settings.setSelectedAgentIds).not.toHaveBeenCalled();
    expect(settings.setAgentMode).not.toHaveBeenCalled();
    expect(settings.setAgentSelectionIsUserSet).not.toHaveBeenCalled();
  });

  it('replaces it once the registry says the agent is gone', async () => {
    const { deps, settings } = userSetSelection(true);
    await runClassroomLoad(deps);
    expect(settings.setSelectedAgentIds).toHaveBeenCalledWith([
      'default-1',
      'default-2',
      'default-3',
    ]);
    expect(settings.setAgentSelectionIsUserSet).toHaveBeenCalledWith(false);
  });
});
