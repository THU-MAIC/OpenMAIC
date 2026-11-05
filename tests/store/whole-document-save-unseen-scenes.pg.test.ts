// @vitest-environment jsdom

/**
 * A whole-document save replaces the stored scene list with the one this
 * browser holds, so a scene another writer added since this browser last synced
 * would be deleted by it. The real stage store, save scheduler, document
 * mutation path and PostgreSQL document store run here; only chats and the
 * device-local reading position, which have nothing to do with it, are faked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { DSL_VERSION } from '@openmaic/dsl';
import {
  PgDocumentStore,
  ensureDocumentSchema,
  type Queryable,
} from '@openmaic/storage/document/pg';

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
vi.mock('@/lib/document-store/current-scene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-store/current-scene')>()),
  saveCurrentScene: vi.fn().mockResolvedValue(undefined),
  loadCurrentScene: vi.fn().mockResolvedValue(null),
}));

import { configureDocumentStorage, resetDocumentStorageForTests } from '@/lib/document-store/store';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { flushStageSave, useStageStore } from '@/lib/store/stage';
import { forgetKnownScenes } from '@/lib/store/known-scenes';
import type { Scene, Stage } from '@/lib/types/stage';

const contractUrl = process.env.PG_CONTRACT_URL;

if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl) {
  throw new Error(
    'whole-document save: STORAGE_PG_CONTRACT_REQUIRED=1 requires PG_CONTRACT_URL; ' +
      'refusing to skip the PostgreSQL suite',
  );
}

const SCHEMA = `whole_doc_save_${process.pid}`;
let sequence = 0;

function sceneOf(stageId: string, id: string, order: number, title = id): Scene {
  return {
    id,
    stageId,
    type: 'slide',
    title,
    order,
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${id}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#000000'],
          fontColor: '#000000',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
  } as Scene;
}

describe.skipIf(!contractUrl)('a whole-document save and scenes this browser never saw', () => {
  let pool: Pool;
  let store: PgDocumentStore<Scene, Stage>;
  let stageId: string;

  /** A writer other than this browser: an agent tool or another tab. */
  const remoteWrite = (scene: Scene) => store.putScene(stageId, scene);
  const storedIds = async () =>
    (await store.loadDocument(stageId))!.scenes.map((scene) => scene.id).sort();

  /** This browser opens the course the way the classroom does. */
  async function openCourse() {
    await useStageStore.getState().loadFromStorage(stageId);
  }

  beforeAll(async () => {
    // A schema of its own: this suite shares its database with the others.
    const admin = new Pool({ connectionString: contractUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.end();
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${SCHEMA}` });
    await ensureDocumentSchema(pool as unknown as Queryable);
    store = new PgDocumentStore<Scene, Stage>(pool as unknown as Queryable, {
      withTransaction: async (body) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await body(client as unknown as Queryable);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    sequence += 1;
    stageId = `whole-doc-${process.pid}-${Date.now()}-${sequence}`;
    resetDocumentStorageForTests();
    configureDocumentStorage({ store });
    await store.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: stageId, name: 'Course', createdAt: 1, updatedAt: 1 } as Stage,
      scenes: [sceneOf(stageId, 'a', 0), sceneOf(stageId, 'b', 1), sceneOf(stageId, 'c', 2)],
      outline: { outlines: [], createdAt: 1, updatedAt: 1 },
    } as never);
  });

  afterEach(async () => {
    await flushStageSave().catch(() => undefined);
    useStageStore.getState().clearStore();
    await store.deleteDocument(stageId);
    resetDocumentStorageForTests();
    vi.restoreAllMocks();
  });

  it('keeps a scene an agent added after this browser loaded, when the user deletes a page', async () => {
    await openCourse();
    await remoteWrite(sceneOf(stageId, 'agent-new', 3));

    useStageStore.getState().deleteScene('b');
    await flushStageSave();

    expect(await storedIds()).toEqual(['a', 'agent-new', 'c']);
  });

  it('deletes the page the user deleted, and it stays deleted after a reload', async () => {
    await openCourse();

    useStageStore.getState().deleteScene('b');
    await flushStageSave();
    expect(await storedIds()).toEqual(['a', 'c']);

    useStageStore.getState().clearStore();
    await openCourse();
    expect(useStageStore.getState().scenes.map((scene) => scene.id)).toEqual(['a', 'c']);
    useStageStore.getState().updateScene('a', { title: 'edited' });
    useStageStore.getState().setOutlines([]);
    await flushStageSave();
    expect(await storedIds()).toEqual(['a', 'c']);
  });

  it('deletes a page added in this browser and removed again, when its add was saved', async () => {
    await openCourse();
    useStageStore.getState().addScene(sceneOf(stageId, 'local-new', 3));
    await flushStageSave();
    expect(await storedIds()).toContain('local-new');

    useStageStore.getState().deleteScene('local-new');
    await flushStageSave();

    expect(await storedIds()).toEqual(['a', 'b', 'c']);
  });

  it('deletes a page that reached this browser through a sync, as the sync writes it', async () => {
    await openCourse();
    await remoteWrite(sceneOf(stageId, 'agent-new', 3));
    useStageStore.setState((state) => ({
      scenes: [...state.scenes, sceneOf(stageId, 'agent-new', 3)],
    }));

    useStageStore.getState().deleteScene('agent-new');
    await flushStageSave();

    expect(await storedIds()).toEqual(['a', 'b', 'c']);
  });

  it('a reorder keeps the local order and puts the unseen scene after it', async () => {
    await openCourse();
    await remoteWrite(sceneOf(stageId, 'agent-new', 1));

    const [a, b, c] = useStageStore.getState().scenes;
    useStageStore.getState().setScenes([
      { ...c!, order: 0 },
      { ...a!, order: 1 },
      { ...b!, order: 2 },
    ]);
    await flushStageSave();

    const stored = (await store.loadDocument(stageId))!.scenes;
    expect(stored.map((scene) => scene.id)).toEqual(['c', 'a', 'b', 'agent-new']);
  });

  it('leaves the order of an unseen scene alone when nothing else holds it', async () => {
    await openCourse();
    await remoteWrite(sceneOf(stageId, 'agent-new', 5));

    useStageStore.getState().deleteScene('c');
    await flushStageSave();

    expect((await store.getScene(stageId, 'agent-new'))?.order).toBe(5);
  });

  it('moves unseen scenes that collide, past every scene and each other', async () => {
    await openCourse();
    await remoteWrite(sceneOf(stageId, 'agent-1', 1));
    await remoteWrite(sceneOf(stageId, 'agent-2', 9));
    await remoteWrite(sceneOf(stageId, 'agent-3', 9));

    useStageStore.getState().deleteScene('c');
    await flushStageSave();

    const stored = (await store.loadDocument(stageId))!.scenes;
    const orders = stored.map((scene) => scene.order);
    expect(new Set(orders).size).toBe(orders.length);
    expect(stored.find((scene) => scene.id === 'b')!.order).toBe(1);
    expect(stored.find((scene) => scene.id === 'agent-1')!.order).toBeGreaterThan(9);
    expect(orders).toContain(9);
  });

  it('keeps the content of the unseen scene as the agent wrote it', async () => {
    await openCourse();
    await remoteWrite(sceneOf(stageId, 'agent-new', 3, 'written by the agent'));

    useStageStore.getState().deleteScene('b');
    await flushStageSave();

    const stored = await store.getScene(stageId, 'agent-new');
    expect(stored?.title).toBe('written by the agent');
  });

  it('the aggregate save keeps an unseen scene too', async () => {
    await openCourse();
    await remoteWrite(sceneOf(stageId, 'agent-new', 3));

    await useStageStore.getState().saveToStorage();

    expect(await storedIds()).toEqual(['a', 'agent-new', 'b', 'c']);
  });

  it('a scene id used again after its removal counts as unseen', async () => {
    await openCourse();
    useStageStore.getState().deleteScene('b');
    await flushStageSave();
    expect(await storedIds()).toEqual(['a', 'c']);

    // An agent writes that id again. This browser has not read it.
    await remoteWrite(sceneOf(stageId, 'b', 5, 'written again'));
    useStageStore.getState().deleteScene('c');
    await flushStageSave();

    expect(await storedIds()).toEqual(['a', 'b']);
    expect((await store.getScene(stageId, 'b'))?.title).toBe('written again');
  });

  it('a scene the sync removed and an agent wrote again counts as unseen', async () => {
    await openCourse();
    await store.deleteScene(stageId, 'b');
    useStageStore.setState((state) => ({
      scenes: state.scenes.filter((scene) => scene.id !== 'b'),
    }));
    forgetKnownScenes(stageId, ['b']);

    await remoteWrite(sceneOf(stageId, 'b', 5, 'written again'));
    useStageStore.getState().deleteScene('c');
    await flushStageSave();

    expect(await storedIds()).toEqual(['a', 'b']);
  });

  it('a page deleted while the save of its add is on the wire is still deleted', async () => {
    await openCourse();
    useStageStore.getState().addScene(sceneOf(stageId, 'local-new', 3));
    const adding = flushStageSave();
    useStageStore.getState().deleteScene('local-new');
    await adding;
    await flushStageSave();

    expect(await storedIds()).toEqual(['a', 'b', 'c']);
  });

  it('a scene the sync brought in while a save was on the wire can be deleted', async () => {
    await openCourse();
    await remoteWrite(sceneOf(stageId, 'agent-new', 3));

    const realSave = store.saveDocument.bind(store);
    vi.spyOn(store, 'saveDocument').mockImplementationOnce(async (document) => {
      await realSave(document);
      // The save that kept it has landed but not settled; the sync takes it now.
      useStageStore.setState((state) => ({
        scenes: [...state.scenes, sceneOf(stageId, 'agent-new', 3)],
      }));
    });
    useStageStore.getState().deleteScene('b');
    await flushStageSave();
    expect(await storedIds()).toEqual(['a', 'agent-new', 'c']);

    useStageStore.getState().deleteScene('agent-new');
    await flushStageSave();

    expect(await storedIds()).toEqual(['a', 'c']);
  });

  it('a page restored while its deletion was on the wire can be deleted again', async () => {
    await openCourse();
    const pageB = useStageStore.getState().scenes.find((scene) => scene.id === 'b')!;

    const realSave = store.saveDocument.bind(store);
    vi.spyOn(store, 'saveDocument').mockImplementationOnce(async (document) => {
      await realSave(document);
      // The user undoes the deletion before the save settles.
      useStageStore.getState().setScenes([...useStageStore.getState().scenes, pageB]);
    });
    useStageStore.getState().deleteScene('b');
    await flushStageSave();
    await flushStageSave();
    expect(await storedIds()).toEqual(['a', 'b', 'c']);

    useStageStore.getState().deleteScene('b');
    await flushStageSave();

    expect(await storedIds()).toEqual(['a', 'c']);
  });

  it('a reload starts over: a scene removed while away and written again is unseen', async () => {
    await openCourse();
    useStageStore.getState().clearStore();
    await store.deleteScene(stageId, 'b');
    await openCourse();

    await remoteWrite(sceneOf(stageId, 'b', 5, 'written again'));
    useStageStore.getState().deleteScene('c');
    await flushStageSave();

    expect(await storedIds()).toEqual(['a', 'b']);
  });

  it('a scene another tab deleted comes back from a stale list, as it does today', async () => {
    await openCourse();
    await store.deleteScene(stageId, 'c');

    useStageStore.getState().deleteScene('b');
    await flushStageSave();

    // Not this change's to fix: the list still names it. Pinned so that a later
    // change to it is a decision rather than an accident.
    expect(await storedIds()).toEqual(['a', 'c']);
  });
});
