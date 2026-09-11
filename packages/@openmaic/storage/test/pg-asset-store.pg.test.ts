import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { contentHashOf, type ContentHash } from '../src/asset/blob.js';
import type { AssetByteStore } from '../src/asset/byte-store.js';
import { AssetCollector } from '../src/asset/collector.js';
import { PgAssetByteStore } from '../src/asset/pg-bytes.js';
import {
  AssetQuotaExceededError,
  PgAssetStore,
  ensureAssetSchema,
  type QueryResult,
  type Queryable,
  type WithTransaction,
} from '../src/asset/pg.js';
import { PgDocumentStore, ensureDocumentSchema } from '../src/document/pg.js';
import type { MaicDocument } from '../src/document/types.js';
import {
  acquireDocumentPgContractLock,
  truncateDocumentTables,
} from './pg-document-contract-helpers.js';

const contractUrl = process.env.PG_CONTRACT_URL;

if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl) {
  throw new Error(
    '@openmaic/storage: STORAGE_PG_CONTRACT_REQUIRED=1 requires PG_CONTRACT_URL; refusing to skip the PostgreSQL asset suite',
  );
}

function transactionFor(pool: Pool): WithTransaction {
  return async (body) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client as Queryable);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the transaction body's original error.
      }
      throw error;
    } finally {
      client.release();
    }
  };
}

