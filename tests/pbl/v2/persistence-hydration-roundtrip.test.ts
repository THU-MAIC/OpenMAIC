import { BrowserRuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { extractLearnerState, stripToDesignTemplate } from '@/lib/pbl/v2/runtime/learner-state';
import type { Scene, Stage } from '@/lib/types/stage';
import { legacyPBLSceneFixture } from '@/tests/fixtures/pbl-v1-scene';

const LEARNER_KEY = 'anon:persistence-roundtrip';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function makeStage(id: string): Stage {
  return {
    id,
    name: `Persistence roundtrip ${id}`,
    createdAt: 1_786_032_000_000,
    updatedAt: 1_786_032_000_000,
  };
}

function makeProject(): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 'Persistence boundary project',
    description: 'Keep learner work outside the design document',
    proficiency: 'intermediate',
    language: 'en-US',
    tags: ['persistence'],
    status: 'active',
    roles: [{ id: 'instructor-1', type: 'instructor', name: 'Instructor' }],
    milestones: [
      {
        id: 'milestone-1',
        title: 'Build the prototype',
        status: 'active',
        order: 0,
        microtasks: [
          {
            id: 'microtask-1',
            title: 'Explain the design',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            completionReason: 'The learner submitted a concrete explanation.',
          },
          {
            id: 'microtask-2',
            title: 'Review the result',
            status: 'todo',
            assignee: 'user',
            hints: [],
            order: 1,
          },
        ],
      },
    ],
    submissions: [
      {
        id: 'submission-1',
        microtaskId: 'microtask-1',
        milestoneId: 'milestone-1',
        kind: 'text',
        content: 'The persisted learner submission.',
        createdAt: '2026-08-07T08:00:02.000Z',
      },
    ],
    evaluations: [],
    threads: [
      {
        agentId: 'instructor-1',
        messages: [
          {
            id: 'message-1',
            roleType: 'user',
            content: 'Here is my design explanation.',
            ts: '2026-08-07T08:00:01.000Z',
            microtaskId: 'microtask-1',
          },
          {
            id: 'message-2',
            agentId: 'instructor-1',
            roleType: 'instructor',
            content: 'That explanation is complete.',
            ts: '2026-08-07T08:00:03.000Z',
            microtaskId: 'microtask-1',
          },
        ],
      },
    ],
    engagementEvents: [],
    runtimeEvents: [],
    createdAt: '2026-08-07T08:00:00.000Z',
    updatedAt: '2026-08-07T08:00:03.000Z',
  };
}

function makePBLScene(stageId: string, sceneId: string, project: PBLProjectV2): Scene {
  return {
    id: sceneId,
    stageId,
    type: 'pbl',
    title: 'PBL project',
    order: 0,
    content: { type: 'pbl', projectV2: project },
    actions: [],
    createdAt: 1_786_032_000_000,
    updatedAt: 1_786_032_003_000,
  };
}

function pblProject(scene: Scene): PBLProjectV2 {
  if (scene.content.type !== 'pbl' || !scene.content.projectV2) {
    throw new Error(`expected scene ${scene.id} to contain PBL v2`);
  }
  return scene.content.projectV2;
}

async function createHarness(label: string) {
  const documentIndexedDB = new IDBFactory();
  const runtimeIndexedDB = new IDBFactory();
  vi.stubGlobal('indexedDB', new IDBFactory());

  const documentStoreModule = await import('@/lib/document-store');
  const runtimeStoreModule = await import('@/lib/runtime/store');
  const documentStore = documentStoreModule.getDocumentStore({
    indexedDB: documentIndexedDB,
    dbName: `pbl-persistence-roundtrip-documents-${label}`,
  });
  const runtimeStore = new BrowserRuntimeStore({
    indexedDB: runtimeIndexedDB,
    dbName: `pbl-persistence-roundtrip-runtime-${label}`,
  });

  documentStoreModule.configureDocumentStorage({ store: documentStore });
  runtimeStoreModule.configureRuntimeStorage({ store: runtimeStore });

  return { documentStore, runtimeStore };
}

