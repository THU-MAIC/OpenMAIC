import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { DSL_VERSION } from '@openmaic/dsl';
import type { KVScope } from '@openmaic/storage';

// Drives the inline-image converter through its production dependency graph:
// the real Dexie tables, the real browser asset pool, and the real
// document-store load path — not injected in-memory maps.
describe('inline image conversion with production wiring', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    // The document-store path imports the stage store, whose module body
    // registers visibility/unload listeners; a minimal window/document keeps
    // it loadable without dragging in a full DOM.
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window);
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: 'visible',
    } as unknown as Document);
    vi.stubGlobal('location', { origin: 'http://localhost' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function dataUrl(payload: string): string {
    return `data:image/png;base64,${btoa(payload)}`;
  }

  function documentWithInlineImage(src: string, stageId = 'stage-1') {
    return {
      dslVersion: DSL_VERSION,
      stage: { id: stageId, name: 'Course', createdAt: 1, updatedAt: 2 },
      scenes: [
        {
          id: 'scene-1',
          stageId,
          type: 'slide',
          title: 'S',
          order: 0,
          content: {
            type: 'slide',
            canvas: {
              id: 'c1',
              elements: [
                { id: 'el1', type: 'image', src, left: 0, top: 0, width: 100, height: 100 },
              ],
            },
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    } as never;
  }

  async function documentStore(dbName = 'maic-documents') {
    const { BrowserDocumentStore } = await import('@openmaic/storage');
    return new BrowserDocumentStore({
      indexedDB: globalThis.indexedDB as unknown as IDBFactory,
      dbName,
      validateScene: () => ({ valid: true }),
    });
  }

  function accessDeps(store: unknown) {
    return {
      store: store as never,
      kv: new MemoryKv(),
      legacyStore: { read: async () => null, listStages: async () => [] },
      lockManager: lockManager(),
    };
  }

  it('converts inline data URLs through the real pool and real Dexie on access, then stays a no-op', async () => {
    const store = await documentStore();
    await store.saveDocument(documentWithInlineImage(dataUrl('first')));
    const { accessDocument } = await import('@/lib/document-store/migration');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const { db } = await import('@/lib/utils/database');
    const pool = getAssetPool();
    const saveSpy = vi.spyOn(store, 'saveDocument');

    const first = await accessDocument('stage-1', accessDeps(store));

    const src = (first.document?.scenes[0].content as { canvas: { elements: { src: string }[] } })
      .canvas.elements[0].src;
    expect(src).toMatch(/^ast_/);
    expect(await pool.exists?.(src as never)).toBe(true);
    const row = await db.mediaFiles.get(`stage-1:${src}`);
    expect(row?.type).toBe('image');
    expect(row?.placeholderRef).toBe(dataUrl('first'));
    expect(await row?.blob.text()).toBe('first');
    // The converted document was saved back once.
    expect(saveSpy).toHaveBeenCalledTimes(1);

    // Second open is a no-op: nothing inline remains, so nothing is written.
    saveSpy.mockClear();
    const second = await accessDocument('stage-1', accessDeps(store));
    expect(saveSpy).not.toHaveBeenCalled();
    expect(
      (second.document?.scenes[0].content as { canvas: { elements: { src: string }[] } }).canvas
        .elements[0].src,
    ).toBe(src);
  });

  it('the narrowed save window re-converts newer content observed during conversion', async () => {
    // Conversion runs under the per-stage lock but the lock does not
    // coordinate independent browsers: a concurrent write during conversion
    // must be reconciled — the save path reloads, converts on top of the
    // newer content, and persists that, never the stale pre-concurrency
    // snapshot.
    const store = await documentStore();
    await store.saveDocument(documentWithInlineImage(dataUrl('old')));
    const { accessDocument } = await import('@/lib/document-store/migration');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const { db } = await import('@/lib/utils/database');
    const pool = getAssetPool();
    let loads = 0;
    const racingStore = new Proxy(store, {
      get(target, property) {
        if (property === 'loadDocument') {
          return async (id: string) => {
            loads += 1;
            const doc = await target.loadDocument(id);
            if (loads === 2 && doc) {
              // A concurrent editor swapped the image bytes while conversion ran.
              return documentWithInlineImage(dataUrl('newer'));
            }
            return doc;
          };
        }
        return Reflect.get(target, property);
      },
    });

    const result = await accessDocument('stage-1', accessDeps(racingStore));

    const src = (result.document?.scenes[0].content as { canvas: { elements: { src: string }[] } })
      .canvas.elements[0].src;
    expect(src).toMatch(/^ast_/);
    // The persisted bytes are the NEWER image, converted on top of the
    // concurrent edit — the stale snapshot was not saved.
    const persisted = await store.loadDocument('stage-1');
    const persistedSrc = (
      persisted?.scenes[0].content as { canvas: { elements: { src: string }[] } }
    ).canvas.elements[0].src;
    expect(persistedSrc).toBe(src);
    expect(await pool.exists?.(src as never)).toBe(true);
    const row = await db.mediaFiles.get(`stage-1:${src}`);
    expect(await row?.blob.text()).toBe('newer');
  });

  it('a failed save-back rolls every fresh allocation back through the real helper', async () => {
    const store = await documentStore();
    await store.saveDocument(documentWithInlineImage(dataUrl('bytes')));
    const flakyStore = new Proxy(store, {
      get(target, property) {
        if (property === 'saveDocument') return () => Promise.reject(new Error('quota'));
        return Reflect.get(target, property);
      },
    });
    const { accessDocument } = await import('@/lib/document-store/migration');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const { db } = await import('@/lib/utils/database');
    const pool = getAssetPool();
    const removeSpy = vi.spyOn(pool, 'remove');

    const result = await accessDocument('stage-1', accessDeps(flakyStore));

    // The opened document is unconverted (the save never landed).
    const src = (result.document?.scenes[0].content as { canvas: { elements: { src: string }[] } })
      .canvas.elements[0].src;
    expect(src).toBe(dataUrl('bytes'));
    // Every fresh allocation was rolled back through the real helper: pool
    // entry and compatibility row are gone.
    const rolledBack = new Set(removeSpy.mock.calls.map((args) => String(args[0])));
    expect(rolledBack.size).toBe(1);
    for (const id of rolledBack) {
      expect(await pool.exists?.(id as never)).toBe(false);
      expect(await db.mediaFiles.get(`stage-1:${id}`)).toBeUndefined();
    }
  });

  it('deleting the stage reclaims the converted pool bytes through the real flow', async () => {
    const store = await documentStore();
    await store.saveDocument(documentWithInlineImage(dataUrl('reclaim-me')));
    const { accessDocument } = await import('@/lib/document-store/migration');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const pool = getAssetPool();

    const result = await accessDocument('stage-1', accessDeps(store));
    const src = (result.document?.scenes[0].content as { canvas: { elements: { src: string }[] } })
      .canvas.elements[0].src;
    expect(src).toMatch(/^ast_/);
    expect(await pool.exists?.(src as never)).toBe(true);

    // The deletion flow: prepare the reclamation plan from the document and
    // its compatibility rows, delete the authoritative document, then
    // execute — exactly the ordering stage deletion uses.
    const {
      loadStageAssetInventory,
      buildStageAssetReclamationPlan,
      executeStageAssetReclamation,
    } = await import('@/lib/media/reclaim-stage-assets');
    const inventory = await loadStageAssetInventory(result.document!);
    const plan = buildStageAssetReclamationPlan(
      'stage-1',
      inventory.refs,
      inventory.mediaRows,
      inventory.audioRows,
    );
    expect(plan.poolRefs).toContain(src);
    await store.deleteDocument('stage-1');
    await executeStageAssetReclamation(plan, null);

    expect(await pool.exists?.(src as never)).toBe(false);
  });

  it('the classroom fetch path converts inline images in a server payload and persists the ids', async () => {
    const payload = {
      stage: { id: 'classroom-1', name: 'Server Course', createdAt: 1, updatedAt: 2 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'classroom-1',
          type: 'slide',
          title: 'S',
          order: 0,
          content: {
            type: 'slide',
            canvas: {
              id: 'c1',
              elements: [
                {
                  id: 'el1',
                  type: 'image',
                  src: dataUrl('classroom-image'),
                  left: 0,
                  top: 0,
                  width: 100,
                  height: 100,
                },
              ],
            },
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (String(input) === '/api/classroom?id=classroom-1') {
          return new Response(JSON.stringify({ success: true, classroom: payload }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }),
    );
    const store = await documentStore();
    const { fetchClassroomFromApi } = await import('@/lib/classroom/load-classroom');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const { db } = await import('@/lib/utils/database');
    const pool = getAssetPool();

    const result = await fetchClassroomFromApi('classroom-1', () => true, accessDeps(store));

    const committed = await store.loadDocument('classroom-1');
    const src = (committed?.scenes[0].content as { canvas: { elements: { src: string }[] } }).canvas
      .elements[0].src;
    expect(src).toMatch(/^ast_/);
    expect(result?.scenes[0]).toEqual(committed?.scenes[0]);
    // The inline bytes never entered storage: they live in the pool and the
    // compatibility row only.
    expect(await pool.exists?.(src as never)).toBe(true);
    const row = await db.mediaFiles.get(`classroom-1:${src}`);
    expect(await row?.blob.text()).toBe('classroom-image');

    // A second cold load reuses the committed document (no re-allocation).
    const again = await fetchClassroomFromApi('classroom-1', () => true, accessDeps(store));
    expect(again?.scenes[0]).toEqual(committed?.scenes[0]);
  });

  it('a classroom load still returns the document when the content digest is unavailable', async () => {
    // A non-secure context / older webview: `crypto.subtle` is undefined, so
    // the default sha-256 digest cannot run. The inline pass must degrade to a
    // no-op (everything kept, one warn) instead of throwing — a load that
    // succeeded before the inline converter existed must keep succeeding.
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
      randomUUID: originalCrypto.randomUUID.bind(originalCrypto),
    } as unknown as Crypto);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const payload = {
      stage: { id: 'classroom-1', name: 'Server Course', createdAt: 1, updatedAt: 2 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'classroom-1',
          type: 'slide',
          title: 'S',
          order: 0,
          content: {
            type: 'slide',
            canvas: {
              id: 'c1',
              elements: [
                {
                  id: 'el1',
                  type: 'image',
                  src: dataUrl('inline'),
                  left: 0,
                  top: 0,
                  width: 100,
                  height: 100,
                },
              ],
            },
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (String(input) === '/api/classroom?id=classroom-1') {
          return new Response(JSON.stringify({ success: true, classroom: payload }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }),
    );
    const store = await documentStore();
    const { fetchClassroomFromApi } = await import('@/lib/classroom/load-classroom');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const pool = getAssetPool();

    const result = await fetchClassroomFromApi('classroom-1', () => true, accessDeps(store));

    // The load succeeds (null would be the pre-fix hard regression) and the
    // document is persisted with the data URL still inline — nothing was
    // converted, nothing was allocated.
    expect(result).not.toBeNull();
    const committed = await store.loadDocument('classroom-1');
    const src = (committed?.scenes[0].content as { canvas: { elements: { src: string }[] } }).canvas
      .elements[0].src;
    expect(src).toBe(dataUrl('inline'));
    expect(await pool.exists?.(src as never)).toBe(false);
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('digest unavailable'))).toBe(
      true,
    );
    warnSpy.mockRestore();
  });

  it('a classroom persisted with kept inline images converts them on the next open', async () => {
    // First open: the content digest is unavailable (a non-secure context /
    // older webview), so the birth pass keeps the inline image and persists
    // the document with the data URL still inline — the exact state a
    // transient digest failure, budget expiry, or oversized payload leaves.
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
      randomUUID: originalCrypto.randomUUID.bind(originalCrypto),
    } as unknown as Crypto);
    const payload = {
      stage: { id: 'classroom-1', name: 'Server Course', createdAt: 1, updatedAt: 2 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'classroom-1',
          type: 'slide',
          title: 'S',
          order: 0,
          content: {
            type: 'slide',
            canvas: {
              id: 'c1',
              elements: [
                {
                  id: 'el1',
                  type: 'image',
                  src: dataUrl('inline'),
                  left: 0,
                  top: 0,
                  width: 100,
                  height: 100,
                },
              ],
            },
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (String(input) === '/api/classroom?id=classroom-1') {
          return new Response(JSON.stringify({ success: true, classroom: payload }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }),
    );
    const store = await documentStore();
    const { fetchClassroomFromApi } = await import('@/lib/classroom/load-classroom');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const { db } = await import('@/lib/utils/database');
    const pool = getAssetPool();

    const first = await fetchClassroomFromApi('classroom-1', () => true, accessDeps(store));
    expect(first).not.toBeNull();
    let committed = await store.loadDocument('classroom-1');
    let src = (committed?.scenes[0].content as { canvas: { elements: { src: string }[] } }).canvas
      .elements[0].src;
    expect(src).toBe(dataUrl('inline'));
    expect(await pool.exists?.(src as never)).toBe(false);

    // Second open: the digest works again. The kept inline image must convert
    // through the EXISTING-document path (the birth-only pass would have
    // returned the committed document verbatim, forever), and the converted
    // document must persist through the same save machinery.
    vi.stubGlobal('crypto', originalCrypto);
    const second = await fetchClassroomFromApi('classroom-1', () => true, accessDeps(store));
    expect(second).not.toBeNull();
    committed = await store.loadDocument('classroom-1');
    src = (committed?.scenes[0].content as { canvas: { elements: { src: string }[] } }).canvas
      .elements[0].src;
    expect(src).toMatch(/^ast_/);
    expect(await pool.exists?.(src as never)).toBe(true);
    const row = await db.mediaFiles.get(`classroom-1:${src}`);
    expect(await row?.blob.text()).toBe('inline');
  });

  it('a superseded classroom load rolls the shared ledger back through the real helper', async () => {
    const { db } = await import('@/lib/utils/database');
    // The payload carries BOTH a legacy gen placeholder (owned by the #1101
    // converter) and an inline data URL (owned by this converter). A liveness
    // abort after the legacy allocation must roll BOTH back through the
    // shared ledger — one rollback call covers both converters' allocations.
    await db.mediaFiles.put({
      id: 'classroom-1:gen_img_1',
      stageId: 'classroom-1',
      type: 'image',
      blob: new Blob(['gen-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 9,
      prompt: 'p',
      params: '{}',
      createdAt: 1,
    });
    const payload = {
      stage: { id: 'classroom-1', name: 'Server Course', createdAt: 1, updatedAt: 2 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'classroom-1',
          type: 'slide',
          title: 'S',
          order: 0,
          content: {
            type: 'slide',
            canvas: {
              id: 'c1',
              elements: [
                {
                  id: 'el1',
                  type: 'image',
                  src: 'gen_img_1',
                  left: 0,
                  top: 0,
                  width: 100,
                  height: 100,
                },
                {
                  id: 'el2',
                  type: 'image',
                  src: dataUrl('inline'),
                  left: 0,
                  top: 0,
                  width: 100,
                  height: 100,
                },
              ],
            },
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (String(input) === '/api/classroom?id=classroom-1') {
          return new Response(JSON.stringify({ success: true, classroom: payload }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }),
    );
    const store = await documentStore();
    const { fetchClassroomFromApi } = await import('@/lib/classroom/load-classroom');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const pool = getAssetPool();
    const removeSpy = vi.spyOn(pool, 'remove');
    // Entry (1) and the legacy pass's commit-boundary checks stay live; the
    // inline pass's first liveness check turns the load stale.
    let calls = 0;
    const shouldConvert = () => ++calls < 4;

    const result = await fetchClassroomFromApi('classroom-1', shouldConvert, accessDeps(store));

    expect(result).toBeNull();
    // BOTH converters' fresh allocations were rolled back through the real
    // helper: nothing is stranded in the pool, and the document was never
    // committed.
    const rolledBack = new Set(removeSpy.mock.calls.map((args) => String(args[0])));
    expect(rolledBack.size).toBeGreaterThan(0);
    for (const id of rolledBack) {
      expect(await pool.exists?.(id as never)).toBe(false);
      expect(await db.mediaFiles.get(`classroom-1:${id}`)).toBeUndefined();
    }
    expect(await store.loadDocument('classroom-1')).toBeNull();
  });
});

class MemoryKv {
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
