// @vitest-environment jsdom

/**
 * A stored PBL v2 scene is a design template: the learner's work lives in the
 * runtime store and is folded back in when the course loads. A freshness sync
 * reads that stored copy, so it has to fold it back in as well, or the learner's
 * work leaves the screen, and the next save records the empty state as the truth.
 * The real sync, stage store, save path, document store and runtime store run
 * here; only fetch and EventSource, the sync's way to the server, are faked.
 */
import { BrowserRuntimeStore, type DocumentStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  configureDocumentStorage,
  getDocumentStore,
  resetDocumentStorageForTests,
} from '@/lib/document-store/store';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { preparePBLScenesForDocumentPersistence } from '@/lib/pbl/v2/runtime/document-persistence';
import { stripToDesignTemplate } from '@/lib/pbl/v2/runtime/learner-state';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { configureRuntimeStorage, resetRuntimeStorageForTests } from '@/lib/runtime/config';
import { flushStageSave, useStageStore } from '@/lib/store/stage';
import type { AppScene, Scene, Stage } from '@/lib/types/stage';
import { useStageFreshnessSync } from '@/lib/workbench/use-workbench-session';
import { inMemoryDocumentStore } from '@/tests/helpers/in-memory-document-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STAGE = 'stage-pbl-sync';
const LEARNER_KEY = 'anon:pbl-sync';

function project(): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 'Project',
    description: 'Keep the learner work',
    proficiency: 'intermediate',
    language: 'en-US',
    tags: [],
    status: 'active',
    roles: [{ id: 'instructor-1', type: 'instructor', name: 'Instructor' }],
    milestones: [
      {
        id: 'milestone-1',
        title: 'Build',
        status: 'active',
        order: 0,
        microtasks: [
          {
            id: 'microtask-1',
            title: 'Explain',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            completionReason: 'Done.',
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
        content: 'The learner submission.',
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
            content: 'My explanation.',
            ts: '2026-08-07T08:00:01.000Z',
            microtaskId: 'microtask-1',
          },
        ],
      },
    ],
    engagementEvents: [],
    runtimeEvents: [],
    createdAt: '2026-08-07T08:00:00.000Z',
    updatedAt: '2026-08-07T08:00:03.000Z',
  } as unknown as PBLProjectV2;
}

function pblScene(projectV2: PBLProjectV2): Scene {
  return {
    id: 'pbl',
    stageId: STAGE,
    type: 'pbl',
    title: 'PBL',
    order: 1,
    content: { type: 'pbl', projectV2 },
    actions: [],
  } as Scene;
}

function slideScene(): Scene {
  return {
    id: 'slide',
    stageId: STAGE,
    type: 'slide',
    title: 'Slide',
    order: 0,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas',
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
  } as Scene;
}

function shownProject(): PBLProjectV2 {
  const scene = useStageStore.getState().scenes.find((candidate) => candidate.id === 'pbl')!;
  return (scene.content as { projectV2: PBLProjectV2 }).projectV2;
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, (() => void)[]>();
  constructor(_url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  close() {}
  emitFreshness() {
    for (const fn of this.listeners.get('stage_freshness') ?? []) fn();
  }
}

let documents: DocumentStore<AppScene, AppStage>;
let runtimeStore: BrowserRuntimeStore;
let root: ReturnType<typeof createRoot> | null = null;
let sceneRev = 1;
let manifestReads = 0;

function Harness() {
  useStageFreshnessSync(STAGE);
  return null;
}

/** The classroom loads the course; the sync starts, and verifies every scene once. */
async function openAndSync() {
  await useStageStore.getState().loadFromStorage(STAGE);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(Harness)));
  await vi.waitFor(() => expect(manifestReads).toBeGreaterThan(0));
  await syncPass();
}

