// @vitest-environment jsdom

/**
 * The freshness sync against the REAL stage store and its save scheduler: a
 * server copy of a scene must never replace an edit this browser has not
 * finished saving, and the debounced save must never write that server copy
 * back in the edit's place. Only the network edges are faked (fetch,
 * EventSource, the storage module's write).
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ServerScene {
  id: string;
  stageId: string;
  order: number;
  title: string;
  type: 'slide';
  content: { type: 'slide'; canvas: { elements: never[] } };
}

interface Saved {
  dirty: readonly { kind: string; sceneId?: string }[];
  scenes: readonly ServerScene[];
}

const mocks = vi.hoisted(() => ({
  stageRev: 1,
  sceneRevs: new Map<string, number>(),
  serverScenes: new Map<string, unknown>(),
  manifestFetches: 0,
  sceneFetches: [] as string[][],
  /** Held open while a test acts between the server's read and the response. */
  sceneResponseGate: null as Promise<void> | null,
  /** Held open while a test acts with a write on the wire. */
  saveGate: null as Promise<void> | null,
  /** Runs on the server right after a save lands. */
  afterSaveOnServer: null as (() => void) | null,
  /** The next save reports its scene changes as not written. */
  failNextSave: false,
  /** Held open while a test acts with a keepalive write on the wire. */
  keepaliveGate: null as Promise<void> | null,
  keepaliveSucceeds: true,
  saves: [] as unknown[],
}));

vi.mock('@/lib/live-mode', () => ({ isLiveMode: true }));
vi.mock('@/lib/workbench/session-store', () => ({
  appendCompactedReplayEvent: vi.fn(),
  compactReplayEvents: vi.fn(),
  useWorkbenchStore: { getState: () => ({ panelOpen: true, playbackOn: false }) },
}));
vi.mock('@/lib/document-store/store', () => ({
  getDocumentStore: () => ({ loadDocument: vi.fn() }),
}));
vi.mock('@/lib/utils/stage-storage', () => {
  /** What a save does on the server: the dirty scenes land and their revs move. */
  const save = async (
    _stageId: string,
    dirty: readonly { kind: string; sceneId?: string }[],
    data: { scenes: readonly { id: string }[] },
  ) => {
    mocks.saves.push({ dirty, scenes: data.scenes });
    if (mocks.saveGate) await mocks.saveGate;
    if (mocks.failNextSave) {
      mocks.failNextSave = false;
      return { failedChanges: dirty };
    }
    for (const change of dirty) {
      if (change.kind !== 'scene' || !change.sceneId) continue;
      const scene = data.scenes.find((candidate) => candidate.id === change.sceneId);
      if (!scene) continue;
      mocks.serverScenes.set(change.sceneId, structuredClone(scene));
      mocks.sceneRevs.set(change.sceneId, (mocks.sceneRevs.get(change.sceneId) ?? 0) + 1);
      mocks.stageRev += 1;
    }
    mocks.afterSaveOnServer?.();
    return { failedChanges: [] };
  };
  return {
    saveStageData: vi.fn(async () => {
      if (mocks.saveGate) await mocks.saveGate;
      return undefined;
    }),
    saveStageDataIncremental: vi.fn(save),
    writeStageChangesForUnload: vi.fn((_stageId: string, changes: readonly unknown[]) => ({
      sent: changes,
      deferred: [],
      settled: (mocks.keepaliveGate ?? Promise.resolve()).then(() => mocks.keepaliveSucceeds),
    })),
    loadStageData: vi.fn().mockResolvedValue(null),
  };
});
vi.mock('@/lib/orchestration/registry/store', () => ({
  applyGeneratedAgentsToRegistry: vi.fn((_stageId: string, configs: { id: string }[]) =>
    configs.map((config) => config.id),
  ),
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: () => ({
      agentMode: 'auto',
      selectedAgentIds: [],
      agentSelectionIsUserSet: false,
      setSelectedAgentIds: vi.fn(),
      setAgentSelectionIsUserSet: vi.fn(),
    }),
  },
}));

