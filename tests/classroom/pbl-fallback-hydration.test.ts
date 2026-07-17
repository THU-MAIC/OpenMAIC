import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RuntimePayload,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
} from '@openmaic/dsl';
import type { KVScope, KVStore, RuntimeSessionInit, RuntimeStore } from '@openmaic/storage';

const { saveStageDataMock } = vi.hoisted(() => ({
  saveStageDataMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: (...args: unknown[]) => saveStageDataMock(...args),
  loadStageData: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: async (_stageId: string, scenes: Scene[]) => scenes,
}));
vi.mock('@/lib/utils/database', () => ({
  db: { stageOutlines: { put: vi.fn(), get: vi.fn() } },
}));

import type { PBLProjectConfig } from '@/lib/pbl/types';
import { transitionProjectUiPhase } from '@/lib/pbl/v2/operations/runtime-events';
import { drainProjectRuntime } from '@/lib/pbl/v2/runtime/drain';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import {
  applyHydratedClassroomFallbackScenes,
  hydrateClassroomFallbackScenes,
} from '@/lib/classroom/pbl-fallback-hydration';
import { claimStageSceneLoadToken, useStageStore } from '@/lib/store/stage';
import { makeScene, type Scene, type Stage } from '@/lib/types/stage';

const STAGE_ID = 'stage-1';
const SCENE_ID = 'scene-1';
const LEARNER_KEY = 'anon:test-device';

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

