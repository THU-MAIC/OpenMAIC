// @vitest-environment jsdom

/**
 * A queued structural change makes the next flush a whole-document save, which
 * writes the store's scene list and DELETES every stored scene absent from it.
 * So the sync must keep bringing remote scenes into the store while that change
 * waits in the debounce, or the flush erases them. Runs the real store, the real
 * scheduler, the real `saveStageDataIncremental` and a real document store: only
 * the network edges (fetch, EventSource) and the locks around them are faked.
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const documents = vi.hoisted(() => ({
  store: null as unknown,
}));

vi.mock('@/lib/document-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-store')>()),
  mutateDocument: async (
    stageId: string,
    work: (document: unknown, store: unknown) => Promise<unknown>,
  ) => {
    const store = documents.store as { loadDocument(id: string): Promise<unknown> };
    return work(await store.loadDocument(stageId), store);
  },
  saveCurrentScene: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: async (_stageId: string, scenes: unknown[]) => scenes,
}));
vi.mock('@/lib/utils/chat-storage-lock', () => ({
  withRuntimeStorageSharedLock: (callback: () => unknown) => callback(),
  withRuntimeStorageExclusiveLockUntilSettled: (callback: () => unknown) => callback(),
}));
vi.mock('@/lib/utils/chat-storage', () => ({
  ChatStorageLockUnavailableError: class extends Error {},
  saveChatSessions: vi.fn().mockResolvedValue(undefined),
  loadChatSessions: vi.fn().mockResolvedValue([]),
  deleteChatSessions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/workbench/session-store', () => ({
  appendCompactedReplayEvent: vi.fn(),
  compactReplayEvents: vi.fn(),
  useWorkbenchStore: { getState: () => ({ panelOpen: true, playbackOn: false }) },
}));

import type { DocumentStore } from '@openmaic/storage';
import { DSL_VERSION } from '@openmaic/dsl';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { flushStageSave, useStageStore } from '@/lib/store/stage';
import { makeScene, type AppScene, type Scene, type Stage } from '@/lib/types/stage';
import { useStageFreshnessSync } from '@/lib/workbench/use-workbench-session';
import { inMemoryDocumentStore } from '@/tests/helpers/in-memory-document-store';

const STAGE: Stage = { id: 'stage-a', name: 'Course', createdAt: 1, updatedAt: 1 };

function scene(id: string, order: number, title: string): Scene {
  return makeScene(
    { id, stageId: STAGE.id, title, order },
    {
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
  );
}

let store: DocumentStore<AppScene, AppStage>;
/** The server's per-scene rev: it moves when what the scene row holds changes. */
const revs = new Map<string, { rev: number; held: string }>();
let stageRev = 1;

async function serverScenes(): Promise<AppScene[]> {
  const document = await store.loadDocument(STAGE.id);
  return [...(document?.scenes ?? [])];
}

async function manifest() {
  const scenes = await serverScenes();
  for (const row of scenes) {
    const held = JSON.stringify(row);
    const known = revs.get(row.id);
    if (!known) revs.set(row.id, { rev: 1, held });
    else if (known.held !== held) revs.set(row.id, { rev: known.rev + 1, held });
  }
  stageRev += 1;
  return {
    rev: stageRev,
    scenes: scenes.map(({ id, order }) => ({ id, order, rev: revs.get(id)!.rev })),
  };
}

