import { DSL_VERSION } from '@openmaic/dsl';
import {
  BrowserDocumentStore,
  HttpDocumentStore,
  type DocumentStore,
  type KVScope,
  type KVStore,
} from '@openmaic/storage';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, test, vi } from 'vitest';

import {
  accessDocument,
  migrateDocumentForVerification,
  mutateDocument,
  type LegacyDocumentSnapshot,
  type LegacyDocumentStore,
} from '@/lib/document-store/migration';
import type { AppDocument } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';

// The migration layer compensates a discarded conversion's side effects
// through the converter's rollback helper; spy on it so tests can pin exactly
// which allocations a failed pass rolls back. (The real helper needs a real
// pool, which this suite does not provide; the converter suite owns it.) The
// suite's stand-in store lets a test converter perform REAL allocations --
// pool entries plus audio/media compatibility rows -- and asserts the failed
// pass actually cleans them up: the mocked helper mirrors the real one's
// semantics (removeAsset plus the two Dexie row deletions) against it.
const { rollbackSpy, allocationState } = vi.hoisted(() => ({
  rollbackSpy: vi.fn(),
  allocationState: {
    pool: new Set<string>(),
    audioRows: new Set<string>(),
    mediaRows: new Set<string>(),
  },
}));
vi.mock('@/lib/media/convert-legacy-asset-refs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/convert-legacy-asset-refs')>();
  return {
    ...actual,
    rollbackConvertedAllocations: (stageId: string, ids: readonly string[]): Promise<void> => {
      rollbackSpy(stageId, ids);
      for (const id of ids) {
        allocationState.pool.delete(id);
        allocationState.audioRows.delete(id);
        allocationState.mediaRows.delete(`${stageId}:${id}`);
      }
      return Promise.resolve();
    },
  };
});

class MemoryKv implements KVStore {
  readonly values = new Map<string, unknown>();
  failMarker = false;

