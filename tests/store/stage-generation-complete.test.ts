import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// IndexedDB / stage-storage modules are imported dynamically inside the
// store's save/load actions. Mock them so we can drive load inputs and
// observe persistence without a real IndexedDB. Spies go through vi.hoisted
// so they exist before the hoisted vi.mock factories run.
const {
  hydratePBLScenesFromRuntimeMock,
  loadStageDataMock,
  saveStageDataMock,
  stageOutlinesGet,
  stageOutlinesPut,
} = vi.hoisted(() => ({
  hydratePBLScenesFromRuntimeMock: vi.fn(),
  loadStageDataMock: vi.fn(),
  saveStageDataMock: vi.fn().mockResolvedValue(undefined),
  stageOutlinesGet: vi.fn(),
  stageOutlinesPut: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/runtime/hydration', () => ({
  hydratePBLScenesFromRuntime: (...args: unknown[]) => hydratePBLScenesFromRuntimeMock(...args),
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: (...args: unknown[]) => saveStageDataMock(...args),
  loadStageData: (...args: unknown[]) => loadStageDataMock(...args),
}));
vi.mock('@/lib/utils/database', () => ({
  db: { stageOutlines: { put: stageOutlinesPut, get: stageOutlinesGet } },
}));

import {
  claimStageSceneLoadToken,
  useStageStore,
  type StageSceneLoadToken,
} from '@/lib/store/stage';
import { applyHydratedClassroomFallbackScenes } from '@/lib/classroom/pbl-fallback-hydration';
import type { Scene, Stage } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

function makeStage(id = 'stage-1'): Stage {
  return { id, name: 'Test stage', createdAt: 1, updatedAt: 1 };
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

function makeOutline(order: number): SceneOutline {
  return {
    id: `outline-${order}`,
    type: 'slide',
    title: `outline ${order}`,
    description: 'desc',
    keyPoints: ['k1'],
    order,
  };
}

function makeStoredLoad(stageId: string, sceneId: string) {
  return {
    stage: makeStage(stageId),
    scenes: [makeSlideScene(sceneId, 1, stageId)],
    currentSceneId: sceneId,
    chats: [],
  };
}

function applyFallbackToStageStore(stageId: string, token: StageSceneLoadToken, scenes: Scene[]) {
  return applyHydratedClassroomFallbackScenes({
    loadToken: token,
    stage: makeStage(stageId),
    scenes,
    hydrateScenes: async () => scenes,
    applyStageAndScenes: (stage, hydrated) => {
      useStageStore.getState().setStage(stage);
      useStageStore.setState({
        scenes: hydrated,
        currentSceneId: hydrated[0]?.id ?? null,
        mode: 'playback',
      });
    },
  });
}

beforeEach(() => {
  useStageStore.getState().clearStore();
  hydratePBLScenesFromRuntimeMock.mockReset();
  hydratePBLScenesFromRuntimeMock.mockImplementation(
    async (_stageId: string, scenes: Scene[]) => scenes,
  );
  stageOutlinesGet.mockReset();
  stageOutlinesPut.mockReset();
  loadStageDataMock.mockReset();
});

afterEach(async () => {
  try {
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
    }
  } finally {
    if (vi.isFakeTimers()) {
      vi.useRealTimers();
    }
    useStageStore.getState().clearStore();
  }
});