import {
  markStagePersistenceDirty,
  setServerGeneratingStage,
  useStageStore,
  writePendingChangesForUnload,
} from '@/lib/store/stage';
import { unseenScenes } from '@/lib/store/known-scenes';
import type { Scene, Stage } from '@/lib/types/stage';
import { useStageFreshnessSync } from '@/lib/workbench/use-workbench-session';

function serverScene(id: string, order: number, title: string): ServerScene {
  return {
    id,
    stageId: 'stage-a',
    order,
    title,
    type: 'slide',
    content: { type: 'slide', canvas: { elements: [] } },
  };
}

/** Someone else (an agent, another tab) writes a scene: content and revs move. */
function remoteWrite(sceneId: string, title: string) {
  const current = mocks.serverScenes.get(sceneId) as ServerScene;
  mocks.serverScenes.set(sceneId, { ...current, title });
  mocks.sceneRevs.set(sceneId, (mocks.sceneRevs.get(sceneId) ?? 0) + 1);
  mocks.stageRev += 1;
}

function remoteDelete(sceneId: string) {
  mocks.serverScenes.delete(sceneId);
  mocks.sceneRevs.delete(sceneId);
  mocks.stageRev += 1;
}

function manifest() {
  return {
    rev: mocks.stageRev,
    scenes: [...mocks.serverScenes.values()].map((scene) => {
      const { id, order } = scene as ServerScene;
      return { id, order, rev: mocks.sceneRevs.get(id) ?? 0 };
    }),
  };
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
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  close() {
    this.readyState = 2;
  }
  emitFreshness() {
    for (const fn of this.listeners.get('stage_freshness') ?? []) {
      fn({ data: JSON.stringify({ type: 'stage_freshness', stageId: 'stage-a', rev: 0 }) });
    }
  }
}

function Harness() {
  useStageFreshnessSync('stage-a');
  return null;
}

let root: ReturnType<typeof createRoot> | null = null;

function titleOf(sceneId: string): string | undefined {
  return useStageStore.getState().scenes.find((scene) => scene.id === sceneId)?.title;
}

function edit(sceneId: string, title: string) {
  useStageStore.getState().updateScene(sceneId, { title });
}

