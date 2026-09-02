// @vitest-environment jsdom

/**
 * The canvas freshness sync acceptance suite (Mono #1960 Part 2, AC1–AC7).
 *
 * The project has failed five times on criterion position: fixtures too
 * small, read windows too narrow, injections landing on pure functions,
 * assertions importing the constant under test, and — the Part 1 lesson —
 * criteria stopping at the mechanism's upstream (17 green tests while the
 * push side never worked, because only "a notification was emitted" was
 * asserted, never "the subscriber woke"). So the criteria HERE land on the
 * DATA THE CANVAS ACTUALLY RECEIVED: the stage store's `scenes` array after a
 * sync pass, and the exact ids/volume the batch endpoint was asked for. No
 * assertion reads a constant the implementation exports.
 *
 * The harness mounts `useStageFreshnessSync` against mocked fetch/EventSource
 * and a minimal in-memory stage store, then drives manifests, batches and
 * stream frames exactly like the server would.
 */
import { act, createElement, startTransition } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadDocument: vi.fn(),
  // Stage store — a tiny in-memory zustand lookalike the sync drives.
  stageState: {
    stage: null as { id: string } | null,
    scenes: [] as Record<string, unknown>[],
    currentSceneId: null as string | null,
    mode: 'playback' as string,
    isOwner: true,
    generationComplete: false,
    outlineProducer: null as string | null,
    outlines: [] as unknown[],
    stageSyncRequest: 0,
    serverManifestByStage: {} as Record<string, unknown>,
  },
  stageSubscribers: [] as ((state: unknown, prev: unknown) => void)[],
  workbenchState: { panelOpen: true, playbackOn: false },
  // Server doubles.
  manifest: { rev: 1, scenes: [] as { id: string; order: number; rev: number }[] },
  sceneContent: {} as Record<string, Record<string, unknown>>,
  manifestUnavailable: false,
  batchUnavailable: false,
  /**
   * The batch endpoint's per-request id cap, mirroring the real route's
   * `MAX_BATCH_SCENE_IDS` as a LITERAL in the test (the client must chunk
   * below it; a single over-cap request gets a 400, exactly like production).
   */
  batchMaxIds: 200,
  // Telemetry the assertions read.
  manifestFetchCount: 0,
  loadCount: 0,
  batchCalls: [] as string[][],
  batchBytes: 0,
  fetch: null as ((input: RequestInfo | URL) => Promise<unknown>) | null,
}));

// The sync runs against the REAL `stage-freshness.ts`, whose manifest fetch
// short-circuits when `!isLiveMode` (D1-F5) — pin live mode on so the suite
// exercises the actual request path.
vi.mock('@/lib/live-mode', () => ({ isLiveMode: true }));

vi.mock('@/lib/workbench/session-store', () => ({
  appendCompactedReplayEvent: vi.fn(),
  compactReplayEvents: vi.fn(),
  useWorkbenchStore: {
    getState: () => mocks.workbenchState,
  },
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: {
    getState: () => mocks.stageState,
    // zustand semantics: `prev` is the PRE-STATE snapshot (a distinct object),
    // so subscribers can tell "the reload array changed" apart from any other
    // write. Mutating the live object in place and passing it as both state
    // and prev would make every `state.X === prev.X` guard a tautology.
    setState: (patch: unknown) => {
      const prev = { ...mocks.stageState };
      const next =
        typeof patch === 'function'
          ? { ...prev, ...(patch as (s: typeof prev) => Record<string, unknown>)(prev) }
          : { ...prev, ...(patch as Partial<typeof prev>) };
      Object.assign(mocks.stageState, next);
      for (const listener of mocks.stageSubscribers) listener(mocks.stageState, prev);
    },
    subscribe: (listener: (state: unknown, prev: unknown) => void) => {
      mocks.stageSubscribers.push(listener);
      return () => {
        const at = mocks.stageSubscribers.indexOf(listener);
        if (at >= 0) mocks.stageSubscribers.splice(at, 1);
      };
    },
  },
}));

vi.mock('@/lib/document-store/store', () => ({
  getDocumentStore: () => ({ loadDocument: mocks.loadDocument }),
}));

import { useStageFreshnessSync } from '@/lib/workbench/use-workbench-session';

// ── server doubles ──────────────────────────────────────────────────────────

