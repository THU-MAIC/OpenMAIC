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
import { DSL_VERSION } from '@openmaic/dsl';
import type { Scene } from '@openmaic/dsl';
import type { AssetByteStore } from '../src/asset/byte-store.js';
import {
  AssetCollector,
  AssetReferenceTrackingNotEnabledError,
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
  scope: string;
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
      // Stage-level rows first, then scenes: document order, so an expected
      // array reads the way the document does.
      `SELECT stage_id, scope, scene_id, asset_id
         FROM document_asset_refs
        ORDER BY stage_id, (scope <> 'stage'), scene_id, asset_id`,
    );
    return result.rows;
  };

  const documentStore = (trackAssetReferences: boolean): PgDocumentStore =>
    new PgDocumentStore(db, { withTransaction: transactions(db), trackAssetReferences });

  const trackingMarkers = async (): Promise<number> =>
    (await db.query('SELECT singleton FROM asset_reference_tracking')).rows.length;

  /** The sum the quota bounds: logical bytes over this principal's live entries. */
  const liveBytes = async (): Promise<number> => {
    const result = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(blobs.byte_size), 0)::text AS total
         FROM asset_entries AS entries
         JOIN asset_blobs AS blobs ON blobs.content_hash = entries.content_hash
        WHERE entries.principal = $1 AND entries.unreferenced_at IS NULL`,
      [PRINCIPAL.key],
    );
    return Number(result.rows[0]?.total ?? 0);
  };

  /**
   * Write the marker a reference-maintaining document store writes.
   *
   * Seeded directly rather than by saving a document, so a test can exercise
   * the collector without also exercising the document store.
   */
  const enableReferenceTracking = async (): Promise<void> => {
    await db.query(
      `INSERT INTO asset_reference_tracking (singleton, enabled_at)
       VALUES (TRUE, now()) ON CONFLICT DO NOTHING`,
    );
  };

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
      // And no read path mentions a lifecycle column at all. Both surfaces
      // have to be recorded: `identify` queries the store's own queryable
      // while `resolve` and `resolveIndirect` run through `withTransaction`,
      // so recording only the former would leave the two paths that read
      // bytes unexamined.
      const statements: string[] = [];
      const record = (queryable: Queryable): Queryable => ({
        query: async (text, params) => {
          statements.push(text);
          return queryable.query(text, params);
        },
      });
      const signing: AssetByteStore = {
        ...byteStore,
        write: (hash, value) => byteStore.write(hash, value),
        read: (hash) => byteStore.read(hash),
        delete: (hash) => byteStore.delete(hash),
        signReadUrl: async () => 'https://objects.example/signed',
      };
      const recorded = new PgAssetStore(record(db), {
        withTransaction: (body) => db.transaction((tx: Queryable) => body(record(tx))),
        byteStore: signing,
      });

      expect((await recorded.resolve(PRINCIPAL, pending))?.mime).toBe('image/png');
      expect(await recorded.identify(PRINCIPAL, pending)).not.toBeNull();
      expect(
        await recorded.resolveIndirect(PRINCIPAL, pending, {
          label: () => ({ contentType: 'image/png', contentDisposition: 'inline' }),
          cacheControl: 'private, no-store',
          expiresInSeconds: 60,
        }),
      ).toEqual({ url: 'https://objects.example/signed', revision: 1 });

      // All three really reached the recorder, so "no lifecycle column" is a
      // statement about statements that ran, not about an empty list.
      expect(statements.filter((statement) => statement.includes('asset_entries')).length).toBe(3);
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

    test('replacing an unreferenced entry cannot move the live sum, so the quota ignores it', async () => {
      const quotaStore = new PgAssetStore(db, assetOptions({ quotaBytes: 10 }));
      await quotaStore.put(PRINCIPAL, new Blob(['12345']));
      const stale = await quotaStore.put(PRINCIPAL, new Blob(['abcde']));
      await db.query('UPDATE asset_entries SET unreferenced_at = now() WHERE id = $1', [stale]);
      expect(await liveBytes()).toBe(5);

      // `replace` leaves the lifecycle columns alone, so this entry is outside
      // the live sum before the write and still outside it after: neither its
      // old nor its new bytes can move the total the quota bounds, and the
      // check is therefore a no-op. Charging the replacement instead would
      // refuse a write whose post-state is comfortably under quota.
      await expect(quotaStore.replace(PRINCIPAL, stale, new Blob(['x'.repeat(50)]))).resolves.toBe(
        2,
      );

      expect(await liveBytes()).toBe(5);
      // And the live entry is still bounded: five live bytes plus six is over.
      await expect(quotaStore.put(PRINCIPAL, new Blob(['123456']))).rejects.toBeInstanceOf(
        AssetQuotaExceededError,
      );
    });

    test('a referenced entry is still charged for its replacement bytes', async () => {
      const quotaStore = new PgAssetStore(db, assetOptions({ quotaBytes: 10 }));
      const live = await quotaStore.put(PRINCIPAL, new Blob(['12345']));

      await expect(
        quotaStore.replace(PRINCIPAL, live, new Blob(['x'.repeat(11)])),
      ).rejects.toBeInstanceOf(AssetQuotaExceededError);
      await expect(quotaStore.replace(PRINCIPAL, live, new Blob(['x'.repeat(10)]))).resolves.toBe(
        2,
      );
      expect(await liveBytes()).toBe(10);
    });
  });

  describe('reference maintenance', () => {
    test('only ids the registry holds become rows, and nothing parses a ref', async () => {
      const allocated = await store.put(PRINCIPAL, new Blob(['real']));

      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        scope: {
          scope: 'scene',
          sceneId: 'scene-a',
          candidates: [
            allocated,
            'gen_img_placeholder',
            'data:image/png;base64,AAA',
            'https://example.test/legacy.png',
            './relative/path.png',
            'ast_never_allocated',
          ],
        },
      });

      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scope: 'scene', scene_id: 'scene-a', asset_id: allocated },
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
        scope: { scope: 'stage', sceneId: '', candidates: ['42'] },
      });

      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scope: 'stage', scene_id: '', asset_id: '42' },
      ]);
      expect((await lifecycleOf('42'))?.committed_at).not.toBeNull();
    });

    test('the first reference commits the entry and retires its expiry', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['committing']));

      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        scope: { scope: 'scene', sceneId: 'scene-a', candidates: [id] },
      });
      const committed = await lifecycleOf(id);
      expect(committed?.committed_at).not.toBeNull();
      expect(committed?.expires_at).toBeNull();
      expect(committed?.unreferenced_at).toBeNull();

      // A second write naming the same id keeps the original commit stamp:
      // commit is "a document has named this", which happens once.
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-2',
        scope: { scope: 'scene', sceneId: 'scene-z', candidates: [id] },
      });
      expect((await lifecycleOf(id))?.committed_at).toEqual(committed?.committed_at);
    });

    test('losing the last reference stamps the entry, and another scope keeps it', async () => {
      const shared = await store.put(PRINCIPAL, new Blob(['shared']));
      const lonely = await store.put(PRINCIPAL, new Blob(['lonely']));
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        scope: { scope: 'scene', sceneId: 'scene-a', candidates: [shared, lonely] },
      });
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        scope: { scope: 'scene', sceneId: 'scene-b', candidates: [shared] },
      });

      // scene-a drops both. `shared` survives on scene-b's row.
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        scope: { scope: 'scene', sceneId: 'scene-a', candidates: [] },
      });

      expect((await lifecycleOf(shared))?.unreferenced_at).toBeNull();
      expect((await lifecycleOf(lonely))?.unreferenced_at).not.toBeNull();
    });

    test('a reference arriving back inside the window un-stamps the entry', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['restored']));
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        scope: { scope: 'scene', sceneId: 'scene-a', candidates: [id] },
      });
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        scope: { scope: 'scene', sceneId: 'scene-a', candidates: [] },
      });
      expect((await lifecycleOf(id))?.unreferenced_at).not.toBeNull();

      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        scope: { scope: 'scene', sceneId: 'scene-a', candidates: [id] },
      });

      expect((await lifecycleOf(id))?.unreferenced_at).toBeNull();
    });

    test('an already-stamped entry keeps its original stamp when a write misses it', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['draining']));
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        scope: { scope: 'scene', sceneId: 'scene-a', candidates: [id] },
      });
      await syncDocumentAssetReferences(db, {
        stageId: 'stage-1',
        scope: { scope: 'scene', sceneId: 'scene-a', candidates: [] },
      });
      const stamped = (await lifecycleOf(id))?.unreferenced_at;
      await db.query(
        `INSERT INTO document_asset_refs (stage_id, scope, scene_id, asset_id)
         VALUES ('stage-9', 'stage', '', $1)`,
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
        scope: { scope: 'scene', sceneId: 'scene-a', candidates: [id] },
      });

      await store.remove(PRINCIPAL, id);

      expect(await refRows()).toEqual([]);
      // And an unknown id is still the same no-op it was before the cascade.
      await expect(store.remove(PRINCIPAL, 'ast_unknown')).resolves.toBeUndefined();
      await expect(store.remove({ key: 'other' }, id)).resolves.toBeUndefined();
    });
  });

  describe('a scene cannot impersonate the stage scope', () => {
    test('a scene whose id is empty leaves the stage-level references alone', async () => {
      // The reserved-sentinel version of this table keyed stage rows on
      // `scene_id = ''`. Scene ids are opaque and unvalidated, so a scene
      // could be stored under that id, and its scope write would then delete
      // the stage's rows and stamp the stage's assets unreferenced -- silent
      // permanent media loss through the ordinary document write path. The
      // scope column makes the two keys disjoint by construction.
      const stageAsset = await store.put(PRINCIPAL, new Blob(['stage asset']));
      const sceneAsset = await store.put(PRINCIPAL, new Blob(['scene asset']));
      const emptyIdAsset = await store.put(PRINCIPAL, new Blob(['empty id asset']));
      const documents = documentStore(true);
      await documents.saveDocument(
        documentWith(
          'stage-1',
          [sceneWithImages('stage-1', 'scene-a', 0, [sceneAsset])],
          [stageAsset],
        ),
      );

      await documents.saveDocument(
        documentWith('stage-1', [sceneWithImages('stage-1', '', 0, [emptyIdAsset])], [stageAsset]),
      );

      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scope: 'stage', scene_id: '', asset_id: stageAsset },
        { stage_id: 'stage-1', scope: 'scene', scene_id: '', asset_id: emptyIdAsset },
      ]);
      // The stage whiteboard still names it, so it must still be live.
      expect((await lifecycleOf(stageAsset))?.unreferenced_at).toBeNull();
      expect((await lifecycleOf(emptyIdAsset))?.unreferenced_at).toBeNull();
      // Only the scene that really went is released.
      expect((await lifecycleOf(sceneAsset))?.unreferenced_at).not.toBeNull();
    });

    test('an incremental write to the empty-id scene touches neither the stage nor another scene', async () => {
      const stageAsset = await store.put(PRINCIPAL, new Blob(['stage asset']));
      const otherAsset = await store.put(PRINCIPAL, new Blob(['other scene asset']));
      const arriving = await store.put(PRINCIPAL, new Blob(['arriving asset']));
      const documents = documentStore(true);
      await documents.saveDocument(
        documentWith(
          'stage-1',
          [
            sceneWithImages('stage-1', '', 0, []),
            sceneWithImages('stage-1', 'scene-b', 1, [otherAsset]),
          ],
          [stageAsset],
        ),
      );

      await documents.putScene('stage-1', sceneWithImages('stage-1', '', 0, [arriving]));

      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scope: 'stage', scene_id: '', asset_id: stageAsset },
        { stage_id: 'stage-1', scope: 'scene', scene_id: '', asset_id: arriving },
        { stage_id: 'stage-1', scope: 'scene', scene_id: 'scene-b', asset_id: otherAsset },
      ]);
      for (const id of [stageAsset, otherAsset, arriving]) {
        expect((await lifecycleOf(id))?.unreferenced_at).toBeNull();
      }
    });

    test('deleting the empty-id scene leaves the stage-level rows in place', async () => {
      const stageAsset = await store.put(PRINCIPAL, new Blob(['stage asset']));
      const sceneAsset = await store.put(PRINCIPAL, new Blob(['scene asset']));
      const documents = documentStore(true);
      await documents.saveDocument(
        documentWith('stage-1', [sceneWithImages('stage-1', '', 0, [sceneAsset])], [stageAsset]),
      );

      await documents.deleteScene('stage-1', '');

      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scope: 'stage', scene_id: '', asset_id: stageAsset },
      ]);
      expect((await lifecycleOf(stageAsset))?.unreferenced_at).toBeNull();
      expect((await lifecycleOf(sceneAsset))?.unreferenced_at).not.toBeNull();
    });
  });

  describe('documents the enumerator cannot fully read', () => {
    /**
     * A scene the DSL validates but whose canvas holds members the slot
     * enumerator cannot read. `validateScene` never inspects
     * `content.canvas.elements`, so this really does go through the ordinary
     * write path -- unlike `actions`, which it does validate.
     */
    const sceneWithNullElements = (stageId: string, id: string, refs: string[]): Scene =>
      ({
        id,
        stageId,
        title: id,
        order: 0,
        type: 'slide',
        content: {
          type: 'slide',
          canvas: {
            id: `canvas-${id}`,
            elements: [null, 'not an element', 7, ...refs.map((src) => ({ type: 'image', src }))],
          },
        },
      }) as unknown as Scene;

    test('unreadable canvas members are skipped rather than thrown at', () => {
      expect(
        sceneAssetScope('scene-a', sceneWithNullElements('stage-1', 'scene-a', ['a'])),
      ).toEqual({ scope: 'scene', sceneId: 'scene-a', candidates: ['a'] });
    });

    test('unreadable stage whiteboard members are skipped too', () => {
      expect(
        stageAssetScope({
          whiteboard: [null, { id: 'wb', elements: [null, { type: 'image', src: 'w' }] }],
        }),
      ).toEqual({ scope: 'stage', sceneId: '', candidates: ['w'] });
    });

    test('the document write that names an asset is not refused by such a scene', async () => {
      // The contract promises a document write is never refused by what it
      // references. An enumerator that threw here would break that promise on
      // content the DSL accepts, and only when tracking is on.
      const id = await store.put(PRINCIPAL, new Blob(['reachable']));
      const documents = documentStore(true);

      await expect(
        documents.saveDocument(
          documentWith('stage-1', [sceneWithNullElements('stage-1', 'scene-a', [id])]),
        ),
      ).resolves.toBeUndefined();

      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scope: 'scene', scene_id: 'scene-a', asset_id: id },
      ]);
    });

    test('the backfill walks past a stored document it cannot fully read', async () => {
      // Written straight to the tables, which is the case that matters: rows
      // an older release stored, including the `actions` shapes today's
      // validator would refuse. The dangerous version of this is the walk
      // throwing on the offending row -- the cursor never advances past it,
      // every later pass fails in the same place, and no legacy entry is ever
      // marked, so the entry level is dead for the whole deployment.
      await db.query(
        `INSERT INTO document_stages (id, name, created_at, updated_at, data)
         VALUES ('stage-1', 'Legacy', 1000, 2000, $1::jsonb)`,
        [
          JSON.stringify({
            id: 'stage-1',
            name: 'Legacy',
            createdAt: 1000,
            updatedAt: 2000,
            dslVersion: DSL_VERSION,
            whiteboard: [null, { id: 'wb', elements: [null] }],
          }),
        ],
      );
      await db.query(
        `INSERT INTO document_scenes (stage_id, id, scene_order, data)
         VALUES ('stage-1', 'scene-a', 0, $1::jsonb)`,
        [
          JSON.stringify({
            id: 'scene-a',
            stageId: 'stage-1',
            title: 'scene-a',
            order: 0,
            type: 'slide',
            content: {
              type: 'slide',
              canvas: { id: 'canvas', elements: [null, { type: 'image', src: 'legacy-null' }] },
            },
            whiteboards: [null],
            actions: [null, { type: 'speech', audioId: 'legacy-null' }],
          }),
        ],
      );
      await db.query(`INSERT INTO asset_blobs (content_hash, byte_size) VALUES ('hash-null', 3)`);
      await db.query(
        `INSERT INTO asset_entries (id, principal, content_hash, mime, meta, revision, created_at)
         VALUES ('legacy-null', $1, 'hash-null', 'image/png', '{}'::jsonb, 1, 0)`,
        [PRINCIPAL.key],
      );
      await enableReferenceTracking();

      const pass = await collector({ graceMs: 60 * 60 * 1000 }).collectPass();

      expect(pass.backfilledDocuments).toBe(1);
      expect(pass.legacyEntriesCommitted).toBe(1);
      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scope: 'scene', scene_id: 'scene-a', asset_id: 'legacy-null' },
      ]);
      expect((await lifecycleOf('legacy-null'))?.unreferenced_at).toBeNull();
    });

    test('a genuine failure names the document as a property, never in the message', async () => {
      // Fail-loud is kept for anything that is not a shape the enumerator can
      // be taught to skip: the walk stops, nothing is marked, and invariant
      // (i) keeps the entry pass from releasing. The stage id rides as a
      // property because the message is the value that escapes into logs.
      const documents = documentStore(false);
      await documents.saveDocument(documentWith('stage-a', []));
      await documents.saveDocument(documentWith('stage-b', []));
      await db.query(`INSERT INTO asset_blobs (content_hash, byte_size) VALUES ('hash-x', 3)`);
      await db.query(
        `INSERT INTO asset_entries (id, principal, content_hash, mime, meta, revision, created_at)
         VALUES ('legacy-x', $1, 'hash-x', 'image/png', '{}'::jsonb, 1, 0)`,
        [PRINCIPAL.key],
      );
      await enableReferenceTracking();
      // The document read now happens inside the per-document transaction, so
      // that is where the failure has to be injected.
      const failingTransaction: WithTransaction = (body) =>
        db.transaction((tx: Queryable) =>
          body({
            query: async (text, params) => {
              if (text.includes('document_scenes') && params?.[0] === 'stage-b') {
                throw new Error('injected read failure');
              }
              return tx.query(text, params);
            },
          }),
        );

      const failure = await new AssetCollector(db, byteStore, {
        withTransaction: failingTransaction,
        documentReferences: true,
        graceMs: 0,
      })
        .collectPass()
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as { stageId?: string }).stageId).toBe('stage-b');
      expect((failure as Error).message).not.toContain('stage-b');
      // Nothing was marked, so the entry level released nothing.
      expect((await lifecycleOf('legacy-x'))?.committed_at).toBeNull();
    });
  });

  describe('reference tracking marker', () => {
    test('a tracking document store records the marker on its write', async () => {
      expect(await trackingMarkers()).toBe(0);

      await documentStore(true).saveDocument(documentWith('stage-1', []));

      expect(await trackingMarkers()).toBe(1);
    });

    test('an untracked document store records nothing', async () => {
      await documentStore(false).saveDocument(documentWith('stage-1', []));

      expect(await trackingMarkers()).toBe(0);
    });

    test('the entry pass refuses without the marker, and the blob pass still runs', async () => {
      // The failure this prevents: no document store maintains references, so
      // every entry looks pending and the pass deletes each on its TTL while
      // the documents naming them are still there.
      const id = await store.put(PRINCIPAL, new Blob(['live media']));
      await documentStore(false).saveDocument(
        documentWith('stage-1', [sceneWithImages('stage-1', 'scene-a', 0, [id])]),
      );
      await db.query(
        `UPDATE asset_entries SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1`,
        [id],
      );
      // An unrelated blob waiting for the byte pass.
      const doomed = await store.put(PRINCIPAL, new Blob(['unreferenced bytes']));
      await store.remove(PRINCIPAL, doomed);
      await db.query(
        `UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'
          WHERE NOT EXISTS (SELECT 1 FROM asset_entries WHERE content_hash = asset_blobs.content_hash)`,
      );

      const failure = await collector()
        .collectPass()
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AssetReferenceTrackingNotEnabledError);
      expect((failure as Error).message).toMatch(/trackAssetReferences/);
      // The media is untouched...
      expect((await store.resolve(PRINCIPAL, id))?.bytes).toEqual(
        new TextEncoder().encode('live media'),
      );
      // ...and the byte level, which needs no reference writer, still ran.
      expect((await db.query('SELECT content_hash FROM asset_blobs')).rows).toHaveLength(1);
    });

    test('one document write through a tracking store is enough to let the pass run', async () => {
      const id = await store.put(PRINCIPAL, new Blob(['expired pending']));
      await documentStore(true).saveDocument(documentWith('stage-1', []));
      await db.query(
        `UPDATE asset_entries SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1`,
        [id],
      );

      expect((await collector().collectPass()).entriesCollected).toBe(1);
    });

    test('the blob pass alone never asks about the marker', async () => {
      const doomed = await store.put(PRINCIPAL, new Blob(['bytes only']));
      await store.remove(PRINCIPAL, doomed);
      await db.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);

      const pass = await collector({ documentReferences: false }).collectPass();

      expect(pass.collected).toBe(1);
    });
  });

  describe('scope enumeration', () => {
    test('a scene scope holds its own slots and the stage scope holds the stage slots', async () => {
      const scene = sceneWithImages('stage-1', 'scene-a', 0, ['a', 'b']);
      expect(sceneAssetScope('scene-a', scene)).toEqual({
        scope: 'scene',
        sceneId: 'scene-a',
        candidates: ['a', 'b'],
      });
      expect(
        stageAssetScope({
          whiteboard: [{ id: 'wb', elements: [{ type: 'image', src: 'w' }] }],
          videoManifest: { 'video-key': { any: 'shape' } },
        }),
      ).toEqual({ scope: 'stage', sceneId: '', candidates: ['w', 'video-key'] });
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
        { scope: 'stage', sceneId: '', candidates: [] },
        { scope: 'scene', sceneId: 'scene-a', candidates: ['a'] },
        { scope: 'scene', sceneId: 'scene-broken', candidates: [] },
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
        scope: 'scene',
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
        { stage_id: 'stage-1', scope: 'stage', scene_id: '', asset_id: stageAsset },
        { stage_id: 'stage-1', scope: 'scene', scene_id: 'scene-a', asset_id: first },
        { stage_id: 'stage-1', scope: 'scene', scene_id: 'scene-b', asset_id: second },
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
        { stage_id: 'stage-1', scope: 'scene', scene_id: 'scene-a', asset_id: kept },
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
        { stage_id: 'stage-1', scope: 'scene', scene_id: 'scene-a', asset_id: existing },
        { stage_id: 'stage-1', scope: 'scene', scene_id: 'scene-b', asset_id: arriving },
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
        { stage_id: 'stage-1', scope: 'stage', scene_id: '', asset_id: stageAsset },
        { stage_id: 'stage-1', scope: 'scene', scene_id: 'scene-a', asset_id: sceneAsset },
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

      expect(await refRows()).toEqual([
        { stage_id: 'stage-1', scope: 'scene', scene_id: 'scene-a', asset_id: id },
      ]);
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
    // The entry pass refuses without the marker a reference-maintaining
    // document store writes. Tests that do not write through such a store
    // seed it here, deliberately, so the refusal is tested on its own (see
    // the 'reference tracking marker' block) rather than by accident
    // everywhere else.
    beforeEach(async () => {
      await enableReferenceTracking();
    });

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
        scope: { scope: 'scene', sceneId: 'scene-a', candidates: [id] },
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
        scope: { scope: 'scene', sceneId: 'scene-a', candidates: [id] },
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

    beforeEach(async () => {
      await enableReferenceTracking();
    });

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
        { stage_id: 'stage-1', scope: 'scene', scene_id: 'scene-a', asset_id: 'legacy-referenced' },
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
        { stage_id: 'stage-1', scope: 'stage', scene_id: '', asset_id: 'legacy-stage' },
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