async function syncPass() {
  const before = manifestReads;
  await act(async () => MockEventSource.instances.at(-1)!.emitFreshness());
  await vi.waitFor(() => expect(manifestReads).toBeGreaterThan(before));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

beforeEach(async () => {
  sceneRev = 1;
  manifestReads = 0;
  MockEventSource.instances = [];
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('EventSource', MockEventSource);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  localStorage.clear();
  resetDocumentStorageForTests();
  resetRuntimeStorageForTests();
  configureDocumentStorage({ store: inMemoryDocumentStore('pbl-sync-documents') });
  documents = getDocumentStore();
  runtimeStore = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: 'pbl-sync-runtime',
  });
  configureRuntimeStorage({ store: runtimeStore, learnerKey: () => LEARNER_KEY });

  // What a course with a learner's work looks like: the work in the runtime
  // store, and the template in the document.
  const persisted = await preparePBLScenesForDocumentPersistence(STAGE, [pblScene(project())]);
  await documents.saveDocument({
    stage: { id: STAGE, name: 'Course', createdAt: 1, updatedAt: 1 } as Stage,
    scenes: [slideScene(), ...persisted] as AppScene[],
    outline: { outlines: [], createdAt: 1, updatedAt: 1 },
  } as never);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/manifest')) {
        manifestReads += 1;
        const doc = await documents.loadDocument(STAGE);
        const body = {
          rev: sceneRev,
          scenes: doc!.scenes.map((scene) => ({ id: scene.id, order: scene.order, rev: sceneRev })),
        };
        return { ok: true, status: 200, json: async () => body };
      }
      if (url.includes('/scenes?')) {
        const ids = new URL(url, 'http://test').searchParams.get('ids')!.split(',');
        const doc = await documents.loadDocument(STAGE);
        const scenes = doc!.scenes.filter((scene) => ids.includes(scene.id));
        return { ok: true, status: 200, json: async () => ({ scenes }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  await flushStageSave().catch(() => undefined);
  useStageStore.getState().clearStore();
  useStageStore.setState({ serverManifestByStage: {} });
  resetDocumentStorageForTests();
  resetRuntimeStorageForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a freshness sync over a PBL v2 scene', () => {
  it('keeps the learner work on screen, with no save', async () => {
    await openAndSync();

    expect(shownProject().submissions).toHaveLength(1);
    expect(shownProject().uiPhase).toBe('workspace');
    expect(shownProject().threads[0]!.messages).toHaveLength(1);
    expect(shownProject().milestones[0]!.microtasks[0]!.status).toBe('completed');
  });

  it('keeps the learner work through a whole-document save and a reload', async () => {
    await openAndSync();

    useStageStore.getState().deleteScene('slide');
    await flushStageSave();
    await act(async () => root?.unmount());
    root = null;
    useStageStore.getState().clearStore();
    await useStageStore.getState().loadFromStorage(STAGE);

    expect(shownProject().submissions).toHaveLength(1);
    expect(shownProject().uiPhase).toBe('workspace');
    expect(shownProject().milestones[0]!.microtasks[0]!.status).toBe('completed');
  });

  it('takes an agent change to the design and keeps the learner work on it', async () => {
    await openAndSync();

    const stored = await documents.getScene(STAGE, 'pbl');
    await documents.putScene(STAGE, {
      ...stored!,
      content: {
        type: 'pbl',
        projectV2: { ...stripToDesignTemplate(project()), title: 'Renamed by the agent' },
      },
    } as AppScene);
    sceneRev += 1;
    await syncPass();

    expect(shownProject().title).toBe('Renamed by the agent');
    expect(shownProject().submissions).toHaveLength(1);
  });

  it('leaves the scene alone while the runtime store cannot be read, and takes it later', async () => {
    await openAndSync();
    const stored = await documents.getScene(STAGE, 'pbl');
    await documents.putScene(STAGE, {
      ...stored!,
      content: {
        type: 'pbl',
        projectV2: { ...stripToDesignTemplate(project()), title: 'Renamed by the agent' },
      },
    } as AppScene);
    sceneRev += 1;

    const failing = vi.spyOn(runtimeStore, 'listSessions').mockRejectedValue(new Error('down'));
    await syncPass();
    expect(shownProject().submissions).toHaveLength(1);
    expect(shownProject().title).toBe('Project');

    failing.mockRestore();
    await syncPass();
    expect(shownProject().title).toBe('Renamed by the agent');
    expect(shownProject().submissions).toHaveLength(1);
  });

  it('holds back only the scene whose fold failed, and retries it', async () => {
    await openAndSync();
    const stored = await documents.getScene(STAGE, 'pbl');
    await documents.putScene(STAGE, {
      ...stored!,
      content: {
        type: 'pbl',
        projectV2: { ...stripToDesignTemplate(project()), title: 'Renamed by the agent' },
      },
    } as AppScene);
    await documents.putScene(STAGE, { ...slideScene(), title: 'Changed' } as AppScene);
    sceneRev += 1;

    const failing = vi.spyOn(runtimeStore, 'listSessions').mockRejectedValue(new Error('down'));
    await syncPass();
    const slide = () => useStageStore.getState().scenes.find((scene) => scene.id === 'slide')!;
    expect(slide().title).toBe('Changed');
    expect(shownProject().title).toBe('Project');
    expect(shownProject().submissions).toHaveLength(1);

    failing.mockRestore();
    const reads = manifestReads;
    // The pass retries by itself, with no new signal.
    await vi.waitFor(() => expect(manifestReads).toBeGreaterThan(reads), { timeout: 5_000 });
    await vi.waitFor(() => expect(shownProject().title).toBe('Renamed by the agent'));
    expect(shownProject().submissions).toHaveLength(1);
  });

  it('applies other kinds of scene as they are', async () => {
    await openAndSync();
    await documents.putScene(STAGE, { ...slideScene(), title: 'Changed' } as AppScene);
    sceneRev += 1;
    await syncPass();

    const slide = useStageStore.getState().scenes.find((scene) => scene.id === 'slide')!;
    expect(slide.title).toBe('Changed');
  });
});