const SCENE_IDS = ['scene-1', 'scene-2', 'scene-3'];

function sceneData(
  id: string,
  rev: number,
  order: number = SCENE_IDS.indexOf(id),
): Record<string, unknown> {
  return {
    id,
    stageId: 'stage-a',
    order,
    title: `${id} v${rev}`,
    type: 'slide',
    content: { type: 'slide', canvas: { elements: [{ prompt: `p-${id}-${rev}` }] } },
    createdAt: 1_785_900_000_000,
    updatedAt: 1_785_900_000_000,
  };
}

/** (Re)seed the server doubles for a 3-scene course at a given stage rev. */
function seedCourse(stageRev: number, sceneRevs: number[] = [1, 1, 1]): void {
  mocks.manifest = {
    rev: stageRev,
    scenes: SCENE_IDS.map((id, i) => ({ id, order: i, rev: sceneRevs[i] })),
  };
  mocks.sceneContent = {};
  for (const id of SCENE_IDS) {
    mocks.sceneContent[id] = sceneData(id, 1);
  }
}

function manifestWith(overrides: {
  rev?: number;
  scenes?: { id: string; order: number; rev: number }[];
}) {
  mocks.manifest = {
    rev: overrides.rev ?? mocks.manifest.rev,
    scenes: overrides.scenes ?? mocks.manifest.scenes,
  };
}

function bumpSceneRev(sceneId: string): void {
  // Build a NEW manifest object. The sync holds the PREVIOUS manifest object
  // as its "rendered" baseline; mutating this one in place would rewrite that
  // baseline too and the diff would see no change.
  const scenes = mocks.manifest.scenes.map((s) =>
    s.id === sceneId ? { ...s, rev: s.rev + 1 } : s,
  );
  mocks.manifest = { rev: mocks.manifest.rev + 1, scenes };
  // The write: the scene the server now serves.
  const nextRev = scenes.find((s) => s.id === sceneId)!.rev;
  mocks.sceneContent[sceneId] = sceneData(
    sceneId,
    nextRev,
    scenes.find((s) => s.id === sceneId)!.order,
  );
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor(_url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (event: { data?: string }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (event: { data?: string }) => void) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((f) => f !== fn),
    );
  }
  close() {
    this.readyState = 2;
  }
  /** Simulate the server pushing a freshness frame. */
  emitFreshness() {
    for (const fn of this.listeners.get('stage_freshness') ?? []) {
      fn({
        data: JSON.stringify({
          type: 'stage_freshness',
          stageId: 'stage-a',
          rev: mocks.manifest.rev,
        }),
      });
    }
  }
  /** Simulate the connection opening (initial or after a drop). */
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** Simulate the connection dropping. */
  error() {
    this.readyState = 0;
    this.onerror?.();
  }
}

function wireFetch(): void {
  mocks.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/manifest')) {
      mocks.manifestFetchCount += 1;
      if (mocks.manifestUnavailable) return { ok: false, status: 404 };
      return { ok: true, json: async () => mocks.manifest };
    }
    if (url.includes('/scenes?')) {
      const ids = new URL(url, 'http://localhost').searchParams.get('ids')!.split(',');
      mocks.batchCalls.push(ids);
      // The server double enforces the same per-request cap as the real route
      // (a literal 200): if the client stopped chunking, one over-cap request
      // answers 400 exactly like production and the pass aborts.
      if (ids.length > mocks.batchMaxIds) return { ok: false, status: 400 };
      if (mocks.batchUnavailable) return { ok: false, status: 500 };
      const scenes = ids
        .map((id) => mocks.sceneContent[id])
        .filter((scene): scene is Record<string, unknown> => !!scene);
      mocks.batchBytes += JSON.stringify(scenes).length;
      return { ok: true, json: async () => ({ scenes }) };
    }
    return { ok: false, status: 404 };
  });
  vi.stubGlobal('fetch', mocks.fetch);
}

/**
 * Seed a course of `count` scenes (each scene rev 1, stage rev 1) on the mock
 * server. Used by the >200-scene tests (cr D3-F1): the batch endpoint's cap
 * would 400 an over-cap request, so the client must chunk.
 */