/** Someone else (an agent) writes a scene row on the server. */
const agentWrites = (row: Scene) => store.putScene(STAGE.id, row as AppScene);

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, (() => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
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

function Harness() {
  useStageFreshnessSync(STAGE.id);
  return null;
}

let root: ReturnType<typeof createRoot> | null = null;
let manifestReads = 0;

async function waitForNextPass(source: MockEventSource) {
  const before = manifestReads;
  await act(async () => {
    source.emitFreshness();
    await vi.waitFor(() => expect(manifestReads).toBeGreaterThan(before));
    // The pass goes on to read scenes from the store and apply them.
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function openCourse() {
  const scenes = [scene('scene-1', 1, 'One'), scene('scene-2', 2, 'Two')];
  await store.saveDocument({
    dslVersion: DSL_VERSION,
    stage: STAGE as AppStage,
    scenes: scenes as AppScene[],
  } as Parameters<typeof store.saveDocument>[0]);
  useStageStore.setState({ stage: STAGE, scenes, currentSceneId: 'scene-1' });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(Harness)));
  await vi.waitFor(() => expect(manifestReads).toBe(1));
  const source = MockEventSource.instances[0]!;
  await waitForNextPass(source); // Verifies the true revs once.
  return source;
}

function storedTitles() {
  return useStageStore.getState().scenes.map((row) => row.title);
}

async function serverTitles() {
  return (await serverScenes()).sort((a, b) => a.order - b.order).map((row) => row.title);
}

beforeEach(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  store = inMemoryDocumentStore(`whole-document-${crypto.randomUUID()}`, new IDBFactory());
  documents.store = store;
  revs.clear();
  stageRev = 1;
  manifestReads = 0;
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/manifest')) {
        const body = await manifest();
        manifestReads += 1;
        return { ok: true, status: 200, json: async () => body };
      }
      if (url.includes('/scenes?')) {
        const ids = (new URL(url, 'http://test').searchParams.get('ids') ?? '').split(',');
        const scenes = (await serverScenes()).filter((row) => ids.includes(row.id));
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
  useStageStore.getState().clearStore();
  useStageStore.setState({ serverManifestByStage: {} });
  vi.unstubAllGlobals();
});

describe('a structural change waiting in the save debounce', () => {
  it('does not erase a scene an agent added meanwhile', async () => {
    const source = await openCourse();

    useStageStore.getState().insertSceneAfter('scene-2', scene('local-new', 3, 'Mine'));
    await agentWrites(scene('agent-new', 3, 'From the agent'));
    await waitForNextPass(source);
    await act(() => flushStageSave());

    expect(await serverTitles()).toEqual(['One', 'Two', 'Mine', 'From the agent']);
    expect(storedTitles()).toEqual(['One', 'Two', 'Mine', 'From the agent']);
  });

  it('does not revert a scene an agent changed meanwhile', async () => {
    const source = await openCourse();

    useStageStore.getState().deleteScene('scene-1');
    await agentWrites(scene('scene-2', 2, 'Agent filled this page'));
    await waitForNextPass(source);
    await act(() => flushStageSave());

    expect(await serverTitles()).toEqual(['Agent filled this page']);
    expect(storedTitles()).toEqual(['Agent filled this page']);
  });

  it('keeps the local deletion when an agent changed the deleted scene', async () => {
    const source = await openCourse();

    useStageStore.getState().deleteScene('scene-2');
    await agentWrites(scene('scene-2', 2, 'Agent filled this page'));
    await waitForNextPass(source);
    expect(storedTitles()).toEqual(['One']);
    await act(() => flushStageSave());

    expect(await serverTitles()).toEqual(['One']);
  });

  it('keeps the local order while taking remote content', async () => {
    const source = await openCourse();

    const [one, two] = useStageStore.getState().scenes;
    useStageStore.getState().setScenes([
      { ...two!, order: 1 },
      { ...one!, order: 2 },
    ]);
    await agentWrites(scene('scene-1', 1, 'Agent filled this page'));
    await waitForNextPass(source);
    expect(storedTitles()).toEqual(['Two', 'Agent filled this page']);
    await act(() => flushStageSave());

    expect(await serverTitles()).toEqual(['Two', 'Agent filled this page']);
  });

  it('keeps an unsaved edit of the scene itself', async () => {
    const source = await openCourse();

    useStageStore.getState().updateScene('scene-2', { title: 'Typed locally' });
    useStageStore.getState().insertSceneAfter('scene-2', scene('local-new', 3, 'Mine'));
    await agentWrites(scene('scene-2', 2, 'Agent wrote this'));
    await waitForNextPass(source);
    expect(storedTitles()).toEqual(['One', 'Typed locally', 'Mine']);
    await act(() => flushStageSave());

    expect(await serverTitles()).toEqual(['One', 'Typed locally', 'Mine']);
  });

  it('follows a remote removal of a scene with no edit, so the save does not restore it', async () => {
    const source = await openCourse();

    useStageStore.getState().insertSceneAfter('scene-2', scene('local-new', 3, 'Mine'));
    await store.deleteScene(STAGE.id, 'scene-1');
    await waitForNextPass(source);
    await act(() => flushStageSave());

    expect(await serverTitles()).toEqual(['Two', 'Mine']);
  });
});

describe('an outline change waiting in the save debounce', () => {
  it('does not erase a scene an agent added meanwhile', async () => {
    const source = await openCourse();

    useStageStore.getState().setOutlines([]);
    await agentWrites(scene('agent-new', 3, 'From the agent'));
    await waitForNextPass(source);
    await act(() => flushStageSave());

    expect(await serverTitles()).toEqual(['One', 'Two', 'From the agent']);
  });
});
