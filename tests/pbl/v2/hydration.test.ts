import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type {
  RuntimePayload,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
} from '@openmaic/dsl';
import { BrowserRuntimeStore, type RuntimeSessionInit, type RuntimeStore } from '@openmaic/storage';

import { applyInstructorEvent } from '@/components/scene-renderers/pbl/v2/apply-instructor-event';
import type { PBLProjectConfig } from '@/lib/pbl/types';
import { recordEvent } from '@/lib/pbl/v2/operations/engagement';
import { addEvaluation } from '@/lib/pbl/v2/operations/evaluation';
import {
  advanceMicrotask,
  continueAfterHandover,
  resetProjectProgress,
  startMicrotask,
} from '@/lib/pbl/v2/operations/progress';
import { transitionProjectUiPhase } from '@/lib/pbl/v2/operations/runtime-events';
import { addSubmission } from '@/lib/pbl/v2/operations/submission';
import {
  clearPendingTaskCompletion,
  setPendingTaskCompletion,
} from '@/lib/pbl/v2/operations/task-completion';
import { drainProjectRuntime } from '@/lib/pbl/v2/runtime/drain';
import { foldPBLRuntime } from '@/lib/pbl/v2/runtime/fold';
import {
  appendPBLRuntimeSnapshotIfChanged,
  hydratePBLProjectFromRuntime,
  hydratePBLScenesFromRuntime,
  synchronizePBLProjectRuntime,
} from '@/lib/pbl/v2/runtime/hydration';
import { extractLearnerState, stripToDesignTemplate } from '@/lib/pbl/v2/runtime/learner-state';
import {
  pblSnapshotRecordPayload,
  type PBLRuntimeStorePayload,
} from '@/lib/pbl/v2/runtime/record-payloads';
import { makeScene, type Scene } from '@/lib/types/stage';
import type { KVScope, KVStore } from '@openmaic/storage';
import type { PBLProjectV2, PBLRuntimeEvent } from '@/lib/pbl/v2/types';
import { withRuntimeStorageExclusiveLock } from '@/lib/utils/chat-storage-lock';

if (!('IDBKeyRange' in globalThis)) {
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
}

const STAGE_ID = 'stage-1';
const SCENE_ID = 'scene-1';
const LEARNER_KEY = 'anon:test-device';