beforeEach(() => {
  vi.resetModules();
  const localStorage = new MemoryStorage();
  localStorage.setItem('maic:device:runtime.learnerKey', JSON.stringify(LEARNER_KEY));
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PBL persistence boundary roundtrip', () => {
  it('saves a design template and restores learner state from the real runtime store', async () => {
    const stageId = 'stage-full-roundtrip';
    const sceneId = 'scene-full-roundtrip';
    const project = makeProject();
    const scene = makePBLScene(stageId, sceneId, project);
    const { documentStore, runtimeStore } = await createHarness('full');
    const { preparePBLScenesForDocumentPersistence } =
      await import('@/lib/pbl/v2/runtime/document-persistence');
    const { hydratePBLScenesFromRuntime } = await import('@/lib/pbl/v2/runtime/hydration');

    const persistedScenes = await preparePBLScenesForDocumentPersistence(stageId, [scene]);
    await documentStore.saveDocument({ stage: makeStage(stageId), scenes: persistedScenes });
    const reloaded = await documentStore.loadDocument(stageId);

    expect(reloaded).not.toBeNull();
    const storedProject = pblProject(reloaded!.scenes[0]!);
    expect(storedProject).toEqual(stripToDesignTemplate(project));
    expect(storedProject.threads[0]!.messages).toEqual([]);
    expect(storedProject.submissions).toEqual([]);
    expect(storedProject.milestones[0]!.microtasks[0]!.status).toBe('todo');

    const hydratedScenes = await hydratePBLScenesFromRuntime(stageId, reloaded!.scenes);
    const hydratedProject = pblProject(hydratedScenes[0]!);
    expect(extractLearnerState(hydratedProject)).toEqual(extractLearnerState(project));
    expect(hydratedProject.threads[0]!.messages).toEqual(project.threads[0]!.messages);
    expect(hydratedProject.submissions).toEqual(project.submissions);
    expect(hydratedProject.milestones[0]!.microtasks[0]!.status).toBe('completed');

    const sessions = await runtimeStore.listSessions(stageId, LEARNER_KEY);
    expect(sessions).toHaveLength(1);
    expect(await runtimeStore.listRecords(sessions[0]!.id, { sceneId })).not.toHaveLength(0);
  });

  it('round-trips learner state through the real incremental single-scene save path', async () => {
    const stageId = 'stage-incremental-roundtrip';
    const sceneId = 'scene-incremental-roundtrip';
    const stage = makeStage(stageId);
    const project = makeProject();
    const designScene = makePBLScene(stageId, sceneId, stripToDesignTemplate(project));
    const learnerScene = makePBLScene(stageId, sceneId, project);
    const untouchedLegacy = {
      ...structuredClone(legacyPBLSceneFixture),
      id: 'scene-incremental-legacy',
      stageId,
      order: 1,
    } as Scene;
    const { documentStore } = await createHarness('incremental');
    await documentStore.saveDocument({ stage, scenes: [designScene, untouchedLegacy] });

    const { saveStageDataIncremental } = await import('@/lib/utils/stage-storage');
    const { stageDeletionEpoch } = await import('@/lib/utils/deleted-stages');
    await saveStageDataIncremental(
      stageId,
      [{ kind: 'scene', sceneId }],
      {
        stage,
        scenes: [learnerScene, untouchedLegacy],
        currentSceneId: sceneId,
        chats: [],
        outline: { outlines: [], createdAt: 1, updatedAt: 1 },
      },
      stageDeletionEpoch(stageId),
    );

    const reloaded = await documentStore.loadDocument(stageId);
    expect(reloaded).not.toBeNull();
    expect(pblProject(reloaded!.scenes[0]!)).toEqual(stripToDesignTemplate(project));
    expect(reloaded!.scenes[1]).toEqual(untouchedLegacy);

    const { hydratePBLScenesFromRuntime } = await import('@/lib/pbl/v2/runtime/hydration');
    const hydrated = await hydratePBLScenesFromRuntime(stageId, reloaded!.scenes);
    expect(extractLearnerState(pblProject(hydrated[0]!))).toEqual(extractLearnerState(project));
    expect(hydrated[1]).toEqual(untouchedLegacy);
  });

  it('keeps legacy-only and damaged-hybrid scenes byte-identical end to end', async () => {
    const stageId = 'stage-legacy-hybrid-roundtrip';
    const legacyScene = {
      ...structuredClone(legacyPBLSceneFixture),
      id: 'scene-legacy-only',
      stageId,
      order: 0,
    } as Scene;
    const damagedHybrid = {
      ...structuredClone(legacyPBLSceneFixture),
      id: 'scene-damaged-hybrid',
      stageId,
      order: 1,
    } as Scene;
    if (damagedHybrid.content.type !== 'pbl') throw new Error('expected PBL scene');
    Reflect.set(damagedHybrid.content, 'projectV2', { title: 'damaged v2 bytes' });
    const originalBytes = [legacyScene, damagedHybrid].map((scene) => JSON.stringify(scene));
    const { documentStore, runtimeStore } = await createHarness('legacy-hybrid');
    const { preparePBLScenesForDocumentPersistence } =
      await import('@/lib/pbl/v2/runtime/document-persistence');
    const { hydratePBLScenesFromRuntime } = await import('@/lib/pbl/v2/runtime/hydration');

    const persistedScenes = await preparePBLScenesForDocumentPersistence(stageId, [
      legacyScene,
      damagedHybrid,
    ]);
    await documentStore.saveDocument({ stage: makeStage(stageId), scenes: persistedScenes });
    const reloaded = await documentStore.loadDocument(stageId);

    expect(reloaded).not.toBeNull();
    expect(reloaded!.scenes.map((scene) => JSON.stringify(scene))).toEqual(originalBytes);

    const hydrated = await hydratePBLScenesFromRuntime(stageId, reloaded!.scenes);
    expect(hydrated.map((scene) => JSON.stringify(scene))).toEqual(originalBytes);
    expect(await runtimeStore.listSessions(stageId, LEARNER_KEY)).toEqual([]);
  });
});