function seedManyScenes(count: number): string[] {
  const ids = Array.from({ length: count }, (_, i) => `scene-${String(i + 1).padStart(4, '0')}`);
  mocks.manifest = {
    rev: 1,
    scenes: ids.map((id, i) => ({ id, order: i, rev: 1 })),
  };
  mocks.sceneContent = {};
  for (let i = 0; i < ids.length; i += 1) {
    mocks.sceneContent[ids[i]!] = sceneData(ids[i]!, 1, i);
  }
  return ids;
}

let root: ReturnType<typeof createRoot> | null = null;

function Harness({
  stageId,
  bootstrapDocument = true,
}: {
  stageId: string;
  bootstrapDocument?: boolean;
}) {
  useStageFreshnessSync(stageId, { bootstrapDocument });
  return null;
}

/**
 * The abandoned-render construction (regression protection for the deleted
 * `course-sync-race.test.ts`): a render that suspends on a never-resolving
 * thenable inside a transition is abandoned by React — its layout effects
 * never commit, so it must not write the store or persist anything.
 */
const neverCommits = new Promise<never>(() => undefined);
let abandonedRenderObserved: () => void = () => undefined;
function AbandonedHarness({
  stageId,
  bootstrapDocument = true,
}: {
  stageId: string;
  bootstrapDocument?: boolean;
}): never {
  useStageFreshnessSync(stageId, { bootstrapDocument });
  abandonedRenderObserved();
  throw neverCommits;
}

const mount = async (opts: { bootstrapDocument?: boolean; stageId?: string } = {}) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(Harness, {
        stageId: opts.stageId ?? 'stage-a',
        bootstrapDocument: opts.bootstrapDocument ?? true,
      }),
    ),
  );
  return root;
};

const unmount = async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.assign(mocks.stageState, {
    stage: null,
    scenes: [],
    currentSceneId: null,
    mode: 'playback',
    isOwner: true,
    generationComplete: false,
    outlineProducer: null,
    outlines: [],
    stageSyncRequest: 0,
    serverManifestByStage: {},
  });
  mocks.workbenchState.panelOpen = true;
  mocks.workbenchState.playbackOn = false;
  mocks.loadDocument.mockReset();
  mocks.loadCount = 0;
  mocks.manifestFetchCount = 0;
  mocks.batchCalls = [];
  mocks.batchBytes = 0;
  mocks.manifestUnavailable = false;
  mocks.batchUnavailable = false;
  mocks.batchMaxIds = 200;
  mocks.stageSubscribers = [];
  MockEventSource.instances = [];
  abandonedRenderObserved = () => undefined;
  seedCourse(1);
  wireFetch();
  mocks.loadDocument.mockImplementation(async () => {
    mocks.loadCount += 1;
    return {
      stage: { id: 'stage-a', name: '课' },
      scenes: SCENE_IDS.map((id) => mocks.sceneContent[id]),
      outline: { outlines: [], generationComplete: false },
    };
  });
  vi.stubGlobal('EventSource', MockEventSource);
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'hidden',
  });
});

afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
});