/** Let everything that can settle settle, past the 500 ms save debounce. */
async function settle(ms = 1_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function lastSavedTitle(sceneId: string): string | undefined {
  const last = mocks.saves.at(-1) as Saved | undefined;
  return last?.scenes.find((scene) => scene.id === sceneId)?.title;
}

/** The classroom loaded the course; the sync verified the true revs once. */
async function openCourse() {
  useStageStore.setState({
    stage: { id: 'stage-a', name: 'Course', createdAt: 1, updatedAt: 1 } as Stage,
    scenes: [...mocks.serverScenes.values()].map((scene) => structuredClone(scene)) as Scene[],
    currentSceneId: 'scene-1',
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(Harness)));
  const source = MockEventSource.instances[0]!;
  await act(async () => source.emitFreshness());
  mocks.manifestFetches = 0;
  mocks.sceneFetches = [];
  return source;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.stageRev = 1;
  mocks.sceneRevs = new Map([
    ['scene-1', 1],
    ['scene-2', 1],
  ]);
  mocks.serverScenes = new Map([
    ['scene-1', serverScene('scene-1', 0, 'One')],
    ['scene-2', serverScene('scene-2', 1, 'Two')],
  ]);
  mocks.manifestFetches = 0;
  mocks.sceneFetches = [];
  mocks.sceneResponseGate = null;
  mocks.saveGate = null;
  mocks.afterSaveOnServer = null;
  mocks.failNextSave = false;
  mocks.keepaliveGate = null;
  mocks.keepaliveSucceeds = true;
  mocks.saves = [];
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/manifest')) {
        mocks.manifestFetches += 1;
        const body = manifest();
        return { ok: true, status: 200, json: async () => body };
      }
      if (url.includes('/scenes?')) {
        const ids = (new URL(url, 'http://test').searchParams.get('ids') ?? '').split(',');
        mocks.sceneFetches.push(ids);
        // The server answers from what it holds now; the response arrives later.
        const scenes = ids.flatMap((id) => {
          const scene = mocks.serverScenes.get(id);
          return scene ? [structuredClone(scene)] : [];
        });
        if (mocks.sceneResponseGate) await mocks.sceneResponseGate;
        return { ok: true, status: 200, json: async () => ({ scenes }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  setServerGeneratingStage(null);
  useStageStore.getState().clearStore();
  useStageStore.setState({ serverManifestByStage: {} });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a freshness sync with unsaved scene edits', () => {
  it('forgets a scene it removed, so the id written again later counts as new', async () => {
    const source = await openCourse();
    const stored = [{ id: 'scene-2' }];
    expect(unseenScenes('stage-a', stored, [])).toEqual([]);

    remoteDelete('scene-2');
    await act(async () => source.emitFreshness());

    expect(useStageStore.getState().scenes.map((scene) => scene.id)).toEqual(['scene-1']);
    expect(unseenScenes('stage-a', stored, [])).toEqual(stored);
  });

  it('keeps an edit still inside the save debounce, and the save writes the edit', async () => {
    const source = await openCourse();

    edit('scene-1', 'typed locally');
    // The rev of this scene moved (an earlier save of ours, or anyone else's).
    remoteWrite('scene-1', 'server copy');
    await act(async () => source.emitFreshness());

    expect(titleOf('scene-1')).toBe('typed locally');

    await settle();
    expect(lastSavedTitle('scene-1')).toBe('typed locally');
    expect((mocks.serverScenes.get('scene-1') as ServerScene).title).toBe('typed locally');
    expect(titleOf('scene-1')).toBe('typed locally');
  });

  it('keeps an edit whose write is on the wire', async () => {
    const source = await openCourse();
    const save = deferred();
    mocks.saveGate = save.promise;

    edit('scene-1', 'typed locally');
    await settle(); // The debounce fired; the write is now in flight.
    expect(mocks.saves).toHaveLength(1);

    remoteWrite('scene-1', 'server copy');
    await act(async () => source.emitFreshness());
    expect(titleOf('scene-1')).toBe('typed locally');

    mocks.saveGate = null;
    save.release();
    await settle();
    expect((mocks.serverScenes.get('scene-1') as ServerScene).title).toBe('typed locally');
    expect(titleOf('scene-1')).toBe('typed locally');
  });

  it('keeps an edit that lands while the scene fetch is in flight', async () => {
    const source = await openCourse();
    const response = deferred();
    mocks.sceneResponseGate = response.promise;

    remoteWrite('scene-1', 'server copy');
    await act(async () => source.emitFreshness());
    expect(mocks.sceneFetches).toEqual([['scene-1']]);

    edit('scene-1', 'typed during the fetch');

    mocks.sceneResponseGate = null;
    await act(async () => response.release());
    expect(titleOf('scene-1')).toBe('typed during the fetch');

    await settle();
    expect(lastSavedTitle('scene-1')).toBe('typed during the fetch');
    expect((mocks.serverScenes.get('scene-1') as ServerScene).title).toBe('typed during the fetch');
  });

  it('keeps an edit saved in full while an older scene read was in flight', async () => {
    const source = await openCourse();
    const response = deferred();
    mocks.sceneResponseGate = response.promise;

    remoteWrite('scene-1', 'server copy');
    await act(async () => source.emitFreshness());

    // Edited and saved inside the fetch: nothing is unsaved any more when the
    // response arrives, but the response is older than the save.
    edit('scene-1', 'typed and saved');
    await settle();
    expect((mocks.serverScenes.get('scene-1') as ServerScene).title).toBe('typed and saved');

    mocks.sceneResponseGate = null;
    await act(async () => response.release());
    await settle();
    expect(titleOf('scene-1')).toBe('typed and saved');
  });

  it('takes a remote change once the local edit is saved, without waiting for a signal', async () => {
    const source = await openCourse();
    const save = deferred();
    mocks.saveGate = save.promise;

    edit('scene-1', 'typed locally');
    await settle();

    // A frame arrives with the write on the wire: this pass has to skip.
    remoteWrite('scene-1', 'first agent write');
    await act(async () => source.emitFreshness());
    expect(titleOf('scene-1')).toBe('typed locally');

    // The agent writes again right after our save lands. No further frame is
    // delivered, and the 30 s fallback is not reached.
    mocks.afterSaveOnServer = () => remoteWrite('scene-1', 'agent wrote after the save');
    mocks.saveGate = null;
    save.release();
    await settle();

    expect(titleOf('scene-1')).toBe('agent wrote after the save');
    expect(mocks.saves).toHaveLength(1);
  });

  it('still applies a remote change to another scene right away', async () => {
    const source = await openCourse();

    edit('scene-1', 'typed locally');
    remoteWrite('scene-1', 'server copy');
    remoteWrite('scene-2', 'agent filled this page');
    await act(async () => source.emitFreshness());

    expect(titleOf('scene-1')).toBe('typed locally');
    expect(titleOf('scene-2')).toBe('agent filled this page');
    // The kept scene stays behind in the baseline, so it is read again later.
    const baseline = useStageStore.getState().serverManifestByStage['stage-a'];
    expect(baseline?.scenes.find((scene) => scene.id === 'scene-1')?.rev).toBe(1);
    expect(baseline?.scenes.find((scene) => scene.id === 'scene-2')?.rev).toBe(2);
  });

  it('does not drop a scene with an unsaved edit that the server removed', async () => {
    const source = await openCourse();

    edit('scene-2', 'typed locally');
    remoteDelete('scene-2');
    await act(async () => source.emitFreshness());

    expect(titleOf('scene-2')).toBe('typed locally');
  });

  it('does not bring back a scene deleted locally while the deletion is unsaved', async () => {
    const source = await openCourse();

    useStageStore.getState().deleteScene('scene-2');
    remoteWrite('scene-2', 'server copy');
    await act(async () => source.emitFreshness());

    expect(titleOf('scene-2')).toBeUndefined();
  });

  it('applies nothing to a store that has moved to another course by the response', async () => {
    const source = await openCourse();
    const response = deferred();
    mocks.sceneResponseGate = response.promise;

    remoteWrite('scene-1', 'server copy');
    await act(async () => source.emitFreshness());

    useStageStore.setState({
      stage: { id: 'stage-b', name: 'Other', createdAt: 1, updatedAt: 1 } as Stage,
      scenes: [],
      currentSceneId: null,
    });
    mocks.sceneResponseGate = null;
    await act(async () => response.release());

    expect(useStageStore.getState().scenes).toEqual([]);
  });

  it('applies a remote change at once when there is nothing unsaved, and writes nothing', async () => {
    const source = await openCourse();

    remoteWrite('scene-1', 'agent filled this page');
    await act(async () => source.emitFreshness());
    expect(titleOf('scene-1')).toBe('agent filled this page');

    await settle();
    expect(mocks.saves).toHaveLength(0);
    const baseline = useStageStore.getState().serverManifestByStage['stage-a'];
    expect(baseline?.scenes.find((scene) => scene.id === 'scene-1')?.rev).toBe(2);
  });
});

describe('a freshness sync with other writes outstanding', () => {
  it('holds every scene for a whole-document save on the wire, and reads them when it ends', async () => {
    const source = await openCourse();
    const save = deferred();
    mocks.saveGate = save.promise;

    const saving = useStageStore.getState().saveToStorage();
    remoteWrite('scene-2', 'agent filled this page');
    await act(async () => source.emitFreshness());
    expect(titleOf('scene-2')).toBe('Two');

    mocks.saveGate = null;
    save.release();
    await act(async () => {
      await saving;
    });
    await settle(100);
    // No frame, and well short of the fallback clock: the save's end did it.
    expect(titleOf('scene-2')).toBe('agent filled this page');
  });

  it('holds every scene for a flush round that writes the whole document', async () => {
    const source = await openCourse();
    const save = deferred();
    mocks.saveGate = save.promise;

    // Two categories of document change flush together as one aggregate save.
    edit('scene-1', 'typed locally');
    useStageStore.setState((state) => ({ stage: { ...state.stage!, name: 'Renamed' } }));
    markStagePersistenceDirty([{ kind: 'stage' }]);
    await settle();
    expect(mocks.saves).toHaveLength(1);

    remoteWrite('scene-2', 'agent filled this page');
    await act(async () => source.emitFreshness());
    expect(titleOf('scene-2')).toBe('Two');

    mocks.saveGate = null;
    save.release();
    await settle();
    expect(titleOf('scene-2')).toBe('agent filled this page');
    expect(titleOf('scene-1')).toBe('typed locally');
  });

  it('keeps an edit carried by a keepalive write on the wire', async () => {
    const source = await openCourse();
    // The unload path needs the storage module, which the first save loads.
    edit('scene-2', 'an earlier edit');
    await settle();

    const keepalive = deferred();
    mocks.keepaliveGate = keepalive.promise;
    edit('scene-1', 'typed locally');
    writePendingChangesForUnload();

    remoteWrite('scene-1', 'server copy');
    await act(async () => source.emitFreshness());
    expect(titleOf('scene-1')).toBe('typed locally');

    // The page stayed (a cancelled unload, a return from the back/forward cache).
    // The frame for this rev has been consumed, so nothing else would wake the sync.
    keepalive.release();
    await settle(100);
    expect(titleOf('scene-1')).toBe('server copy');
  });

  it('keeps an edit whose keepalive write failed, and saves it through the regular path', async () => {
    const source = await openCourse();
    edit('scene-2', 'an earlier edit');
    await settle();

    const keepalive = deferred();
    mocks.keepaliveGate = keepalive.promise;
    mocks.keepaliveSucceeds = false;
    edit('scene-1', 'typed locally');
    writePendingChangesForUnload();

    remoteWrite('scene-1', 'server copy');
    await act(async () => source.emitFreshness());

    keepalive.release();
    await settle(100); // Short of the debounce: the edit is queued again, and kept.
    expect(titleOf('scene-1')).toBe('typed locally');

    await settle();
    expect(lastSavedTitle('scene-1')).toBe('typed locally');
    expect((mocks.serverScenes.get('scene-1') as ServerScene).title).toBe('typed locally');
    expect(titleOf('scene-1')).toBe('typed locally');
  });

  it('keeps a learner change to a course its generation run still owns', async () => {
    const source = await openCourse();
    setServerGeneratingStage('stage-a');

    edit('scene-1', 'learner progress');
    expect(mocks.saves).toHaveLength(0);
    remoteWrite('scene-1', 'server copy');
    await act(async () => source.emitFreshness());

    expect(titleOf('scene-1')).toBe('learner progress');
  });

  it('keeps an edit whose save failed, and writes it on the retry', async () => {
    const source = await openCourse();
    mocks.failNextSave = true;

    edit('scene-1', 'typed locally');
    await settle();
    expect(mocks.saves).toHaveLength(1);
    expect((mocks.serverScenes.get('scene-1') as ServerScene).title).toBe('One');

    remoteWrite('scene-1', 'server copy');
    await act(async () => source.emitFreshness());
    expect(titleOf('scene-1')).toBe('typed locally');

    await settle(2_000); // Past the first retry's backoff.
    expect(mocks.saves).toHaveLength(2);
    expect(lastSavedTitle('scene-1')).toBe('typed locally');
    expect((mocks.serverScenes.get('scene-1') as ServerScene).title).toBe('typed locally');
    expect(titleOf('scene-1')).toBe('typed locally');
  });
});