function makeProject(overrides: Partial<PBLProjectV2> = {}): PBLProjectV2 {
  return {
    uiPhase: 'hero',
    title: 'Fallback PBL project',
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

function makeStage(id = STAGE_ID): Stage {
  return {
    id,
    name: 'Fallback stage',
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  saveStageDataMock.mockClear();
  saveStageDataMock.mockResolvedValue(undefined);
  useStageStore.getState().clearStore();
});

afterEach(async () => {
  try {
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync();
      await vi.dynamicImportSettled();
      expect(vi.getTimerCount()).toBe(0);
    }
  } finally {
    if (vi.isFakeTimers()) {
      vi.useRealTimers();
    }
    useStageStore.getState().clearStore();
  }
});

describe('classroom server fallback PBL hydration', () => {
  it('hydrates runtime chats before committing a server fallback', async () => {
    const stage = makeStage('stage-chat-fallback');
    const serverScene = makePBLScene(makeProject());
    const token = claimStageSceneLoadToken();
    const chatState = {
      chats: [
        {
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
        },
      ],
      chatSnapshot: { sessions: [], restoreMarker: null },
    };
    const applyStageAndScenes = vi.fn();

    await expect(
      applyHydratedClassroomFallbackScenes({
        loadToken: token,
        stage,
        scenes: [serverScene],
        hydrateScenes: async () => [serverScene],
        hydrateChats: async () => chatState,
        applyStageAndScenes,
      }),
    ).resolves.toBe(true);

    expect(applyStageAndScenes).toHaveBeenCalledWith(stage, [serverScene], chatState);
  });

  it('applies fallback scenes under the navigation token that started the request', async () => {
    const stage = makeStage('stage-a');
    const serverScene = makePBLScene(makeProject());
    const token = claimStageSceneLoadToken();

    const applied = await applyHydratedClassroomFallbackScenes({
      loadToken: token,
      stage,
      scenes: [serverScene],
      hydrateScenes: async () => [serverScene],
      applyStageAndScenes: (nextStage, hydrated) => {
        useStageStore.getState().setStage(nextStage);
        useStageStore.setState({
          scenes: hydrated,
          currentSceneId: hydrated[0]?.id ?? null,
          mode: 'playback',
        });
      },
    });

    expect(applied).toBe(true);
    expect(useStageStore.getState().stage?.id).toBe('stage-a');
    expect(useStageStore.getState().scenes).toEqual([serverScene]);
  });

  it('does not apply fallback scenes after a newer stage request starts', async () => {
    const stageA = makeStage('stage-a');
    const stageB = makeStage('stage-b');
    const fallbackScene = makePBLScene(makeProject());
    const token = claimStageSceneLoadToken();
    let resolveHydration!: (scenes: Scene[]) => void;
    const hydrateScenes = vi.fn(
      () =>
        new Promise<Scene[]>((resolve) => {
          resolveHydration = resolve;
        }),
    );

    const applying = applyHydratedClassroomFallbackScenes({
      loadToken: token,
      stage: stageA,
      scenes: [fallbackScene],
      hydrateScenes,
      applyStageAndScenes: (stage, scenes) => {
        useStageStore.getState().setStage(stage);
        useStageStore.setState({
          scenes,
          currentSceneId: scenes[0]?.id ?? null,
          mode: 'playback',
        });
      },
    });
    await vi.waitFor(() => expect(hydrateScenes).toHaveBeenCalled());

    useStageStore.getState().setStage(stageB);
    resolveHydration([fallbackScene]);

    await expect(applying).resolves.toBe(false);
    expect(useStageStore.getState().stage?.id).toBe('stage-b');
    expect(useStageStore.getState().scenes).toEqual([]);
  });

  it('does not apply fallback scenes after the initiating effect is cancelled', async () => {
    const stage = makeStage('stage-a');
    const fallbackScene = makePBLScene(makeProject());
    const token = claimStageSceneLoadToken();
    let effectCurrent = true;
    let resolveHydration!: (scenes: Scene[]) => void;
    const hydrateScenes = vi.fn(
      () =>
        new Promise<Scene[]>((resolve) => {
          resolveHydration = resolve;
        }),
    );
    const applyStageAndScenes = vi.fn();

    const applying = applyHydratedClassroomFallbackScenes({
      loadToken: token,
      isCurrent: () => effectCurrent,
      stage,
      scenes: [fallbackScene],
      hydrateScenes,
      applyStageAndScenes,
    });
    await vi.waitFor(() => expect(hydrateScenes).toHaveBeenCalled());

    effectCurrent = false;
    resolveHydration([fallbackScene]);

    await expect(applying).resolves.toBe(false);
    expect(applyStageAndScenes).not.toHaveBeenCalled();
  });

  it('hydrates server-fallback scenes from existing runtime records', async () => {
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
    const serverFallbackScenes = [makePBLScene({ ...runtimeProject, runtimeEvents: [] })];

    const hydrated = await hydrateClassroomFallbackScenes(STAGE_ID, serverFallbackScenes, {
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });

    expect(hydrated[0]?.content.type).toBe('pbl');
    expect(hydrated[0]?.content.type === 'pbl' && hydrated[0].content.projectV2?.uiPhase).toBe(
      'workspace',
    );
  });

  it('does not persist a server fallback stage before its hydrated scenes are ready', async () => {
    vi.useFakeTimers();
    const stage = makeStage();
    const serverScene = makePBLScene(makeProject());
    const token = claimStageSceneLoadToken();
    let resolveHydration!: (scenes: Scene[]) => void;
    const hydrateScenes = vi.fn(
      () =>
        new Promise<Scene[]>((resolve) => {
          resolveHydration = resolve;
        }),
    );

    const applying = applyHydratedClassroomFallbackScenes({
      loadToken: token,
      stage,
      scenes: [serverScene],
      hydrateScenes,
      applyStageAndScenes: (nextStage, hydrated) => {
        useStageStore.getState().setStage(nextStage);
        useStageStore.setState({
          scenes: hydrated,
          currentSceneId: hydrated[0]?.id ?? null,
          mode: 'playback',
        });
      },
    });

    await vi.advanceTimersByTimeAsync(600);
    expect(saveStageDataMock).not.toHaveBeenCalled();
    expect(useStageStore.getState().stage).toBeNull();
    expect(useStageStore.getState().scenes).toEqual([]);

    resolveHydration([serverScene]);
    await applying;
    await vi.advanceTimersByTimeAsync(600);

    expect(saveStageDataMock).toHaveBeenCalledOnce();
    expect(saveStageDataMock).toHaveBeenCalledWith(
      STAGE_ID,
      expect.objectContaining({
        stage,
        scenes: [serverScene],
        currentSceneId: SCENE_ID,
      }),
    );
  });
});