describe('generationComplete', () => {
  it('defaults to false', () => {
    expect(useStageStore.getState().generationComplete).toBe(false);
  });

  it('setGenerationComplete(true) flips the flag and persists it alongside outlines', async () => {
    useStageStore.setState({ stage: makeStage(), outlines: [makeOutline(1), makeOutline(2)] });
    useStageStore.getState().setGenerationComplete(true);
    expect(useStageStore.getState().generationComplete).toBe(true);
    // Persisted via an async dynamic import.
    await vi.waitFor(() => expect(stageOutlinesPut).toHaveBeenCalled());
    const record = stageOutlinesPut.mock.calls.at(-1)![0] as {
      generationComplete?: boolean;
      outlines: SceneOutline[];
    };
    expect(record.generationComplete).toBe(true);
    expect(record.outlines.map((o) => o.order)).toEqual([1, 2]);
  });

  // Guards a persistence race: the final scene saves through a 500ms debounce,
  // so the flag must not reach IndexedDB before the scenes do — else a reload
  // would trust the flag and drop the unsaved final slide.
  it('flushes scenes before persisting the completion flag', async () => {
    useStageStore.setState({ stage: makeStage(), outlines: [makeOutline(1)] });
    saveStageDataMock.mockClear();
    stageOutlinesPut.mockClear();

    useStageStore.getState().setGenerationComplete(true);

    await vi.waitFor(() => expect(stageOutlinesPut).toHaveBeenCalled());
    expect(saveStageDataMock).toHaveBeenCalled();
    // Scene flush must be ordered before the flag write.
    expect(saveStageDataMock.mock.invocationCallOrder[0]).toBeLessThan(
      stageOutlinesPut.mock.invocationCallOrder[0],
    );
  });

  it('does not persist the completion flag when the scene flush fails', async () => {
    useStageStore.setState({ stage: makeStage(), outlines: [makeOutline(1)] });
    saveStageDataMock.mockRejectedValueOnce(new Error('disk full'));
    stageOutlinesPut.mockClear();

    useStageStore.getState().setGenerationComplete(true);
    // In-memory flag still flips (UI), but the durable record must not be
    // written ahead of the scenes — else a reload would drop the unsaved slide.
    expect(useStageStore.getState().generationComplete).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stageOutlinesPut).not.toHaveBeenCalled();
  });

  it('starting a new stage resets generationComplete to false', () => {
    vi.useFakeTimers();
    useStageStore.setState({ generationComplete: true });
    useStageStore.getState().setStage(makeStage());
    expect(useStageStore.getState().generationComplete).toBe(false);
  });

  describe('deleteScene preserves completion', () => {
    // A deck complete-by-count but missing the flag (e.g. generated before the
    // flag existed, or edited without a reload so self-heal never ran) must
    // record completion when a slide is deleted — otherwise the count breaks
    // and the "Course complete" end page disappears.
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('marks complete when deleting from a fully-materialized deck whose flag was unset', () => {
      useStageStore.setState({
        stage: makeStage(),
        scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2), makeSlideScene('c', 3)],
        outlines: [makeOutline(1), makeOutline(2), makeOutline(3)],
        failedOutlines: [],
        generationComplete: false,
        currentSceneId: 'b',
      });
      useStageStore.getState().deleteScene('b');
      expect(useStageStore.getState().generationComplete).toBe(true);
      expect(useStageStore.getState().scenes.map((s) => s.order)).toEqual([1, 3]);
    });

    it('does not mark complete when deleting from a still-incomplete deck', () => {
      useStageStore.setState({
        stage: makeStage(),
        scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)], // outline order 3 not materialized
        outlines: [makeOutline(1), makeOutline(2), makeOutline(3)],
        failedOutlines: [],
        generationComplete: false,
        currentSceneId: 'a',
      });
      useStageStore.getState().deleteScene('b');
      expect(useStageStore.getState().generationComplete).toBe(false);
    });

    it('keeps generationComplete true when deleting from an already-complete deck', () => {
      useStageStore.setState({
        stage: makeStage(),
        scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)],
        outlines: [makeOutline(1), makeOutline(2)],
        failedOutlines: [],
        generationComplete: true,
        currentSceneId: 'a',
      });
      useStageStore.getState().deleteScene('b');
      expect(useStageStore.getState().generationComplete).toBe(true);
    });
  });

  describe('markGenerationCompleteIfDone', () => {
    it('marks complete when every outline has a scene and none failed', () => {
      useStageStore.setState({
        stage: makeStage(),
        scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)],
        outlines: [makeOutline(1), makeOutline(2)],
        failedOutlines: [],
        generationComplete: false,
      });
      useStageStore.getState().markGenerationCompleteIfDone();
      expect(useStageStore.getState().generationComplete).toBe(true);
    });

    it('does not mark complete while an outline is still unmaterialized', () => {
      useStageStore.setState({
        stage: makeStage(),
        scenes: [makeSlideScene('a', 1)],
        outlines: [makeOutline(1), makeOutline(2)],
        failedOutlines: [],
        generationComplete: false,
      });
      useStageStore.getState().markGenerationCompleteIfDone();
      expect(useStageStore.getState().generationComplete).toBe(false);
    });

    it('does not mark complete while an outline is still failed', () => {
      useStageStore.setState({
        stage: makeStage(),
        scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)],
        outlines: [makeOutline(1), makeOutline(2)],
        failedOutlines: [makeOutline(2)],
        generationComplete: false,
      });
      useStageStore.getState().markGenerationCompleteIfDone();
      expect(useStageStore.getState().generationComplete).toBe(false);
    });
  });

  // The core regression: a completed deck must not resurrect a deleted slide.
  // On reload the orphaned outline (no matching scene) must NOT become a
  // generating placeholder, and the flag must round-trip.
  it('drops generating placeholders on load when generation already completed', async () => {
    loadStageDataMock.mockResolvedValue({
      stage: makeStage(),
      scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)], // order 3 was deleted
      currentSceneId: 'a',
      chats: [],
    });
    stageOutlinesGet.mockResolvedValue({
      stageId: 'stage-1',
      outlines: [makeOutline(1), makeOutline(2), makeOutline(3)], // orphan order 3
      generationComplete: true,
    });

    await useStageStore.getState().loadFromStorage('stage-1');

    expect(useStageStore.getState().generationComplete).toBe(true);
    expect(useStageStore.getState().generatingOutlines).toEqual([]);
  });

  // Backward-compat: a deck generated before the flag existed has no
  // generationComplete in its record. If every outline already has a scene it
  // is fully generated, so it must self-heal to complete (and persist) — else
  // the first deletion would regenerate the slide.
  it('infers and persists completion for a legacy fully-generated deck', async () => {
    loadStageDataMock.mockResolvedValue({
      stage: makeStage(),
      scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2), makeSlideScene('c', 3)],
      currentSceneId: 'a',
      chats: [],
    });
    stageOutlinesGet.mockResolvedValue({
      stageId: 'stage-1',
      outlines: [makeOutline(1), makeOutline(2), makeOutline(3)], // all materialized, no flag
    });

    await useStageStore.getState().loadFromStorage('stage-1');

    expect(useStageStore.getState().generationComplete).toBe(true);
    expect(useStageStore.getState().generatingOutlines).toEqual([]);
    // Healed flag is written back so the next load is authoritative.
    const healed = stageOutlinesPut.mock.calls.at(-1)![0] as { generationComplete?: boolean };
    expect(healed.generationComplete).toBe(true);
  });

  it('does not infer completion for a legacy deck while an outline is failed', async () => {
    useStageStore.setState({ stage: makeStage(), failedOutlines: [makeOutline(2)] });
    loadStageDataMock.mockResolvedValue({
      stage: makeStage(),
      scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)],
      currentSceneId: 'a',
      chats: [],
    });
    stageOutlinesGet.mockResolvedValue({
      stageId: 'stage-1',
      outlines: [makeOutline(1), makeOutline(2)],
    });

    await useStageStore.getState().loadFromStorage('stage-1');

    expect(useStageStore.getState().generationComplete).toBe(false);
    expect(stageOutlinesPut).not.toHaveBeenCalled();
  });

  it('does not let failed outlines from another stage block legacy completion inference', async () => {
    useStageStore.setState({
      stage: { ...makeStage(), id: 'other-stage' },
      failedOutlines: [makeOutline(2)],
    });
    loadStageDataMock.mockResolvedValue({
      stage: makeStage(),
      scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)],
      currentSceneId: 'a',
      chats: [],
    });
    stageOutlinesGet.mockResolvedValue({
      stageId: 'stage-1',
      outlines: [makeOutline(1), makeOutline(2)],
    });

    await useStageStore.getState().loadFromStorage('stage-1');

    expect(useStageStore.getState().generationComplete).toBe(true);
    const healed = stageOutlinesPut.mock.calls.at(-1)![0] as { generationComplete?: boolean };
    expect(healed.generationComplete).toBe(true);
  });

  // Resume-on-refresh for a genuinely interrupted generation is preserved:
  // when not complete, the missing outline still drives a placeholder.
  it('keeps generating placeholders on load when generation is not complete', async () => {
    loadStageDataMock.mockResolvedValue({
      stage: makeStage(),
      scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)],
      currentSceneId: 'a',
      chats: [],
    });
    stageOutlinesGet.mockResolvedValue({
      stageId: 'stage-1',
      outlines: [makeOutline(1), makeOutline(2), makeOutline(3)],
      generationComplete: false,
    });

    await useStageStore.getState().loadFromStorage('stage-1');

    expect(useStageStore.getState().generationComplete).toBe(false);
    expect(useStageStore.getState().generatingOutlines.map((o) => o.order)).toEqual([3]);
  });

  it('does not overwrite in-memory scenes that appear while runtime hydration is pending', async () => {
    const diskScene = makeSlideScene('disk', 1);
    const freshScene = makeSlideScene('fresh', 1);
    loadStageDataMock.mockResolvedValue({
      stage: makeStage(),
      scenes: [diskScene],
      currentSceneId: 'disk',
      chats: [],
    });
    stageOutlinesGet.mockResolvedValue({
      stageId: 'stage-1',
      outlines: [makeOutline(1)],
      generationComplete: true,
    });
    let resolveHydration!: (scenes: Scene[]) => void;
    hydratePBLScenesFromRuntimeMock.mockImplementation(
      async () =>
        new Promise<Scene[]>((resolve) => {
          resolveHydration = resolve;
        }),
    );

    const load = useStageStore.getState().loadFromStorage('stage-1');
    await vi.waitFor(() => expect(hydratePBLScenesFromRuntimeMock).toHaveBeenCalled());
    useStageStore.setState({
      stage: makeStage(),
      scenes: [freshScene],
      currentSceneId: 'fresh',
    });
    resolveHydration([diskScene]);
    await load;

    expect(useStageStore.getState().scenes).toEqual([freshScene]);
    expect(useStageStore.getState().currentSceneId).toBe('fresh');
  });

  it('does not overwrite a different stage that appears while runtime hydration is pending', async () => {
    const diskScene = makeSlideScene('disk-a', 1, 'stage-a');
    const freshScene = makeSlideScene('fresh-b', 1, 'stage-b');
    loadStageDataMock.mockResolvedValue({
      stage: makeStage('stage-a'),
      scenes: [diskScene],
      currentSceneId: 'disk-a',
      chats: [],
    });
    stageOutlinesGet.mockResolvedValue({
      stageId: 'stage-a',
      outlines: [makeOutline(1)],
      generationComplete: true,
    });
    let resolveHydration!: (scenes: Scene[]) => void;
    hydratePBLScenesFromRuntimeMock.mockImplementation(
      async () =>
        new Promise<Scene[]>((resolve) => {
          resolveHydration = resolve;
        }),
    );

    const load = useStageStore.getState().loadFromStorage('stage-a');
    await vi.waitFor(() => expect(hydratePBLScenesFromRuntimeMock).toHaveBeenCalled());
    useStageStore.getState().setStage(makeStage('stage-b'));
    useStageStore.setState({ scenes: [freshScene], currentSceneId: 'fresh-b' });
    resolveHydration([diskScene]);
    await load;

    expect(useStageStore.getState().stage?.id).toBe('stage-b');
    expect(useStageStore.getState().scenes).toEqual([freshScene]);
    expect(useStageStore.getState().currentSceneId).toBe('fresh-b');
  });

  it('keeps the later overlapping storage load when the older hydration resolves first', async () => {
    useStageStore.setState({
      stage: makeStage('stage-b'),
      scenes: [makeSlideScene('resident-b', 1, 'stage-b')],
      currentSceneId: 'resident-b',
    });
    loadStageDataMock.mockImplementation(async (stageId: string) =>
      makeStoredLoad(stageId, `disk-${stageId}`),
    );
    stageOutlinesGet.mockImplementation(async (stageId: string) => ({
      stageId,
      outlines: [makeOutline(1)],
      generationComplete: true,
    }));
    const resolvers = new Map<string, (scenes: Scene[]) => void>();
    hydratePBLScenesFromRuntimeMock.mockImplementation(
      async (stageId: string) =>
        new Promise<Scene[]>((resolve) => {
          resolvers.set(stageId, resolve);
        }),
    );

    const loadC = useStageStore.getState().loadFromStorage('stage-c');
    await vi.waitFor(() => expect(resolvers.has('stage-c')).toBe(true));
    const loadD = useStageStore.getState().loadFromStorage('stage-d');
    await vi.waitFor(() => expect(resolvers.has('stage-d')).toBe(true));

    resolvers.get('stage-c')!([makeSlideScene('disk-stage-c', 1, 'stage-c')]);
    await loadC;
    resolvers.get('stage-d')!([makeSlideScene('disk-stage-d', 1, 'stage-d')]);
    await loadD;

    expect(useStageStore.getState().stage?.id).toBe('stage-d');
    expect(useStageStore.getState().currentSceneId).toBe('disk-stage-d');
    expect(useStageStore.getState().scenes[0]).toMatchObject({
      id: 'disk-stage-d',
      stageId: 'stage-d',
    });
  });

  it('keeps the later overlapping storage load when the newer hydration resolves first', async () => {
    useStageStore.setState({
      stage: makeStage('stage-b'),
      scenes: [makeSlideScene('resident-b', 1, 'stage-b')],
      currentSceneId: 'resident-b',
    });
    loadStageDataMock.mockImplementation(async (stageId: string) =>
      makeStoredLoad(stageId, `disk-${stageId}`),
    );
    stageOutlinesGet.mockImplementation(async (stageId: string) => ({
      stageId,
      outlines: [makeOutline(1)],
      generationComplete: true,
    }));
    const resolvers = new Map<string, (scenes: Scene[]) => void>();
    hydratePBLScenesFromRuntimeMock.mockImplementation(
      async (stageId: string) =>
        new Promise<Scene[]>((resolve) => {
          resolvers.set(stageId, resolve);
        }),
    );

    const loadC = useStageStore.getState().loadFromStorage('stage-c');
    await vi.waitFor(() => expect(resolvers.has('stage-c')).toBe(true));
    const loadD = useStageStore.getState().loadFromStorage('stage-d');
    await vi.waitFor(() => expect(resolvers.has('stage-d')).toBe(true));

    resolvers.get('stage-d')!([makeSlideScene('disk-stage-d', 1, 'stage-d')]);
    await loadD;
    resolvers.get('stage-c')!([makeSlideScene('disk-stage-c', 1, 'stage-c')]);
    await loadC;

    expect(useStageStore.getState().stage?.id).toBe('stage-d');
    expect(useStageStore.getState().currentSceneId).toBe('disk-stage-d');
    expect(useStageStore.getState().scenes[0]).toMatchObject({
      id: 'disk-stage-d',
      stageId: 'stage-d',
    });
  });

  it('lets a later classroom fallback apply beat an earlier storage load', async () => {
    useStageStore.setState({
      stage: makeStage('stage-b'),
      scenes: [makeSlideScene('resident-b', 1, 'stage-b')],
      currentSceneId: 'resident-b',
    });
    loadStageDataMock.mockResolvedValue(makeStoredLoad('stage-c', 'disk-stage-c'));
    stageOutlinesGet.mockResolvedValue({
      stageId: 'stage-c',
      outlines: [makeOutline(1)],
      generationComplete: true,
    });
    let resolveStorageHydration!: (scenes: Scene[]) => void;
    hydratePBLScenesFromRuntimeMock.mockImplementation(
      async () =>
        new Promise<Scene[]>((resolve) => {
          resolveStorageHydration = resolve;
        }),
    );
    const fallbackScene = makeSlideScene('fallback-stage-d', 1, 'stage-d');
    let resolveFallbackHydration!: (scenes: Scene[]) => void;

    const loadC = useStageStore.getState().loadFromStorage('stage-c');
    await vi.waitFor(() => expect(resolveStorageHydration).toBeDefined());
    const fallbackDToken = claimStageSceneLoadToken();
    const fallbackD = applyHydratedClassroomFallbackScenes({
      loadToken: fallbackDToken,
      stage: makeStage('stage-d'),
      scenes: [fallbackScene],
      hydrateScenes: async () =>
        new Promise<Scene[]>((resolve) => {
          resolveFallbackHydration = resolve;
        }),
      applyStageAndScenes: (stage, scenes) => {
        useStageStore.getState().setStage(stage);
        useStageStore.setState({
          scenes,
          currentSceneId: scenes[0]?.id ?? null,
          mode: 'playback',
        });
      },
    });
    await vi.waitFor(() => expect(resolveFallbackHydration).toBeDefined());

    resolveStorageHydration([makeSlideScene('disk-stage-c', 1, 'stage-c')]);
    await loadC;
    resolveFallbackHydration([fallbackScene]);
    await expect(fallbackD).resolves.toBe(true);

    expect(useStageStore.getState().stage?.id).toBe('stage-d');
    expect(useStageStore.getState().currentSceneId).toBe('fallback-stage-d');
    expect(useStageStore.getState().scenes).toEqual([fallbackScene]);
  });

  it('does not let an older classroom fallback override a newer storage navigation', async () => {
    loadStageDataMock.mockImplementation(async (stageId: string) => {
      if (stageId === 'stage-b') {
        return makeStoredLoad('stage-b', 'disk-stage-b');
      }
      return null;
    });
    stageOutlinesGet.mockImplementation(async (stageId: string) => ({
      stageId,
      outlines: [makeOutline(1)],
      generationComplete: true,
    }));
    let resolveStorageHydration!: (scenes: Scene[]) => void;
    hydratePBLScenesFromRuntimeMock.mockImplementation(async (stageId: string, scenes: Scene[]) => {
      if (stageId !== 'stage-b') {
        return scenes;
      }
      return new Promise<Scene[]>((resolve) => {
        resolveStorageHydration = resolve;
      });
    });
    const fallbackA = makeSlideScene('fallback-stage-a', 1, 'stage-a');
    const diskB = makeSlideScene('disk-stage-b', 1, 'stage-b');

    const stageAToken = claimStageSceneLoadToken();
    await useStageStore.getState().loadFromStorage('stage-a', stageAToken);
    const stageBToken = claimStageSceneLoadToken();
    const loadB = useStageStore.getState().loadFromStorage('stage-b', stageBToken);
    await vi.waitFor(() => expect(resolveStorageHydration).toBeDefined());

    await expect(applyFallbackToStageStore('stage-a', stageAToken, [fallbackA])).resolves.toBe(
      false,
    );
    resolveStorageHydration([diskB]);
    await loadB;

    expect(useStageStore.getState().stage?.id).toBe('stage-b');
    expect(useStageStore.getState().currentSceneId).toBe('disk-stage-b');
    expect(useStageStore.getState().scenes).toEqual([diskB]);
  });

  it('does not let an older classroom fallback apply before the newer fallback resolves', async () => {
    loadStageDataMock.mockResolvedValue(null);
    stageOutlinesGet.mockImplementation(async (stageId: string) => ({
      stageId,
      outlines: [],
      generationComplete: false,
    }));
    const fallbackA = makeSlideScene('fallback-stage-a', 1, 'stage-a');
    const fallbackB = makeSlideScene('fallback-stage-b', 1, 'stage-b');

    const stageAToken = claimStageSceneLoadToken();
    await useStageStore.getState().loadFromStorage('stage-a', stageAToken);
    const stageBToken = claimStageSceneLoadToken();
    await useStageStore.getState().loadFromStorage('stage-b', stageBToken);

    await expect(applyFallbackToStageStore('stage-a', stageAToken, [fallbackA])).resolves.toBe(
      false,
    );
    expect(useStageStore.getState().stage).toBeNull();

    await expect(applyFallbackToStageStore('stage-b', stageBToken, [fallbackB])).resolves.toBe(
      true,
    );

    expect(useStageStore.getState().stage?.id).toBe('stage-b');
    expect(useStageStore.getState().currentSceneId).toBe('fallback-stage-b');
    expect(useStageStore.getState().scenes).toEqual([fallbackB]);
  });

  it('does not let an older classroom fallback override a newer fallback navigation', async () => {
    loadStageDataMock.mockResolvedValue(null);
    stageOutlinesGet.mockImplementation(async (stageId: string) => ({
      stageId,
      outlines: [],
      generationComplete: false,
    }));
    const fallbackA = makeSlideScene('fallback-stage-a', 1, 'stage-a');
    const fallbackB = makeSlideScene('fallback-stage-b', 1, 'stage-b');

    const stageAToken = claimStageSceneLoadToken();
    await useStageStore.getState().loadFromStorage('stage-a', stageAToken);
    const stageBToken = claimStageSceneLoadToken();
    await useStageStore.getState().loadFromStorage('stage-b', stageBToken);

    await expect(applyFallbackToStageStore('stage-b', stageBToken, [fallbackB])).resolves.toBe(
      true,
    );
    await expect(applyFallbackToStageStore('stage-a', stageAToken, [fallbackA])).resolves.toBe(
      false,
    );

    expect(useStageStore.getState().stage?.id).toBe('stage-b');
    expect(useStageStore.getState().currentSceneId).toBe('fallback-stage-b');
    expect(useStageStore.getState().scenes).toEqual([fallbackB]);
  });

  it('applies same-navigation classroom fallback after storage has no local data', async () => {
    loadStageDataMock.mockResolvedValue(null);
    stageOutlinesGet.mockResolvedValue({
      stageId: 'stage-a',
      outlines: [],
      generationComplete: false,
    });
    const fallbackA = makeSlideScene('fallback-stage-a', 1, 'stage-a');

    const stageAToken = claimStageSceneLoadToken();
    await useStageStore.getState().loadFromStorage('stage-a', stageAToken);
    await expect(applyFallbackToStageStore('stage-a', stageAToken, [fallbackA])).resolves.toBe(
      true,
    );

    expect(useStageStore.getState().stage?.id).toBe('stage-a');
    expect(useStageStore.getState().currentSceneId).toBe('fallback-stage-a');
    expect(useStageStore.getState().scenes).toEqual([fallbackA]);
  });

  it('does not let failed outlines from another stage block legacy completion inference', async () => {
    const diskScene = makeSlideScene('disk-a', 1, 'stage-a');
    const residentScene = makeSlideScene('resident-b', 1, 'stage-b');
    useStageStore.setState({
      stage: makeStage('stage-b'),
      scenes: [residentScene],
      failedOutlines: [makeOutline(99)],
      currentSceneId: 'resident-b',
    });
    loadStageDataMock.mockResolvedValue({
      stage: makeStage('stage-a'),
      scenes: [diskScene],
      currentSceneId: 'disk-a',
      chats: [],
    });
    stageOutlinesGet.mockResolvedValue({
      stageId: 'stage-a',
      outlines: [makeOutline(1)],
    });

    await useStageStore.getState().loadFromStorage('stage-a');

    expect(useStageStore.getState().generationComplete).toBe(true);
    expect(useStageStore.getState().stage?.id).toBe('stage-a');
    expect(useStageStore.getState().scenes).toHaveLength(1);
    expect(useStageStore.getState().scenes[0]).toMatchObject({
      id: 'disk-a',
      stageId: 'stage-a',
    });
    expect(useStageStore.getState().currentSceneId).toBe('disk-a');
    const healed = stageOutlinesPut.mock.calls.at(-1)![0] as { generationComplete?: boolean };
    expect(healed.generationComplete).toBe(true);
  });
});