async function waitForLockWaiter(pool: { query: Queryable['query'] }): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const waiting = await pool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()`,
    );
    if (waiting.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no backend blocked on a lock: the operation never contended for the blob row');
}

class BlockingReadByteStore implements AssetByteStore {
  private readonly values = new Map<ContentHash, Uint8Array>();
  private signalReadStarted!: () => void;
  private allowReadToFinish!: () => void;
  readonly readStarted = new Promise<void>((resolve) => {
    this.signalReadStarted = resolve;
  });
  private readonly mayFinishRead = new Promise<void>((resolve) => {
    this.allowReadToFinish = resolve;
  });
  // Bytes live in a process-local map, never in the registry's PostgreSQL, so
  // the plain methods cannot contend for its row locks (see
  // AssetByteStore.writesOutsideRegistryDatabase).
  readonly writesOutsideRegistryDatabase = true as const;

  async write(hash: ContentHash, value: Uint8Array): Promise<void> {
    this.values.set(hash, new Uint8Array(value));
  }

  async read(hash: ContentHash): Promise<Uint8Array | null> {
    this.signalReadStarted();
    await this.mayFinishRead;
    const value = this.values.get(hash);
    return value === undefined ? null : new Uint8Array(value);
  }

  async delete(hash: ContentHash): Promise<void> {
    this.values.delete(hash);
  }

  finishRead(): void {
    this.allowReadToFinish();
  }
}

describe.skipIf(!contractUrl)('PgAssetStore with PostgreSQL 16', () => {
  let pool: Pool;
  let bytes: PgAssetByteStore;
  let store: PgAssetStore;
  const principal = { key: 'postgres-principal' };

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl, max: 12 });
    await ensureAssetSchema(pool as Queryable);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE document_asset_refs, asset_entries, asset_blobs');
    bytes = new PgAssetByteStore(pool as Queryable);
    store = new PgAssetStore(pool as Queryable, {
      byteStore: bytes,
      withTransaction: transactionFor(pool),
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  test('provisions the non-cascading foreign key and stores BYTEA bytes', async () => {
    const id = await store.put(principal, new Blob(['postgres bytes']));
    const foreignKey = await pool.query<{ delete_rule: string }>(
      `SELECT delete_rule
         FROM information_schema.referential_constraints
        WHERE constraint_schema = current_schema()
          AND constraint_name = 'asset_entries_content_hash_fkey'`,
    );
    expect(foreignKey.rows).toEqual([{ delete_rule: 'NO ACTION' }]);
    expect((await store.resolve(principal, id))?.bytes).toEqual(
      new TextEncoder().encode('postgres bytes'),
    );
  });

  test('an adopting put survives a collector that already holds the blob row lock', async () => {
    const data = new Blob(['locked adoption']);
    const original = await store.put(principal, data);
    await store.remove(principal, original);
    await pool.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);

    let locked!: () => void;
    const rowLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const mayDelete = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collector = new AssetCollector(pool as Queryable, bytes, {
      graceMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      withTransaction: async (body) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await body({
            async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
              text: string,
              params?: unknown[],
            ): Promise<QueryResult<TRow>> {
              const result = await (client as Queryable).query<TRow>(text, params);
              if (text.includes('FOR UPDATE')) {
                locked();
                await mayDelete;
              }
              return result;
            },
          });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    });

    const collection = collector.collect();
    await rowLocked;

    // The adopting put blocks on the collector's row lock before it can write
    // any bytes -- claim first, then write, is the ordering under test. Observe
    // a backend actually waiting on a lock rather than sleeping or signalling
    // off an implementation detail.
    const adopter = new PgAssetStore(pool as Queryable, {
      byteStore: bytes,
      withTransaction: transactionFor(pool),
    });
    const adoption = adopter.put(principal, data);
    await waitForLockWaiter(pool);
    release();

    expect(await collection).toBe(1);
    const adoptedId = await adoption;
    expect((await adopter.resolve(principal, adoptedId))?.bytes).toEqual(
      new TextEncoder().encode('locked adoption'),
    );
  });

  test('a resolving read pins the blob row until its byte read completes', async () => {
    const layer = new BlockingReadByteStore();
    const registry = new PgAssetStore(pool as Queryable, {
      byteStore: layer,
      withTransaction: transactionFor(pool),
    });
    const data = new Blob(['pinned read']);
    const { contentHash } = await contentHashOf(data);
    const id = await registry.put(principal, data);
    // Make the row a collector candidate while it is still referenced. The
    // collector's transaction re-checks references, so deleting the entry
    // after the read starts isolates the lock interleaving under test.
    await pool.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);

    const resolving = registry.resolve(principal, id);
    await layer.readStarted;
    await pool.query('DELETE FROM asset_entries WHERE id = $1', [id]);

    const collector = new AssetCollector(pool as Queryable, layer, {
      graceMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      withTransaction: transactionFor(pool),
    });
    const collection = collector.collect();
    await waitForLockWaiter(pool);

    layer.finishRead();
    expect((await resolving)?.bytes).toEqual(new TextEncoder().encode('pinned read'));
    expect(await collection).toBe(1);
    expect(await layer.read(contentHash)).toBeNull();
  });

  test('concurrent writes cannot exceed a principal logical quota', async () => {
    // A quota read on the pool is already stale when it is acted on: two
    // concurrent writes both observe the old total and both pass. Enforcement
    // has to happen inside the write transaction, behind a per-principal lock,
    // which only a real connection pool can exercise -- PGlite is
    // single-connection and cannot contend.
    const quoted = new PgAssetStore(pool as Queryable, {
      byteStore: bytes,
      withTransaction: transactionFor(pool),
      quotaBytes: 10,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) =>
        quoted.put(principal, new Blob([`${index}`.repeat(6)])),
      ),
    );

    const accepted = results.filter((result) => result.status === 'fulfilled');
    const usage = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(blobs.byte_size), 0)::text AS total
         FROM asset_entries AS entries
         JOIN asset_blobs AS blobs ON blobs.content_hash = entries.content_hash
        WHERE entries.principal = $1`,
      [principal.key],
    );

    expect(accepted).toHaveLength(1);
    expect(Number(usage.rows[0]!.total)).toBeLessThanOrEqual(10);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(AssetQuotaExceededError);
      }
    }
  });

  test('a failed registry transaction leaves no PostgreSQL bytes behind', async () => {
    // This byte layer writes through the registry's own transaction, so a
    // rollback takes the bytes with it and there is no orphan to collect. An
    // object store cannot join that transaction and does strand one; that case
    // is deployment housekeeping, not reference counting.
    const data = new Blob(['postgres orphan']);
    const { contentHash } = await contentHashOf(data);
    const failing = new PgAssetStore(pool as Queryable, {
      byteStore: bytes,
      withTransaction: (body) =>
        transactionFor(pool)(async (queryable) => {
          await body(queryable);
          throw new Error('injected failure after the body');
        }) as Promise<never>,
    });

    await expect(failing.put(principal, data)).rejects.toThrow(/registry put failed/);

    expect((await pool.query('SELECT * FROM asset_entries')).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM asset_blobs')).rows).toEqual([]);
    expect(await bytes.read(contentHash)).toBeNull();
  });
});

/**
 * The document -> asset reference level against a real server.
 *
 * Separate from the suite above because it provisions the DOCUMENT schema as
 * well, which every suite that does must serialize on the shared contract
 * lock: `CREATE OR REPLACE FUNCTION` / `CREATE TRIGGER` from two vitest
 * processes at once races on the catalog. The lock is taken for this block
 * only, so the asset suite above is unaffected.
 */
