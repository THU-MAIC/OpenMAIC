import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { DSL_VERSION } from '@openmaic/dsl';
import {
  BrowserDocumentStore,
  type DocumentStore,
  type KVScope,
  type KVStore,
} from '@openmaic/storage';
import type { AppScene } from '@/lib/types/stage';
import type { DocumentMigrationDeps, LegacyDocumentStore } from '@/lib/document-store/migration';

// Drives the REAL fetchClassroomFromApi end to end: the /api/classroom JSON
// boundary, the real legacy asset-reference converter (server media transport
// URLs, dangling audioUrl pairs), the real Dexie compatibility rows and the
// real asset pool, and the document-store commit under the per-stage lock.
// Only the network is stubbed. This is deliberately NOT the converter unit
// suite: it pins the server-fallback contract at the API boundary, where a
// regression in transport-URL conversion or raw-URL persistence would
// otherwise leave the suite green.

// The real pool's removeAsset is spy-wrapped (still delegating) so tests can
// pin exactly when allocations are rolled back and when they must NOT be.
const { removeAssetSpy } = vi.hoisted(() => ({ removeAssetSpy: vi.fn() }));
vi.mock('@/lib/media/asset-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/asset-pool')>();
  return {
    ...actual,
    removeAsset: (...args: Parameters<typeof actual.removeAsset>) => {
      removeAssetSpy(...args);
      return actual.removeAsset(...args);
    },
  };
});