describe('AC1: 另一个会话改这门课 → 画布收敛（判据在画布拿到的数据上）', () => {
  it('初始同步后，外部写入经 freshness 帧 → 画布的 scenes 收敛到新数据', async () => {
    await mount();
    const source = MockEventSource.instances[0]!;

    // Initial sync: manifest + full document read; the canvas holds 3 scenes.
    expect(mocks.stageState.scenes).toHaveLength(3);
    expect(mocks.loadCount).toBe(1);

    // Another session wrote scene-2: the manifest rev changed and the trigger emitted a frame.
    bumpSceneRev('scene-2');
    await act(async () => source.emitFreshness());

    // Criterion: the scene-2 the canvas actually holds is the new version.
    const canvasScene2 = mocks.stageState.scenes.find((s) => s.id === 'scene-2');
    expect(canvasScene2).toMatchObject({ title: 'scene-2 v2' });
    expect(
      (canvasScene2!.content as { canvas: { elements: { prompt: string }[] } }).canvas.elements[0]
        .prompt,
    ).toBe('p-scene-2-2');
    // Unchanged scenes keep their object identity (the stable-reference axis).
    const s1 = mocks.stageState.scenes.find((s) => s.id === 'scene-1');
    const s3 = mocks.stageState.scenes.find((s) => s.id === 'scene-3');
    expect(s1).toMatchObject({ title: 'scene-1 v1' });
    expect(s3).toMatchObject({ title: 'scene-3 v1' });
    // No second full read anywhere — only the changed scene was re-fetched.
    expect(mocks.loadCount).toBe(1);
  });

  it('FAULT INJECTION: freshness 帧不重取整档——只有该场景的批量请求发生（AC2 判据：ids 与体量）', async () => {
    await mount();
    const source = MockEventSource.instances[0]!;
    // Five consecutive single-scene writes in one run.
    for (let i = 0; i < 5; i += 1) {
      bumpSceneRev('scene-2');
      await act(async () => source.emitFreshness());
    }
    // Each pass re-fetches exactly the one id, scene-2.
    expect(mocks.batchCalls).toHaveLength(5);
    for (const ids of mocks.batchCalls) {
      expect(ids).toEqual(['scene-2']);
    }
    // Volume: a single-scene batch (~14.5kB) rather than the whole document (~100kB).
    const perBatch = mocks.batchBytes / mocks.batchCalls.length;
    expect(mocks.batchBytes).toBeLessThan(50_000);
    expect(perBatch).toBeLessThan(20_000);
    // Steady-state request count (after the fix): 1 full read at mount + N manifests + N single-scene batches.
    expect(mocks.loadCount).toBe(1);
    expect(mocks.manifestFetchCount).toBe(1 + 5);
    expect(mocks.batchCalls.length).toBe(5);
    console.log(
      `AC2 实测：整档读 ${mocks.loadCount} 次；manifest ${mocks.manifestFetchCount} 次；` +
        `单场景批量 ${mocks.batchCalls.length} 次，共 ${mocks.batchBytes} bytes（每次 ${perBatch.toFixed(0)}B）。` +
        `改前等价：每 checkpoint 一次整档读（~100kB）；改后：每变化一次 ~${perBatch.toFixed(0)}B。`,
    );
  });
});

describe('revision-veto sync request (#1960 Part 2 fix)', () => {
  it('the store sync-request tick triggers one sync pass that converges the canvas', async () => {
    await mount();

    // An agent commit lands while the canvas is stale; elsewhere a save was
    // vetoed and the store's sync-request tick was bumped (the veto's "trigger
    // one sync" side, see stage-revision-veto.test.ts).
    bumpSceneRev('scene-2');
    const before = mocks.manifestFetchCount;
    await act(async () => {
      const { useStageStore } = await import('@/lib/store/stage');
      useStageStore.setState({
        stageSyncRequest: (mocks.stageState.stageSyncRequest ?? 0) + 1,
      });
    });

    // One pass ran and the canvas converged to the agent's scene — the store
    // no longer holds content the server has superseded.
    expect(mocks.manifestFetchCount).toBe(before + 1);
    expect(mocks.stageState.scenes.find((s) => s.id === 'scene-2')).toMatchObject({
      title: 'scene-2 v2',
    });
  });

  it('the sync records the write-side baseline (server manifest) into the store', async () => {
    await mount();
    const source = MockEventSource.instances[0]!;
    // The mock store holds the real manifest the sync applied, per stage.
    const recorded = mocks.stageState.serverManifestByStage['stage-a'] as {
      rev: number;
      scenes: { id: string; rev: number }[];
    };
    expect(recorded?.rev).toBe(1);
    expect(recorded?.scenes.find((s) => s.id === 'scene-2')?.rev).toBe(1);

    // After an agent rewrite, the next pass records the fresh manifest.
    bumpSceneRev('scene-2');
    await act(async () => source.emitFreshness());
    const refreshed = mocks.stageState.serverManifestByStage['stage-a'] as {
      rev: number;
      scenes: { id: string; rev: number }[];
    };
    expect(refreshed?.rev).toBe(2);
    expect(refreshed?.scenes.find((s) => s.id === 'scene-2')?.rev).toBe(2);
  });
});