describe.skipIf(!contractUrl)('document asset references with PostgreSQL 16', () => {
  let pool: Pool;
  let bytes: PgAssetByteStore;
  let assets: PgAssetStore;
  let documents: PgDocumentStore;
  let releaseContractLock: (() => Promise<void>) | undefined;
  const principal = { key: 'postgres-reference-principal' };

  const stageWithImage = (stageId: string, sceneId: string, ref: string): MaicDocument =>
    ({
      stage: { id: stageId, name: 'Referenced Course', createdAt: 1000, updatedAt: 2000 },
      scenes: [
        {
          id: sceneId,
          stageId,
          title: sceneId,
          order: 0,
          type: 'slide',
          content: {
            type: 'slide',
            canvas: { id: `canvas-${sceneId}`, elements: [{ type: 'image', src: ref }] },
          },
        },
      ],
    }) as unknown as MaicDocument;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl, max: 8 });
    releaseContractLock = await acquireDocumentPgContractLock(pool);
    await ensureAssetSchema(pool as Queryable);
    await ensureDocumentSchema(pool as Queryable);
  }, 60_000);

  beforeEach(async () => {
    await truncateDocumentTables(pool as Queryable);
    await pool.query('TRUNCATE document_asset_refs, asset_entries, asset_blobs');
    await pool.query('TRUNCATE asset_reference_tracking');
    bytes = new PgAssetByteStore(pool as Queryable);
    assets = new PgAssetStore(pool as Queryable, {
      byteStore: bytes,
      withTransaction: transactionFor(pool),
    });
    documents = new PgDocumentStore(pool as Queryable, {
      withTransaction: transactionFor(pool),
      trackAssetReferences: true,
    });
  });

  afterAll(async () => {
    await releaseContractLock?.();
    await pool.end();
  });

  test('provisions the cascading reference foreign key and the scoped primary key', async () => {
    const foreignKey = await pool.query<{ delete_rule: string }>(
      `SELECT delete_rule
         FROM information_schema.referential_constraints
        WHERE constraint_schema = current_schema()
          AND constraint_name = 'document_asset_refs_asset_id_fkey'`,
    );
    expect(foreignKey.rows).toEqual([{ delete_rule: 'CASCADE' }]);

    // The server itself, not the pin, says the scope is part of the key: this
    // is what makes a scene id equal to the stage sentinel a different row
    // rather than the same one.
    const key = await pool.query<{ column_name: string }>(
      `SELECT key.column_name
         FROM information_schema.table_constraints AS constraints
         JOIN information_schema.key_column_usage AS key
           ON key.constraint_name = constraints.constraint_name
        WHERE constraints.table_name = 'document_asset_refs'
          AND constraints.constraint_type = 'PRIMARY KEY'
        ORDER BY key.ordinal_position`,
    );
    expect(key.rows.map((row) => row.column_name)).toEqual([
      'stage_id',
      'scope',
      'scene_id',
      'asset_id',
    ]);

    // Two rows differing only in scope coexist -- the P1 collision, closed.
    const id = await assets.put(principal, new Blob(['scoped']));
    await pool.query(
      `INSERT INTO document_asset_refs (stage_id, scope, scene_id, asset_id)
       VALUES ('key-stage', 'stage', '', $1), ('key-stage', 'scene', '', $1)`,
      [id],
    );
    const rows = await pool.query(`SELECT 1 FROM document_asset_refs WHERE stage_id = 'key-stage'`);
    expect(rows.rows).toHaveLength(2);
  });

  test('a save records the reference and commits the entry', async () => {
    const id = await assets.put(principal, new Blob(['referenced bytes']));

    await documents.saveDocument(stageWithImage('ref-stage', 'ref-scene', id));

    const rows = await pool.query<{
      stage_id: string;
      scope: string;
      scene_id: string;
      asset_id: string;
    }>('SELECT stage_id, scope, scene_id, asset_id FROM document_asset_refs ORDER BY scene_id');
    // One row: the scene that names it. The stage of this fixture carries no
    // whiteboard and no video manifest, so the stage-level scope is empty.
    expect(rows.rows).toEqual([
      { stage_id: 'ref-stage', scope: 'scene', scene_id: 'ref-scene', asset_id: id },
    ]);
    const entry = await pool.query<{ committed_at: Date | null; expires_at: Date | null }>(
      'SELECT committed_at, expires_at FROM asset_entries WHERE id = $1',
      [id],
    );
    expect(entry.rows[0]?.committed_at).not.toBeNull();
    expect(entry.rows[0]?.expires_at).toBeNull();
  });

  test('deleting the course stamps the entry, and the collector takes it after grace', async () => {
    const id = await assets.put(principal, new Blob(['course bytes']));
    await documents.saveDocument(stageWithImage('drained-stage', 'drained-scene', id));

    await documents.deleteDocument('drained-stage');

    expect(
      (await pool.query('SELECT 1 FROM document_asset_refs WHERE asset_id = $1', [id])).rows,
    ).toEqual([]);
    const stamped = await pool.query<{ unreferenced_at: Date | null }>(
      'SELECT unreferenced_at FROM asset_entries WHERE id = $1',
      [id],
    );
    expect(stamped.rows[0]?.unreferenced_at).not.toBeNull();

    // Within the grace period nothing moves; past it the entry goes and its
    // blob is stamped in turn.
    const hour = 60 * 60 * 1000;
    const entryCollector = (now: Date): AssetCollector =>
      new AssetCollector(pool as Queryable, bytes, {
        withTransaction: transactionFor(pool),
        documentReferences: true,
        graceMs: hour,
        now: () => now,
      });
    expect((await entryCollector(new Date()).collectPass()).entriesCollected).toBe(0);

    const past = await pool.query<{ unreferenced_at: Date }>(
      `UPDATE asset_entries SET unreferenced_at = now() - interval '2 hours'
        WHERE id = $1 RETURNING unreferenced_at`,
      [id],
    );
    expect(past.rows).toHaveLength(1);
    const pass = await entryCollector(new Date()).collectPass();
    expect(pass.entriesCollected).toBe(1);
    expect((await pool.query('SELECT id FROM asset_entries WHERE id = $1', [id])).rows).toEqual([]);
    const blob = await pool.query<{ unreferenced_at: Date | null }>(
      'SELECT unreferenced_at FROM asset_blobs',
    );
    expect(blob.rows[0]?.unreferenced_at).not.toBeNull();
  });

  test('an entry a document still names survives a pass that considers it', async () => {
    const id = await assets.put(principal, new Blob(['kept bytes']));
    await documents.saveDocument(stageWithImage('kept-stage', 'kept-scene', id));
    // A stale stamp with the reference still in place: the per-row re-check
    // under FOR UPDATE is the only thing standing between this and data loss.
    await pool.query(
      `UPDATE asset_entries SET unreferenced_at = now() - interval '2 days' WHERE id = $1`,
      [id],
    );

    const pass = await new AssetCollector(pool as Queryable, bytes, {
      withTransaction: transactionFor(pool),
      documentReferences: true,
      graceMs: 0,
    }).collectPass();

    expect(pass.entriesCollected).toBe(0);
    expect((await assets.resolve(principal, id))?.bytes).toEqual(
      new TextEncoder().encode('kept bytes'),
    );
  });

  test('a concurrent save cannot make the backfill resurrect the row it just removed', async () => {
    // The backfill pages stage ids outside a transaction, so the document it
    // enumerates could have been replaced between the page and the insert.
    // Re-reading the stage inside the transaction under FOR SHARE closes it:
    // the same row every tracking write path takes FOR UPDATE on, so the save
    // below must wait for the backfill's transaction to finish, and what the
    // backfill then inserts is the document the save wrote.
    const stale = await assets.put(principal, new Blob(['stale reference']));
    const fresh = await assets.put(principal, new Blob(['fresh reference']));
    await documents.saveDocument(stageWithImage('race-stage', 'race-scene', stale));
    // Made legacy after the save, so the collector has a reason to backfill at
    // all -- the save would otherwise have committed the entry and left
    // nothing for the walk to do.
    await pool.query(
      `UPDATE asset_entries SET committed_at = NULL, expires_at = NULL WHERE id = $1`,
      [stale],
    );

    let reachedLock!: () => void;
    const atLock = new Promise<void>((resolve) => {
      reachedLock = resolve;
    });
    let release!: () => void;
    const mayProceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pausingTransaction: WithTransaction = async (body) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await body({
          async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
            text: string,
            params?: unknown[],
          ): Promise<QueryResult<TRow>> {
            const answer = await (client as Queryable).query<TRow>(text, params);
            if (text.includes('document_stages') && text.includes('FOR SHARE')) {
              reachedLock();
              await mayProceed;
            }
            return answer;
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };

    const backfilling = new AssetCollector(pool as Queryable, bytes, {
      withTransaction: pausingTransaction,
      documentReferences: true,
      graceMs: 60 * 60 * 1000,
    }).collectPass();
    await atLock;

    // The save replaces the document while the backfill holds the stage row.
    const saving = documents.saveDocument(stageWithImage('race-stage', 'race-scene', fresh));
    await waitForLockWaiter(pool);
    release();
    await backfilling;
    await saving;

    // Exactly what the document holds: the backfill's older read did not come
    // back as a row, and the stale entry is released rather than pinned.
    const rows = await pool.query<{ asset_id: string }>(
      `SELECT asset_id FROM document_asset_refs WHERE stage_id = 'race-stage'`,
    );
    expect(rows.rows.map((row) => row.asset_id)).toEqual([fresh]);
    const released = await pool.query<{ unreferenced_at: Date | null }>(
      'SELECT unreferenced_at FROM asset_entries WHERE id = $1',
      [stale],
    );
    expect(released.rows[0]?.unreferenced_at).not.toBeNull();
  });

  test('removing the entry cascades its reference rows away', async () => {
    const id = await assets.put(principal, new Blob(['cascade bytes']));
    await documents.saveDocument(stageWithImage('cascade-stage', 'cascade-scene', id));

    await assets.remove(principal, id);

    expect((await pool.query('SELECT 1 FROM document_asset_refs')).rows).toEqual([]);
  });
});
