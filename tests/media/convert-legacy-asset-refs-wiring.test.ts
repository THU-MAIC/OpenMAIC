import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { KVScope } from '@openmaic/storage';

// Drives the converter through its production dependency graph: the real
// Dexie tables, the real browser asset pool, and the real media-proxy
// request shape -- not the injected in-memory maps. Only the network is
// stubbed.
describe('legacy conversion with production wiring', () => {
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

  it('converts a dangling pair through the media proxy, the real pool, and real Dexie', async () => {
    const proxyCalls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        proxyCalls.push({ url: input, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(new Blob(['proxy-audio'], { type: 'audio/mpeg' }), { status: 200 });
      }),
    );
    const { db } = await import('@/lib/utils/database');
    const { convertDocumentAssetRefs } = await import('@/lib/media/convert-legacy-asset-refs');

    const legacyUrl = 'https://server.example.com/audio/real.mp3';
    const doc = {
      stage: { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 2 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          type: 'slide',
          title: 'S',
          order: 0,
          content: { type: 'slide', canvas: { id: 'c1', elements: [] } },
          actions: [
            { id: 'a1', type: 'speech', text: 'Hi', audioId: 'tts_s0_a1', audioUrl: legacyUrl },
          ],
        },
      ],
    } as never;

    const result = await convertDocumentAssetRefs(doc);

    // The URL went through the same-origin proxy, not a direct fetch.
    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0]?.url).toBe('/api/proxy-media');
    expect(proxyCalls[0]?.body).toEqual({ url: legacyUrl });

    // The document was rewritten to a pool-backed id, the pool holds the
    // bytes, and the compatibility mirror carries both recovery keys.
    const action = result.document.scenes[0].actions?.[0] as unknown as Record<string, unknown>;
    const assetId = action.audioId as string;
    expect(assetId).toMatch(/^ast_/);
    expect(action.audioUrl).toBeUndefined();

    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const pool = getAssetPool();
    expect(await pool.exists?.(assetId as never)).toBe(true);

    const mirror = await db.audioFiles.get(assetId);
    expect(mirror?.originAudioId).toBe('tts_s0_a1');
    expect(mirror?.originAudioUrl).toBe(legacyUrl);
    expect(await mirror?.blob.text()).toBe('proxy-audio');

    // Second open is a no-op through the same wiring.
    const again = await convertDocumentAssetRefs(result.document);
    expect(again.changed).toBe(false);
    expect(proxyCalls).toHaveLength(1);
  });

  it('rolls back real pool assets and both mirror types through the real helper', async () => {
    // The production boundary of `rollbackConvertedAllocations`: a conversion
    // that allocated through the real pool and mirrored into the real Dexie
    // tables is fully compensated -- pool entries and audio/media
    // compatibility rows alike -- while the legacy source rows survive.
    const { db } = await import('@/lib/utils/database');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const { convertDocumentAssetRefs, rollbackConvertedAllocations } =
      await import('@/lib/media/convert-legacy-asset-refs');
    const pool = getAssetPool();
    await db.mediaFiles.put({
      id: 'stage-1:gen_img_1',
      stageId: 'stage-1',
      type: 'image',
      blob: new Blob(['image-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 11,
      prompt: 'a prompt',
      params: '{}',
      createdAt: 1,
    });
    await db.audioFiles.put({
      id: 'tts_s0_a1',
      stageId: 'stage-1',
      blob: new Blob(['audio-bytes'], { type: 'audio/mpeg' }),
      format: 'mp3',
      text: 'narration',
      createdAt: 1,
    });
    const doc = {
      stage: { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 2 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          type: 'slide',
          title: 'S',
          order: 0,
          content: {
            type: 'slide',
            canvas: { id: 'c1', elements: [{ id: 'el1', type: 'image', src: 'gen_img_1' }] },
          },
          actions: [{ id: 'a1', type: 'speech', text: 'Hi', audioId: 'tts_s0_a1' }],
        },
      ],
    } as never;

    const ledger: string[] = [];
    const result = await convertDocumentAssetRefs(doc, undefined, undefined, ledger);

    expect(result.changed).toBe(true);
    expect(ledger.length).toBe(2);
    for (const id of ledger) {
      expect(await pool.exists?.(id as never)).toBe(true);
    }
    // Both mirror types exist while the pass is live.
    const mediaMirror = await db.mediaFiles.get(`stage-1:${ledger[0]}`);
    const audioMirror = await db.audioFiles.get(ledger[1]);
    expect(mediaMirror?.placeholderRef).toBe('gen_img_1');
    expect(audioMirror?.originAudioId).toBe('tts_s0_a1');

    await rollbackConvertedAllocations('stage-1', ledger);

    for (const id of ledger) {
      expect(await pool.exists?.(id as never)).toBe(false);
    }
    expect(await db.mediaFiles.get(`stage-1:${ledger[0]}`)).toBeUndefined();
    expect(await db.audioFiles.get(ledger[1])).toBeUndefined();
    // The legacy source rows are untouched: rollback only undoes the pass.
    expect(await db.mediaFiles.get('stage-1:gen_img_1')).toBeDefined();
    expect(await db.audioFiles.get('tts_s0_a1')).toBeDefined();
  });

  it('a discarded migration save-back leaves no pool assets or mirrors through the real helper', async () => {
    // The load path's discarded-pass boundary: accessDocument converts through
    // the real pool and real Dexie, the save-back fails, and the REAL
    // rollback helper removes every pool entry and both mirror types.
    const { db } = await import('@/lib/utils/database');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const { BrowserDocumentStore } = await import('@openmaic/storage');
    const { accessDocument } = await import('@/lib/document-store/migration');
    const { DSL_VERSION } = await import('@openmaic/dsl');
    const pool = getAssetPool();
    const removeSpy = vi.spyOn(pool, 'remove');
    await db.mediaFiles.put({
      id: 'stage-1:gen_img_1',
      stageId: 'stage-1',
      type: 'image',
      blob: new Blob(['image-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 11,
      prompt: 'a prompt',
      params: '{}',
      createdAt: 1,
    });
    const store = new BrowserDocumentStore({
      indexedDB: globalThis.indexedDB as unknown as IDBFactory,
      dbName: 'maic-documents',
      validateScene: () => ({ valid: true }),
    });
    await store.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Migrated', createdAt: 100, updatedAt: 200 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          type: 'slide',
          title: 'S',
          order: 0,
          content: {
            type: 'slide',
            canvas: { id: 'c1', elements: [{ id: 'el1', type: 'image', src: 'gen_img_1' }] },
          },
        },
      ],
    } as never);
    const flakyStore = new Proxy(store, {
      get(target, property) {
        if (property === 'saveDocument') return () => Promise.reject(new Error('quota'));
        return Reflect.get(target, property);
      },
    });

    const result = await accessDocument('stage-1', {
      store: flakyStore,
      kv: new MemoryKv(),
      legacyStore: { read: async () => null, listStages: async () => [] },
      lockManager: lockManager(),
    });

    // The opened document is unconverted (the save never landed).
    const canvas = (
      result.document?.scenes[0].content as { canvas: { elements: { src: string }[] } }
    ).canvas;
    expect(canvas.elements[0].src).toBe('gen_img_1');
    // The real rollback helper removed every allocation it was handed: pool
    // entries and the media compatibility mirror are all gone.
    const rolledBack = new Set(removeSpy.mock.calls.map((args) => String(args[0])));
    expect(rolledBack.size).toBeGreaterThan(0);
    for (const id of rolledBack) {
      expect(await pool.exists?.(id as never)).toBe(false);
      expect(await db.mediaFiles.get(`stage-1:${id}`)).toBeUndefined();
    }
    expect(await db.mediaFiles.get('stage-1:gen_img_1')).toBeDefined();
  });

  it('a discarded server-fetch pass leaves no pool assets or mirrors through the real helper', async () => {
    // The server-classroom fetch path converts a fresh payload and commits it
    // under the per-stage lock; a load superseded before the commit rolls the
    // whole pass back through the REAL helper. Pool entries and the audio
    // compatibility mirror must both be absent afterwards.
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const { BrowserDocumentStore } = await import('@openmaic/storage');
    const { fetchClassroomFromApi } = await import('@/lib/classroom/load-classroom');
    const pool = getAssetPool();
    const removeSpy = vi.spyOn(pool, 'remove');
    const legacyUrl = 'https://server.example.com/api/classroom-media/c1/audio/a1.mp3';
    const payload = {
      stage: { id: 'classroom-1', name: 'Server Course', createdAt: 1, updatedAt: 2 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'classroom-1',
          type: 'slide',
          title: 'S',
          order: 0,
          content: { type: 'slide', canvas: { id: 'c1', elements: [] } },
          actions: [
            { id: 'a1', type: 'speech', text: 'Hi', audioId: 'tts_s0_a1', audioUrl: legacyUrl },
          ],
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, _init?: RequestInit) => {
        if (String(input) === '/api/classroom?id=classroom-1') {
          return new Response(JSON.stringify({ success: true, classroom: payload }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (String(input) === '/api/proxy-media') {
          return new Response(new Blob(['server-audio'], { type: 'audio/mpeg' }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }),
    );
    const store = new BrowserDocumentStore({
      indexedDB: globalThis.indexedDB as unknown as IDBFactory,
      dbName: 'maic-documents',
      validateScene: () => ({ valid: true }),
    });
    // The converter rechecks liveness at every commit boundary and the fetch
    // path gates once more before the document write; the third call is that
    // final gate, which vetoes the commit after the pass fully completed.
    let calls = 0;
    const shouldConvert = () => ++calls < 4;

    const result = await fetchClassroomFromApi('classroom-1', shouldConvert, {
      store,
      kv: new MemoryKv(),
      legacyStore: { read: async () => null, listStages: async () => [] },
      lockManager: lockManager(),
    });

    expect(result).toBeNull();
    const rolledBack = new Set(removeSpy.mock.calls.map((args) => String(args[0])));
    expect(rolledBack.size).toBeGreaterThan(0);
    const { db } = await import('@/lib/utils/database');
    for (const id of rolledBack) {
      expect(await pool.exists?.(id as never)).toBe(false);
      expect(await db.audioFiles.get(id)).toBeUndefined();
    }
    // The document was never committed.
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