describe('AC3: 新增/删除场景都能正确反映', () => {
  it('manifest 多出/少掉场景 id → 画布增删，且新增只重取新增的那个', async () => {
    await mount();
    const source = MockEventSource.instances[0]!;

    // scene-4 added, scene-1 removed.
    mocks.sceneContent['scene-4'] = sceneData('scene-4', 1, 3);
    manifestWith({
      rev: 3,
      scenes: [
        { id: 'scene-2', order: 1, rev: 1 },
        { id: 'scene-3', order: 2, rev: 1 },
        { id: 'scene-4', order: 3, rev: 1 },
      ],
    });
    await act(async () => source.emitFreshness());

    const ids = mocks.stageState.scenes.map((s) => s.id as string);
    expect(ids).toEqual(['scene-2', 'scene-3', 'scene-4']);
    // The added scene is fetched by its own id only (removals are handled by the local diff, not fetched).
    expect(mocks.batchCalls.at(-1)).toEqual(['scene-4']);
    // The scene-4 on the canvas is real data.
    expect(mocks.stageState.scenes.find((s) => s.id === 'scene-4')).toMatchObject({
      title: 'scene-4 v1',
    });
  });
});

describe('AC4: freshness 流断开 → 兜底周期内仍收敛（绝对时间上界，不导入常量）', () => {
  it('断流 + 外部写入 → 兜底时钟内画布收敛', async () => {
    vi.useFakeTimers();
    await mount();
    const source = MockEventSource.instances[0]!;

    // The stream is down: no frame for any later write will arrive.
    await act(async () => source.error());

    // An external write (another session) changes a scene — the stream is down, so the canvas cannot know.
    bumpSceneRev('scene-1');
    expect(mocks.stageState.scenes.find((s) => s.id === 'scene-1')).toMatchObject({
      title: 'scene-1 v1',
    });

    // Fallback period (30s ±20% → ≤36s): assert an absolute cap of 45s, hard-coded, not imported from the implementation.
    // If the implementation moved the fallback beyond 45s, this "converged" assertion would fail.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    expect(mocks.stageState.scenes.find((s) => s.id === 'scene-1')).toMatchObject({
      title: 'scene-1 v2',
    });
  });
});

describe('AC5: tab focus / 重连各触发一次 manifest 拉取', () => {
  it('focus 一次 +1；断线重连一次 +1', async () => {
    await mount();
    const source = MockEventSource.instances[0]!;

    // After the initial sync: 1 manifest fetch (mount's baseline), stream not open yet.
    const afterMount = mocks.manifestFetchCount;

    // Tab focus → exactly one manifest fetch.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(mocks.manifestFetchCount).toBe(afterMount + 1);

    // Drop + reconnect → exactly one manifest fetch.
    await act(async () => source.error());
    expect(mocks.manifestFetchCount).toBe(afterMount + 1); // the error itself does not fetch
    await act(async () => source.open());
    expect(mocks.manifestFetchCount).toBe(afterMount + 2);
  });
});

describe('编辑态保护已移除（#1961 决策变更 2026-08-23）：agent 的新版本直接替换画布', () => {
  it('编辑中的 scene-2 被 agent 改动 → 场景被直接替换（不再保护、不再标 stale）', async () => {
    await mount();
    const source = MockEventSource.instances[0]!;
    // The user is editing scene-2 (the canvas is in edit state).
    mocks.stageState.currentSceneId = 'scene-2';
    mocks.stageState.mode = 'edit';

    bumpSceneRev('scene-2');
    await act(async () => source.emitFreshness());

    // Criterion (effect): the canvas gets the agent's new version directly — read-side protection was removed by the product decision.
    expect(mocks.stageState.scenes.find((s) => s.id === 'scene-2')).toMatchObject({
      title: 'scene-2 v2',
    });
  });

  it('view 模式（非编辑）下的场景自由刷新（原有行为保留）', async () => {
    await mount();
    const source = MockEventSource.instances[0]!;
    mocks.stageState.currentSceneId = 'scene-2';
    mocks.stageState.mode = 'playback';
    mocks.workbenchState.panelOpen = false; // full-screen learning: view mode

    bumpSceneRev('scene-2');
    await act(async () => source.emitFreshness());

    // View mode refreshes freely: direct replacement.
    expect(mocks.stageState.scenes.find((s) => s.id === 'scene-2')).toMatchObject({
      title: 'scene-2 v2',
    });
  });
});

