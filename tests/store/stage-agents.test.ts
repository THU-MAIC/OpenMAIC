import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  settingsState,
  setSelectedAgentIds,
  setAgentSelectionIsUserSet,
  applyGeneratedAgentsToRegistry,
} = vi.hoisted(() => {
  const setSelectedAgentIds = vi.fn();
  const setAgentSelectionIsUserSet = vi.fn();
  return {
    setSelectedAgentIds,
    setAgentSelectionIsUserSet,
    settingsState: {
      agentMode: 'auto' as 'preset' | 'auto',
      selectedAgentIds: [] as string[],
      agentSelectionIsUserSet: false,
      setSelectedAgentIds,
      setAgentSelectionIsUserSet,
    },
    applyGeneratedAgentsToRegistry: vi.fn(
      (_stageId: string, configs: ReadonlyArray<{ id: string }>) => configs.map((c) => c.id),
    ),
  };
});

// Stage-storage modules are imported dynamically inside the store's save/load
// actions. Mock them so the scheduled flush doesn't try to talk to a real (or
// jsdom) IndexedDB in the test environment.
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: vi.fn().mockResolvedValue(undefined),
  loadStageData: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  applyGeneratedAgentsToRegistry,
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: () => settingsState,
  },
}));

import {
  discardPendingStageChanges,
  restorePendingStageChanges,
  snapshotPendingStageChangesForDeletion,
  useStageStore,
} from '@/lib/store/stage';
import {
  markStageDeleted,
  stageDeletionEpoch,
  unmarkStageDeleted,
} from '@/lib/utils/deleted-stages';
import { saveStageData, saveStageDataIncremental } from '@/lib/utils/stage-storage';
import type { Stage } from '@/lib/types/stage';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