function readWriteLockManager(onAcquire?: (mode: LockMode) => void): Pick<LockManager, 'request'> {
  type Waiter = {
    mode: LockMode;
    run(): void;
  };
  const states = new Map<string, { readers: number; writer: boolean; waiters: Waiter[] }>();
  const stateFor = (name: string) => {
    let state = states.get(name);
    if (!state) {
      state = { readers: 0, writer: false, waiters: [] };
      states.set(name, state);
    }
    return state;
  };
  const pump = (name: string) => {
    const state = stateFor(name);
    if (state.writer || state.waiters.length === 0) return;
    if (state.waiters[0]!.mode === 'exclusive') {
      if (state.readers === 0) state.waiters.shift()!.run();
      return;
    }
    while (state.waiters[0]?.mode === 'shared' && !state.writer) {
      state.waiters.shift()!.run();
    }
  };
  return {
    request<T>(
      name: string,
      optionsOrCallback: LockOptions | (() => Promise<T> | T),
      maybeCallback?: () => Promise<T> | T,
    ): Promise<T> {
      const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
      const mode = options?.mode ?? 'exclusive';
      const state = stateFor(name);
      return new Promise<T>((resolve, reject) => {
        state.waiters.push({
          mode,
          run() {
            if (mode === 'shared') state.readers += 1;
            else state.writer = true;
            onAcquire?.(mode);
            void Promise.resolve()
              .then(callback)
              .then(resolve, reject)
              .finally(() => {
                if (mode === 'shared') state.readers -= 1;
                else state.writer = false;
                pump(name);
              });
          },
        });
        pump(name);
      });
    },
  } as Pick<LockManager, 'request'>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

class MemoryKVStore implements KVStore {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string, scope: KVScope = 'account'): Promise<T | null> {
    return (this.values.get(`${scope}:${key}`) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T, scope: KVScope = 'account'): Promise<void> {
    this.values.set(`${scope}:${key}`, value);
  }

  async remove(key: string, scope: KVScope = 'account'): Promise<void> {
    this.values.delete(`${scope}:${key}`);
  }

  async keys(prefix = '', scope: KVScope = 'account'): Promise<string[]> {
    const scopedPrefix = `${scope}:`;
    return [...this.values.keys()]
      .filter((key) => key.startsWith(scopedPrefix))
      .map((key) => key.slice(scopedPrefix.length))
      .filter((key) => key.startsWith(prefix));
  }
}

class MemoryRuntimeStore implements RuntimeStore {
  readonly sessions: RuntimeSession[] = [];
  readonly records: RuntimeRecord[] = [];

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    const existing = this.sessions.find((session) => session.id === init.id);
    if (existing) throw new Error(`session ${init.id} already exists`);
    const session: RuntimeSession = { ...init, runtimeDslVersion: 'test' };
    this.sessions.push(session);
    return session;
  }

  async getSession(sessionId: string): Promise<RuntimeSession | undefined> {
    return this.sessions.find((session) => session.id === sessionId);
  }

  async listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]> {
    return this.sessions.filter(
      (session) => session.stageId === stageId && session.learnerKey === learnerKey,
    );
  }

  async setSessionStatus(): Promise<void> {}
  async deleteSession(): Promise<void> {}

  async appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
  ): Promise<RuntimeRecord<TPayload>> {
    const seq = this.records.filter((record) => record.sessionId === init.sessionId).length;
    const record: RuntimeRecord<TPayload> = { ...init, seq };
    this.records.push(record);
    return record;
  }

  async listRecords(sessionId: string, opts?: { sceneId?: string }): Promise<RuntimeRecord[]> {
    return this.records.filter(
      (record) =>
        record.sessionId === sessionId && (opts?.sceneId ? record.sceneId === opts.sceneId : true),
    );
  }

  async mergeLearner(): Promise<number> {
    return 0;
  }

  async deleteLearnerRuntime(): Promise<void> {}
  async deleteStageRuntime(): Promise<void> {}
  async deleteAllRuntime(): Promise<void> {}
}

class ThrowingRuntimeStore extends MemoryRuntimeStore {
  async listSessions(): Promise<RuntimeSession[]> {
    throw new Error('runtime unavailable');
  }

  async listRecords(): Promise<RuntimeRecord[]> {
    throw new Error('runtime unavailable');
  }

  async appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
  ): Promise<RuntimeRecord<TPayload>> {
    void init;
    throw new Error('runtime unavailable');
  }
}

class SlowFirstAppendRuntimeStore extends MemoryRuntimeStore {
  private releaseAppend!: () => void;
  private readonly appendGate = new Promise<void>((resolve) => {
    this.releaseAppend = resolve;
  });
  private markStarted!: () => void;
  readonly appendStarted = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  constructor(private readonly slowRecordId: string) {
    super();
  }

  override async appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
  ): Promise<RuntimeRecord<TPayload>> {
    if (init.id === this.slowRecordId) {
      this.markStarted();
      await this.appendGate;
    }
    return super.appendRecord(init);
  }

  release(): void {
    this.releaseAppend();
  }
}

class BlockFirstRecordListRuntimeStore extends MemoryRuntimeStore {
  private recordListCount = 0;
  private releaseFirstList!: () => void;
  private readonly firstListGate = new Promise<void>((resolve) => {
    this.releaseFirstList = resolve;
  });
  private markFirstListStarted!: () => void;
  readonly firstListStarted = new Promise<void>((resolve) => {
    this.markFirstListStarted = resolve;
  });

  override async listRecords(
    sessionId: string,
    opts?: { sceneId?: string },
  ): Promise<RuntimeRecord[]> {
    this.recordListCount += 1;
    if (this.recordListCount === 1) {
      this.markFirstListStarted();
      await this.firstListGate;
    }
    return super.listRecords(sessionId, opts);
  }

  release(): void {
    this.releaseFirstList();
  }
}

