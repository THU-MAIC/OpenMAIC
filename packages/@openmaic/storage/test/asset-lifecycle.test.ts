/**
 * The server-owned asset lifecycle, end to end over PGlite: pending
 * allocation, commit by a document write, reference maintenance at each write
 * granularity, live-entry quota, and the collector's entry pass and backfill.
 *
 * PGlite is real PostgreSQL, so the SQL these paths run -- partial indexes,
 * `FOR UPDATE` re-checks, the `ON DELETE CASCADE` on the reference table -- is
 * exercised rather than simulated. What it cannot show is contention between
 * connections; `pg-asset-store.pg.test.ts` covers the lifecycle against a real
 * server with a pool.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Scene } from '@openmaic/dsl';
import type { AssetByteStore } from '../src/asset/byte-store.js';
import {
  AssetCollector,
  type AssetCollectionPass,
  type AssetCollectorOptions,
} from '../src/asset/collector.js';
import type { ContentHash } from '../src/asset/blob.js';
import {
  ASSET_PG_SCHEMA,
  DEFAULT_ASSET_PENDING_TTL_MS,
  PgAssetStore,
  ensureAssetSchema,
  type PgAssetStoreOptions,
  type Queryable,
  type WithTransaction,
} from '../src/asset/pg.js';
import {
  documentAssetScopes,
  removeDocumentAssetReferences,
  sceneAssetScope,
  stageAssetScope,
  syncDocumentAssetReferences,
} from '../src/asset/references.js';
import { AssetQuotaExceededError } from '../src/asset/types.js';
import { PgDocumentStore, ensureDocumentSchema } from '../src/document/pg.js';
import type { MaicDocument } from '../src/document/types.js';

const PRINCIPAL = { key: 'lifecycle-principal' } as const;

class MemoryByteStore implements AssetByteStore {
  private readonly values = new Map<ContentHash, Uint8Array>();
  readonly writesOutsideRegistryDatabase = true as const;

  async write(hash: ContentHash, bytes: Uint8Array): Promise<void> {
    this.values.set(hash, new Uint8Array(bytes));
  }

  async read(hash: ContentHash): Promise<Uint8Array | null> {
    return this.values.get(hash) ?? null;
  }

  async delete(hash: ContentHash): Promise<void> {
    this.values.delete(hash);
  }
}

function transactions(db: PGlite): WithTransaction {
  return (body) => db.transaction((tx: Queryable) => body(tx));
}

interface LifecycleRow extends Record<string, unknown> {
  id: string;
  // PostgreSQL timestamptz arrives as a Date, so these are compared with
  // toEqual rather than toBe.
  committed_at: Date | null;
  expires_at: Date | null;
  unreferenced_at: Date | null;
}

interface RefRow extends Record<string, unknown> {
  stage_id: string;
  scene_id: string;
  asset_id: string;
}

/** A slide scene whose canvas holds the given refs as image elements. */
function sceneWithImages(stageId: string, id: string, order: number, refs: string[]): Scene {
  return {
    id,
    stageId,
    title: id,
    order,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${id}`,
        elements: refs.map((src) => ({ type: 'image', src })),
      },
    },
  } as unknown as Scene;
}

function documentWith(stageId: string, scenes: Scene[], stageRefs: string[] = []): MaicDocument {
  return {
    stage: {
      id: stageId,
      name: 'Lifecycle Course',
      createdAt: 1000,
      updatedAt: 2000,
      ...(stageRefs.length === 0
        ? {}
        : {
            whiteboard: [
              { id: 'wb-1', elements: stageRefs.map((src) => ({ type: 'image', src })) },
            ],
          }),
    },
    scenes,
  } as unknown as MaicDocument;
}

describe('asset entry lifecycle with PGlite', () => {
  let db: PGlite;
  let byteStore: MemoryByteStore;
  let store: PgAssetStore;

  const assetOptions = (extra: Partial<PgAssetStoreOptions> = {}): PgAssetStoreOptions => ({
    withTransaction: transactions(db),
    byteStore,
    ...extra,
  });

  const lifecycleOf = async (id: string): Promise<LifecycleRow | undefined> => {
    const result = await db.query<LifecycleRow>(
      'SELECT id, committed_at, expires_at, unreferenced_at FROM asset_entries WHERE id = $1',
      [id],
    );
    return result.rows[0];
  };

  const refRows = async (): Promise<RefRow[]> => {
    const result = await db.query<RefRow>(
      'SELECT stage_id, scene_id, asset_id FROM document_asset_refs ORDER BY stage_id, scene_id, asset_id',
    );
    return result.rows;
  };

  const documentStore = (trackAssetReferences: boolean): PgDocumentStore =>
    new PgDocumentStore(db, { withTransaction: transactions(db), trackAssetReferences });

  const collector = (options: Partial<AssetCollectorOptions> = {}): AssetCollector =>
    new AssetCollector(db, byteStore, {
      withTransaction: transactions(db),
      documentReferences: true,
      graceMs: 0,
      ...options,
    });

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAssetSchema(db);
    await ensureDocumentSchema(db);
    byteStore = new MemoryByteStore();
    store = new PgAssetStore(db, assetOptions());
  });

  afterEach(async () => {
    await db.close();
  });

  describe('allocation is pending, and pending is invisible', () => {
    test('put stamps an expiry and leaves the entry uncommitted', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['pending bytes']));

      const row = await lifecycleOf(id);
      expect(row?.committed_at).toBeNull();
      expect(row?.unreferenced_at).toBeNull();
      expect(row?.expires_at).not.toBeNull();
      const ttl = row!.expires_at!.getTime() - Date.now();
      // The default window, allowing for the clock moving during the write.
      expect(ttl).toBeGreaterThan(DEFAULT_ASSET_PENDING_TTL_MS - 60_000);
      expect(ttl).toBeLessThanOrEqual(DEFAULT_ASSET_PENDING_TTL_MS + 60_000);
    });

    test('pendingTtlMs sets the window and refuses a nonsensical one', async () => {
      const shortLived = new PgAssetStore(db, assetOptions({ pendingTtlMs: 1000 }));
      const id = await shortLived.put(PRINCIPAL, new Blob(['short']));
      const row = await lifecycleOf(id);
      expect(row!.expires_at!.getTime() - Date.now()).toBeLessThanOrEqual(1000);

      for (const pendingTtlMs of [0, -1, 1.5, Number.NaN]) {
        expect(() => new PgAssetStore(db, assetOptions({ pendingTtlMs }))).toThrow(
          /pendingTtlMs must be a positive safe integer/,
        );
      }
    });

    test('a pending entry reads exactly like a committed one', async () => {
      const pending = await store.put(PRINCIPAL, new Blob(['same bytes'], { type: 'image/png' }));
      const committed = await store.put(
        PRINCIPAL,
        new Blob(['other bytes'], { type: 'image/png' }),
      );
      await db.query(
        `UPDATE asset_entries SET committed_at = now(), expires_at = NULL WHERE id = $1`,
        [committed],
      );

      const pendingRead = await store.resolve(PRINCIPAL, pending);
      const committedRead = await store.resolve(PRINCIPAL, committed);
      expect(pendingRead?.revision).toBe(committedRead?.revision);
      expect(pendingRead?.mime).toBe(committedRead?.mime);
      expect(await store.identify(PRINCIPAL, pending)).toEqual({
        mime: 'image/png',
        revision: 1,
        byteLength: 10,
      });
      // And no read path mentions a lifecycle column at all.
      const statements: string[] = [];
      const recording: Queryable = {
        query: async (text: string, params?: unknown[]) => {
          statements.push(text);
          return db.query(text, params);
        },
      };
      const recorded = new PgAssetStore(recording, assetOptions());
      await recorded.resolve(PRINCIPAL, pending);
      await recorded.identify(PRINCIPAL, pending);
      for (const statement of statements) {
        expect(statement).not.toMatch(/committed_at|expires_at|unreferenced_at/);
      }
    });

    test('replace leaves every lifecycle column where it was', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['first']));
      const before = await lifecycleOf(id);

      await store.replace(PRINCIPAL, id, new Blob(['second']));

      expect(await lifecycleOf(id)).toEqual(before);
    });
  });

  describe('quota counts live entries', () => {
    test('an unreferenced entry stops spending its principal quota', async () => {
      const quotaStore = new PgAssetStore(db, assetOptions({ quotaBytes: 10 }));
      const first = await quotaStore.put(PRINCIPAL, new Blob(['12345']));
      await expect(quotaStore.put(PRINCIPAL, new Blob(['123456']))).rejects.toBeInstanceOf(
        AssetQuotaExceededError,
      );

      await db.query('UPDATE asset_entries SET unreferenced_at = now() WHERE id = $1', [first]);

      // The predecessor's five bytes are back in the budget.
      await expect(quotaStore.put(PRINCIPAL, new Blob(['123456']))).resolves.toBeTruthy();
    });

    test('replacing an unreferenced entry neither frees nor double-counts its bytes', async () => {
      const quotaStore = new PgAssetStore(db, assetOptions({ quotaBytes: 10 }));
      const spent = await quotaStore.put(PRINCIPAL, new Blob(['12345']));
      const stale = await quotaStore.put(PRINCIPAL, new Blob(['abcde']));
      await db.query('UPDATE asset_entries SET unreferenced_at = now() WHERE id = $1', [stale]);

      // Live usage is five bytes. Replacing the unreferenced entry with six
      // adds six to that, because its own five were never in the sum.
      await expect(
        quotaStore.replace(PRINCIPAL, stale, new Blob(['123456'])),
      ).rejects.toBeInstanceOf(AssetQuotaExceededError);
      await expect(quotaStore.replace(PRINCIPAL, stale, new Blob(['12345']))).resolves.toBe(2);
      expect(spent).not.toBe(stale);
    });
  });

  describe('reference maintenance', () => {
    test('only ids the registry holds become rows, and nothing parses a ref', async () => {
      const allocated = await store.put(PRINCIPAL, new Blob(['real']));

      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: 'scene-a',
        candidates: [
          allocated,
          'gen_img_placeholder',
          'data:image/png;base64,AAA',
          'https://example.test/legacy.png',
          './relative/path.png',
          'ast_never_allocated',
        ],
      });

      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scene_id: 'scene-a', asset_id: allocated },
      ]);
    });

    test('an opaque id with no prefix at all is referenced like any other', async () => {
      // The registry mints prefixed ids, but nothing in this path may depend
      // on that: an entry inserted under an arbitrary id references normally.
      await db.query(`INSERT INTO asset_blobs (content_hash, byte_size) VALUES ('hash-opaque', 3)`);
      await db.query(
        `INSERT INTO asset_entries (id, principal, content_hash, mime, meta, revision, created_at, expires_at)
         VALUES ('42', $1, 'hash-opaque', 'text/plain', '{}'::jsonb, 1, 0, now() + interval '1 day')`,
        [PRINCIPAL.key],
      );

      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: '',
        candidates: ['42'],
      });

      expect(await refRows()).toEqual([{ stage_id: 'stage-1', scene_id: '', asset_id: '42' }]);
      expect((await lifecycleOf('42'))?.committed_at).not.toBeNull();
    });

    test('the first reference commits the entry and retires its expiry', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['committing']));

      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: 'scene-a',
        candidates: [id],
      });
      const committed = await lifecycleOf(id);
      expect(committed?.committed_at).not.toBeNull();
      expect(committed?.expires_at).toBeNull();
      expect(committed?.unreferenced_at).toBeNull();

      // A second write naming the same id keeps the original commit stamp:
      // commit is "a document has named this", which happens once.
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-2',
        sceneId: 'scene-z',
        candidates: [id],
      });
      expect((await lifecycleOf(id))?.committed_at).toEqual(committed?.committed_at);
    });

    test('losing the last reference stamps the entry, and another scope keeps it', async () => {
      const shared = await store.put(PRINCIPAL, new Blob(['shared']));
      const lonely = await store.put(PRINCIPAL, new Blob(['lonely']));
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: 'scene-a',
        candidates: [shared, lonely],
      });
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: 'scene-b',
        candidates: [shared],
      });

      // scene-a drops both. `shared` survives on scene-b's row.
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: 'scene-a',
        candidates: [],
      });

      expect((await lifecycleOf(shared))?.unreferenced_at).toBeNull();
      expect((await lifecycleOf(lonely))?.unreferenced_at).not.toBeNull();
    });

    test('a reference arriving back inside the window un-stamps the entry', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['restored']));
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: 'scene-a',
        candidates: [id],
      });
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: 'scene-a',
        candidates: [],
      });
      expect((await lifecycleOf(id))?.unreferenced_at).not.toBeNull();

      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: 'scene-a',
        candidates: [id],
      });

      expect((await lifecycleOf(id))?.unreferenced_at).toBeNull();
    });

    test('an already-stamped entry keeps its original stamp when a write misses it', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['draining']));
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: 'scene-a',
        candidates: [id],
      });
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: 'scene-a',
        candidates: [],
      });
      const stamped = (await lifecycleOf(id))?.unreferenced_at;
      await db.query(
        `INSERT INTO document_asset_refs (stage_id, scene_id, asset_id) VALUES ('stage-9', '', $1)`,
        [id],
      );
      await db.query(`DELETE FROM document_asset_refs WHERE stage_id = 'stage-9'`);

      // Re-running a scope that never held it must not push the grace period
      // out: the stamp marks when the LAST reference went.
      await removeDocumentAssetReferences(db, { stageId: 'stage-1', sceneId: 'scene-a' });

      expect((await lifecycleOf(id))?.unreferenced_at).toEqual(stamped);
    });

    test('removing an entry cascades its reference rows away', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['cascading']));
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: 'scene-a',
        candidates: [id],
      });

      await store.remove(PRINCIPAL, id);

      expect(await refRows()).toEqual([]);
      // And an unknown id is still the same no-op it was before the cascade.
      await expect(store.remove(PRINCIPAL, 'ast_unknown')).resolves.toBeUndefined();
      await expect(store.remove({ key: 'other' }, id)).resolves.toBeUndefined();
    });
  });

  describe('scope enumeration', () => {
    test('a scene scope holds its own slots and the stage scope holds the stage slots', async () => {
      const scene = sceneWithImages('stage-1', 'scene-a', 0, ['a', 'b']);
      expect(sceneAssetScope('scene-a', scene)).toEqual({
        sceneId: 'scene-a',
        candidates: ['a', 'b'],
      });
      expect(
        stageAssetScope({
          whiteboard: [{ id: 'wb', elements: [{ type: 'image', src: 'w' }] }],
          videoManifest: { 'video-key': { any: 'shape' } },
        }),
      ).toEqual({ sceneId: '', candidates: ['w', 'video-key'] });
    });

    test('every scene contributes its own scope, and an unreadable row contributes none', () => {
      const scopes = documentAssetScopes({
        stage: { whiteboard: [] },
        scenes: [
          sceneWithImages('stage-1', 'scene-a', 0, ['a']),
          { id: 'scene-broken' } as unknown as Scene,
        ],
      });

      expect(scopes).toEqual([
        { sceneId: '', candidates: [] },
        { sceneId: 'scene-a', candidates: ['a'] },
        { sceneId: 'scene-broken', candidates: [] },
      ]);
    });

    test('a slide missing its elements array is enumerated rather than thrown at', () => {
      const scene = {
        id: 'scene-legacy',
        stageId: 'stage-1',
        title: 'legacy',
        order: 0,
        type: 'slide',
        content: { type: 'slide', canvas: { id: 'canvas', background: { type: 'color' } } },
      } as unknown as Scene;

      expect(sceneAssetScope('scene-legacy', scene)).toEqual({
        sceneId: 'scene-legacy',
        candidates: [],
      });
    });
  });

  describe('document store integration', () => {
    test('a full save records every scope and commits what it names', async () => {
      const first = await store.put(PRINCIPAL, new Blob(['first']));
      const second = await store.put(PRINCIPAL, new Blob(['second']));
      const stageAsset = await store.put(PRINCIPAL, new Blob(['stage']));

      await documentStore(true).saveDocument(
        documentWith(
          'stage-1',
          [
            sceneWithImages('stage-1', 'scene-a', 0, [first]),
            sceneWithImages('stage-1', 'scene-b', 1, [second]),
          ],
          [stageAsset],
        ),
      );

      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scene_id: '', asset_id: stageAsset },
        { stage_id: 'stage-1', scene_id: 'scene-a', asset_id: first },
        { stage_id: 'stage-1', scene_id: 'scene-b', asset_id: second },
      ]);
      for (const id of [first, second, stageAsset]) {
        const row = await lifecycleOf(id);
        expect(row?.committed_at).not.toBeNull();
        expect(row?.expires_at).toBeNull();
      }
    });

    test('a save that drops a scene releases exactly that scene s references', async () => {
      const kept = await store.put(PRINCIPAL, new Blob(['kept']));
      const dropped = await store.put(PRINCIPAL, new Blob(['dropped']));
      const documents = documentStore(true);
      await documents.saveDocument(
        documentWith('stage-1', [
          sceneWithImages('stage-1', 'scene-a', 0, [kept]),
          sceneWithImages('stage-1', 'scene-b', 1, [dropped]),
        ]),
      );

      await documents.saveDocument(
        documentWith('stage-1', [sceneWithImages('stage-1', 'scene-a', 0, [kept])]),
      );

      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scene_id: 'scene-a', asset_id: kept },
      ]);
      expect((await lifecycleOf(kept))?.unreferenced_at).toBeNull();
      expect((await lifecycleOf(dropped))?.unreferenced_at).not.toBeNull();
    });

    test('putScene touches one scene s rows and commits the id it names', async () => {
      const existing = await store.put(PRINCIPAL, new Blob(['existing']));
      const arriving = await store.put(PRINCIPAL, new Blob(['arriving']));
      const documents = documentStore(true);
      await documents.saveDocument(
        documentWith('stage-1', [
          sceneWithImages('stage-1', 'scene-a', 0, [existing]),
          sceneWithImages('stage-1', 'scene-b', 1, []),
        ]),
      );

      // Exactly what the media write-back does: the bytes were stored first,
      // and this is the write that names them.
      await documents.putScene('stage-1', sceneWithImages('stage-1', 'scene-b', 1, [arriving]));

      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scene_id: 'scene-a', asset_id: existing },
        { stage_id: 'stage-1', scene_id: 'scene-b', asset_id: arriving },
      ]);
      expect((await lifecycleOf(arriving))?.expires_at).toBeNull();
      expect((await lifecycleOf(existing))?.unreferenced_at).toBeNull();
    });

    test('putStage touches only the stage-level rows', async () => {
      const sceneAsset = await store.put(PRINCIPAL, new Blob(['scene']));
      const stageAsset = await store.put(PRINCIPAL, new Blob(['stage']));
      const documents = documentStore(true);
      await documents.saveDocument(
        documentWith('stage-1', [sceneWithImages('stage-1', 'scene-a', 0, [sceneAsset])]),
      );

      const document = documentWith('stage-1', [], [stageAsset]);
      await documents.putStage('stage-1', document.stage);

      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scene_id: '', asset_id: stageAsset },
        { stage_id: 'stage-1', scene_id: 'scene-a', asset_id: sceneAsset },
      ]);
      expect((await lifecycleOf(sceneAsset))?.unreferenced_at).toBeNull();
    });

    test('deleteScene releases the scene s references', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['scene asset']));
      const documents = documentStore(true);
      await documents.saveDocument(
        documentWith('stage-1', [
          sceneWithImages('stage-1', 'scene-a', 0, [id]),
          sceneWithImages('stage-1', 'scene-b', 1, []),
        ]),
      );

      await documents.deleteScene('stage-1', 'scene-a');

      expect(await refRows()).toEqual([]);
      expect((await lifecycleOf(id))?.unreferenced_at).not.toBeNull();
    });

    test('deleteDocument removes every row and stamps the entries', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['course asset']));
      const documents = documentStore(true);
      await documents.saveDocument(
        documentWith('stage-1', [sceneWithImages('stage-1', 'scene-a', 0, [id])], [id]),
      );

      await documents.deleteDocument('stage-1');

      expect(await refRows()).toEqual([]);
      expect((await lifecycleOf(id))?.unreferenced_at).not.toBeNull();
      expect((await db.query('SELECT id FROM document_stages')).rows).toEqual([]);
    });

    test('deleteDocument for a stage outside the scope drops nothing', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['owned asset']));
      const owned = new PgDocumentStore(db, {
        withTransaction: transactions(db),
        trackAssetReferences: true,
      }).forOwner('owner-a');
      await owned.saveDocument(
        documentWith('stage-1', [sceneWithImages('stage-1', 'scene-a', 0, [id])]),
      );

      const foreign = new PgDocumentStore(db, {
        withTransaction: transactions(db),
        trackAssetReferences: true,
      }).forOwner('owner-b');
      await foreign.deleteDocument('stage-1');

      expect(await refRows()).toEqual([{ stage_id: 'stage-1', scene_id: 'scene-a', asset_id: id }]);
      expect((await lifecycleOf(id))?.unreferenced_at).toBeNull();
    });

    test('the option is off by default, and then no write touches either table', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['untracked']));
      const documents = new PgDocumentStore(db, { withTransaction: transactions(db) });
      const document = documentWith(
        'stage-1',
        [sceneWithImages('stage-1', 'scene-a', 0, [id])],
        [id],
      );

      await documents.saveDocument(document);
      await documents.putScene('stage-1', sceneWithImages('stage-1', 'scene-a', 0, [id]));
      await documents.putStage('stage-1', document.stage);
      await documents.deleteScene('stage-1', 'scene-a');
      await documents.deleteDocument('stage-1');

      expect(await refRows()).toEqual([]);
      const row = await lifecycleOf(id);
      expect(row?.committed_at).toBeNull();
      expect(row?.expires_at).not.toBeNull();
    });
  });

  describe('collector entry pass', () => {
    const expired = async (id: string): Promise<void> => {
      await db.query(
        `UPDATE asset_entries SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1`,
        [id],
      );
    };
    const unreferencedSince = async (id: string, at: string): Promise<void> => {
      await db.query(`UPDATE asset_entries SET unreferenced_at = $2::timestamptz WHERE id = $1`, [
        id,
        at,
      ]);
    };
    const committed = async (id: string): Promise<void> => {
      await db.query(
        `UPDATE asset_entries SET committed_at = now(), expires_at = NULL WHERE id = $1`,
        [id],
      );
    };

    test('an expired pending entry is released, and a live one is not', async () => {
      const stale = await store.put(PRINCIPAL, new Blob(['abandoned']));
      const fresh = await store.put(PRINCIPAL, new Blob(['in flight']));
      await expired(stale);

      const pass = await collector().collectPass();

      expect(pass.entriesCollected).toBe(1);
      expect(await lifecycleOf(stale)).toBeUndefined();
      expect(await lifecycleOf(fresh)).toBeDefined();
      // The blob it named is now stamped, so the byte pass takes it in turn.
      const blobs = await db.query<{ unreferenced_at: string | null }>(
        'SELECT unreferenced_at FROM asset_blobs ORDER BY content_hash',
      );
      expect(blobs.rows.filter((row) => row.unreferenced_at !== null)).toHaveLength(1);
    });

    test('a committed entry waits out the grace period after losing its last reference', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['released']));
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: 'scene-a',
        candidates: [id],
      });
      await removeDocumentAssetReferences(db, { stageId: 'stage-1', sceneId: 'scene-a' });

      const hour = 60 * 60 * 1000;
      const early = collector({ graceMs: hour, now: () => new Date() });
      expect((await early.collectPass()).entriesCollected).toBe(0);
      expect(await lifecycleOf(id)).toBeDefined();

      await unreferencedSince(id, '2000-01-01T00:00:00.000Z');
      const late = collector({ graceMs: hour });
      expect((await late.collectPass()).entriesCollected).toBe(1);
      expect(await lifecycleOf(id)).toBeUndefined();
    });

    test('a referenced entry is never released, however its columns look', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['still named']));
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        sceneId: 'scene-a',
        candidates: [id],
      });
      // The pathological case the per-row re-check exists for: a stale stamp
      // left behind while a document still names the entry.
      await unreferencedSince(id, '2000-01-01T00:00:00.000Z');

      expect((await collector().collectPass()).entriesCollected).toBe(0);
      expect(await lifecycleOf(id)).toBeDefined();
    });

    test('the entry pass is bounded and re-runnable', async () => {
      const ids: string[] = [];
      for (const value of ['a', 'b', 'c', 'd', 'e']) {
        const id = await store.put(PRINCIPAL, new Blob([`batch-${value}`]));
        await expired(id);
        ids.push(id);
      }

      const bounded = collector({ batchSize: 2 });
      const passes: AssetCollectionPass[] = [];
      do {
        passes.push(await bounded.collectPass());
      } while (passes[passes.length - 1]?.entriesCapped);

      expect(passes.map((pass) => pass.entriesCollected)).toEqual([2, 2, 1]);
      expect(passes.map((pass) => pass.entriesCapped)).toEqual([true, true, false]);
      expect((await db.query('SELECT id FROM asset_entries')).rows).toEqual([]);
      expect(ids).toHaveLength(5);
    });

    test('the oldest eligible entry goes first, whichever column made it eligible', async () => {
      const newestPending = await store.put(PRINCIPAL, new Blob(['newest pending']));
      const oldestUnreferenced = await store.put(PRINCIPAL, new Blob(['oldest unreferenced']));
      await expired(newestPending);
      await db.query(
        `UPDATE asset_entries SET expires_at = '2005-01-01T00:00:00.000Z' WHERE id = $1`,
        [newestPending],
      );
      await committed(oldestUnreferenced);
      await unreferencedSince(oldestUnreferenced, '2000-01-01T00:00:00.000Z');

      expect((await collector({ batchSize: 1 }).collectPass()).entriesCollected).toBe(1);

      expect(await lifecycleOf(oldestUnreferenced)).toBeUndefined();
      expect(await lifecycleOf(newestPending)).toBeDefined();
    });

    test('the entry level stays dormant unless the deployment asks for it', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['not my job']));
      await expired(id);

      const pass = await collector({ documentReferences: false }).collectPass();

      expect(pass).toEqual({
        collected: 0,
        capped: false,
        entriesCollected: 0,
        entriesCapped: false,
        backfilledDocuments: 0,
        legacyEntriesCommitted: 0,
      });
      expect(await lifecycleOf(id)).toBeDefined();
    });
  });

  describe('collector reference backfill', () => {
    // A real grace period, so invariant (iii) is visible: an entry the
    // backfill finds unreferenced must wait rather than go on the same pass.
    const GRACE_MS = 60 * 60 * 1000;

    /** An entry as a pre-lifecycle deployment left it: no lifecycle columns. */
    const legacyEntry = async (id: string, value: string): Promise<void> => {
      const minted = await store.put(PRINCIPAL, new Blob([value]));
      await db.query(
        `UPDATE asset_entries
            SET id = $2, committed_at = NULL, expires_at = NULL, unreferenced_at = NULL
          WHERE id = $1`,
        [minted, id],
      );
    };

    test('nothing is released while a legacy entry exists and the walk is unfinished', async () => {
      await legacyEntry('legacy-referenced', 'legacy referenced');
      const expiring = await store.put(PRINCIPAL, new Blob(['expired pending']));
      await db.query(
        `UPDATE asset_entries SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1`,
        [expiring],
      );
      // Two stages, one document per backfill chunk: the first pass cannot
      // finish the walk, so invariant (i) must hold it back.
      const documents = documentStore(false);
      await documents.saveDocument(
        documentWith('stage-1', [sceneWithImages('stage-1', 'scene-a', 0, ['legacy-referenced'])]),
      );
      await documents.saveDocument(documentWith('stage-2', []));

      const paced = collector({ graceMs: GRACE_MS, referenceBackfillBatchSize: 1 });
      const first = await paced.collectPass();

      expect(first.backfilledDocuments).toBe(1);
      expect(first.legacyEntriesCommitted).toBe(0);
      expect(first.entriesCollected).toBe(0);
      expect(await lifecycleOf('legacy-referenced')).toBeDefined();
      expect(await lifecycleOf(expiring)).toBeDefined();
    });

    test('the walk resumes, marks on completion, and only then releases', async () => {
      await legacyEntry('legacy-referenced', 'legacy referenced');
      await legacyEntry('legacy-orphan', 'legacy orphan');
      const documents = documentStore(false);
      await documents.saveDocument(
        documentWith('stage-1', [sceneWithImages('stage-1', 'scene-a', 0, ['legacy-referenced'])]),
      );
      await documents.saveDocument(documentWith('stage-2', []));

      const paced = collector({ graceMs: GRACE_MS, referenceBackfillBatchSize: 1 });
      await paced.collectPass();
      const second = await paced.collectPass();

      // The second chunk saw the end of the table, so the marking ran.
      expect(second.backfilledDocuments).toBe(1);
      expect(second.legacyEntriesCommitted).toBe(2);
      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scene_id: 'scene-a', asset_id: 'legacy-referenced' },
      ]);
      const referenced = await lifecycleOf('legacy-referenced');
      expect(referenced?.committed_at).not.toBeNull();
      expect(referenced?.unreferenced_at).toBeNull();
      // (iii): the orphan drains after grace, not on this pass.
      const orphan = await lifecycleOf('legacy-orphan');
      expect(orphan?.committed_at).not.toBeNull();
      expect(orphan?.unreferenced_at).not.toBeNull();
      expect(second.entriesCollected).toBe(0);

      // Once its stamp is older than the grace period, and not before.
      await db.query(
        `UPDATE asset_entries SET unreferenced_at = '2000-01-01T00:00:00.000Z' WHERE id = 'legacy-orphan'`,
      );
      expect((await paced.collectPass()).entriesCollected).toBe(1);
      expect(await lifecycleOf('legacy-orphan')).toBeUndefined();
      expect(await lifecycleOf('legacy-referenced')).toBeDefined();
    });

    test('a restarted collector re-walks from the start and reaches the same end', async () => {
      await legacyEntry('legacy-referenced', 'legacy referenced');
      const documents = documentStore(false);
      await documents.saveDocument(
        documentWith('stage-1', [sceneWithImages('stage-1', 'scene-a', 0, ['legacy-referenced'])]),
      );
      await documents.saveDocument(documentWith('stage-2', []));

      // One pass each, on a fresh instance: the cursor is per instance, so
      // this is the process-restart case. It must not mark early.
      expect(
        (await collector({ graceMs: GRACE_MS, referenceBackfillBatchSize: 1 }).collectPass())
          .legacyEntriesCommitted,
      ).toBe(0);
      expect(
        (await collector({ graceMs: GRACE_MS, referenceBackfillBatchSize: 1 }).collectPass())
          .legacyEntriesCommitted,
      ).toBe(0);
      expect(await lifecycleOf('legacy-referenced')).toBeDefined();

      // A pass that can reach the end finishes the job.
      const finishing = await collector({
        graceMs: GRACE_MS,
        referenceBackfillBatchSize: 50,
      }).collectPass();
      expect(finishing.legacyEntriesCommitted).toBe(1);
      expect((await lifecycleOf('legacy-referenced'))?.unreferenced_at).toBeNull();
    });

    test('the backfill enumerates stage-level slots as well as scenes', async () => {
      await legacyEntry('legacy-stage', 'legacy stage');
      await documentStore(false).saveDocument(documentWith('stage-1', [], ['legacy-stage']));

      await collector({ graceMs: GRACE_MS }).collectPass();

      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scene_id: '', asset_id: 'legacy-stage' },
      ]);
      expect((await lifecycleOf('legacy-stage'))?.unreferenced_at).toBeNull();
    });

    test('a deployment with no legacy entry never walks a document', async () => {
      const documents = documentStore(true);
      const id = await store.put(PRINCIPAL, new Blob(['modern']));
      await documents.saveDocument(
        documentWith('stage-1', [sceneWithImages('stage-1', 'scene-a', 0, [id])]),
      );

      const pass = await collector({ graceMs: GRACE_MS }).collectPass();

      expect(pass.backfilledDocuments).toBe(0);
      expect(pass.legacyEntriesCommitted).toBe(0);
    });
  });

  test('the schema statements are the ones this file relies on', () => {
    // A guard on the guard: these tests assert against column and table names,
    // so they must fail loudly if the schema stops providing them.
    const sql = ASSET_PG_SCHEMA.join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS unreferenced_at TIMESTAMPTZ');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS document_asset_refs');
  });
});