describe('稳态请求数与稳定引用', () => {
  it('无变化的 freshness 帧不触发 setState，scenes 数组引用保持不变', async () => {
    await mount();
    const source = MockEventSource.instances[0]!;
    const scenesRef = mocks.stageState.scenes;

    // Manifest unchanged → empty diff → no setState.
    await act(async () => source.emitFreshness());
    expect(mocks.stageState.scenes).toBe(scenesRef);
    expect(mocks.batchCalls).toHaveLength(0);
  });

  it('只改一个场景时，其它场景的数组项引用稳定（不整体重建 scenes）', async () => {
    await mount();
    const source = MockEventSource.instances[0]!;
    const before = [...mocks.stageState.scenes];

    bumpSceneRev('scene-2');
    await act(async () => source.emitFreshness());

    const after = mocks.stageState.scenes;
    expect(after).not.toBe(before); // changed → new array
    // Unchanged scenes keep the same object identity (stable references: only scene-2 is new).
    expect(after.find((s) => s.id === 'scene-1')).toBe(before.find((s) => s.id === 'scene-1'));
    expect(after.find((s) => s.id === 'scene-3')).toBe(before.find((s) => s.id === 'scene-3'));
    expect(after.find((s) => s.id === 'scene-2')).not.toBe(before.find((s) => s.id === 'scene-2'));
  });
});

describe('显式委托的冷启动路径（bootstrapDocument）', () => {
  it('born-complete 文档的 outline 字段仍然进画布（沿用原行为）', async () => {
    mocks.loadDocument.mockImplementation(async () => {
      mocks.loadCount += 1;
      return {
        stage: { id: 'stage-a', name: 'Day 1' },
        scenes: SCENE_IDS.map((id) => mocks.sceneContent[id]),
        outline: { outlines: [], generationComplete: true, producer: 'server-job' },
      };
    });
    await mount({ bootstrapDocument: true });
    expect(mocks.stageState.generationComplete).toBe(true);
    expect(mocks.stageState.outlineProducer).toBe('server-job');
  });

  it('manifest 不可用（课程刚创建）→ 显式重试，不静默停在空态', async () => {
    vi.useFakeTimers();
    mocks.manifestUnavailable = true;
    await mount({ bootstrapDocument: true });
    // The first sync fails: the canvas stays empty but the retry budget engages
    // (explicit log + timed retry), instead of the old `if (!doc) continue;`
    // silently swallowing it.
    expect(mocks.stageState.scenes).toHaveLength(0);

    // The course now exists: the manifest is available and the retry converges.
    mocks.manifestUnavailable = false;
    mocks.loadDocument.mockImplementation(async () => {
      mocks.loadCount += 1;
      return {
        stage: { id: 'stage-a', name: '课' },
        scenes: SCENE_IDS.map((id) => mocks.sceneContent[id]),
        outline: { outlines: [], generationComplete: false },
      };
    });
    // The retry budget fires after 3s (hard-coded absolute bound, not imported).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(mocks.stageState.scenes).toHaveLength(3);
  });

  it('classroom load 负责填充（bootstrapDocument=false）→ 首帧后零化基线验证一次，此后窄重取', async () => {
    // Simulate the classroom load having filled the store (the non-agent course-write path).
    mocks.stageState.stage = { id: 'stage-a' };
    mocks.stageState.scenes = SCENE_IDS.map((id) => mocks.sceneContent[id]);
    await mount({ bootstrapDocument: false });
    const source = MockEventSource.instances[0]!;

    // First frame: store is warm → record a zeroed baseline, verify once (full batch).
    await act(async () => source.emitFreshness());
    expect(mocks.batchCalls).toHaveLength(1);
    expect(mocks.batchCalls[0]!.slice().sort()).toEqual([...SCENE_IDS].sort());
    // The verification must not disturb what the classroom load filled.
    expect(mocks.stageState.scenes).toHaveLength(3);

    // Later single-scene writes re-fetch only that scene.
    bumpSceneRev('scene-1');
    await act(async () => source.emitFreshness());
    expect(mocks.batchCalls.at(-1)).toEqual(['scene-1']);
    expect(mocks.stageState.scenes.find((s) => s.id === 'scene-1')).toMatchObject({
      title: 'scene-1 v2',
    });
  });
});

