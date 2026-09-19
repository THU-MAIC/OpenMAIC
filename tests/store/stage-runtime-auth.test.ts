import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserRuntimeStore } from '@openmaic/storage';
import { HttpRuntimeStore } from '@openmaic/storage/runtime/http';
import type { AppDocument } from '@/lib/document-store';
import type { ChatSession } from '@/lib/types/chat';
import type { Scene, Stage } from '@/lib/types/stage';

const { documentBoundary, putScene } = vi.hoisted(() => {
  const documentBoundary = { value: undefined as AppDocument | undefined };
  const putScene = vi.fn(async (_stageId: string, scene: Scene) => {
    documentBoundary.value!.scenes = documentBoundary.value!.scenes.map((existing) =>
      existing.id === scene.id ? structuredClone(scene) : existing,
    );
  });
  return { documentBoundary, putScene };
});

// Only the document backend is replaced. The scheduler, split-save result,
// chat sync and HTTP error decoding all run their production implementations.
vi.mock('@/lib/document-store', () => ({
  mutateDocument: async (
    _stageId: string,
    callback: (document: AppDocument | undefined, store: { putScene: typeof putScene }) => unknown,
  ) => callback(documentBoundary.value, { putScene }),
  accessDocument: async () => ({ document: documentBoundary.value, readOnlyLegacy: false }),
  loadCurrentScene: async () => ({ sceneId: 'scene-auth' }),
}));

import { configureRuntimeStorage, resetRuntimeStorageForTests } from '@/lib/runtime/store';
import { loadChatSessions } from '@/lib/utils/chat-storage';
import {
  flushStageSave,
  snapshotPendingStageChangesForDeletion,
  useStageStore,
} from '@/lib/store/stage';

const stage: Stage = { id: 'stage-runtime-auth', name: 'Course', createdAt: 1, updatedAt: 1 };
const scene: Scene = {
  id: 'scene-auth',
  stageId: stage.id,
  type: 'slide',
  title: 'Original title',
  order: 0,
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-auth',
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
const chat: ChatSession = {
  id: 'chat-auth',
  type: 'qa',
  title: 'Question',
  status: 'idle',
  messages: [
    { id: 'question', role: 'user', parts: [{ type: 'text', text: 'Keep this question' }] },
  ],
  config: { agentIds: [] },
  toolCalls: [],
  pendingToolCalls: [],
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  // Leave IndexedDB's setImmediate work real while controlling autosave time.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('navigator', {
    locks: {
      request: async (...args: unknown[]) => (args.at(-1) as () => unknown)(),
    },
  });
  resetRuntimeStorageForTests();
  useStageStore.getState().clearStore();
  putScene.mockClear();
  documentBoundary.value = {
    stage: structuredClone(stage),
    scenes: [structuredClone(scene)],
    outline: { outlines: [], generationComplete: true, createdAt: 1, updatedAt: 1 },
  } as AppDocument;
  useStageStore.setState({
    stage: structuredClone(stage),
    scenes: [structuredClone(scene)],
    currentSceneId: scene.id,
    chats: [],
  });
});

afterEach(() => {
  useStageStore.getState().clearStore();
  resetRuntimeStorageForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('parks a real runtime HTTP 401, saves later document edits, and recovers on a fresh visit', async () => {
  let authenticationRefused = true;
  const backing = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
  const runtimeFetch = vi.fn<typeof fetch>(async (input, init) => {
    if (authenticationRefused) {
      return Response.json(
        { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        { status: 401 },
      );
    }
    const pathname = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === 'GET' && pathname.includes('/stages/')) {
      return Response.json(await backing.listSessions(stage.id, 'learner-auth'));
    }
    if (method === 'POST' && pathname === '/runtime/sessions') {
      return Response.json(await backing.createSession(body));
    }
    const match = /^\/runtime\/sessions\/([^/]+)(\/records)?$/.exec(pathname);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      if (method === 'GET' && match[2]) {
        return Response.json(await backing.listRecords(sessionId));
      }
      if (method === 'POST' && match[2]) {
        return Response.json(await backing.appendRecord(body));
      }
    }
    throw new Error(`Unexpected runtime request: ${method} ${pathname}`);
  });
  configureRuntimeStorage({
    store: new HttpRuntimeStore({ baseUrl: 'https://runtime.test', fetch: runtimeFetch }),
    learnerKey: () => 'learner-auth',
  });
  const baseline = useStageStore.getState().chatSnapshot;
  useStageStore.getState().setChats([chat]);
  await flushStageSave();

  expect(runtimeFetch).toHaveBeenCalledOnce();
  expect(useStageStore.getState().chatSnapshot).toBe(baseline);
  await vi.advanceTimersByTimeAsync(65_000);
  useStageStore.getState().setChats([{ ...chat, updatedAt: 2 }]);
  await vi.advanceTimersByTimeAsync(65_000);
  await flushStageSave();
  expect(runtimeFetch).toHaveBeenCalledOnce();
  expect(useStageStore.getState().chats).toEqual([{ ...chat, updatedAt: 2 }]);
  expect(snapshotPendingStageChangesForDeletion(stage.id)).toEqual([{ kind: 'chats' }]);

  useStageStore.getState().updateScene(scene.id, { title: 'Saved despite runtime refusal' });
  await vi.advanceTimersByTimeAsync(500);
  await flushStageSave();
  expect(putScene).toHaveBeenCalledOnce();
  expect(documentBoundary.value!.scenes[0].title).toBe('Saved despite runtime refusal');
  expect(runtimeFetch).toHaveBeenCalledOnce();
  expect(useStageStore.getState().chatSnapshot).toBe(baseline);
  expect(vi.getTimerCount()).toBe(0);

  authenticationRefused = false;
  useStageStore.getState().clearStore();
  await useStageStore.getState().loadFromStorage(stage.id);
  useStageStore.getState().setChats([chat]);
  await flushStageSave();

  expect(useStageStore.getState().chatSnapshot.sessions).toEqual([chat]);
  expect(await loadChatSessions(stage.id)).toEqual([chat]);
  expect(snapshotPendingStageChangesForDeletion(stage.id)).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