function makeStage(): Stage {
  return {
    id: 'stage-1',
    name: 'Test stage',
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeAgentConfig(id: string): GeneratedAgentConfig {
  return {
    id,
    name: `Agent ${id}`,
    role: 'teacher',
    persona: 'A helpful teacher',
    avatar: 'avatar-url',
    color: '#000000',
    priority: 1,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  applyGeneratedAgentsToRegistry.mockClear();
  setSelectedAgentIds.mockClear();
  setAgentSelectionIsUserSet.mockClear();
  settingsState.agentMode = 'auto';
  settingsState.selectedAgentIds = [];
  settingsState.agentSelectionIsUserSet = false;
  useStageStore.setState({
    stage: makeStage(),
    scenes: [],
    currentSceneId: null,
  });
});

afterEach(() => {
  // clearStore cancels any scheduled flush timer along with pending changes.
  useStageStore.getState().clearStore();
  // Deletion tombstones are session-scoped module state; reset every id the
  // tests use so one test's deletion cannot fence another's writes.
  unmarkStageDeleted('stage-1');
  unmarkStageDeleted('stage-2');
  vi.useRealTimers();
});

describe('setStageAgents', () => {
  it('writes generatedAgentConfigs to stage', () => {
    const configs = [makeAgentConfig('a1'), makeAgentConfig('a2')];
    useStageStore.getState().setStageAgents(configs);
    expect(useStageStore.getState().stage?.generatedAgentConfigs).toEqual(configs);
  });

  it('is a no-op when stage is null', () => {
    useStageStore.setState({ stage: null });
    expect(() => {
      useStageStore.getState().setStageAgents([makeAgentConfig('x')]);
    }).not.toThrow();
    expect(useStageStore.getState().stage).toBeNull();
  });

  it('replaces existing generatedAgentConfigs', () => {
    const stageWithAgents: Stage = {
      ...makeStage(),
      generatedAgentConfigs: [makeAgentConfig('old')],
    };
    useStageStore.setState({ stage: stageWithAgents });
    const newConfigs = [makeAgentConfig('new1'), makeAgentConfig('new2')];
    useStageStore.getState().setStageAgents(newConfigs);
    expect(useStageStore.getState().stage?.generatedAgentConfigs).toEqual(newConfigs);
  });

  it('preserves other stage fields when patching generatedAgentConfigs', () => {
    useStageStore.getState().setStageAgents([makeAgentConfig('a1')]);
    const stage = useStageStore.getState().stage;
    expect(stage?.id).toBe('stage-1');
    expect(stage?.name).toBe('Test stage');
  });

  it('synchronously mirrors the roster into the registry and selection', () => {
    const configs = [makeAgentConfig('a1'), makeAgentConfig('a2')];
    useStageStore.getState().setStageAgents(configs);

    // No timers involved: the registry/selection mirrors are in-memory side
    // effects, not persistence.
    expect(applyGeneratedAgentsToRegistry).toHaveBeenCalledExactlyOnceWith('stage-1', configs);
    expect(setSelectedAgentIds).toHaveBeenCalledExactlyOnceWith(['a1', 'a2']);
  });
});

describe('setStageAgents selection provenance', () => {
  it('tracks the full roster only while the selection is stage-derived (not user-set)', () => {
    settingsState.agentSelectionIsUserSet = false;
    settingsState.selectedAgentIds = ['a1'];

    useStageStore.getState().setStageAgents([makeAgentConfig('a1'), makeAgentConfig('a2')]);

    expect(setSelectedAgentIds).toHaveBeenCalledExactlyOnceWith(['a1', 'a2']);
  });

  it('narrows a user-set auto selection to the surviving roster; newcomers are not auto-selected', () => {
    settingsState.agentSelectionIsUserSet = true;
    settingsState.agentMode = 'auto';
    settingsState.selectedAgentIds = ['a1', 'removed'];

    useStageStore.getState().setStageAgents([makeAgentConfig('a1'), makeAgentConfig('newcomer')]);

    // 'removed' left the roster (dropped); 'newcomer' joined it (NOT selected).
    expect(setSelectedAgentIds).toHaveBeenCalledExactlyOnceWith(['a1']);
  });

  it('leaves a user-set auto selection untouched when every pick is still in the roster', () => {
    settingsState.agentSelectionIsUserSet = true;
    settingsState.agentMode = 'auto';
    settingsState.selectedAgentIds = ['a1'];

    useStageStore.getState().setStageAgents([makeAgentConfig('a1'), makeAgentConfig('a2')]);

    expect(setSelectedAgentIds).not.toHaveBeenCalled();
  });

  it('never touches a user-set preset selection (roster edits do not concern preset agents)', () => {
    settingsState.agentSelectionIsUserSet = true;
    settingsState.agentMode = 'preset';
    settingsState.selectedAgentIds = ['default-1', 'default-2'];

    useStageStore.getState().setStageAgents([makeAgentConfig('a1')]);

    expect(setSelectedAgentIds).not.toHaveBeenCalled();
  });

  it('falls back to the full roster and clears the user-set flag when the intersection is empty', () => {
    // Mirrors restoreAgentSelection's `length > 0` gate: an empty user-set
    // selection is invalid there, so it must not be written here either —
    // otherwise the classroom runs with zero agents until a reload heals it.
    useStageStore.setState({
      stage: {
        ...makeStage(),
        generatedAgentConfigs: [
          makeAgentConfig('old-1'),
          makeAgentConfig('old-2'),
          makeAgentConfig('old-3'),
        ],
      },
    });
    settingsState.agentSelectionIsUserSet = true;
    settingsState.agentMode = 'auto';
    // A genuine subset (not the full roster), all of whose members leave.
    settingsState.selectedAgentIds = ['old-1', 'old-2'];

    useStageStore
      .getState()
      .setStageAgents([makeAgentConfig('fresh-1'), makeAgentConfig('fresh-2')]);

    expect(setSelectedAgentIds).toHaveBeenCalledExactlyOnceWith(['fresh-1', 'fresh-2']);
    expect(setAgentSelectionIsUserSet).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('keeps tracking the whole roster when the user-set selection WAS the full roster (auto-toggle intent)', () => {
    // The AgentBar auto toggle snapshots the entire roster as a "user-set"
    // selection. That intent is "everyone", so a roster addition must include
    // the newcomer instead of freezing the old snapshot forever.
    useStageStore.setState({
      stage: {
        ...makeStage(),
        generatedAgentConfigs: [makeAgentConfig('a1'), makeAgentConfig('a2')],
      },
    });
    settingsState.agentSelectionIsUserSet = true;
    settingsState.agentMode = 'auto';
    settingsState.selectedAgentIds = ['a1', 'a2'];

    useStageStore
      .getState()
      .setStageAgents([makeAgentConfig('a1'), makeAgentConfig('a2'), makeAgentConfig('a3')]);

    expect(setSelectedAgentIds).toHaveBeenCalledExactlyOnceWith(['a1', 'a2', 'a3']);
    // Still the user's choice ("everyone") — provenance is not downgraded.
    expect(setAgentSelectionIsUserSet).not.toHaveBeenCalled();
  });

  it('does not auto-select newcomers when the user-set selection was a genuine subset of the roster', () => {
    useStageStore.setState({
      stage: {
        ...makeStage(),
        generatedAgentConfigs: [makeAgentConfig('a1'), makeAgentConfig('a2')],
      },
    });
    settingsState.agentSelectionIsUserSet = true;
    settingsState.agentMode = 'auto';
    settingsState.selectedAgentIds = ['a1'];

    useStageStore
      .getState()
      .setStageAgents([makeAgentConfig('a1'), makeAgentConfig('a2'), makeAgentConfig('a3')]);

    expect(setSelectedAgentIds).not.toHaveBeenCalled();
    expect(setAgentSelectionIsUserSet).not.toHaveBeenCalled();
  });
});

describe('setStageAgents persistence (document scheduler)', () => {
  beforeEach(() => {
    vi.mocked(saveStageData).mockClear();
    vi.mocked(saveStageDataIncremental).mockClear();
    applyGeneratedAgentsToRegistry.mockClear();
    setSelectedAgentIds.mockClear();
  });

  it('persists generatedAgentConfigs (voice included) via the stage document flush', async () => {
    const configs: GeneratedAgentConfig[] = [
      {
        ...makeAgentConfig('x1'),
        voiceDesign: { identity: 'warm mentor', texture: 'low and clear', delivery: 'calm' },
        voiceConfig: { providerId: 'tts-provider', voiceId: 'voice-1' },
      },
      makeAgentConfig('x2'),
    ];
    useStageStore.getState().setStageAgents(configs);

    // Drain the scheduler's 500 ms debounce window.
    await vi.advanceTimersByTimeAsync(500);

    expect(saveStageDataIncremental).toHaveBeenCalledOnce();
    const [stageId, dirty, storeData] = vi.mocked(saveStageDataIncremental).mock.calls[0];
    expect(stageId).toBe('stage-1');
    expect(dirty).toEqual(expect.arrayContaining([{ kind: 'stage' }]));
    expect(storeData.stage.generatedAgentConfigs).toEqual(configs);
  });

  it('does NOT touch the registry on setCurrentSceneId (scene advance)', async () => {
    // Regression guard: scene advances during playback must never churn the
    // agent registry through a broad save path.
    const stageWithAgents: Stage = {
      ...makeStage(),
      generatedAgentConfigs: [makeAgentConfig('a1')],
    };
    useStageStore.setState({ stage: stageWithAgents, scenes: [] });
    useStageStore.getState().setCurrentSceneId('scene-42');

    await vi.advanceTimersByTimeAsync(500);

    // Only the device-scoped incremental path fires; the roster mirrors stay put.
    expect(saveStageDataIncremental).toHaveBeenCalledOnce();
    expect(saveStageData).not.toHaveBeenCalled();
    expect(applyGeneratedAgentsToRegistry).not.toHaveBeenCalled();
    expect(setSelectedAgentIds).not.toHaveBeenCalled();
  });

  it('drops a pending roster edit when its stage is discarded (deletion path)', async () => {
    useStageStore.getState().setStageAgents([makeAgentConfig('doomed')]);
    discardPendingStageChanges('stage-1');

    await vi.advanceTimersByTimeAsync(500);

    // The queued flush was cancelled with the pending state: a deleted stage
    // cannot be resurrected by a write still sitting in the debounce window.
    expect(saveStageDataIncremental).not.toHaveBeenCalled();
    expect(saveStageData).not.toHaveBeenCalled();
  });

  it('keeps pending work for other stages when discarding a different stage id', async () => {
    useStageStore.getState().setStageAgents([makeAgentConfig('kept')]);
    discardPendingStageChanges('some-other-stage');

    await vi.advanceTimersByTimeAsync(500);

    expect(saveStageDataIncremental).toHaveBeenCalledOnce();
  });

  it('drops a scheduled flush whose stage was deleted after the dirt was queued', async () => {
    // The in-flight-round shape of the deletion race: the dirt is already
    // queued (and may already be snapshotted) when the delete lands. The
    // tombstone — not the pending-map discard — must fence the write.
    useStageStore.getState().setStageAgents([makeAgentConfig('doomed')]);
    markStageDeleted('stage-1');

    await vi.advanceTimersByTimeAsync(500);

    expect(saveStageDataIncremental).not.toHaveBeenCalled();
    expect(saveStageData).not.toHaveBeenCalled();
  });

  it('refuses to queue new dirt for a stage already deleted', async () => {
    markStageDeleted('stage-1');
    useStageStore.getState().setStageAgents([makeAgentConfig('late-edit')]);

    await vi.advanceTimersByTimeAsync(500);

    expect(saveStageDataIncremental).not.toHaveBeenCalled();
  });

  it('does not resurrect a deleted stage through the departing-stage retry window', async () => {
    // Navigation snapshots the departing stage's dirt into local variables and
    // retries once after a delay — outside the pending map, so the deletion
    // path's discard cannot reach it. The deletion fence must stop the retry.
    vi.mocked(saveStageDataIncremental).mockRejectedValueOnce(new Error('transient'));
    useStageStore.getState().setStageAgents([makeAgentConfig('doomed')]);

    useStageStore.getState().setStage({ ...makeStage(), id: 'stage-2' });
    // Let the departing snapshot's first attempt run and fail.
    await vi.advanceTimersByTimeAsync(0);
    const stage1Attempts = () =>
      vi.mocked(saveStageDataIncremental).mock.calls.filter(([id]) => id === 'stage-1');
    expect(stage1Attempts()).toHaveLength(1);

    // The stage is deleted inside the 100 ms retry window.
    markStageDeleted('stage-1');
    await vi.advanceTimersByTimeAsync(100);

    // The retry was dropped instead of recreating the deleted document.
    expect(stage1Attempts()).toHaveLength(1);
  });

  it('drops the departing-stage retry even when a delete → restore lands inside the retry window (epoch fence)', async () => {
    // The straddle a boolean tombstone cannot express: the departing snapshot
    // was captured pre-delete; a same-id restore lifts the deleted flag before
    // the retry fires. The snapshot's captured epoch is stale, so the retry
    // must stay dropped — it would otherwise overwrite the restored document
    // with pre-delete content.
    vi.mocked(saveStageDataIncremental).mockRejectedValueOnce(new Error('transient'));
    useStageStore.getState().setStageAgents([makeAgentConfig('doomed')]);

    useStageStore.getState().setStage({ ...makeStage(), id: 'stage-2' });
    await vi.advanceTimersByTimeAsync(0);
    const stage1Attempts = () =>
      vi.mocked(saveStageDataIncremental).mock.calls.filter(([id]) => id === 'stage-1');
    expect(stage1Attempts()).toHaveLength(1);

    // Delete AND restore both land inside the 100 ms retry window.
    markStageDeleted('stage-1');
    unmarkStageDeleted('stage-1');
    await vi.advanceTimersByTimeAsync(100);

    expect(stage1Attempts()).toHaveLength(1);
  });

  it('persists dirt captured after a delete → restore cycle under the new epoch', async () => {
    // The fence must not overreach: an edit made after the restore observes
    // the current epoch and reaches storage normally.
    markStageDeleted('stage-1');
    unmarkStageDeleted('stage-1');

    useStageStore.getState().setStageAgents([makeAgentConfig('post-restore')]);
    await vi.advanceTimersByTimeAsync(500);

    expect(saveStageDataIncremental).toHaveBeenCalledOnce();
    const [stageId, , , capturedEpoch] = vi.mocked(saveStageDataIncremental).mock.calls[0];
    expect(stageId).toBe('stage-1');
    // The flush captured the CURRENT (post-delete) epoch, not a stale one.
    expect(capturedEpoch).toBe(stageDeletionEpoch('stage-1'));
  });

  it('restores dirt discarded by a failed deletion so the edits still reach storage', async () => {
    // The edit sits in the debounce window when the delete starts; the delete
    // snapshots + discards it, then fails before the document was removed.
    useStageStore.getState().setStageAgents([makeAgentConfig('edited')]);
    const discarded = snapshotPendingStageChangesForDeletion('stage-1');
    expect(discarded).toEqual(expect.arrayContaining([{ kind: 'stage' }]));

    markStageDeleted('stage-1');
    discardPendingStageChanges('stage-1');
    await vi.advanceTimersByTimeAsync(500);
    expect(saveStageDataIncremental).not.toHaveBeenCalled();

    // Failure path: deleteStageData lifts the deleted flag and restores the
    // dirt (the deletion epoch stays bumped).
    unmarkStageDeleted('stage-1');
    restorePendingStageChanges('stage-1', discarded);
    await vi.advanceTimersByTimeAsync(500);

    expect(saveStageDataIncremental).toHaveBeenCalledOnce();
    const [stageId, dirty, , capturedEpoch] = vi.mocked(saveStageDataIncremental).mock.calls[0];
    expect(stageId).toBe('stage-1');
    expect(dirty).toEqual(expect.arrayContaining([{ kind: 'stage' }]));
    // The restored dirt was re-queued as descriptors, so its flush captured a
    // fresh snapshot under the CURRENT (post-bump) epoch — it is not dropped
    // as stale, and it does not replay the pre-delete capture.
    expect(capturedEpoch).toBe(stageDeletionEpoch('stage-1'));
    expect(stageDeletionEpoch('stage-1')).toBeGreaterThan(0);
  });

  it('includes the in-flight flush round dirt in the deletion snapshot', async () => {
    // A round already outside the pending map (mid-await in storage) is
    // exactly the dirt the tombstone will drop; a failed delete must be able
    // to restore it too.
    let release!: (value: { failedChanges: [] }) => void;
    vi.mocked(saveStageDataIncremental).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    useStageStore.getState().setStageAgents([makeAgentConfig('in-flight')]);
    await vi.advanceTimersByTimeAsync(500); // round starts, awaiting storage
    discardPendingStageChanges('stage-1'); // deletion wipes the pending map

    expect(snapshotPendingStageChangesForDeletion('stage-1')).toEqual([{ kind: 'stage' }]);
    expect(snapshotPendingStageChangesForDeletion('some-other-stage')).toEqual([]);

    release({ failedChanges: [] });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('restore no-ops when the store has since moved to another stage', async () => {
    restorePendingStageChanges('stage-2', [{ kind: 'stage' }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(saveStageDataIncremental).not.toHaveBeenCalled();
  });

  it('does NOT touch the registry on plain saveToStorage without a roster edit', async () => {
    const stageWithAgents: Stage = {
      ...makeStage(),
      generatedAgentConfigs: [makeAgentConfig('b1')],
    };
    useStageStore.setState({ stage: stageWithAgents });
    await useStageStore.getState().saveToStorage();

    expect(saveStageData).toHaveBeenCalledOnce();
    expect(applyGeneratedAgentsToRegistry).not.toHaveBeenCalled();
  });
});