describe('stage 切换的栅栏', () => {
  it('切换 stage 时旧 stage 的在途响应不会落进新 store', async () => {
    // The old stage's full document read hangs.
    let resolveOld!: (value: unknown) => void;
    mocks.loadDocument.mockImplementation((stageId: string) =>
      stageId === 'stage-a' ? new Promise((r) => (resolveOld = r)) : Promise.resolve(null),
    );
    await mount({ stageId: 'stage-a', bootstrapDocument: true });
    const before = mocks.stageState.scenes.length;

    // Switch to stage-b: the old response must not write the store when it arrives.
    await act(async () =>
      root?.render(createElement(Harness, { stageId: 'stage-b', bootstrapDocument: true })),
    );
    await act(async () => {
      resolveOld({
        stage: { id: 'stage-a' },
        scenes: [{ id: 'scene-a', order: 0 }],
        outline: {},
      });
      await Promise.resolve();
    });
    expect(mocks.stageState.stage?.id).not.toBe('stage-a');
    expect(mocks.stageState.scenes.length).toBe(before);
  });
});

describe('D3-F1: >200 场景的课程不再触发批量 400（分块 + 全败中止）', () => {
  it('250 场景：批量分块 ≤200/请求；收敛后写基线是真实 rev，不是零化 0', async () => {
    const ids = seedManyScenes(250);
    // Classroom load fills the store (warm) → first pass records a zeroed baseline, the next pass verifies everything.
    mocks.stageState.stage = { id: 'stage-a' };
    mocks.stageState.scenes = ids.map((id) => mocks.sceneContent[id]!);
    await mount({ bootstrapDocument: false });
    const source = MockEventSource.instances[0]!;

    // Trigger the second pass: full diff → chunked re-fetch (250 ids must split into ≤200-id chunks).
    await act(async () => source.emitFreshness());

    // Criterion 1 (mechanism): no batch request exceeds 200 ids (a literal,
    // not an imported implementation constant); the mock endpoint answers 400
    // to over-cap requests (matching production), so if chunking reverted to a
    // single request this criterion fails the pass and the baseline criterion
    // below goes red.
    expect(mocks.batchCalls.length).toBeGreaterThan(1);
    for (const idsInCall of mocks.batchCalls) {
      expect(idsInCall.length).toBeLessThanOrEqual(200);
    }
    // Criterion 2 (effect): the canvas holds all 250 scenes.
    expect(mocks.stageState.scenes).toHaveLength(250);
    // Criterion 3 (effect · the baseline was not written as 0): every scene in
    // the write baseline carries its real rev 1, not the zeroed baseline's 0 —
    // otherwise every later save would be vetoed forever.
    const recorded = mocks.stageState.serverManifestByStage['stage-a'] as {
      rev: number;
      scenes: { id: string; rev: number }[];
    };
    expect(recorded?.rev).toBe(1);
    expect(recorded?.scenes.find((s) => s.id === ids[0])?.rev).toBe(1);
    expect(recorded?.scenes.some((s) => s.rev === 0)).toBe(false);
  });

  it('FAULT INJECTION: 批量全败 → 本 pass 中止，不把零化基线写成写基线；恢复后收敛', async () => {
    seedCourse(1);
    mocks.stageState.stage = { id: 'stage-a' };
    mocks.stageState.scenes = SCENE_IDS.map((id) => mocks.sceneContent[id]!);
    await mount({ bootstrapDocument: false });
    const source = MockEventSource.instances[0]!;

    // The batch endpoint returns 500 (every chunk fails) → the second pass must abort.
    mocks.batchUnavailable = true;
    await act(async () => source.emitFreshness());
    expect(mocks.batchCalls.length).toBeGreaterThan(0);
    // Criterion (effect): serverManifestByStage is still unset — an aborted
    // pass must not advance renderedManifest / recordWriteBaseline (rollback
    // guard: if the abort were removed, this would record a zeroed baseline of
    // scene rev 0 and this assertion would go red).
    expect(mocks.stageState.serverManifestByStage['stage-a']).toBeUndefined();

    // The endpoint recovers → the next pass converges and the write baseline holds real revs.
    mocks.batchUnavailable = false;
    await act(async () => source.emitFreshness());
    const recorded = mocks.stageState.serverManifestByStage['stage-a'] as {
      rev: number;
      scenes: { id: string; rev: number }[];
    };
    expect(recorded?.scenes.find((s) => s.id === 'scene-1')?.rev).toBe(1);
  });
});