function makeProject(overrides: Partial<PBLProjectV2> = {}): PBLProjectV2 {
  return {
    uiPhase: 'hero',
    title: 'Hydration project',
    description: 'Build something',
    proficiency: 'intermediate',
    language: 'en-US',
    tags: [],
    status: 'active',
    roles: [{ id: 'role-i', type: 'instructor', name: 'Instructor' }],
    milestones: [
      {
        id: 'ms-1',
        title: 'Milestone 1',
        status: 'active',
        order: 0,
        microtasks: [
          {
            id: 'mt-1',
            title: 'Task 1',
            status: 'todo',
            assignee: 'user',
            hints: [],
            order: 0,
          },
          {
            id: 'mt-2',
            title: 'Task 2',
            status: 'todo',
            assignee: 'user',
            hints: [],
            order: 1,
          },
        ],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [{ agentId: 'role-i', messages: [] }],
    engagementEvents: [],
    runtimeEvents: [],
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
    ...overrides,
  };
}

function makeTwoMilestoneProject(overrides: Partial<PBLProjectV2> = {}): PBLProjectV2 {
  return makeProject({
    milestones: [
      {
        id: 'ms-1',
        title: 'Milestone 1',
        status: 'active',
        order: 0,
        microtasks: [
          {
            id: 'mt-1',
            title: 'Task 1',
            status: 'todo',
            assignee: 'user',
            hints: [],
            order: 0,
          },
        ],
      },
      {
        id: 'ms-2',
        title: 'Milestone 2',
        status: 'locked',
        order: 1,
        microtasks: [
          {
            id: 'mt-2',
            title: 'Task 2',
            status: 'todo',
            assignee: 'user',
            hints: [],
            order: 0,
          },
        ],
      },
    ],
    ...overrides,
  });
}

function makePBLScene(project: PBLProjectV2): Scene {
  return makeScene(
    {
      id: SCENE_ID,
      stageId: STAGE_ID,
      title: 'PBL scene',
      order: 0,
    },
    {
      type: 'pbl',
      projectConfig: {} as PBLProjectConfig,
      projectV2: project,
    },
  );
}

async function hydrate(project: PBLProjectV2, store: RuntimeStore = new MemoryRuntimeStore()) {
  const kv = new MemoryKVStore();
  return hydratePBLProjectFromRuntime({
    stageId: STAGE_ID,
    sceneId: SCENE_ID,
    project,
    store,
    kv,
    learnerKey: LEARNER_KEY,
  });
}

async function listRecords(store: RuntimeStore): Promise<RuntimeRecord[]> {
  const sessions = await store.listSessions(STAGE_ID, LEARNER_KEY);
  if (!sessions[0]) return [];
  return store.listRecords(sessions[0].id, { sceneId: SCENE_ID });
}

async function ensureSession(store: MemoryRuntimeStore): Promise<RuntimeSession> {
  const existing = store.sessions.find(
    (session) => session.stageId === STAGE_ID && session.learnerKey === LEARNER_KEY,
  );
  if (existing) return existing;
  return store.createSession({
    id: `pbl-${STAGE_ID}-${LEARNER_KEY}`,
    kind: 'pbl',
    stageId: STAGE_ID,
    learnerKey: LEARNER_KEY,
    status: 'active',
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
  });
}

describe('PBL runtime hydration', () => {
  it('returns unchanged scenes when runtime hydration throws for a scene', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = makeProject({ uiPhase: 'workspace' });
    const scenes = [makePBLScene(project)];

    const hydrated = await hydratePBLScenesFromRuntime(STAGE_ID, scenes, {
      store: new ThrowingRuntimeStore(),
      kv: new MemoryKVStore(),
      learnerKey: LEARNER_KEY,
    });

    expect(hydrated).toEqual(scenes);
    expect(hydrated[0]).toBe(scenes[0]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not silently replace runtime-authoritative state with a design-only document', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scenes = [makePBLScene(stripToDesignTemplate(makeProject()))];

    await expect(
      hydratePBLScenesFromRuntime(STAGE_ID, scenes, {
        store: new ThrowingRuntimeStore(),
        kv: new MemoryKVStore(),
        learnerKey: LEARNER_KEY,
      }),
    ).rejects.toThrow('runtime unavailable');
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('using document state'),
      expect.anything(),
    );
    warn.mockRestore();
  });

  it('keeps document state and appends a snapshot for a pre-runtime learner', async () => {
    const store = new MemoryRuntimeStore();
    const project = makeProject({ uiPhase: 'workspace' });
    startMicrotask(project, 'mt-1');
    project.threads[0]!.messages.push({
      id: 'legacy-msg-1',
      roleType: 'user',
      content: 'Legacy answer',
      ts: '2026-05-29T00:00:01.000Z',
      microtaskId: 'mt-1',
    });

    const hydrated = await hydrate(project, store);

    expect(hydrated.source).toBe('document');
    expect(extractLearnerState(hydrated.project)).toEqual(extractLearnerState(project));
    const records = await listRecords(store);
    expect((records.at(-1)?.payload as PBLRuntimeStorePayload).kind).toBe('pbl_snapshot');
  });

  it('synchronizes the complete learner state before document persistence', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject({ uiPhase: 'workspace', runtimeEvents: [] });
    project.threads[0]!.messages.push({
      id: 'legacy-msg-1',
      roleType: 'user',
      content: 'State that must survive the write cutover',
      ts: '2026-05-29T00:00:01.000Z',
      microtaskId: 'mt-1',
    });

    await synchronizePBLProjectRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });

    const records = await listRecords(store);
    const folded = foldPBLRuntime({ designTemplate: stripToDesignTemplate(project), records });
    expect(folded.diagnostics.gaps).toEqual([]);
    expect(folded.learnerState).toEqual(extractLearnerState(project));
    expect(
      records.filter(
        (record) => (record.payload as PBLRuntimeStorePayload).kind === 'pbl_snapshot',
      ),
    ).toHaveLength(1);
  });

  it('serializes the full synchronization so an overlapping stale save cannot win last', async () => {
    const store = new BlockFirstRecordListRuntimeStore();
    const kv = new MemoryKVStore();
    await ensureSession(store);
    const staleProject = makeProject({ uiPhase: 'workspace' });
    const latestProject = makeProject({ uiPhase: 'completed', status: 'completed' });

    const staleSave = synchronizePBLProjectRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project: staleProject,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await store.firstListStarted;
    const latestSave = synchronizePBLProjectRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project: latestProject,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await Promise.resolve();
    store.release();
    await Promise.all([staleSave, latestSave]);

    const records = await listRecords(store);
    const folded = foldPBLRuntime({
      designTemplate: stripToDesignTemplate(latestProject),
      records,
    });
    expect(folded.learnerState).toEqual(extractLearnerState(latestProject));
  });

  it('keeps RuntimeStore authoritative when the first stripped document write is interrupted', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const staleDocument = makeProject({ uiPhase: 'workspace' });
    const latestProject = makeProject({ uiPhase: 'completed', status: 'completed' });

    await synchronizePBLProjectRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project: latestProject,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });

    const hydrated = await hydratePBLProjectFromRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project: staleDocument,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });

    expect(hydrated.source).toBe('fold');
    expect(extractLearnerState(hydrated.project)).toEqual(extractLearnerState(latestProject));
    expect(
      (await listRecords(store)).some(
        (record) =>
          (record.payload as Partial<PBLRuntimeStorePayload>).kind === 'pbl_snapshot' &&
          (record.payload as { reason?: string }).reason === 'write_cutover',
      ),
    ).toBe(true);
  });

  it('hydrates a fresh learner from the folded baseline without writing a snapshot', async () => {
    const store = new MemoryRuntimeStore();
    const project = makeProject();

    const hydrated = await hydrate(project, store);

    expect(hydrated.source).toBe('fold');
    expect(extractLearnerState(hydrated.project)).toEqual(extractLearnerState(project));
    expect(await listRecords(store)).toEqual([]);
  });

  it('uses folded runtime history when it matches the document state', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    let project = transitionProjectUiPhase(makeProject(), 'workspace');
    project = applyInstructorEvent(
      {
        type: 'project_patch',
        patch: {
          kind: 'message',
          message: {
            id: 'msg-1',
            roleType: 'user',
            content: 'Runtime-backed answer',
            ts: '2026-05-29T00:00:01.000Z',
            microtaskId: 'mt-1',
          },
        },
      },
      project,
      () => {},
    );
    await drainProjectRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });

    const hydrated = await hydratePBLProjectFromRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });

    expect(hydrated.source).toBe('fold');
    expect(extractLearnerState(hydrated.project)).toEqual(extractLearnerState(project));
    expect(
      (await listRecords(store)).filter(
        (record) => (record.payload as PBLRuntimeStorePayload).kind === 'pbl_snapshot',
      ),
    ).toHaveLength(0);
  });

  it('uses runtime history when the persisted document contains only the design template', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const runtimeProject = transitionProjectUiPhase(makeProject(), 'workspace');
    await drainProjectRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project: runtimeProject,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    const designDocument = stripToDesignTemplate(runtimeProject);

    const hydrated = await hydratePBLProjectFromRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project: designDocument,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });

    expect(hydrated.source).toBe('fold');
    expect(extractLearnerState(hydrated.project)).toEqual(extractLearnerState(runtimeProject));
    expect(
      (await listRecords(store)).filter(
        (record) => (record.payload as PBLRuntimeStorePayload).kind === 'pbl_snapshot',
      ),
    ).toHaveLength(0);
  });

  it('waits for the actual drain before reading records or writing a snapshot', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = transitionProjectUiPhase(makeProject(), 'workspace');
    const eventId = project.runtimeEvents![0]!.id;
    const store = new SlowFirstAppendRuntimeStore(eventId);

    try {
      const hydrating = hydrate(project, store);
      await store.appendStarted;
      await vi.advanceTimersByTimeAsync(10_001);
      await Promise.resolve();

      const recordsAfterCallerTimeout = await listRecords(store);
      store.release();
      const hydrated = await hydrating;

      expect(
        recordsAfterCallerTimeout.some(
          (record) => (record.payload as Partial<PBLRuntimeStorePayload>).kind === 'pbl_snapshot',
        ),
      ).toBe(false);
      expect(hydrated.source).toBe('fold');
      expect((await listRecords(store)).map((record) => record.id)).toEqual([eventId]);
    } finally {
      store.release();
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('enrolls hydration before later maintenance while waiting for an earlier drain', async () => {
    let sharedAcquisitions = 0;
    vi.stubGlobal('navigator', {
      locks: readWriteLockManager((mode) => {
        if (mode === 'shared') sharedAcquisitions += 1;
      }),
    });
    const project = transitionProjectUiPhase(makeProject(), 'workspace');
    const eventId = project.runtimeEvents![0]!.id;
    const store = new SlowFirstAppendRuntimeStore(eventId);
    const kv = new MemoryKVStore();

    const priorDrain = drainProjectRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await store.appendStarted;
    const hydrating = hydratePBLProjectFromRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sharedAcquisitionsBeforeRelease = sharedAcquisitions;
    const maintenance = withRuntimeStorageExclusiveLock(async () => {
      store.records.splice(0);
      store.sessions.splice(0);
    });

    store.release();
    await Promise.all([priorDrain, hydrating, maintenance]);
    expect(sharedAcquisitionsBeforeRelease).toBe(2);
    expect(store.records).toEqual([]);
    expect(store.sessions).toEqual([]);
  });

  it('falls back to the document without a snapshot when the drain barrier times out', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = transitionProjectUiPhase(makeProject(), 'workspace');
    const eventId = project.runtimeEvents![0]!.id;
    const store = new SlowFirstAppendRuntimeStore(eventId);
    const scenes = [makePBLScene(project)];
    const kv = new MemoryKVStore();

    try {
      const priorDrain = drainProjectRuntime({
        stageId: STAGE_ID,
        sceneId: SCENE_ID,
        project,
        store,
        kv,
        learnerKey: LEARNER_KEY,
      });
      await store.appendStarted;
      let settled = false;
      const hydrating = hydratePBLScenesFromRuntime(STAGE_ID, scenes, {
        store,
        kv,
        learnerKey: LEARNER_KEY,
      }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(20_001);
      await Promise.resolve();

      const settledAtBarrierTimeout = settled;
      const recordsAtBarrierTimeout = await listRecords(store);
      store.release();
      await priorDrain;
      const hydrated = await hydrating;

      expect(settledAtBarrierTimeout).toBe(true);
      expect(hydrated).toEqual(scenes);
      expect(
        recordsAtBarrierTimeout.some(
          (record) => (record.payload as Partial<PBLRuntimeStorePayload>).kind === 'pbl_snapshot',
        ),
      ).toBe(false);
    } finally {
      store.release();
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('retains the shared maintenance lock after a timed-out hydration until work settles', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { locks: readWriteLockManager() });
    const project = transitionProjectUiPhase(makeProject(), 'workspace');
    const eventId = project.runtimeEvents![0]!.id;
    const store = new SlowFirstAppendRuntimeStore(eventId);

    try {
      const hydrating = hydrate(project, store);
      let hydrationSettled = false;
      const hydrationOutcome = hydrating.then(
        () => {
          hydrationSettled = true;
        },
        () => {
          hydrationSettled = true;
        },
      );
      await store.appendStarted;
      await vi.advanceTimersByTimeAsync(20_001);
      await Promise.resolve();
      expect(hydrationSettled).toBe(true);

      let maintenanceStarted = false;
      const maintenance = withRuntimeStorageExclusiveLock(async () => {
        maintenanceStarted = true;
      });
      await Promise.resolve();
      expect(maintenanceStarted).toBe(false);

      store.release();
      await Promise.all([hydrationOutcome, maintenance]);
      expect(maintenanceStarted).toBe(true);
    } finally {
      store.release();
      vi.useRealTimers();
    }
  });

  it('keeps document state and self-heals when runtime history is partial', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject();
    startMicrotask(project, 'mt-1');
    addSubmission(project, {
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      kind: 'text',
      content: 'Answer missing from runtime history',
    });
    project.runtimeEvents = project.runtimeEvents?.slice(0, 1) ?? [];

    const hydrated = await hydratePBLProjectFromRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });

    expect(hydrated.source).toBe('document');
    expect(extractLearnerState(hydrated.project)).toEqual(extractLearnerState(project));
    expect(
      (await listRecords(store)).some(
        (record) => (record.payload as PBLRuntimeStorePayload).kind === 'pbl_snapshot',
      ),
    ).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('flips to fold after a legacy raw-record mismatch has a self-heal snapshot', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject();
    project.threads[0]!.messages.push({
      id: 'legacy-msg-1',
      roleType: 'user',
      content: 'Legacy raw record content recovered by snapshot',
      ts: '2026-05-29T00:00:01.000Z',
      microtaskId: 'mt-1',
    });
    const session = await ensureSession(store);
    const rawEvent: PBLRuntimeEvent = {
      id: 'legacy-raw-message',
      kind: 'message_created',
      actorType: 'user',
      messageId: 'legacy-msg-1',
      threadId: 'role-i',
      ts: '2026-05-29T00:00:01.000Z',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
    };
    await store.appendRecord({
      id: rawEvent.id,
      sessionId: session.id,
      sceneId: SCENE_ID,
      createdAt: rawEvent.ts,
      payload: rawEvent as unknown as RuntimePayload,
    });
    await store.appendRecord({
      id: 'self-heal-snapshot',
      sessionId: session.id,
      sceneId: SCENE_ID,
      createdAt: '2026-05-29T00:00:02.000Z',
      payload: pblSnapshotRecordPayload({
        epoch: 0,
        learnerState: extractLearnerState(project),
        anchor: { lastRuntimeEventId: rawEvent.id },
        reason: 'self_heal',
      }),
    });

    const hydrated = await hydratePBLProjectFromRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });

    expect(hydrated.source).toBe('fold');
    expect(hydrated.diagnostics.gaps).toEqual([]);
    expect(
      (await listRecords(store)).filter(
        (record) => (record.payload as PBLRuntimeStorePayload).kind === 'pbl_snapshot',
      ),
    ).toHaveLength(1);
  });

  it('skips a duplicate self-heal snapshot when the latest snapshot already matches', async () => {
    const store = new MemoryRuntimeStore();
    const project = makeProject({ uiPhase: 'workspace' });
    const session = await ensureSession(store);
    const learnerState = extractLearnerState(project);

    const firstAppend = await appendPBLRuntimeSnapshotIfChanged({
      store,
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      learnerKey: LEARNER_KEY,
      project,
      learnerState,
      records: [],
      reason: 'self_heal',
    });
    const snapshotRecord = await store.listRecords(session.id, { sceneId: SCENE_ID });
    const snapshotPayload = snapshotRecord[0]!.payload as Extract<
      PBLRuntimeStorePayload,
      { kind: 'pbl_snapshot' }
    >;
    snapshotPayload.learnerState = {
      status: learnerState.status,
      uiPhase: learnerState.uiPhase,
      milestones: learnerState.milestones,
      submissions: learnerState.submissions,
      evaluations: learnerState.evaluations,
      threads: learnerState.threads,
      engagementEvents: learnerState.engagementEvents,
    };
    const secondAppend = await appendPBLRuntimeSnapshotIfChanged({
      store,
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      learnerKey: LEARNER_KEY,
      project,
      learnerState,
      records: snapshotRecord,
      reason: 'self_heal',
    });

    expect(firstAppend).toBe(true);
    expect(secondAppend).toBe(false);
    expect(
      (await listRecords(store)).filter(
        (record) => (record.payload as PBLRuntimeStorePayload).kind === 'pbl_snapshot',
      ),
    ).toHaveLength(1);
  });

  it('preserves document-only transient fields on a fold-match hydration', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject({
      pendingOpenTaskPriorQuizResults: [
        {
          sceneId: 'quiz-1',
          sceneTitle: 'Readiness quiz',
          totalQuestions: 2,
          correctCount: 1,
          incorrectCount: 1,
          unscoredCount: 0,
          accuracy: 0.5,
        },
      ],
    });

    const hydrated = await hydratePBLProjectFromRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });

    expect(hydrated.source).toBe('fold');
    expect(hydrated.project.pendingOpenTaskPriorQuizResults).toEqual(
      project.pendingOpenTaskPriorQuizResults,
    );
  });

  it('self-heals when a bounded document outbox cannot cover an older runtime gap', async () => {
    const store = new MemoryRuntimeStore();
    const project = makeProject({ uiPhase: 'workspace', runtimeEvents: [] });
    project.threads[0]!.messages.push({
      id: 'evicted-msg',
      roleType: 'user',
      content: 'This message event was evicted from the document outbox',
      ts: '2026-05-29T00:00:01.000Z',
      microtaskId: 'mt-1',
    });

    const hydrated = await hydrate(project, store);

    expect(hydrated.source).toBe('document');
    expect(
      (await listRecords(store)).some(
        (record) => (record.payload as PBLRuntimeStorePayload).kind === 'pbl_snapshot',
      ),
    ).toBe(true);
  });

  it('folds duplicate records from overlapping drains exactly once', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    let project = transitionProjectUiPhase(makeProject(), 'workspace');
    project = applyInstructorEvent(
      {
        type: 'project_patch',
        patch: {
          kind: 'message',
          message: {
            id: 'msg-1',
            roleType: 'user',
            content: 'Only once',
            ts: '2026-05-29T00:00:01.000Z',
            microtaskId: 'mt-1',
          },
        },
      },
      project,
      () => {},
    );
    await Promise.all([
      drainProjectRuntime({
        stageId: STAGE_ID,
        sceneId: SCENE_ID,
        project,
        store,
        kv,
        learnerKey: LEARNER_KEY,
      }),
      drainProjectRuntime({
        stageId: STAGE_ID,
        sceneId: SCENE_ID,
        project,
        store,
        kv,
        learnerKey: LEARNER_KEY,
      }),
    ]);

    const records = await listRecords(store);
    const folded = foldPBLRuntime({ designTemplate: stripToDesignTemplate(project), records });

    expect(folded.learnerState.threads[0]?.messages).toHaveLength(1);
    expect(folded.learnerState).toEqual(extractLearnerState(project));
  });

  it('folds staged and consumed handover events drained in one batch', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeTwoMilestoneProject();
    startMicrotask(project, 'mt-1');
    const advanced = advanceMicrotask(project, 'mt-1', 'stage complete', {
      performance: 'ready for the next milestone',
    });
    expect(advanced.ok).toBe(true);
    expect(project.pendingHandover?.consumed).toBe(false);

    const consumed = continueAfterHandover(project);
    expect(consumed.ok).toBe(true);
    expect(project.pendingHandover?.consumed).toBe(true);

    await drainProjectRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    const records = await listRecords(store);
    const folded = foldPBLRuntime({ designTemplate: stripToDesignTemplate(project), records });

    expect(folded.diagnostics.gaps).toEqual([]);
    expect(folded.learnerState).toEqual(extractLearnerState(project));
  });

  it('keeps microtask engagement and assessment attached to the completing status event', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject();
    startMicrotask(project, 'mt-1');
    recordEvent(project, 'learner_turn', {
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      payload: { chars: 24 },
    });
    const advanced = advanceMicrotask(project, 'mt-1', 'learner completed task', {
      performance: 'specific evidence',
    });
    expect(advanced.ok).toBe(true);

    await drainProjectRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    const records = await listRecords(store);
    const completedStatus = records
      .map((record) => record.payload as PBLRuntimeStorePayload)
      .find(
        (payload) =>
          payload.kind === 'pbl_runtime_event' &&
          payload.event.kind === 'status_changed' &&
          payload.event.entityType === 'microtask' &&
          payload.event.entityId === 'mt-1' &&
          payload.event.to === 'completed',
      );
    const folded = foldPBLRuntime({ designTemplate: stripToDesignTemplate(project), records });

    expect(completedStatus).toMatchObject({
      kind: 'pbl_runtime_event',
      attachment: {
        kind: 'status',
        microtask: {
          completionReason: 'learner completed task',
          internalAssessment: { performance: 'specific evidence' },
          engagement: { learnerTurnCount: 1 },
        },
      },
    });
    expect(folded.diagnostics.gaps).toEqual([]);
    expect(folded.learnerState).toEqual(extractLearnerState(project));
  });

  it('property-checks randomized reducer sequences against BrowserRuntimeStore folds', async () => {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const kv = new MemoryKVStore();
    let project = makeProject({ uiPhase: 'workspace' });
    let seed = 869;
    let messageIndex = 0;

    const nextRandom = () => {
      seed = (seed * 1103515245 + 12345) % 0x80000000;
      return seed / 0x80000000;
    };

    for (let step = 0; step < 24; step++) {
      const active = project.milestones
        .find((milestone) => milestone.status === 'active')
        ?.microtasks.find((task) => task.status === 'todo' || task.status === 'in_progress');
      const roll = nextRandom();
      if (!active || project.status === 'completed') {
        project = resetProjectProgress(project);
      } else if (roll < 0.2) {
        startMicrotask(project, active.id);
      } else if (roll < 0.4) {
        messageIndex += 1;
        project = applyInstructorEvent(
          {
            type: 'project_patch',
            patch: {
              kind: 'message',
              message: {
                id: `msg-${messageIndex}`,
                roleType: messageIndex % 2 === 0 ? 'instructor' : 'user',
                agentId: messageIndex % 2 === 0 ? 'role-i' : undefined,
                content: `Message ${messageIndex}`,
                ts: `2026-05-29T00:${String(step).padStart(2, '0')}:00.000Z`,
                microtaskId: active.id,
              },
            },
          },
          project,
          () => {},
        );
      } else if (roll < 0.55) {
        addSubmission(project, {
          microtaskId: active.id,
          milestoneId: 'ms-1',
          kind: 'text',
          content: `Submission ${step}`,
        });
      } else if (roll < 0.68) {
        setPendingTaskCompletion(project, {
          microtaskId: active.id,
          milestoneId: 'ms-1',
          reason: `ready ${step}`,
          assessment: { performance: 'ready' },
        });
      } else if (roll < 0.78) {
        clearPendingTaskCompletion(project, active.id);
      } else if (roll < 0.9) {
        const result = advanceMicrotask(project, active.id, `completed ${step}`, {
          performance: `performance ${step}`,
        });
        expect(result.ok).toBe(true);
      } else {
        addEvaluation(project, {
          kind: 'task',
          microtaskId: active.id,
          milestoneId: 'ms-1',
          feedback: `Feedback ${step}`,
          score: 80,
        });
      }

      if (step % 7 === 0) {
        project = transitionProjectUiPhase(
          project,
          project.uiPhase === 'workspace' ? 'hero' : 'workspace',
        );
      }

      await drainProjectRuntime({
        stageId: STAGE_ID,
        sceneId: SCENE_ID,
        project,
        store,
        kv,
        learnerKey: LEARNER_KEY,
      });
      const records = await listRecords(store);
      const folded = foldPBLRuntime({ designTemplate: stripToDesignTemplate(project), records });
      expect(folded.diagnostics.gaps).toEqual([]);
      expect(folded.learnerState).toEqual(extractLearnerState(project));
    }
  });
});