class MemoryKv implements KVStore {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string, scope: KVScope = 'account'): Promise<T | null> {
    return (this.values.get(`${scope}:${key}`) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T, scope: KVScope = 'account'): Promise<void> {
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

function documentStore(idb: IDBFactory): DocumentStore<AppScene> {
  return new BrowserDocumentStore<AppScene>({
    indexedDB: idb,
    dbName: 'maic-documents',
    validateScene: () => ({ valid: true }),
    validateStage: () => ({ valid: true }),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const IMAGE_URL = '/api/classroom-media/images/cover.png';
const VIDEO_URL = '/api/classroom-media/videos/demo.mp4';
const AUDIO_URL = 'https://cdn.example.com/narration.mp3';

/**
 * A realistic pre-conversion server classroom payload: slides whose media
 * slots carry server transport URLs, and a speech action whose narration
 * lives only behind a serving URL beside a derived audioId.
 */
function serverPayload() {
  return {
    stage: { id: 'stage-1', name: 'Server Course', createdAt: 1, updatedAt: 2 },
    scenes: [
      {
        id: 'scene-1',
        stageId: 'stage-1',
        type: 'slide',
        title: 'Intro',
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'canvas-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: {
              backgroundColor: '#fff',
              themeColors: ['#000'],
              fontColor: '#000',
              fontName: 'Inter',
            },
            elements: [
              {
                id: 'el-1',
                type: 'image',
                x: 0,
                y: 0,
                w: 100,
                h: 100,
                src: IMAGE_URL,
              },
              {
                id: 'el-2',
                type: 'video',
                x: 0,
                y: 0,
                w: 100,
                h: 100,
                src: VIDEO_URL,
                mediaRef: VIDEO_URL,
              },
            ],
          },
        },
        actions: [
          { id: 'a1', type: 'speech', text: 'Hi', audioId: 'tts_s0_a1', audioUrl: AUDIO_URL },
        ],
      },
    ],
  };
}

interface FetchStubOptions {
  payload?: unknown;
  /** When set, classroom-media GETs wait on this gate instead of resolving. */
  mediaGate?: ReturnType<typeof deferred<Response>>;
  /** When set, classroom-media GETs fail with this status instead of resolving. */
  mediaStatus?: number;
  /** When set, proxy (audio) fetches fail with this status. */
  proxyStatus?: number;
}

function stubNetwork(options: FetchStubOptions = {}) {
  const { payload = serverPayload(), mediaGate, mediaStatus, proxyStatus } = options;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('/api/classroom?')) {
        return Response.json({ success: true, classroom: payload });
      }
      if (url === '/api/proxy-media') {
        const body = JSON.parse(String(init?.body)) as { url?: string };
        if (proxyStatus !== undefined) return new Response(null, { status: proxyStatus });
        return new Response(new Blob([`audio:${body.url ?? 'unknown'}`], { type: 'audio/mpeg' }), {
          status: 200,
        });
      }
      if (url.startsWith('/api/classroom-media/')) {
        if (mediaStatus !== undefined) return new Response(null, { status: mediaStatus });
        if (mediaGate) {
          // Each caller consumes its own response body: a single Response
          // object cannot back two URLs (its body is single-use).
          await mediaGate.promise;
        }
        const type = url.includes('/videos/') ? 'video/mp4' : 'image/png';
        return new Response(new Blob([`bytes:${url}`], { type }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }),
  );
  return calls;
}

function allocatedIds(value: unknown): string[] {
  const found = new Set<string>();
  for (const match of JSON.stringify(value).matchAll(/ast_[A-Za-z0-9_-]+/g)) found.add(match[0]);
  return [...found];
}

function makeApiDeps(idb: IDBFactory): DocumentMigrationDeps {
  return {
    store: documentStore(idb),
    kv: new MemoryKv(),
    legacyStore: {
      read: async () => null,
      listStages: async () => [],
    } satisfies LegacyDocumentStore,
    lockManager: lockManager(),
  };
}

describe('fetchClassroomFromApi at the server-media boundary', () => {
  let idb: IDBFactory;
  let deps: DocumentMigrationDeps;

  beforeEach(async () => {
    vi.resetModules();
    removeAssetSpy.mockClear();
    idb = new IDBFactory();
    deps = makeApiDeps(idb);
    vi.stubGlobal('indexedDB', idb);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('location', { origin: 'http://localhost', href: 'http://localhost/' });
    // The dexie package module outlives vi.resetModules (externalized), and it
    // captures `indexedDB` once at evaluation. Point its dependencies at this
    // test's fresh factory so the re-imported app db opens an empty database.
    const { Dexie } = await import('dexie');
    Dexie.dependencies.indexedDB = idb;
    Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function fetchApi() {
    const { fetchClassroomFromApi } = await import('@/lib/classroom/load-classroom');
    return fetchClassroomFromApi('stage-1', undefined, deps);
  }

  it('converts real server image/video transport URLs and dangling audio pairs at the boundary', async () => {
    stubNetwork();
    const result = await fetchApi();

    // The applied payload is fully converted: every transport URL became an
    // allocated asset id, and no raw address survives anywhere.
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain('/api/classroom-media/');
    expect(JSON.stringify(result)).not.toContain(AUDIO_URL);
    const ids = allocatedIds(result);
    // Two media slots (image src; video src+mediaRef share one URL) plus one
    // narration pair collapse into three distinct assets.
    expect(ids).toHaveLength(3);

    // Ownership transferred to the committed document: the success path never
    // rolls anything back, even though the caller may discard the payload.
    expect(removeAssetSpy).not.toHaveBeenCalled();

    // The document was committed under the lock with the converted aggregate.
    const { getDocumentStore } = await import('@/lib/document-store');
    const committed = await getDocumentStore({ store: deps.store }).loadDocument('stage-1');
    expect(committed).not.toBeNull();
    expect(JSON.stringify(committed)).not.toContain('/api/classroom-media/');
    expect(committed?.dslVersion).toBe(DSL_VERSION);

    // The pool holds every allocated id (bytes are owned, not dangling).
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const pool = getAssetPool();
    for (const id of ids) {
      expect(await pool.exists?.(id as never)).toBe(true);
    }

    // Compatibility rows exist for ZIP export: media mirrored under the
    // allocated ids, audio under its own id with both origin keys.
    const { db } = await import('@/lib/utils/database');
    const mediaRows = await db.mediaFiles.where('stageId').equals('stage-1').toArray();
    expect(mediaRows).toHaveLength(2);
    expect(mediaRows.every((row) => ids.includes(row.id.slice('stage-1:'.length)))).toBe(true);
    const audioRows = await db.audioFiles.where('stageId').equals('stage-1').toArray();
    expect(audioRows).toHaveLength(1);
    expect(audioRows[0]?.originAudioId).toBe('tts_s0_a1');
    expect(audioRows[0]?.originAudioUrl).toBe(AUDIO_URL);
  });

  it('rejects a payload the caller superseded before conversion, with no side effects', async () => {
    stubNetwork();
    const { fetchClassroomFromApi } = await import('@/lib/classroom/load-classroom');
    const result = await fetchClassroomFromApi('stage-1', () => false, deps);

    // The raw payload is returned for the caller to discard, but nothing was
    // converted or committed.
    expect(result?.stage.name).toBe('Server Course');
    const { getDocumentStore } = await import('@/lib/document-store');
    expect(await getDocumentStore({ store: deps.store }).loadDocument('stage-1')).toBeNull();
    const { db } = await import('@/lib/utils/database');
    expect(await db.mediaFiles.where('stageId').equals('stage-1').toArray()).toHaveLength(0);
    expect(await db.audioFiles.where('stageId').equals('stage-1').toArray()).toHaveLength(0);
    expect(removeAssetSpy).not.toHaveBeenCalled();
  });

  it('rolls back allocations and commits nothing when superseded mid-conversion', async () => {
    const gate = deferred<Response>();
    const calls = stubNetwork({ mediaGate: gate });
    const { fetchClassroomFromApi } = await import('@/lib/classroom/load-classroom');
    // Current while the fetch is in flight, superseded by the time the
    // converter reaches its first commit boundary.
    let superseded = false;
    const guard = () => !superseded;

    const loading = fetchClassroomFromApi('stage-1', guard, deps);
    await vi.waitFor(() => expect(calls).toContain(IMAGE_URL));
    superseded = true;
    gate.resolve(new Response(new Blob(['bytes'], { type: 'image/png' }), { status: 200 }));

    await expect(loading).resolves.toBeNull();

    // The aborted pass compensated its fresh allocation: every id the pass
    // allocated was removed from the pool, and no compatibility rows or
    // document were committed.
    expect(removeAssetSpy).toHaveBeenCalled();
    for (const [id] of removeAssetSpy.mock.calls) {
      expect(String(id)).toMatch(/^ast_/);
    }
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const pool = getAssetPool();
    for (const [id] of removeAssetSpy.mock.calls) {
      expect(await pool.exists?.(id as never)).toBe(false);
    }
    const { db } = await import('@/lib/utils/database');
    expect(await db.mediaFiles.where('stageId').equals('stage-1').toArray()).toHaveLength(0);
    expect(await db.audioFiles.where('stageId').equals('stage-1').toArray()).toHaveLength(0);
    const { getDocumentStore } = await import('@/lib/document-store');
    expect(await getDocumentStore({ store: deps.store }).loadDocument('stage-1')).toBeNull();
  });

  it('persists nothing raw when conversion cannot complete', async () => {
    // The media endpoint fails transiently for every request: transport URLs
    // cannot be ingested AND cannot be declared dead, so the converted
    // document would still carry raw addresses. The load must fail rather
    // than apply or persist them.
    stubNetwork({ mediaStatus: 500, proxyStatus: 500 });
    const result = await fetchApi();

    expect(result).toBeNull();
    const { getDocumentStore } = await import('@/lib/document-store');
    expect(await getDocumentStore({ store: deps.store }).loadDocument('stage-1')).toBeNull();
    const { db } = await import('@/lib/utils/database');
    expect(await db.mediaFiles.where('stageId').equals('stage-1').toArray()).toHaveLength(0);
    expect(await db.audioFiles.where('stageId').equals('stage-1').toArray()).toHaveLength(0);
  });

  it('removes definitively dead transport URLs and completes the load', async () => {
    // A 404 is a definitive refusal: the bytes are gone for good, so the
    // reference converts to nothing rather than failing an otherwise usable
    // classroom. The load succeeds with the dead references REMOVED, no raw
    // transport URL survives, and nothing is allocated for dead entries.
    stubNetwork({ mediaStatus: 404, proxyStatus: 404 });
    const result = await fetchApi();

    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain('/api/classroom-media/');
    expect(JSON.stringify(result)).not.toContain(AUDIO_URL);
    const { getDocumentStore } = await import('@/lib/document-store');
    const persisted = await getDocumentStore({ store: deps.store }).loadDocument('stage-1');
    expect(persisted).not.toBeNull();
    expect(JSON.stringify(persisted)).not.toContain('/api/classroom-media/');
    expect(JSON.stringify(persisted)).not.toContain(AUDIO_URL);
    expect(allocatedIds(result)).toHaveLength(0);
  });

  it('serializes two simultaneous cold loads: one conversion set, one committed document', async () => {
    const gate = deferred<Response>();
    const calls = stubNetwork({ mediaGate: gate });
    const { fetchClassroomFromApi } = await import('@/lib/classroom/load-classroom');

    // First load enters the document lock and stalls on the media fetch.
    const first = fetchClassroomFromApi('stage-1', undefined, deps);
    await vi.waitFor(() => expect(calls).toContain(IMAGE_URL));
    // Second load queues behind the first on the per-stage lock.
    let secondSettled = false;
    const second = fetchClassroomFromApi('stage-1', undefined, deps).then((value) => {
      secondSettled = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    gate.resolve(new Response(new Blob(['bytes'], { type: 'image/png' }), { status: 200 }));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // Both loads see the SAME committed classroom.
    expect(firstResult).not.toBeNull();
    expect(secondResult).not.toBeNull();
    expect(secondResult?.stage.name).toBe(firstResult?.stage.name);
    expect(JSON.stringify(secondResult)).not.toContain('/api/classroom-media/');

    // Exactly ONE conversion set exists: the loser reused the winner's
    // committed document instead of allocating a competing set.
    const { db } = await import('@/lib/utils/database');
    const mediaRows = await db.mediaFiles.where('stageId').equals('stage-1').toArray();
    expect(mediaRows).toHaveLength(2);
    const audioRows = await db.audioFiles.where('stageId').equals('stage-1').toArray();
    expect(audioRows).toHaveLength(1);
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const pool = getAssetPool();
    for (const id of allocatedIds(firstResult)) {
      expect(await pool.exists?.(id as never)).toBe(true);
    }
  });

  it('hands the committed document to a later cold load without re-allocating', async () => {
    stubNetwork();
    const first = await fetchApi();
    expect(first).not.toBeNull();
    const idsAfterFirst = allocatedIds(first);

    // A fresh load finds the committed document and reuses it verbatim.
    const second = await fetchApi();
    expect(second).not.toBeNull();
    expect(second?.stage.name).toBe(first?.stage.name);
    expect(allocatedIds(second)).toEqual(idsAfterFirst);

    const { db } = await import('@/lib/utils/database');
    expect(await db.mediaFiles.where('stageId').equals('stage-1').toArray()).toHaveLength(2);
    expect(await db.audioFiles.where('stageId').equals('stage-1').toArray()).toHaveLength(1);
    expect(removeAssetSpy).not.toHaveBeenCalled();
  });

  it('returns null for an unsuccessful API response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(fetchApi()).resolves.toBeNull();
  });

  it('cold-loads and commits through the lock-free route when Web Locks are absent', async () => {
    // Finding: withDocumentLock throws DocumentLockUnavailableError when
    // navigator.locks is absent (non-secure context, older browsers, some
    // webviews), and the old requireLock gate rethrew it, so the outer catch
    // returned null -- a silent no-op cold load where the same path used to
    // load. An absent lock API must degrade to the app's lock-free route,
    // keeping the ledger+rollback discipline: a failed unlocked attempt
    // still leaves nothing behind.
    stubNetwork();
    const { fetchClassroomFromApi } = await import('@/lib/classroom/load-classroom');
    const result = await fetchClassroomFromApi('stage-1', undefined, {
      ...deps,
      lockManager: null,
    });

    // The cold load completed: the payload converted and committed even
    // without Web Locks.
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain('/api/classroom-media/');
    expect(JSON.stringify(result)).not.toContain(AUDIO_URL);
    const ids = allocatedIds(result);
    expect(ids).toHaveLength(3);
    const { getDocumentStore } = await import('@/lib/document-store');
    const committed = await getDocumentStore({ store: deps.store }).loadDocument('stage-1');
    expect(committed).not.toBeNull();
    expect(JSON.stringify(committed)).not.toContain('/api/classroom-media/');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const pool = getAssetPool();
    for (const id of ids) {
      expect(await pool.exists?.(id as never)).toBe(true);
    }
    // The success path owns its allocations; nothing was rolled back.
    expect(removeAssetSpy).not.toHaveBeenCalled();
  });

  it('still fails the cold load when a present lock manager cannot acquire', async () => {
    // Finding: the lock-free degradation is reserved for an ABSENT lock API.
    // A lock manager that exists but fails to acquire is the race requireLock
    // exists to prevent: two realms could allocate competing asset sets, so
    // that failure must keep failing (the load returns null, no side effects).
    const rejectingLocks = {
      request: vi.fn(() => Promise.reject(new Error('lock acquisition failed'))),
      query: vi.fn(),
    } as unknown as LockManager;
    stubNetwork();
    const { fetchClassroomFromApi } = await import('@/lib/classroom/load-classroom');
    const result = await fetchClassroomFromApi('stage-1', undefined, {
      ...deps,
      lockManager: rejectingLocks,
    });

    expect(result).toBeNull();
    const { getDocumentStore } = await import('@/lib/document-store');
    expect(await getDocumentStore({ store: deps.store }).loadDocument('stage-1')).toBeNull();
    const { db } = await import('@/lib/utils/database');
    expect(await db.mediaFiles.where('stageId').equals('stage-1').toArray()).toHaveLength(0);
    expect(await db.audioFiles.where('stageId').equals('stage-1').toArray()).toHaveLength(0);
    expect(removeAssetSpy).not.toHaveBeenCalled();
  });
});