describe('D3-F4: 在途 pass 不得挡掉新 stage 的 sync，也不得清掉新 stage 的兜底时钟', () => {
  it('旧 pass 的迟到 finally 不得清掉新 stage 的兜底时钟（断流后兜底仍收敛）', async () => {
    // The criterion is the final effect (canvas convergence): A's pass is in
    // flight → switch to B → B converges and schedules its fallback → A's late
    // response arrives (if its finally cleared the in-flight slot or B's
    // fallback clock, B would stay on stale content forever).
    vi.useFakeTimers();
    let resolveA!: (value: unknown) => void;
    mocks.loadDocument.mockImplementation((stageId: string) => {
      if (stageId === 'stage-a') return new Promise((r) => (resolveA = r));
      mocks.loadCount += 1;
      return Promise.resolve({
        stage: { id: 'stage-b' },
        scenes: [{ id: 'scene-b1', order: 0, title: 'scene-b1' }],
        outline: {},
      });
    });
    await mount({ stageId: 'stage-a', bootstrapDocument: true });
    expect(mocks.loadDocument).toHaveBeenCalledWith('stage-a');

    // Switch to stage-b: B's mount sync runs immediately and completes (its fallback clock is scheduled).
    await act(async () =>
      root?.render(createElement(Harness, { stageId: 'stage-b', bootstrapDocument: true })),
    );
    expect(mocks.stageState.stage?.id).toBe('stage-b');

    // A's late response arrives: its finally must not clear B's fallback clock.
    await act(async () => {
      resolveA({
        stage: { id: 'stage-a' },
        scenes: [{ id: 'scene-a', order: 0 }],
        outline: {},
      });
      await Promise.resolve();
    });

    // B's stream drops: no frame for later writes will arrive; only the fallback can converge.
    const sourceB = MockEventSource.instances[1]!;
    await act(async () => sourceB.error());
    bumpSceneRev('scene-2');

    // Fallback period (30s ±20% → ≤36s): must converge within an absolute cap
    // of 45s. If A's late finally cleared B's fallback clock (the old
    // implementation's single in-flight slot + unguarded scheduleFallback),
    // this would stay on 'scene-2 v1' forever and the assertion goes red.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(mocks.stageState.scenes.find((s) => s.id === 'scene-2')).toMatchObject({
      title: 'scene-2 v2',
    });
  });
});

describe('被放弃的并发渲染不得写 store（原 course-sync-race.test.ts 的回归保护）', () => {
  it('startTransition + 抛错 Harness：被放弃的渲染不写 store、不持久化 generation 字段', async () => {
    let resolveA!: (value: unknown) => void;
    mocks.loadDocument.mockImplementation((stageId: string) =>
      stageId === 'stage-a' ? new Promise((r) => (resolveA = r)) : Promise.resolve(null),
    );
    await mount({ stageId: 'stage-a', bootstrapDocument: true });
    expect(mocks.loadDocument).toHaveBeenCalledWith('stage-a');
    const before = mocks.stageState.scenes.length;

    // An abandoned concurrent render: inside a transition, render a Harness
    // that throws a never-resolving load. React abandons the render — its
    // effect never commits, so it must not touch the store.
    const observed = new Promise<void>((resolve) => {
      abandonedRenderObserved = resolve;
    });
    await act(async () => {
      startTransition(() => {
        root?.render(
          createElement(AbandonedHarness, {
            stageId: 'stage-never-commits',
            bootstrapDocument: true,
          }),
        );
      });
    });
    await observed;

    // The committed stage-a pass lands its own content as usual.
    await act(async () => {
      resolveA({
        stage: { id: 'stage-a' },
        scenes: [
          { id: 'scene-a', order: 0, title: 'scene-a' },
          { id: 'scene-b', order: 1, title: 'scene-b' },
        ],
        outline: { outlines: [], generationComplete: true, producer: 'server-job' },
      });
      await Promise.resolve();
    });
    // Criterion (effect): the store holds only what the committed pass wrote —
    // the abandoned render ('stage-never-commits') left no trace: no second
    // read, no stage change, no scenes written.
    expect(mocks.loadDocument).toHaveBeenCalledTimes(1);
    expect(mocks.stageState.stage?.id).toBe('stage-a');
    expect(mocks.stageState.scenes.length).toBe(before + 2);
    expect(mocks.stageState.scenes.find((s) => s.id === 'scene-never-commits')).toBeUndefined();
    expect(mocks.stageState.outlineProducer).toBe('server-job');
    expect(mocks.stageState.generationComplete).toBe(true);
  });
});
