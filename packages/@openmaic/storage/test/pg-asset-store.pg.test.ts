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
    await pool.query('TRUNCATE asset_entries, asset_blobs');
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