  async get<T>(key: string, scope: KVScope = 'account'): Promise<T | null> {
    return (this.values.get(`${scope}:${key}`) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T, scope: KVScope = 'account'): Promise<void> {
    if (this.failMarker && key.startsWith('document-migration:')) throw new Error('marker failed');
    this.values.set(`${scope}:${key}`, structuredClone(value));
  }

  async remove(key: string, scope: KVScope = 'account'): Promise<void> {
    this.values.delete(`${scope}:${key}`);
  }

  async keys(prefix = '', scope: KVScope = 'account'): Promise<string[]> {
    const fullPrefix = `${scope}:${prefix}`;
    return [...this.values.keys()]
      .filter((key) => key.startsWith(fullPrefix))
      .map((key) => key.slice(scope.length + 1));
  }
}

function snapshot(name = 'Legacy'): LegacyDocumentSnapshot {
  return {
    stage: {
      id: 'stage-1',
      name,
      createdAt: 100,
      updatedAt: 200,
      currentSceneId: 'scene-1',
    },
    scenes: [
      {
        id: 'scene-1',
        stageId: 'stage-1',
        type: 'quiz',
        title: 'Scene',
        order: 0,
        content: { type: 'slide', canvas: { id: 'canvas-1', elements: [] } as never },
        whiteboard: [{ id: 'whiteboard-1', elements: [] } as never],
        createdAt: 100,
        updatedAt: 200,
      },
    ],
    outline: {
      stageId: 'stage-1',
      outlines: [],
      generationComplete: true,
      createdAt: 100,
      updatedAt: 200,
    },
  };
}

function legacy(value: LegacyDocumentSnapshot | null): LegacyDocumentStore {
  return {
    read: vi.fn().mockResolvedValue(value),
    listStages: vi.fn().mockResolvedValue(value ? [value.stage] : []),
  };
}

async function indexedLegacyStore(
  idb: IDBFactory,
  value: LegacyDocumentSnapshot,
): Promise<LegacyDocumentStore> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open('MAIC-Database', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('stages', { keyPath: 'id' });
      const scenes = request.result.createObjectStore('scenes', { keyPath: 'id' });
      scenes.createIndex('stageId', 'stageId');
      request.result.createObjectStore('stageOutlines', { keyPath: 'stageId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['stages', 'scenes', 'stageOutlines'], 'readwrite');
    tx.objectStore('stages').put(value.stage);
    for (const scene of value.scenes) tx.objectStore('scenes').put(scene);
    if (value.outline) tx.objectStore('stageOutlines').put(value.outline);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  const requestValue = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  return {
    async read(stageId) {
      const tx = database.transaction(['stages', 'scenes', 'stageOutlines'], 'readonly');
      const [stage, scenes, outline] = await Promise.all([
        requestValue(tx.objectStore('stages').get(stageId)),
        requestValue(tx.objectStore('scenes').index('stageId').getAll(stageId)),
        requestValue(tx.objectStore('stageOutlines').get(stageId)),
      ]);
      return stage
        ? {
            stage,
            scenes,
            outline,
          }
        : null;
    },
    async listStages() {
      const tx = database.transaction('stages', 'readonly');
      return requestValue(tx.objectStore('stages').getAll());
    },
  };
}

function lockManager(): LockManager {
  let tail = Promise.resolve();
  return {
    request: vi.fn((_name, _options, callback) => {
      const result = tail.then(() => callback({ name: _name, mode: 'exclusive' } as Lock));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }),
    query: vi.fn(),
  } as unknown as LockManager;
}

function store(idb = new IDBFactory()): DocumentStore<AppScene> {
  return new BrowserDocumentStore<AppScene>({
    indexedDB: idb,
    dbName: 'maic-documents',
    validateScene: () => ({ valid: true }),
  });
}

describe('legacy document migration', () => {
  test('keeps the opaque outline outside the migration verification baseline', () => {
    const outline = {
      outlines: [],
      generationComplete: true,
      createdAt: 100,
      updatedAt: 200,
    };
    const document: AppDocument = {
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Legacy', createdAt: 100, updatedAt: 200 },
      scenes: [],
      outline,
    };
    const migrateDsl = vi.fn((value: unknown) => {
      const candidate = value as AppDocument;
      return 'outline' in candidate
        ? { ...candidate, stage: { ...candidate.stage, name: 'Corrupted' } }
        : candidate;
    });

    const migrated = migrateDocumentForVerification(document, migrateDsl);

    expect(migrateDsl).toHaveBeenCalledOnce();
    expect(migrateDsl.mock.calls[0]![0]).not.toHaveProperty('outline');
    expect(migrated).toEqual(document);
    expect(migrated.outline).toBe(outline);
  });

  test('returns null when neither store has a document', async () => {
    await expect(
      accessDocument('missing', {
        store: store(),
        kv: new MemoryKv(),
        legacyStore: legacy(null),
        lockManager: lockManager(),
      }),
    ).resolves.toEqual({ document: null, readOnlyLegacy: false });
  });

  test('migrates, canonicalizes, verifies, and records device state', async () => {
    const idb = new IDBFactory();
    const documentStore = store(idb);
    const kv = new MemoryKv();
    const result = await accessDocument('stage-1', {
      store: documentStore,
      kv,
      legacyStore: await indexedLegacyStore(idb, snapshot()),
      lockManager: lockManager(),
    });

    expect(result.document).toMatchObject({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Legacy' },
      scenes: [{ id: 'scene-1', type: 'slide', whiteboards: [{ id: 'whiteboard-1' }] }],
      outline: { generationComplete: true },
    });
    expect(result.document!.stage).not.toHaveProperty('currentSceneId');
    expect(await kv.get('editor-current-scene:stage-1', 'device')).toMatchObject({
      sceneId: 'scene-1',
    });
    expect(await kv.get('document-migration:stage-1', 'device')).toMatchObject({
      sourceUpdatedAt: 200,
    });
  });

  test('uses the injected DSL migration to verify a fresh destination', async () => {
    const migrateDsl = vi.fn((value: unknown) => ({
      ...(value as AppDocument),
      dslVersion: DSL_VERSION,
    }));

    await expect(
      accessDocument('stage-1', {
        store: store(),
        kv: new MemoryKv(),
        legacyStore: legacy(snapshot()),
        lockManager: lockManager(),
        migrateDsl,
      }),
    ).resolves.toMatchObject({
      document: { dslVersion: DSL_VERSION, stage: { id: 'stage-1' } },
      readOnlyLegacy: false,
    });

    expect(migrateDsl).toHaveBeenCalledOnce();
    expect(migrateDsl.mock.calls[0]![0]).toMatchObject({ stage: { id: 'stage-1' } });
  });

  test('uses the injected DSL migration to verify an existing destination', async () => {
    const documentStore = store();
    const kv = new MemoryKv();
    const destination: AppDocument = {
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Migrated', createdAt: 100, updatedAt: 200 },
      scenes: [],
      outline: {
        outlines: [],
        generationComplete: true,
        createdAt: 100,
        updatedAt: 200,
      },
    };
    await documentStore.saveDocument(destination);
    const migrateDsl = vi.fn((value: unknown) => {
      const candidate = value as AppDocument;
      return {
        ...candidate,
        dslVersion: DSL_VERSION,
        stage: { ...candidate.stage, name: 'Migrated' },
        scenes: [],
      };
    });

    await expect(
      accessDocument('stage-1', {
        store: documentStore,
        kv,
        legacyStore: legacy(snapshot()),
        lockManager: lockManager(),
        migrateDsl,
      }),
    ).resolves.toMatchObject({ document: destination, readOnlyLegacy: false });

    expect(migrateDsl).toHaveBeenCalledOnce();
    expect(await kv.get('document-migration:stage-1', 'device')).toMatchObject({
      sourceUpdatedAt: 200,
    });
  });

  test('normalizes optional undefined members for an injected HTTP store', async () => {
    const source = snapshot();
    source.stage.description = undefined;
    source.scenes[0]!.content = {
      type: 'pbl',
      projectConfig: {},
      projectV2: {
        roles: [],
        milestones: [{ microtasks: [{ internalAssessment: undefined }] }],
        submissions: [],
        evaluations: [],
        threads: [],
        engagementEvents: [],
      },
    } as never;
    const kv = new MemoryKv();
    let persisted: AppDocument | null = null;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        persisted = JSON.parse(init.body as string) as AppDocument;
        return new Response(null, { status: 204 });
      }
      if (persisted) return Response.json(persisted);
      return Response.json(
        { error: { code: 'DOCUMENT_NOT_FOUND', message: 'missing' } },
        { status: 404 },
      );
    }) as typeof globalThis.fetch;
    const documentStore = new HttpDocumentStore<AppScene>({
      baseUrl: 'https://documents.test',
      fetch,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });

    const result = await accessDocument('stage-1', {
      store: documentStore,
      kv,
      legacyStore: legacy(source),
      lockManager: lockManager(),
    });

    expect(result.document?.stage).not.toHaveProperty('description');
    expect(
      (
        persisted!.scenes[0]!.content as unknown as {
          projectV2: { milestones: Array<{ microtasks: Array<Record<string, unknown>> }> };
        }
      ).projectV2.milestones[0]!.microtasks[0],
    ).not.toHaveProperty('internalAssessment');
    expect(await kv.get('document-migration:stage-1', 'device')).toMatchObject({
      sourceUpdatedAt: 200,
    });
  });

  test('exposes legacy read-only when Web Locks are unavailable', async () => {
    vi.stubGlobal('window', {});
    try {
      const result = await accessDocument('stage-1', {
        store: store(),
        legacyStore: legacy(snapshot()),
        lockManager: null,
      });
      expect(result).toMatchObject({
        readOnlyLegacy: true,
        legacyCurrentSceneId: 'scene-1',
        document: { stage: { name: 'Legacy' } },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('keeps a divergent destination authoritative without certifying the legacy snapshot', async () => {
    const documentStore = store();
    const kv = new MemoryKv();
    const legacyStore = legacy(snapshot('Legacy V2'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await documentStore.saveDocument({
      stage: { id: 'stage-1', name: 'Destination V1', createdAt: 1, updatedAt: 2 },
      scenes: [],
    });
    const result = await accessDocument('stage-1', {
      store: documentStore,
      kv,
      legacyStore,
      lockManager: lockManager(),
    });
    expect(result.document!.stage.name).toBe('Destination V1');
    expect(await kv.get('document-migration:stage-1', 'device')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stage stage-1'));
    await expect(legacyStore.read('stage-1')).resolves.toMatchObject({
      stage: { name: 'Legacy V2' },
    });
    warn.mockRestore();
  });

  test('fails loud for a future-versioned destination instead of falling back', async () => {
    const future = {
      stage: { id: 'stage-1', name: 'Future', createdAt: 1, updatedAt: 2 },
      scenes: [],
      dslVersion: '99.0.0',
    } as AppDocument;
    const futureStore = {
      loadDocument: vi.fn().mockResolvedValue(future),
    } as unknown as DocumentStore<AppScene>;
    await expect(
      accessDocument('stage-1', {
        store: futureStore,
        kv: new MemoryKv(),
        legacyStore: legacy(snapshot()),
        lockManager: lockManager(),
      }),
    ).rejects.toThrow('unsupported DSL version');
  });

  test('resumes metadata after destination commit when the marker write failed', async () => {
    const documentStore = store();
    const kv = new MemoryKv();
    kv.failMarker = true;
    const deps = {
      store: documentStore,
      kv,
      legacyStore: legacy(snapshot()),
      lockManager: lockManager(),
    };
    await expect(accessDocument('stage-1', deps)).rejects.toThrow('marker failed');
    expect(await documentStore.loadDocument('stage-1')).not.toBeNull();

    kv.failMarker = false;
    await expect(accessDocument('stage-1', deps)).resolves.toMatchObject({ readOnlyLegacy: false });
    expect(await kv.get('document-migration:stage-1', 'device')).not.toBeNull();
  });

  test('fails loud when post-write verification differs', async () => {
    const realStore = store();
    let loads = 0;
    const corruptingStore = new Proxy(realStore, {
      get(target, property) {
        if (property === 'loadDocument') {
          return async (stageId: string): Promise<AppDocument | null> => {
            const loaded = (await target.loadDocument(stageId)) as AppDocument | null;
            loads += 1;
            return loads > 1 && loaded
              ? { ...loaded, scenes: loaded.scenes.map((scene) => ({ ...scene, order: 99 })) }
              : loaded;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DocumentStore<AppScene>;
    await expect(
      accessDocument('stage-1', {
        store: corruptingStore,
        kv: new MemoryKv(),
        legacyStore: legacy(snapshot()),
        lockManager: lockManager(),
      }),
    ).rejects.toThrow('verification failed');
  });

  test('serializes concurrent migrations from two stores over one IndexedDB', async () => {
    const idb = new IDBFactory();
    const locks = lockManager();
    const source = legacy(snapshot());
    const kv = new MemoryKv();
    const [first, second] = await Promise.all([
      accessDocument('stage-1', { store: store(idb), kv, legacyStore: source, lockManager: locks }),
      accessDocument('stage-1', { store: store(idb), kv, legacyStore: source, lockManager: locks }),
    ]);
    expect(first.document).toEqual(second.document);
    expect(locks.request).toHaveBeenCalledTimes(2);
  });

  test('does not clobber a newer current-scene KV value', async () => {
    const kv = new MemoryKv();
    await kv.set(
      'editor-current-scene:stage-1',
      { sceneId: 'newer-scene', updatedAt: '2030-01-01T00:00:00.000Z' },
      'device',
    );
    await accessDocument('stage-1', {
      store: store(),
      kv,
      legacyStore: legacy(snapshot()),
      lockManager: lockManager(),
    });
    expect(await kv.get('editor-current-scene:stage-1', 'device')).toMatchObject({
      sceneId: 'newer-scene',
    });
  });

  test('converts legacy asset references on open and saves the rewrite back', async () => {
    const documentStore = store();
    await documentStore.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Migrated', createdAt: 100, updatedAt: 200 },
      scenes: [],
    });
    const convertAssetRefs = vi.fn(async (document: AppDocument) => ({
      ...document,
      stage: { ...document.stage, description: 'converted' },
    }));

    const result = await accessDocument('stage-1', {
      store: documentStore,
      kv: new MemoryKv(),
      legacyStore: legacy(null),
      lockManager: lockManager(),
      convertAssetRefs,
    });

    expect(convertAssetRefs).toHaveBeenCalledOnce();
    expect(result.document?.stage.description).toBe('converted');
    // The converted document was persisted: a later raw load sees the rewrite.
    expect((await documentStore.loadDocument('stage-1'))?.stage.description).toBe('converted');
  });

  test('pays no write when the converter returns the document by identity', async () => {
    const realStore = store();
    let saves = 0;
    const countingStore = new Proxy(realStore, {
      get(target, property) {
        if (property === 'saveDocument') {
          return async (document: AppDocument): Promise<void> => {
            saves += 1;
            return target.saveDocument(document);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DocumentStore<AppScene>;
    await realStore.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Migrated', createdAt: 100, updatedAt: 200 },
      scenes: [],
    });
    saves = 0;

    const result = await accessDocument('stage-1', {
      store: countingStore,
      kv: new MemoryKv(),
      legacyStore: legacy(null),
      lockManager: lockManager(),
      convertAssetRefs: (document) => Promise.resolve(document),
    });

    expect(result.document?.stage.name).toBe('Migrated');
    expect(saves).toBe(0);
  });

  test('converts a canonicalized legacy snapshot before its first save', async () => {
    const documentStore = store();
    const kv = new MemoryKv();
    const convertAssetRefs = vi.fn(async (document: AppDocument) => ({
      ...document,
      stage: { ...document.stage, description: 'converted-at-birth' },
    }));

    const result = await accessDocument('stage-1', {
      store: documentStore,
      kv,
      legacyStore: legacy(snapshot()),
      lockManager: lockManager(),
      convertAssetRefs,
    });

    expect(convertAssetRefs).toHaveBeenCalledOnce();
    expect(result.document?.stage.description).toBe('converted-at-birth');
    expect((await documentStore.loadDocument('stage-1'))?.stage.description).toBe(
      'converted-at-birth',
    );
    // The migration metadata still settles against the converted destination.
    expect(await kv.get('document-migration:stage-1', 'device')).toMatchObject({
      sourceUpdatedAt: 200,
    });
  });

  test('a converter failure does not break loading the document', async () => {
    const documentStore = store();
    await documentStore.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Migrated', createdAt: 100, updatedAt: 200 },
      scenes: [],
    });

    const result = await accessDocument('stage-1', {
      store: documentStore,
      kv: new MemoryKv(),
      legacyStore: legacy(null),
      lockManager: lockManager(),
      convertAssetRefs: () => Promise.reject(new Error('pool unavailable')),
    });

    expect(result.document?.stage.name).toBe('Migrated');
    expect((await documentStore.loadDocument('stage-1'))?.stage).not.toHaveProperty('description');
  });

  test('a save-back failure returns the unconverted document and retries on the next open', async () => {
    // Quota pressure or a transient write error must not fail the read, but
    // the failed save also means durable storage still holds the legacy
    // references: acting as if conversion never happened returns the
    // unconverted document, so the next open retries cleanly instead of
    // accumulating orphaned allocations.
    const realStore = store();
    await realStore.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Migrated', createdAt: 100, updatedAt: 200 },
      scenes: [],
    });
    let writes = 0;
    const flakyStore = new Proxy(realStore, {
      get(target, property) {
        if (property === 'saveDocument') {
          return (document: AppDocument) => {
            writes += 1;
            if (writes === 1) return Promise.reject(new Error('quota exceeded'));
            return target.saveDocument(document);
          };
        }
        return Reflect.get(target, property);
      },
    });
    const kv = new MemoryKv();
    const convert = (doc: AppDocument): Promise<AppDocument> =>
      Promise.resolve({
        ...doc,
        stage: { ...doc.stage, name: 'converted' },
      });

    const first = await accessDocument('stage-1', {
      store: flakyStore,
      kv,
      legacyStore: legacy(null),
      lockManager: lockManager(),
      convertAssetRefs: convert,
    });
    // The failed write is treated as if conversion never happened: the opened
    // document is the unconverted one, not the converted rewrite.
    expect(first.document?.stage.name).toBe('Migrated');
    // Nothing persisted from the failed write.
    expect((await realStore.loadDocument('stage-1'))?.stage.name).toBe('Migrated');

    const second = await accessDocument('stage-1', {
      store: flakyStore,
      kv,
      legacyStore: legacy(null),
      lockManager: lockManager(),
      convertAssetRefs: convert,
    });
    expect(second.document?.stage.name).toBe('converted');
    expect((await realStore.loadDocument('stage-1'))?.stage.name).toBe('converted');
  });

  test("a save-back failure rolls back the converter's real allocations and compatibility rows", async () => {
    // Finding: the test converter must do REAL work -- allocate pool entries
    // and write audio/media compatibility rows -- or a failed save-back could
    // leak the fresh ids while durable storage still holds the legacy
    // references, letting repeated opens accumulate orphaned assets. A failed
    // save must roll the pass ledger back (pool entries and mirror rows) and
    // return the unconverted document; the next open then retries cleanly.
    const realStore = store();
    await realStore.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Migrated', createdAt: 100, updatedAt: 200 },
      scenes: [],
    });
    let writes = 0;
    const flakyStore = new Proxy(realStore, {
      get(target, property) {
        if (property === 'saveDocument') {
          return (document: AppDocument) => {
            writes += 1;
            if (writes === 1) return Promise.reject(new Error('quota exceeded'));
            return target.saveDocument(document);
          };
        }
        return Reflect.get(target, property);
      },
    });
    allocationState.pool.clear();
    allocationState.audioRows.clear();
    allocationState.mediaRows.clear();
    rollbackSpy.mockClear();
    let calls = 0;
    const convert = (doc: AppDocument, ledger?: string[]): Promise<AppDocument> => {
      calls += 1;
      // A genuine conversion pass: one pool entry per allocated id, one audio
      // compatibility row and one media compatibility row keyed by it, all
      // recorded on the caller's ledger for rollback.
      const id = `ast_saveback_${calls}`;
      allocationState.pool.add(id);
      allocationState.audioRows.add(id);
      allocationState.mediaRows.add(`stage-1:${id}`);
      ledger?.push(id);
      const baseScene = doc.scenes[0] ?? {
        id: 'scene-1',
        stageId: 'stage-1',
        type: 'slide',
        title: 'Scene',
        order: 0,
        content: { type: 'slide', canvas: { id: 'canvas-1', elements: [] } } as never,
        whiteboard: [{ id: 'whiteboard-1', elements: [] }] as never,
        createdAt: 100,
        updatedAt: 200,
      };
      const scenes = [
        {
          ...baseScene,
          actions: [
            ...(baseScene.actions ?? []),
            { id: 'a1', type: 'speech' as const, text: 'Hi', audioId: id },
          ],
        },
      ];
      return Promise.resolve({
        ...doc,
        stage: { ...doc.stage, name: 'converted', description: 'converted' },
        scenes,
      });
    };

    const first = await accessDocument('stage-1', {
      store: flakyStore,
      kv: new MemoryKv(),
      legacyStore: legacy(null),
      lockManager: lockManager(),
      convertAssetRefs: convert,
    });

    // The failed write is treated as if conversion never happened: the opened
    // document is the unconverted one, and every fresh allocation -- pool
    // entry and both compatibility rows -- was rolled back, not leaked.
    expect(first.document?.stage.name).toBe('Migrated');
    expect(first.document?.stage).not.toHaveProperty('description');
    expect(allocationState.pool.size).toBe(0);
    expect(allocationState.audioRows.size).toBe(0);
    expect(allocationState.mediaRows.size).toBe(0);
    expect(rollbackSpy).toHaveBeenCalledWith('stage-1', ['ast_saveback_1']);
    // Nothing persisted from the failed write.
    expect((await realStore.loadDocument('stage-1'))?.stage.name).toBe('Migrated');

    // The next open retries cleanly: the pass allocates again, the save-back
    // succeeds, and the conversion's own reference keeps the allocation alive
    // (only failure rolls it back).
    const second = await accessDocument('stage-1', {
      store: flakyStore,
      kv: new MemoryKv(),
      legacyStore: legacy(null),
      lockManager: lockManager(),
      convertAssetRefs: convert,
    });
    expect(calls).toBe(2);
    expect(second.document?.stage.name).toBe('converted');
    expect((await realStore.loadDocument('stage-1'))?.stage.name).toBe('converted');
    expect(allocationState.pool.has('ast_saveback_2')).toBe(true);
    expect(allocationState.audioRows.has('ast_saveback_2')).toBe(true);
    expect(allocationState.mediaRows.has('stage-1:ast_saveback_2')).toBe(true);
  });

  test('a concurrent write during conversion is reconciled, not overwritten', async () => {
    // The conversion window can span seconds of URL probing; another browser
    // writing in that window must not have its edit clobbered by the stale
    // conversion save. The save path reloads, converts the fresh document,
    // and returns that.
    const realStore = store();
    await realStore.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Migrated', createdAt: 100, updatedAt: 200 },
      scenes: [],
    });
    let loads = 0;
    const racingStore = new Proxy(realStore, {
      get(target, property) {
        if (property === 'loadDocument') {
          return async (id: string) => {
            loads += 1;
            const doc = await target.loadDocument(id);
            if (loads === 2 && doc) {
              // A concurrent editor renamed the stage while conversion ran.
              return { ...doc, stage: { ...doc.stage, name: 'concurrent edit' } };
            }
            return doc;
          };
        }
        return Reflect.get(target, property);
      },
    });
    const convert = (doc: AppDocument): Promise<AppDocument> =>
      Promise.resolve({ ...doc, stage: { ...doc.stage, description: 'converted' } });

    const result = await accessDocument('stage-1', {
      store: racingStore,
      kv: new MemoryKv(),
      legacyStore: legacy(null),
      lockManager: lockManager(),
      convertAssetRefs: convert,
    });

    // The opened document is the reconciled one: the concurrent edit survives
    // and the conversion applies on top of it.
    expect(result.document?.stage.name).toBe('concurrent edit');
    expect(result.document?.stage.description).toBe('converted');
    const persisted = await realStore.loadDocument('stage-1');
    expect(persisted?.stage.name).toBe('concurrent edit');
    expect(persisted?.stage.description).toBe('converted');
  });

  test('a concurrent deletion during conversion is honored, not resurrected', async () => {
    // The reload finds the document gone: saving the stale converted
    // snapshot would recreate a wiped classroom, so the save is skipped and
    // the load observes the deletion.
    const realStore = store();
    await realStore.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Migrated', createdAt: 100, updatedAt: 200 },
      scenes: [],
    });
    let loads = 0;
    const deletingStore = new Proxy(realStore, {
      get(target, property) {
        if (property === 'loadDocument') {
          return async (id: string) => {
            loads += 1;
            if (loads === 2) return null; // deleted while conversion ran
            return target.loadDocument(id);
          };
        }
        return Reflect.get(target, property);
      },
    });
    const convert = (doc: AppDocument): Promise<AppDocument> =>
      Promise.resolve({ ...doc, stage: { ...doc.stage, description: 'converted' } });

    const result = await accessDocument('stage-1', {
      store: deletingStore,
      kv: new MemoryKv(),
      legacyStore: legacy(null),
      lockManager: lockManager(),
      convertAssetRefs: convert,
    });

    expect(result.document).toBeNull();
    // Nothing was saved back: the persisted document is the original,
    // untouched by the conversion that was about to overwrite it.
    const persisted = await realStore.loadDocument('stage-1');
    expect(persisted?.stage.name).toBe('Migrated');
    expect(persisted?.stage).not.toHaveProperty('description');
  });

  test('rolls back the reconciliation pass through the shared ledger when its save fails', async () => {
    // Finding: the reconciliation conversion (a concurrent edit detected
    // during save) must share the caller's allocation ledger. If its save
    // fails, its fresh allocations are untracked and can never be cleaned
    // up. The ledger must carry them so the pass's cleanup compensates them.
    // The failed save also returns the AUTHORITATIVE RELOADED document
    // (unconverted), never the stale pre-concurrency snapshot: the concurrent
    // edit is durable and must not be hidden from the caller.
    const realStore = store();
    await realStore.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Migrated', createdAt: 100, updatedAt: 200 },
      scenes: [],
    });
    let loads = 0;
    const racingStore = new Proxy(realStore, {
      get(target, property) {
        if (property === 'loadDocument') {
          return async (id: string) => {
            loads += 1;
            const doc = await target.loadDocument(id);
            if (loads === 2 && doc) {
              // A concurrent editor renamed the stage while conversion ran.
              // The edit's own save already landed durably before the
              // conversion's save-back was attempted.
              const concurrent = { ...doc, stage: { ...doc.stage, name: 'concurrent edit' } };
              await target.saveDocument(concurrent);
              return concurrent;
            }
            return doc;
          };
        }
        if (property === 'saveDocument') {
          return async (doc: AppDocument) => {
            // The concurrent editor's own save lands; the conversion
            // save-back (which applies a 'converted' description) always
            // fails, exactly like a quota rejection after the reload.
            const stageMeta = doc.stage as { name?: string; description?: string };
            if (stageMeta.name === 'concurrent edit' && !stageMeta.description) {
              return target.saveDocument(doc);
            }
            throw new Error('quota exceeded');
          };
        }
        return Reflect.get(target, property);
      },
    });
    rollbackSpy.mockClear();
    let calls = 0;
    const convert = (doc: AppDocument, ledger?: string[]): Promise<AppDocument> => {
      calls += 1;
      ledger?.push(calls === 1 ? 'ast_first' : 'ast_reconciled');
      return Promise.resolve({ ...doc, stage: { ...doc.stage, description: 'converted' } });
    };

    const result = await accessDocument('stage-1', {
      store: racingStore,
      kv: new MemoryKv(),
      legacyStore: legacy(null),
      lockManager: lockManager(),
      convertAssetRefs: convert,
    });

    // The save failed, so the opened document is the authoritative reloaded
    // document -- the concurrent edit, unconverted -- never the first pass's
    // conversion, whose allocations were rolled back.
    expect(result.document?.stage.name).toBe('concurrent edit');
    expect(result.document?.stage).not.toHaveProperty('description');
    expect(calls).toBe(2);
    // The concurrent edit is durable; the failed conversion left no trace.
    const persisted = await realStore.loadDocument('stage-1');
    expect(persisted?.stage.name).toBe('concurrent edit');
    expect(persisted?.stage).not.toHaveProperty('description');
    // Cleanup compensated BOTH passes' allocations: the first pass's and the
    // reconciliation's fresh ids.
    const rolledBackIds = rollbackSpy.mock.calls.flatMap((args) => args[1] as string[]);
    expect(rolledBackIds).toContain('ast_first');
    expect(rolledBackIds).toContain('ast_reconciled');
  });

  test('a wholesale replacement skips eager conversion of the replaced document', async () => {
    // Finding: mutateDocument eagerly converts the existing document before
    // every mutation callback, including wholesale replacements (import,
    // backup restore). Assets allocated for content the callback immediately
    // replaces would be orphaned by the very save that lands next.
    const documentStore = store();
    await documentStore.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Pre-existing', createdAt: 100, updatedAt: 200 },
      scenes: [],
    });
    const convertAssetRefs = vi.fn(async (document: AppDocument) => ({
      ...document,
      stage: { ...document.stage, description: 'eagerly converted' },
    }));
    const replacement: AppDocument = {
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Restored', createdAt: 300, updatedAt: 400 },
      scenes: [],
    };
    let seenExisting: AppDocument | null | undefined;
    const deps = {
      store: documentStore,
      kv: new MemoryKv(),
      legacyStore: legacy(null),
      lockManager: lockManager(),
      convertAssetRefs,
    };

    const result = await mutateDocument(
      'stage-1',
      async (existing, store) => {
        seenExisting = existing;
        await store.saveDocument(replacement);
        return 'committed';
      },
      deps,
      { mode: 'replace' },
    );

    expect(result).toBe('committed');
    // The eager conversion never ran, and the callback owned the whole
    // aggregate instead of receiving the converted current document.
    expect(convertAssetRefs).not.toHaveBeenCalled();
    expect(seenExisting).toBeNull();
    const persisted = await documentStore.loadDocument('stage-1');
    expect(persisted?.stage.name).toBe('Restored');
    expect(persisted?.stage).not.toHaveProperty('description');
  });

  test('cleanup keeps a manifest-only ref allocation while rolling back truly unreferenced ones', async () => {
    // Finding: cleanup computed orphans from the renderable `referenced`
    // set, which excludes videoManifest keys. A ref that appears ONLY as a
    // videoManifest key was converted and saved, then cleanup rolled its
    // pool entry + mirror back while the persisted manifest still names it.
    const documentStore = store();
    await documentStore.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Migrated', createdAt: 100, updatedAt: 200 },
      scenes: [],
    });
    allocationState.pool.clear();
    allocationState.audioRows.clear();
    allocationState.mediaRows.clear();
    rollbackSpy.mockClear();
    const convert = (doc: AppDocument, ledger?: string[]): Promise<AppDocument> => {
      const manifestOnly = 'ast_manifest_only';
      const unreferenced = 'ast_truly_unreferenced';
      for (const id of [manifestOnly, unreferenced]) {
        allocationState.pool.add(id);
        allocationState.audioRows.add(id);
        allocationState.mediaRows.add(`stage-1:${id}`);
        ledger?.push(id);
      }
      return Promise.resolve({
        ...doc,
        stage: {
          ...doc.stage,
          name: 'converted',
          // The manifest-only id appears ONLY as a videoManifest key: no
          // slide or action names it, so the renderable `referenced` set
          // excludes it.
          videoManifest: { [manifestOnly]: { type: 'video', prompt: 'a video' } },
        },
      });
    };

    const result = await accessDocument('stage-1', {
      store: documentStore,
      kv: new MemoryKv(),
      legacyStore: legacy(null),
      lockManager: lockManager(),
      convertAssetRefs: convert,
    });

    expect(result.document?.stage.name).toBe('converted');
    // The manifest-only id survived cleanup: the persisted manifest still
    // owns it, so its pool entry and both compatibility rows are intact.
    expect(allocationState.pool.has('ast_manifest_only')).toBe(true);
    expect(allocationState.audioRows.has('ast_manifest_only')).toBe(true);
    expect(allocationState.mediaRows.has('stage-1:ast_manifest_only')).toBe(true);
    // The truly unreferenced id was rolled back, and only it.
    expect(allocationState.pool.has('ast_truly_unreferenced')).toBe(false);
    expect(rollbackSpy).toHaveBeenCalledWith('stage-1', ['ast_truly_unreferenced']);
    expect(rollbackSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['ast_manifest_only']),
    );
  });

  test('a generation fence firing mid-save rolls back the pass allocations and stays fatal', async () => {
    // Finding: the save-back's generation fence sat BEFORE the rollback
    // scope, so a cross-realm clearDatabase landing between the fence read
    // and the save stranded the pass's allocations: the fence error
    // propagated and cleanup never ran. The fence must stay fatal (it is a
    // cross-tab write race, not a persistence hiccup) but must roll the
    // ledger back first.
    const documentStore = store();
    await documentStore.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Migrated', createdAt: 100, updatedAt: 200 },
      scenes: [],
    });
    allocationState.pool.clear();
    allocationState.audioRows.clear();
    allocationState.mediaRows.clear();
    rollbackSpy.mockClear();
    let calls = 0;
    const convert = (doc: AppDocument, ledger?: string[]): Promise<AppDocument> => {
      calls += 1;
      const id = `ast_fence_${calls}`;
      allocationState.pool.add(id);
      allocationState.audioRows.add(id);
      allocationState.mediaRows.add(`stage-1:${id}`);
      ledger?.push(id);
      return Promise.resolve({ ...doc, stage: { ...doc.stage, description: 'converted' } });
    };

    await expect(
      accessDocument('stage-1', {
        store: documentStore,
        kv: new GenerationFlipsOnFenceKv(),
        legacyStore: legacy(null),
        lockManager: lockManager(),
        convertAssetRefs: convert,
      }),
    ).rejects.toThrow('storage was cleared during the mutation');

    // The fatal fence error did not strand the pass's side effects: pool
    // entry and both compatibility rows are gone.
    expect(allocationState.pool.size).toBe(0);
    expect(allocationState.audioRows.size).toBe(0);
    expect(allocationState.mediaRows.size).toBe(0);
    expect(rollbackSpy).toHaveBeenCalledWith('stage-1', ['ast_fence_1']);
    // Nothing persisted from the fenced save.
    expect((await documentStore.loadDocument('stage-1'))?.stage).not.toHaveProperty('description');
  });

  test('a birth-path save whose document vanishes rolls back the pass allocations', async () => {
    // Finding: the birth path's lost-document throw (the save landed but the
    // post-save reload observed a concurrent deletion) skipped cleanup, so
    // the pass's fresh allocations stranded even though nothing durable
    // references them.
    const realStore = store();
    const vanishingStore = new Proxy(realStore, {
      get(target, property) {
        if (property === 'saveDocument') {
          return async (doc: AppDocument): Promise<void> => {
            await target.saveDocument(doc);
            // A concurrent deletion wipes the document between the save and
            // the post-save reload, so the reload observes nothing.
            await target.deleteDocument('stage-1');
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    allocationState.pool.clear();
    allocationState.audioRows.clear();
    allocationState.mediaRows.clear();
    rollbackSpy.mockClear();
    let calls = 0;
    const convert = (doc: AppDocument, ledger?: string[]): Promise<AppDocument> => {
      calls += 1;
      const id = `ast_birth_${calls}`;
      allocationState.pool.add(id);
      allocationState.audioRows.add(id);
      allocationState.mediaRows.add(`stage-1:${id}`);
      ledger?.push(id);
      return Promise.resolve({ ...doc, stage: { ...doc.stage, name: 'converted' } });
    };

    await expect(
      accessDocument('stage-1', {
        store: vanishingStore,
        kv: new MemoryKv(),
        legacyStore: legacy(snapshot()),
        lockManager: lockManager(),
        convertAssetRefs: convert,
      }),
    ).rejects.toThrow('Legacy migration lost document');

    // The vanished document owned nothing, so every fresh allocation was
    // rolled back instead of stranding.
    expect(allocationState.pool.size).toBe(0);
    expect(allocationState.audioRows.size).toBe(0);
    expect(allocationState.mediaRows.size).toBe(0);
    const rolledBackIds = rollbackSpy.mock.calls.flatMap((args) => args[1] as string[]);
    expect(rolledBackIds).toContain('ast_birth_1');
    // Nothing durable remains from the birth save.
    expect(await realStore.loadDocument('stage-1')).toBeNull();
  });
});

/** KV whose generation read changes at the save-back fence, mid-pass. */
class GenerationFlipsOnFenceKv extends MemoryKv {
  generationReads = 0;

  override async get<T>(key: string, scope: KVScope = 'account'): Promise<T | null> {
    const value = await super.get<T>(key, scope);
    if (key === 'document-storage-generation') {
      this.generationReads += 1;
      // Reads 1-2 (phase-1 probe, phase-3 fence baseline) agree; the third
      // read -- the save-back's generation fence -- sees a clear that landed
      // mid-pass.
      if (this.generationReads >= 3) return 7 as T;
    }
    return value;
  }
}
