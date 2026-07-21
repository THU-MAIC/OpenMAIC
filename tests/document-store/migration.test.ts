import { DSL_VERSION } from '@openmaic/dsl';
import {
  BrowserDocumentStore,
  type DocumentStore,
  type KVScope,
  type KVStore,
} from '@openmaic/storage';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, test, vi } from 'vitest';

import {
  accessDocument,
  type LegacyDocumentSnapshot,
  type LegacyDocumentStore,
} from '@/lib/document-store/migration';
import type { AppDocument } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';

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
});
