import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { contentHashOf, type ContentHash } from '../src/asset/blob.js';
import type { AssetByteStore } from '../src/asset/byte-store.js';
import {
  ASSET_REFERENCE_RULE_VERSION,
  AssetCollector,
  AssetReferenceRuleVersionError,
} from '../src/asset/collector.js';
import { PgAssetByteStore } from '../src/asset/pg-bytes.js';
import {
  AssetQuotaExceededError,
  AssetRootTargetError,
  AssetRootedError,
  PgAssetStore,
  changeAssetRoots,
  ensureAssetSchema,
  type ChangeAssetRootsInput,
  type QueryResult,
  type Queryable,
  type WithTransaction,
} from '../src/asset/pg.js';
import {
  AssetCollectionFailure,
  AssetReferenceTrackingNotEnabledError,
} from '../src/asset/collector.js';
import {
  backfillDocumentAssetReferences,
  recordAssetReferenceTracking,
  removeDocumentAssetReferences,
  sceneAssetScope,
  syncDocumentAssetReferences,
  syncStageAssetReferences,
} from '../src/asset/references.js';
import {
  DocumentAssetReferencesDisabledError,
  PgDocumentStore,
  StorageLockUnavailableError,
  ensureDocumentSchema,
} from '../src/document/pg.js';
import type { MaicDocument } from '../src/document/types.js';
import {
  acquireDocumentPgContractLock,
  CONTRACT_OWNERSHIP,
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

/**
 * Wait a short while for some backend to block on a lock, and carry on either
 * way.
 *
 * Unlike {@link waitForLockWaiter}, the absence of a waiter is not a failure
 * here: it is the state a test wants to go on and make an assertion about, and
 * throwing (or hanging) instead would replace that assertion with a timeout.
 */
async function settleForLockWaiter(pool: { query: Queryable['query'] }): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const waiting = await pool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()`,
    );
    if (waiting.rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * The package's write transactions, with a lock-wait budget a test can wait
 * for.
 *
 * The production budget is thirty seconds, which is the right number and the
 * wrong test. The hook rewrites only that statement, so what runs is the real
 * transaction shape and the real mapping from a fired `lock_timeout` to the
 * package's typed error.
 */
function impatientTransaction(pool: Pool): WithTransaction {
  return async (body) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body({
        async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          params?: unknown[],
        ): Promise<QueryResult<TRow>> {
          const statement = text.startsWith('SET LOCAL lock_timeout')
            ? `SET LOCAL lock_timeout = '150ms'`
            : text;
          return (client as Queryable).query<TRow>(statement, params);
        },
      });
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

/**
 * An object-store stand-in whose byte operations can run a probe, or park
 * until a test opens them.
 */
class GatedByteStore implements AssetByteStore {
  private readonly values = new Map<ContentHash, Uint8Array>();
  private readonly gates = new Map<
    'read' | 'write',
    Array<{ arrive: () => void; opened: Promise<void> }>
  >();
  // Bytes live in a process-local map, never in the registry's PostgreSQL, so
  // the plain methods cannot contend for its row locks (see
  // AssetByteStore.writesOutsideRegistryDatabase).
  readonly writesOutsideRegistryDatabase = true as const;
  writes = 0;
  onWrite?: () => Promise<void>;
  onRead?: () => Promise<void>;

  /** Park the next not-yet-gated operation of `kind` until `open()`. */
  gate(kind: 'read' | 'write'): { reached: Promise<void>; open: () => void } {
    let arrive!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const queue = this.gates.get(kind) ?? [];
    queue.push({ arrive, opened });
    this.gates.set(kind, queue);
    return { reached, open };
  }

  private async pass(kind: 'read' | 'write'): Promise<void> {
    const gate = this.gates.get(kind)?.shift();
    if (!gate) return;
    gate.arrive();
    await gate.opened;
  }

  async write(hash: ContentHash, value: Uint8Array): Promise<void> {
    this.writes += 1;
    await this.onWrite?.();
    await this.pass('write');
    this.values.set(hash, new Uint8Array(value));
  }

  async read(hash: ContentHash): Promise<Uint8Array | null> {
    await this.onRead?.();
    await this.pass('read');
    const value = this.values.get(hash);
    return value === undefined ? null : new Uint8Array(value);
  }

  async delete(hash: ContentHash): Promise<void> {
    this.values.delete(hash);
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
    await pool.query(
      'TRUNCATE asset_root_refs, document_asset_refs, asset_entries, asset_blob_stages, asset_blobs',
    );
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

  describe('an object-store byte layer, staged outside every registry transaction', () => {
    let probePool: Pool;
    let probeName: string;

    beforeEach(() => {
      // A pool of its own, tagged, so the probes below see exactly this
      // store's backends and none of a parallel suite's.
      probeName = `asset-stage-probe-${Math.random().toString(36).slice(2)}`;
      probePool = new Pool({ connectionString: contractUrl, max: 6, application_name: probeName });
    });

    afterEach(async () => {
      await probePool.end();
    });

    function stagedStore(
      layer: AssetByteStore,
      extra: { quotaBytes?: number; stageTtlMs?: number } = {},
    ): PgAssetStore {
      return new PgAssetStore(probePool as Queryable, {
        byteStore: layer,
        withTransaction: transactionFor(probePool),
        ...extra,
      });
    }

    /** What is held while a byte operation runs, read from outside the store. */
    async function heldDuringByteIo(hash: ContentHash, principalKey: string) {
      const checkedOut = probePool.totalCount - probePool.idleCount;
      const open = await pool.query<{ open: string }>(
        `SELECT count(*)::text AS open FROM pg_stat_activity
          WHERE application_name = $1 AND xact_start IS NOT NULL`,
        [probeName],
      );
      // Both would wait (and then fail on NOWAIT / answer false) if the store
      // still held the blob row lock or the principal's quota lock.
      const row = await pool.query(
        'SELECT 1 FROM asset_blobs WHERE content_hash = $1 FOR UPDATE NOWAIT',
        [hash],
      );
      const quotaLock = await pool.query<{ got: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got',
        [principalKey],
      );
      return {
        checkedOut,
        openTransactions: Number(open.rows[0]!.open),
        blobRowPresent: row.rows.length === 1,
        quotaLockFree: quotaLock.rows[0]!.got,
      };
    }

    test('a put holds no connection, transaction or lock across the byte upload', async () => {
      const data = new Blob(['uploaded with nothing held']);
      const { contentHash } = await contentHashOf(data);
      const layer = new GatedByteStore();
      let held: Awaited<ReturnType<typeof heldDuringByteIo>> | undefined;
      layer.onWrite = async () => {
        held = await heldDuringByteIo(contentHash, principal.key);
      };
      const registry = stagedStore(layer, { quotaBytes: 1_000 });

      const id = await registry.put(principal, data);

      expect(held).toEqual({
        checkedOut: 0,
        openTransactions: 0,
        blobRowPresent: true,
        quotaLockFree: true,
      });
      expect((await registry.resolve(principal, id))?.bytes).toEqual(
        new TextEncoder().encode('uploaded with nothing held'),
      );
      expect((await pool.query('SELECT * FROM asset_blob_stages')).rows).toEqual([]);
      const blobRow = await pool.query<{ stamped: boolean }>(
        'SELECT unreferenced_at IS NOT NULL AS stamped FROM asset_blobs',
      );
      expect(blobRow.rows).toEqual([{ stamped: false }]);
    });

    test('a replace holds no connection, transaction or lock across the byte upload', async () => {
      const layer = new GatedByteStore();
      const registry = stagedStore(layer, { quotaBytes: 1_000 });
      const id = await registry.put(principal, new Blob(['before replace']));
      const replacement = new Blob(['after replace']);
      const { contentHash } = await contentHashOf(replacement);
      let held: Awaited<ReturnType<typeof heldDuringByteIo>> | undefined;
      layer.onWrite = async () => {
        held = await heldDuringByteIo(contentHash, principal.key);
      };

      expect(await registry.replace(principal, id, replacement)).toBe(2);

      expect(held).toEqual({
        checkedOut: 0,
        openTransactions: 0,
        blobRowPresent: true,
        quotaLockFree: true,
      });
      expect((await registry.resolve(principal, id))?.bytes).toEqual(
        new TextEncoder().encode('after replace'),
      );
      expect((await pool.query('SELECT * FROM asset_blob_stages')).rows).toEqual([]);
    });

    test('a resolve holds no connection, transaction or lock across the byte read', async () => {
      const data = new Blob(['read with nothing held']);
      const { contentHash } = await contentHashOf(data);
      const layer = new GatedByteStore();
      const registry = stagedStore(layer);
      const id = await registry.put(principal, data);
      let held: Awaited<ReturnType<typeof heldDuringByteIo>> | undefined;
      layer.onRead = async () => {
        held = await heldDuringByteIo(contentHash, principal.key);
      };

      expect((await registry.resolve(principal, id))?.bytes).toEqual(
        new TextEncoder().encode('read with nothing held'),
      );
      expect(held).toEqual({
        checkedOut: 0,
        openTransactions: 0,
        blobRowPresent: true,
        quotaLockFree: true,
      });
    });

    test('bytes reclaimed after the registry read resolve to a miss', async () => {
      // The read no longer pins the blob row across the byte fetch, so a
      // removal and a collection can complete in between. The answer is then
      // the one a read starting after the removal would give.
      const data = new Blob(['reclaimed mid read']);
      const { contentHash } = await contentHashOf(data);
      const layer = new GatedByteStore();
      const registry = stagedStore(layer);
      const id = await registry.put(principal, data);
      const readGate = layer.gate('read');

      const resolving = registry.resolve(principal, id);
      await readGate.reached;
      await registry.remove(principal, id);
      await pool.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);
      const collector = new AssetCollector(pool as Queryable, layer, {
        graceMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        withTransaction: transactionFor(pool),
      });
      // Completes while the byte read is still parked: nothing waits on it.
      expect(await collector.collect()).toBe(1);
      readGate.open();

      expect(await resolving).toBeNull();
      expect(await layer.read(contentHash)).toBeNull();
    });

    test('the collector skips a blob whose staged upload is in flight', async () => {
      const data = new Blob(['collectable content, re-uploaded']);
      const { contentHash } = await contentHashOf(data);
      const layer = new GatedByteStore();
      const registry = stagedStore(layer);
      const original = await registry.put(principal, data);
      await registry.remove(principal, original);
      // Eligible by every pre-existing rule: unreferenced long ago, no entry.
      await pool.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);
      const writeGate = layer.gate('write');

      const putting = registry.put(principal, data);
      await writeGate.reached;
      const collector = new AssetCollector(pool as Queryable, layer, {
        graceMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        withTransaction: transactionFor(pool),
      });
      await pool.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);
      expect(await collector.collect()).toBe(0);
      writeGate.open();
      const id = await putting;

      expect(await collector.collect()).toBe(0);
      expect((await registry.resolve(principal, id))?.bytes).toEqual(
        new TextEncoder().encode('collectable content, re-uploaded'),
      );
      expect(await layer.read(contentHash)).not.toBeNull();
    });

    test('a stage waits out a collector that already holds the blob row lock', async () => {
      const data = new Blob(['staged after a collection']);
      const layer = new GatedByteStore();
      const registry = stagedStore(layer);
      const original = await registry.put(principal, data);
      await registry.remove(principal, original);
      await pool.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);

      let locked!: () => void;
      const rowLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let release!: () => void;
      const mayDelete = new Promise<void>((resolve) => {
        release = resolve;
      });
      const collector = new AssetCollector(pool as Queryable, layer, {
        graceMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        withTransaction: (body) =>
          transactionFor(pool)((queryable) =>
            body({
              async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
                text: string,
                params?: unknown[],
              ): Promise<QueryResult<TRow>> {
                const result = await queryable.query<TRow>(text, params);
                if (text.includes('FOR UPDATE')) {
                  locked();
                  await mayDelete;
                }
                return result;
              },
            }),
          ),
      });

      const collection = collector.collect();
      await rowLocked;
      const putting = registry.put(principal, data);
      await waitForLockWaiter(pool);
      expect(layer.writes).toBe(1);
      release();

      expect(await collection).toBe(1);
      const id = await putting;
      expect(layer.writes).toBe(2);
      expect((await registry.resolve(principal, id))?.bytes).toEqual(
        new TextEncoder().encode('staged after a collection'),
      );
    });

    test('an allocation whose stage was reclaimed fails instead of naming missing bytes', async () => {
      const layer = new GatedByteStore();
      const registry = stagedStore(layer);
      const data = new Blob(['stage outlived']);
      const { contentHash } = await contentHashOf(data);
      const staged = await registry.stageBytes(data);
      // The stage expired and its blob drained: the only way a pin goes.
      await pool.query(`UPDATE asset_blob_stages SET expires_at = '2000-01-01T00:00:00.000Z'`);
      await pool.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);
      const collector = new AssetCollector(pool as Queryable, layer, {
        graceMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        withTransaction: transactionFor(pool),
      });
      expect(await collector.collect()).toBe(1);
      expect(await layer.read(contentHash)).toBeNull();

      await expect(registry.putStaged(principal, staged)).rejects.toThrow(/registry put failed/);
      expect((await pool.query('SELECT * FROM asset_entries')).rows).toEqual([]);
      expect((await pool.query('SELECT * FROM asset_blobs')).rows).toEqual([]);
    });

    test('an expired pin is dead even while its row survives', async () => {
      const layer = new GatedByteStore();
      const registry = stagedStore(layer);
      const staged = await registry.stageBytes(new Blob(['expired, not reclaimed']));
      await pool.query(`UPDATE asset_blob_stages SET expires_at = '2000-01-01T00:00:00.000Z'`);

      await expect(registry.putStaged(principal, staged)).rejects.toThrow(/registry put failed/);
      expect((await pool.query('SELECT * FROM asset_entries')).rows).toEqual([]);
    });

    test('a collector that fails after deleting the bytes cannot leave a pin an allocation trusts', async () => {
      // The byte delete is outside the database and survives the collector's
      // rollback, so the blob row and its expired pin outlive the bytes. The
      // pin must stay dead: allocating on it would name bytes that are gone.
      const layer = new GatedByteStore();
      const registry = stagedStore(layer);
      const data = new Blob(['deleted, then rolled back']);
      const { contentHash } = await contentHashOf(data);
      const staged = await registry.stageBytes(data);
      await pool.query(`UPDATE asset_blob_stages SET expires_at = '2000-01-01T00:00:00.000Z'`);
      await pool.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);
      const failingCollector = new AssetCollector(pool as Queryable, layer, {
        graceMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        withTransaction: (body) =>
          transactionFor(pool)((queryable) =>
            body({
              async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
                text: string,
                params?: unknown[],
              ): Promise<QueryResult<TRow>> {
                if (text.startsWith('DELETE FROM asset_blobs')) {
                  throw new Error('injected failure after the byte delete');
                }
                return queryable.query<TRow>(text, params);
              },
            }),
          ),
      });

      await expect(failingCollector.collect()).rejects.toThrow();
      expect(await layer.read(contentHash)).toBeNull();
      expect((await pool.query('SELECT id FROM asset_blob_stages')).rows).toHaveLength(1);

      await expect(registry.putStaged(principal, staged)).rejects.toThrow(/registry put failed/);
      expect((await pool.query('SELECT * FROM asset_entries')).rows).toEqual([]);
    });

    test('an upload that outlives its pin fails instead of allocating', async () => {
      const layer = new GatedByteStore();
      const registry = stagedStore(layer, { stageTtlMs: 1 });
      const writeGate = layer.gate('write');

      const putting = registry.put(principal, new Blob(['too slow']));
      await writeGate.reached;
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeGate.open();

      await expect(putting).rejects.toThrow(/registry put failed/);
      expect((await pool.query('SELECT * FROM asset_entries')).rows).toEqual([]);
      expect((await pool.query('SELECT * FROM asset_blob_stages')).rows).toEqual([]);
    });

    test('a caller transaction holding a spent pin open past its deadline does not park the collector', async () => {
      const layer = new GatedByteStore();
      const registry = stagedStore(layer);
      const staged = await registry.stageBytes(new Blob(['spent in a long transaction']));
      // A deadline the open transaction below will outlive.
      await pool.query(
        `UPDATE asset_blob_stages SET expires_at = clock_timestamp() + interval '300 milliseconds'`,
      );
      let finish!: () => void;
      const mayCommit = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let spent!: () => void;
      const pinSpent = new Promise<void>((resolve) => {
        spent = resolve;
      });
      const host = transactionFor(probePool)(async (tx) => {
        const id = await new PgAssetStore(tx, {
          byteStore: layer,
          withTransaction: (body) => body(tx),
        }).putStaged(principal, staged);
        spent();
        await mayCommit;
        return id;
      });
      await pinSpent;
      await new Promise((resolve) => setTimeout(resolve, 400));

      const collector = new AssetCollector(pool as Queryable, layer, {
        withTransaction: transactionFor(pool),
      });
      const started = Date.now();
      await expect(collector.collectPass()).resolves.toMatchObject({ collected: 0 });
      expect(Date.now() - started).toBeLessThan(5_000);

      finish();
      const id = await host;
      expect((await registry.resolve(principal, id))?.bytes).toEqual(
        new TextEncoder().encode('spent in a long transaction'),
      );
    });

    test('a renewal in flight is waited for, so the collector never judges the deadline it replaces', async () => {
      // The renewal decides the pin is live and then has not committed when
      // the old deadline passes. A collector that read the pin without waiting
      // for it would see the old, expired deadline, delete the bytes, and --
      // if it then failed before deleting the row -- leave a renewed pin over
      // bytes that are gone. The renewal holds the blob row, so the collector
      // waits for it and then sees the new deadline.
      const layer = new GatedByteStore();
      let renewing!: () => void;
      const renewalPending = new Promise<void>((resolve) => {
        renewing = resolve;
      });
      let commitRenewal!: () => void;
      const mayCommitRenewal = new Promise<void>((resolve) => {
        commitRenewal = resolve;
      });
      const registry = new PgAssetStore(probePool as Queryable, {
        byteStore: layer,
        stageTtlMs: 60_000,
        withTransaction: (body) =>
          transactionFor(probePool)((queryable) =>
            body({
              async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
                text: string,
                params?: unknown[],
              ): Promise<QueryResult<TRow>> {
                const result = await queryable.query<TRow>(text, params);
                if (text.startsWith('UPDATE asset_blob_stages')) {
                  renewing();
                  await mayCommitRenewal;
                }
                return result;
              },
            }),
          ),
      });
      const data = new Blob(['renewed under the collector']);
      const { contentHash } = await contentHashOf(data);

      const writeGate = layer.gate('write');
      const putting = registry.put(principal, data);
      await writeGate.reached;
      // Otherwise collectable. Stamped now, since the renewal will hold the
      // row until it commits.
      await pool.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);
      // The pin's current deadline is a second out: the renewal, which runs
      // as soon as the upload ends, decides it is live and replaces it with
      // one a minute out.
      await pool.query(
        `UPDATE asset_blob_stages SET expires_at = clock_timestamp() + interval '1 second'`,
      );
      writeGate.open();
      await renewalPending;
      // The deadline the renewal replaces has now passed; the new one has not.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const failingCollector = new AssetCollector(pool as Queryable, layer, {
        graceMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        withTransaction: (body) =>
          transactionFor(pool)((queryable) =>
            body({
              async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
                text: string,
                params?: unknown[],
              ): Promise<QueryResult<TRow>> {
                if (text.startsWith('DELETE FROM asset_blobs')) {
                  throw new Error('injected failure after the byte delete');
                }
                return queryable.query<TRow>(text, params);
              },
            }),
          ),
      });
      const collection = failingCollector.collect();
      await waitForLockWaiter(pool);
      commitRenewal();

      expect(await collection).toBe(0);
      const id = await putting;
      expect(await layer.read(contentHash)).not.toBeNull();
      expect((await registry.resolve(principal, id))?.bytes).toEqual(
        new TextEncoder().encode('renewed under the collector'),
      );
    }, 20_000);

    test('live pins on the oldest blobs do not stall the page or keep it capped', async () => {
      const layer = new GatedByteStore();
      const registry = stagedStore(layer);
      const batchSize = 2;
      // The `batchSize` oldest unreferenced blobs are being staged again.
      const pinned = ['pinned one', 'pinned two'];
      for (const [index, value] of pinned.entries()) {
        const id = await registry.put(principal, new Blob([value]));
        await registry.remove(principal, id);
        const { contentHash } = await contentHashOf(new Blob([value]));
        await pool.query('UPDATE asset_blobs SET unreferenced_at = $2 WHERE content_hash = $1', [
          contentHash,
          `2000-01-0${index + 1}T00:00:00.000Z`,
        ]);
        await registry.stageBytes(new Blob([value]));
      }
      // A younger blob, still well past the grace period, that nothing pins.
      const free = new Blob(['free to reclaim']);
      const { contentHash: freeHash } = await contentHashOf(free);
      await registry.remove(principal, await registry.put(principal, free));
      await pool.query(
        `UPDATE asset_blobs SET unreferenced_at = '2001-01-01T00:00:00.000Z'
                         WHERE content_hash = $1`,
        [freeHash],
      );
      const collector = new AssetCollector(pool as Queryable, layer, {
        graceMs: 0,
        batchSize,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        withTransaction: transactionFor(pool),
      });

      const first = await collector.collectPass();
      expect(first).toMatchObject({ collected: 1, capped: false });
      expect(await layer.read(freeHash)).toBeNull();

      // A caller draining while `capped` stops.
      let passes = 1;
      let pass = first;
      while (pass.capped && passes < 10) {
        pass = await collector.collectPass();
        passes += 1;
      }
      expect(pass.capped).toBe(false);
      expect(passes).toBe(1);
      expect((await pool.query('SELECT 1 FROM asset_blob_stages')).rows).toHaveLength(2);
    });

    test('an upload that finishes after the collector reclaimed its expired pin stays collectable', async () => {
      const layer = new GatedByteStore();
      const registry = stagedStore(layer, { stageTtlMs: 1 });
      const data = new Blob(['outlived its pin']);
      const { contentHash } = await contentHashOf(data);
      const writeGate = layer.gate('write');

      const putting = registry.put(principal, data);
      await writeGate.reached;
      // The pin is dead: the collector takes the row while the upload is
      // still in flight, and the object lands only afterwards.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await pool.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);
      const collector = new AssetCollector(pool as Queryable, layer, {
        graceMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        withTransaction: transactionFor(pool),
      });
      expect(await collector.collect()).toBe(1);
      expect((await pool.query('SELECT 1 FROM asset_blobs')).rows).toEqual([]);
      writeGate.open();

      await expect(putting).rejects.toThrow(/registry put failed/);
      expect(await layer.read(contentHash)).not.toBeNull();
      const tracked = await pool.query<{ stamped: boolean }>(
        'SELECT unreferenced_at IS NOT NULL AS stamped FROM asset_blobs WHERE content_hash = $1',
        [contentHash],
      );
      expect(tracked.rows).toEqual([{ stamped: true }]);
      expect((await pool.query('SELECT * FROM asset_entries')).rows).toEqual([]);

      const later = new AssetCollector(pool as Queryable, layer, {
        graceMs: 0,
        now: () => new Date(Date.now() + 60_000),
        withTransaction: transactionFor(pool),
      });
      expect(await later.collect()).toBe(1);
      expect(await layer.read(contentHash)).toBeNull();
    });

    describe('a failed write on a store bound to a caller transaction leaves nothing behind', () => {
      async function stampOf(hash: ContentHash): Promise<string[]> {
        const rows = await pool.query<{ stamp: string | null }>(
          `SELECT to_char(unreferenced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS stamp
             FROM asset_blobs WHERE content_hash = $1`,
          [hash],
        );
        return rows.rows.map((row) => row.stamp ?? 'NULL');
      }

      /** Run `write` in a caller transaction that catches its failure and commits. */
      async function callerCatchesAndCommits(
        write: (bound: PgAssetStore) => Promise<unknown>,
        layer: AssetByteStore,
      ): Promise<unknown> {
        return transactionFor(probePool)(async (tx) => {
          const bound = new PgAssetStore(tx, {
            byteStore: layer,
            withTransaction: (body) => body(tx),
          });
          let failure: unknown;
          try {
            await write(bound);
          } catch (error) {
            failure = error;
          }
          // The caller's own work still runs, and commits.
          await tx.query('SELECT 1');
          return failure;
        });
      }

      test('an expired stage leaves the blob stamp exactly as it was', async () => {
        const layer = new GatedByteStore();
        const registry = stagedStore(layer);
        const data = new Blob(['expired stage, caller commits']);
        const { contentHash } = await contentHashOf(data);
        const staged = await registry.stageBytes(data);
        await pool.query(`UPDATE asset_blob_stages SET expires_at = '2000-01-01T00:00:00.000Z'`);
        await pool.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);

        const failure = await callerCatchesAndCommits(
          (bound) => bound.putStaged(principal, staged),
          layer,
        );

        expect(String(failure)).toMatch(/registry put failed/);
        expect(await stampOf(contentHash)).toEqual(['2000-01-01']);
        expect((await pool.query('SELECT * FROM asset_entries')).rows).toEqual([]);
      });

      test('a reclaimed stage creates no blob row', async () => {
        const layer = new GatedByteStore();
        const registry = stagedStore(layer);
        const data = new Blob(['reclaimed stage, caller commits']);
        const { contentHash } = await contentHashOf(data);
        const staged = await registry.stageBytes(data);
        await pool.query('DELETE FROM asset_blobs WHERE content_hash = $1', [contentHash]);

        const failure = await callerCatchesAndCommits(
          (bound) => bound.putStaged(principal, staged),
          layer,
        );

        expect(String(failure)).toMatch(/registry put failed/);
        expect(await stampOf(contentHash)).toEqual([]);
        expect((await pool.query('SELECT * FROM asset_entries')).rows).toEqual([]);
      });

      test('an in-database put whose byte write fails keeps the stamp and the transaction usable', async () => {
        // The single-transaction path claims the blob row -- clearing its
        // stamp -- before it writes bytes. A statement error in the byte write
        // must not leave that claim for the caller to commit, nor leave the
        // caller's transaction aborted.
        const data = new Blob(['in-database write fails']);
        const { contentHash } = await contentHashOf(data);
        await store.remove(principal, await store.put(principal, data));
        await pool.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);
        const failingColumn: AssetByteStore & {
          writeWith(queryable: Queryable, hash: ContentHash, bytes: Uint8Array): Promise<void>;
        } = {
          write: async () => undefined,
          read: async () => null,
          delete: async () => undefined,
          writeWith: async (queryable) => {
            await queryable.query('SELECT * FROM no_such_byte_table');
          },
        };

        const failure = await callerCatchesAndCommits(
          (bound) => bound.put(principal, data),
          failingColumn,
        );

        expect(String(failure)).toMatch(/registry put failed/);
        expect(await stampOf(contentHash)).toEqual(['2000-01-01']);
        expect((await pool.query('SELECT * FROM asset_entries')).rows).toEqual([]);
      });
    });

    test('releasing a stage lets its bytes drain, and releasing again is a no-op', async () => {
      const layer = new GatedByteStore();
      const registry = stagedStore(layer);
      const data = new Blob(['given back']);
      const { contentHash } = await contentHashOf(data);
      const staged = await registry.stageBytes(data);

      await registry.releaseStaged(staged);
      await registry.releaseStaged(staged);

      expect((await pool.query('SELECT * FROM asset_blob_stages')).rows).toEqual([]);
      await expect(registry.putStaged(principal, staged)).rejects.toThrow(/registry put failed/);
      await pool.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);
      const collector = new AssetCollector(pool as Queryable, layer, {
        graceMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        withTransaction: transactionFor(pool),
      });
      expect(await collector.collect()).toBe(1);
      expect(await layer.read(contentHash)).toBeNull();
    });

    test.each(['put', 'replace'] as const)(
      'a transaction-bound %s and a pool-bound write of the same content and principal do not deadlock',
      async (operation) => {
        // The pool-bound writer stages and uploads; the host transaction then
        // stages the same content and holds what its stage locked until it
        // commits; the pool-bound writer then allocates (principal's lock,
        // then the blob row) while the host is still uploading. The host's
        // allocation must not then wait for the principal's lock while holding
        // the blob row the pool-bound writer is waiting for.
        const layer = new GatedByteStore();
        const quotaBytes = 1_000;
        const pooled = stagedStore(layer, { quotaBytes });
        const data = new Blob([`contended ${operation}`]);
        const existing =
          operation === 'replace' ? await pooled.put(principal, new Blob(['original'])) : undefined;
        const pooledGate = layer.gate('write');
        const hostGate = layer.gate('write');

        const pooledWrite = pooled.put(principal, data);
        await pooledGate.reached;
        const hostWrite = transactionFor(probePool)(async (tx): Promise<unknown> => {
          const bound = new PgAssetStore(tx, {
            byteStore: layer,
            withTransaction: (body) => body(tx),
            quotaBytes,
          });
          return operation === 'put'
            ? bound.put(principal, data)
            : bound.replace(principal, existing!, data);
        });
        await hostGate.reached;
        pooledGate.open();
        await waitForLockWaiter(pool);
        hostGate.open();

        const results = await Promise.allSettled([pooledWrite, hostWrite]);
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
        const pooledId = (results[0] as PromiseFulfilledResult<string>).value;
        expect((await pooled.resolve(principal, pooledId))?.bytes).toEqual(
          new TextEncoder().encode(`contended ${operation}`),
        );
      },
    );

    test('a store bound to a caller transaction allocates staged bytes with no byte I/O in it', async () => {
      const layer = new GatedByteStore();
      const registry = stagedStore(layer, { quotaBytes: 1_000 });
      const staged = await registry.stageBytes(
        new Blob(['staged for a host'], { type: 'text/plain' }),
      );
      expect(layer.writes).toBe(1);
      const within = (queryable: Queryable) =>
        new PgAssetStore(queryable, {
          byteStore: layer,
          withTransaction: (body) => body(queryable),
          quotaBytes: 1_000,
        });

      // A rolled-back host transaction leaves the stage spendable.
      await expect(
        transactionFor(probePool)(async (tx) => {
          await within(tx).putStaged(principal, staged);
          throw new Error('host transaction rolled back');
        }),
      ).rejects.toThrow(/host transaction rolled back/);
      expect((await pool.query('SELECT * FROM asset_entries')).rows).toEqual([]);

      const id = await transactionFor(probePool)((tx) => within(tx).putStaged(principal, staged));
      expect(layer.writes).toBe(1);
      expect(await registry.resolve(principal, id)).toMatchObject({
        bytes: new TextEncoder().encode('staged for a host'),
        mime: 'text/plain',
      });
      // Spent: a second allocation from the same handle is refused.
      await expect(registry.putStaged(principal, staged)).rejects.toThrow(/registry put failed/);
      expect((await pool.query('SELECT * FROM asset_blob_stages')).rows).toEqual([]);
    });

    test('concurrent staged writes cannot exceed a principal logical quota', async () => {
      const layer = new GatedByteStore();
      const quoted = stagedStore(layer, { quotaBytes: 10 });

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, (_, index) =>
          quoted.put(principal, new Blob([`${index}`.repeat(6)])),
        ),
      );

      const accepted = results.filter((result) => result.status === 'fulfilled');
      expect(accepted).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(AssetQuotaExceededError);
        }
      }
      const usage = await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(blobs.byte_size), 0)::text AS total
           FROM asset_entries AS entries
           JOIN asset_blobs AS blobs ON blobs.content_hash = entries.content_hash
          WHERE entries.principal = $1`,
        [principal.key],
      );
      expect(Number(usage.rows[0]!.total)).toBeLessThanOrEqual(10);
      // Every refused write released its pin.
      expect((await pool.query('SELECT * FROM asset_blob_stages')).rows).toEqual([]);
    });
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
    await pool.query(
      'TRUNCATE asset_root_refs, document_asset_refs, asset_entries, asset_blob_stages, asset_blobs',
    );
    await pool.query('TRUNCATE asset_reference_tracking, document_asset_withdrawals');
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
          AND key.constraint_schema = constraints.constraint_schema
        WHERE constraints.table_schema = current_schema()
          AND constraints.table_name = 'document_asset_refs'
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

  test('an insert-only reference writer on another instance is not swept past', async () => {
    // The entry pass's re-check used to fold "no reference row" into its
    // locking SELECT. That is snapshot-stale against a writer that inserts a
    // reference row WITHOUT updating the entry row: the statement blocks on
    // the FK's KEY SHARE, is granted it when that writer commits, finds the
    // entry row unchanged -- so no EvalPlanQual -- and keeps its own
    // statement-start answer of "no reference". The entry was deleted and the
    // cascade took the just-committed reference row with it, leaving the
    // document naming bytes that no longer exist.
    //
    // The backfill is exactly such a writer, and two collector instances are
    // enough: within one instance the backfill and the entry pass are
    // sequential.
    // Some store on this database tracks, which is all the marker proves --
    // and is the mixed deployment this scenario needs.
    await documents.saveDocument(stageWithImage('tracked-stage', 'tracked-scene', 'unallocated'));
    const id = await assets.put(principal, new Blob(['racing bytes']));
    // Eligible: pending and past its expiry. Written by a store with tracking
    // off, so no reference row exists yet -- the document a later instance's
    // backfill will find.
    const document = stageWithImage('insert-race-stage', 'insert-race-scene', id);
    await new PgDocumentStore(pool as Queryable, {
      withTransaction: transactionFor(pool),
    }).saveDocument(document);
    await pool.query(
      `UPDATE asset_entries SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1`,
      [id],
    );

    // Instance B: the backfill's insert, held open so its KEY SHARE is.
    const backfilling = await pool.connect();
    try {
      await backfilling.query('BEGIN');
      await backfillDocumentAssetReferences(backfilling as Queryable, {
        stageId: 'insert-race-stage',
        scope: sceneAssetScope('insert-race-scene', document.scenes[0]),
      });

      // Instance A: the entry pass, which must block on that KEY SHARE.
      const releasing = new AssetCollector(pool as Queryable, bytes, {
        withTransaction: transactionFor(pool),
        documentReferences: true,
        graceMs: 0,
      }).collectPass();
      await waitForLockWaiter(pool);

      await backfilling.query('COMMIT');
      const pass = await releasing;

      expect(pass.entriesCollected).toBe(0);
    } finally {
      backfilling.release();
    }

    // Both rows survived: the entry the document names, and the reference row
    // the backfill committed.
    expect((await assets.resolve(principal, id))?.bytes).toEqual(
      new TextEncoder().encode('racing bytes'),
    );
    expect(
      (await pool.query('SELECT 1 FROM document_asset_refs WHERE asset_id = $1', [id])).rows,
    ).toHaveLength(1);
  });

  test('a document write that cannot get the stage lock fails as lock contention', async () => {
    // Fired rather than described: the budget is 30 s in production, and the
    // hook below rewrites it to a value a test can wait for. What is under
    // test is the mapping, not the number.
    await documents.saveDocument(stageWithImage('lock-stage', 'lock-scene', 'unallocated'));
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT data FROM document_stages WHERE id = $1 FOR UPDATE', [
        'lock-stage',
      ]);

      const blocked = new PgDocumentStore(pool as Queryable, {
        withTransaction: impatientTransaction(pool),
        trackAssetReferences: true,
      });
      const renamed = stageWithImage('lock-stage', 'lock-scene', 'unallocated').stage;
      const failure = await blocked
        .putStage('lock-stage', { ...renamed, name: 'Renamed' })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StorageLockUnavailableError);
      expect((failure as StorageLockUnavailableError).reason).toBe('lock-timeout');
      expect(((failure as StorageLockUnavailableError).cause as { code?: string }).code).toBe(
        '55P03',
      );
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    // The write rolled back: the name is the one the first save wrote.
    const stored = await pool.query<{ name: string }>(
      'SELECT name FROM document_stages WHERE id = $1',
      ['lock-stage'],
    );
    expect(stored.rows[0]?.name).toBe('Referenced Course');
  });

  test('an entry pass that cannot get the entry lock fails as lock contention', async () => {
    const id = await assets.put(principal, new Blob(['locked entry']));
    await pool.query(
      `UPDATE asset_entries SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1`,
      [id],
    );
    await documents.saveDocument(
      stageWithImage('lock-entry-stage', 'lock-entry-scene', 'unallocated'),
    );
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM asset_entries WHERE id = $1 FOR UPDATE', [id]);

      const failure = await new AssetCollector(pool as Queryable, bytes, {
        withTransaction: impatientTransaction(pool),
        documentReferences: true,
        graceMs: 0,
      })
        .collectPass()
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StorageLockUnavailableError);
      expect((failure as StorageLockUnavailableError).reason).toBe('lock-timeout');
      // Contention keeps its own type rather than flattening into the generic
      // collection failure: a host retries on this and investigates the other.
      expect(failure).not.toBeInstanceOf(AssetCollectionFailure);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    expect((await assets.resolve(principal, id))?.bytes).toEqual(
      new TextEncoder().encode('locked entry'),
    );
  });

  test('legacy marking does not stamp an entry a concurrent backfill just referenced', async () => {
    // `markLegacyEntries` stamps the entries its walk found unreferenced. An
    // `UPDATE ... WHERE NOT EXISTS (refs)` takes FOR NO KEY UPDATE, which does
    // not conflict with the KEY SHARE an insert into document_asset_refs takes
    // on the entry it names -- so it neither waits for an insert-only writer
    // nor sees one that commits after its snapshot, and would stamp an entry
    // another instance's backfill had just given a reference. Not a loss, since
    // releaseEntries re-checks, but it under-counts the principal's live bytes
    // and starts a grace period that should not have started.
    await documents.saveDocument(stageWithImage('marker-stage', 'marker-scene', 'unallocated'));
    const legacy = await assets.put(principal, new Blob(['legacy bytes']));
    await pool.query(
      `UPDATE asset_entries SET committed_at = NULL, expires_at = NULL WHERE id = $1`,
      [legacy],
    );
    const untracked = new PgDocumentStore(pool as Queryable, {
      withTransaction: transactionFor(pool),
    });
    // One document for the walk to read, so its page is fixed before the
    // document below exists.
    await untracked.saveDocument(stageWithImage('walked-stage', 'walked-scene', 'unallocated'));

    let reachedDocument!: () => void;
    const atDocument = new Promise<void>((resolve) => {
      reachedDocument = resolve;
    });
    let releaseDocument!: () => void;
    const mayFinishWalk = new Promise<void>((resolve) => {
      releaseDocument = resolve;
    });
    let paused = false;
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
            if (!paused && text.includes('document_stages') && text.includes('FOR SHARE')) {
              paused = true;
              reachedDocument();
              await mayFinishWalk;
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

    // Instance A: its walk has already read its page of stage ids, and is now
    // inside the first document's transaction.
    const marking = new AssetCollector(pool as Queryable, bytes, {
      withTransaction: pausingTransaction,
      documentReferences: true,
      graceMs: 60 * 60 * 1000,
    }).collectPass();
    await atDocument;

    // A document A's page cannot contain, and instance B's insert-only
    // backfill of it, held open so its KEY SHARE is.
    const late = stageWithImage('late-stage', 'late-scene', legacy);
    await untracked.saveDocument(late);
    const backfilling = await pool.connect();
    try {
      await backfilling.query('BEGIN');
      await backfillDocumentAssetReferences(backfilling as Queryable, {
        stageId: 'late-stage',
        scope: sceneAssetScope('late-scene', late.scenes[0]),
      });

      releaseDocument();
      // A finishes its walk and reaches the marking, whose lock must wait for
      // the KEY SHARE held above. Tolerant of no waiter on purpose: a marking
      // that does not wait races ahead and stamps, which is the regression,
      // and the assertions below are what must catch it.
      expect(await settleForLockWaiter(pool)).toBe(true);
      await backfilling.query('COMMIT');
    } finally {
      backfilling.release();
    }
    const pass = await marking;

    expect(pass.legacyEntriesCommitted).toBe(1);
    const entry = await pool.query<{ committed_at: Date | null; unreferenced_at: Date | null }>(
      'SELECT committed_at, unreferenced_at FROM asset_entries WHERE id = $1',
      [legacy],
    );
    // Marked committed, and NOT stamped: a document names it.
    expect(entry.rows[0]?.committed_at).not.toBeNull();
    expect(entry.rows[0]?.unreferenced_at).toBeNull();
    expect(
      (await pool.query('SELECT 1 FROM document_asset_refs WHERE asset_id = $1', [legacy])).rows,
    ).toHaveLength(1);
  });

  test('the legacy mark honours a reference that arrives between two batches', async () => {
    // The mark used to lock every legacy row, and then every committed
    // unstamped row, in ONE transaction: every healthy entry on the
    // deployment, held for as long as the slowest lock took. Batched, each
    // transaction covers at most `batchSize` ids -- which means the database
    // can change underneath the walk between batches, and the batch that
    // arrives at a newly referenced entry must see the reference rather than
    // the snapshot it paged its candidates in.
    await documents.saveDocument(stageWithImage('batch-stage', 'batch-scene', 'unallocated'));
    const legacy: string[] = [];
    for (const index of [0, 1, 2, 3, 4, 5, 6]) {
      const minted = await assets.put(principal, new Blob([`legacy batch ${index}`]));
      const id = `legacy-batch-${index}`;
      await pool.query(
        `UPDATE asset_entries
            SET id = $2, committed_at = NULL, expires_at = NULL, unreferenced_at = NULL
          WHERE id = $1`,
        [minted, id],
      );
      legacy.push(id);
    }
    // Between the first batch and the second, a document starts naming an id
    // the second batch is about to reach. Committed on its own connection, so
    // only a statement taking a fresh snapshot can see it.
    const lateReference = 'legacy-batch-5';
    let markBatches = 0;
    const observing: WithTransaction = async (body) => {
      let isMarkBatch = false;
      const result = await transactionFor(pool)((queryable) =>
        body({
          async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
            text: string,
            params?: unknown[],
          ): Promise<QueryResult<TRow>> {
            if (text.includes('committed_at IS NULL AND expires_at IS NULL')) isMarkBatch = true;
            return queryable.query<TRow>(text, params);
          },
        }),
      );
      if (isMarkBatch) {
        markBatches += 1;
        if (markBatches === 1) {
          await pool.query(
            `INSERT INTO document_asset_refs (stage_id, scope, scene_id, asset_id)
             VALUES ('late-batch-stage', 'scene', 'late-batch-scene', $1)`,
            [lateReference],
          );
        }
      }
      return result;
    };

    const pass = await new AssetCollector(pool as Queryable, bytes, {
      withTransaction: observing,
      documentReferences: true,
      graceMs: 60 * 60 * 1000,
      batchSize: 3,
    }).collectPass();

    // Seven ids in batches of three: three transactions, none of them holding
    // more than three row locks.
    expect(markBatches).toBe(3);
    expect(pass.legacyEntriesCommitted).toBe(7);
    const rows = await pool.query<{ id: string; committed_at: Date | null; stamped: boolean }>(
      `SELECT id, committed_at, (unreferenced_at IS NOT NULL) AS stamped
         FROM asset_entries
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [legacy],
    );
    expect(rows.rows.map((row) => row.id)).toEqual(legacy);
    expect(rows.rows.filter((row) => row.committed_at === null)).toEqual([]);
    // Every one but the late-referenced id is stamped, and that one is not:
    // it is marked committed like the rest, and left alone.
    expect(rows.rows.filter((row) => !row.stamped).map((row) => row.id)).toEqual([lateReference]);
    // The stamps are `now()`, so nothing drained on the marking pass.
    expect(pass.entriesCollected).toBe(0);
  });

  describe('the standing sweep for entries nothing references any more', () => {
    const stampedIds = async (): Promise<string[]> => {
      const rows = await pool.query<{ id: string }>(
        'SELECT id FROM asset_entries WHERE unreferenced_at IS NOT NULL ORDER BY id',
      );
      return rows.rows.map((row) => row.id);
    };
    const hour = 60 * 60 * 1000;
    const sweeping = (batchSize?: number): AssetCollector =>
      new AssetCollector(pool as Queryable, bytes, {
        withTransaction: transactionFor(pool),
        documentReferences: true,
        graceMs: hour,
        ...(batchSize === undefined ? {} : { batchSize }),
      });

    test('a committed entry no document references is stamped, and drains after grace', async () => {
      // The legacy mark cannot reach this row -- it is committed, so it is not
      // legacy -- and no document write will either, because the reference row
      // went without one: a deleteDocument through a store with
      // trackAssetReferences off, a partial restore, rows removed out of band.
      // Nothing else in the system ever looks at such a row again:
      // releaseEntries takes only entries with expires_at or unreferenced_at
      // set, and the blob pass refuses a blob while any entry names it. The
      // entry, its bytes and its share of the principal quota were held
      // forever.
      const id = await assets.put(principal, new Blob(['orphaned bytes']));
      await documents.saveDocument(stageWithImage('orphan-stage', 'orphan-scene', id));
      await pool.query('DELETE FROM document_asset_refs WHERE asset_id = $1', [id]);
      // The gate is open: nothing on this database is legacy.
      expect(
        (
          await pool.query(
            'SELECT 1 FROM asset_entries WHERE committed_at IS NULL AND expires_at IS NULL',
          )
        ).rows,
      ).toEqual([]);
      expect(await stampedIds()).toEqual([]);

      const collector = sweeping();
      expect((await collector.collectPass()).entriesCollected).toBe(0);

      expect(await stampedIds()).toEqual([id]);
      // (iii): the stamp is now(), so it drains after the grace period rather
      // than on the pass that stamped it.
      expect((await collector.collectPass()).entriesCollected).toBe(0);
      await pool.query(
        `UPDATE asset_entries SET unreferenced_at = now() - interval '2 hours' WHERE id = $1`,
        [id],
      );
      expect((await collector.collectPass()).entriesCollected).toBe(1);
      expect((await pool.query('SELECT id FROM asset_entries WHERE id = $1', [id])).rows).toEqual(
        [],
      );
    });

    test('the sweep takes one bounded batch per pass and wraps at the end', async () => {
      // Four committed entries, three of them referenced. With a batch of two
      // the orphan is out of reach of the first pass: only a cursor that
      // advances gets to it, and only a cursor that wraps gets back to an
      // entry orphaned behind it.
      for (const index of [1, 2, 3, 4]) {
        const minted = await assets.put(principal, new Blob([`sweep ${index}`]));
        await pool.query(
          `UPDATE asset_entries
              SET id = $2, committed_at = now(), expires_at = NULL, unreferenced_at = NULL
            WHERE id = $1`,
          [minted, `sweep-${index}`],
        );
      }
      await pool.query(
        `INSERT INTO document_asset_refs (stage_id, scope, scene_id, asset_id)
         SELECT 'sweep-stage', 'scene', 'sweep-scene', id FROM unnest($1::text[]) AS id`,
        [['sweep-1', 'sweep-2', 'sweep-3']],
      );
      await documents.declareAssetReferenceTracking();
      const collector = sweeping(2);

      // Pass one reaches sweep-1 and sweep-2; both are referenced.
      await collector.collectPass();
      expect(await stampedIds()).toEqual([]);

      // Pass two reaches sweep-3 (referenced) and sweep-4 (the orphan).
      await collector.collectPass();
      expect(await stampedIds()).toEqual(['sweep-4']);

      // An entry BEHIND the cursor loses its last reference the same way.
      await pool.query(`DELETE FROM document_asset_refs WHERE asset_id = 'sweep-1'`);

      // Pass three finds nothing past the cursor and wraps rather than
      // stopping there forever.
      await collector.collectPass();
      expect(await stampedIds()).toEqual(['sweep-4']);

      // Pass four is back at the start.
      await collector.collectPass();
      expect(await stampedIds()).toEqual(['sweep-1', 'sweep-4']);
    });

    test('nothing is swept while the walk is unfinished', async () => {
      // Invariant (i) again: while a legacy entry exists the reference table
      // is a subset of the truth, so "no reference row" does not yet mean "no
      // document names it". Sweeping on that basis would start a grace period
      // for media a document still holds.
      // Committed, referenced by nothing, and named by no stored document --
      // so the walk cannot put its reference row back and only the sweep can
      // reach it.
      const orphan = await assets.put(principal, new Blob(['gated orphan']));
      await pool.query(
        `UPDATE asset_entries SET committed_at = now(), expires_at = NULL WHERE id = $1`,
        [orphan],
      );
      const legacy = await assets.put(principal, new Blob(['gate keeper']));
      await pool.query(
        `UPDATE asset_entries SET committed_at = NULL, expires_at = NULL WHERE id = $1`,
        [legacy],
      );
      // Two documents and one document per chunk, so the first pass cannot
      // finish the walk and the gate stays shut.
      await documents.saveDocument(stageWithImage('gated-stage', 'gated-scene', 'unallocated'));
      await documents.saveDocument(stageWithImage('gated-other', 'gated-scene', 'unallocated'));

      const paced = new AssetCollector(pool as Queryable, bytes, {
        withTransaction: transactionFor(pool),
        documentReferences: true,
        graceMs: hour,
        referenceBackfillBatchSize: 1,
      });
      const first = await paced.collectPass();

      expect(first.legacyEntriesCommitted).toBe(0);
      expect(await stampedIds()).toEqual([]);

      // Once the walk finishes and the mark runs, the gate opens and the same
      // orphan is swept.
      await paced.collectPass();
      expect(await stampedIds()).toContain(orphan);
    });
  });

  test('two full saves whose scopes cross the same ids both complete', async () => {
    // P2: a save used to take its entry locks in as many sequences as it had
    // scopes -- each scope's reference INSERT makes the foreign key take
    // KEY SHARE on the entries it names -- plus one more for the commit and
    // one for the stamp. Two saves whose commit set is the other's stamp set
    // could then hold what the other wanted. One ascending union lock at the
    // top of the transaction makes the second save queue instead.
    const ids: string[] = [];
    for (const name of ['cross-a', 'cross-z']) {
      const minted = await assets.put(principal, new Blob([`bytes ${name}`]));
      await pool.query('UPDATE asset_entries SET id = $2 WHERE id = $1', [minted, name]);
      ids.push(name);
    }
    // Crossed starting state: X holds cross-z, Y holds cross-a.
    await syncStageAssetReferences(pool as Queryable, {
      stageId: 'cross-x',
      scopes: [{ scope: 'stage', sceneId: '', candidates: ['cross-z'] }],
    });
    await syncStageAssetReferences(pool as Queryable, {
      stageId: 'cross-y',
      scopes: [{ scope: 'stage', sceneId: '', candidates: ['cross-a'] }],
    });

    let reachedLock!: () => void;
    const atLock = new Promise<void>((resolve) => {
      reachedLock = resolve;
    });
    let release!: () => void;
    const mayProceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pausingAtTheLock: WithTransaction = async (body) =>
      transactionFor(pool)((queryable) =>
        body({
          async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
            text: string,
            params?: unknown[],
          ): Promise<QueryResult<TRow>> {
            const answer = await queryable.query<TRow>(text, params);
            if (text.includes('FOR NO KEY UPDATE')) {
              reachedLock();
              await mayProceed;
            }
            return answer;
          },
        }),
      );

    // X now names cross-a (which Y is about to drop) and drops cross-z (which
    // Y is about to name), each in a different scope, higher id first.
    const savingX = pausingAtTheLock((queryable) =>
      syncStageAssetReferences(queryable, {
        stageId: 'cross-x',
        scopes: [
          { scope: 'stage', sceneId: '', candidates: [] },
          { scope: 'scene', sceneId: 'x-scene', candidates: ['cross-a'] },
        ],
      }),
    ).then(
      () => 'committed',
      (error: unknown) => `failed: ${String(error)}`,
    );
    await atLock;

    const savingY = transactionFor(pool)((queryable) =>
      syncStageAssetReferences(queryable, {
        stageId: 'cross-y',
        scopes: [
          { scope: 'stage', sceneId: '', candidates: ['cross-z'] },
          { scope: 'scene', sceneId: 'y-scene', candidates: [] },
        ],
      }),
    ).then(
      () => 'committed',
      (error: unknown) => `failed: ${String(error)}`,
    );
    // Y queues on X's union lock rather than acquiring one of the two rows and
    // cycling. Tolerant of no waiter on purpose: a save that does not wait is
    // the shape that could deadlock, and the assertions below are what catch
    // it either way.
    await settleForLockWaiter(pool);
    release();

    expect(await savingX).toBe('committed');
    expect(await savingY).toBe('committed');
    const rows = await pool.query<{ stage_id: string; asset_id: string }>(
      'SELECT stage_id, asset_id FROM document_asset_refs ORDER BY stage_id, asset_id',
    );
    expect(rows.rows).toEqual([
      { stage_id: 'cross-x', asset_id: 'cross-a' },
      { stage_id: 'cross-y', asset_id: 'cross-z' },
    ]);
    expect(ids).toHaveLength(2);
  });

  test('the legacy mark and a multi-scope save do not deadlock each other', async () => {
    // The other half of P2, and the one the reviewer reproduced: the mark
    // locks its batch ascending with FOR UPDATE, which conflicts with the
    // KEY SHARE a reference INSERT takes. While the save took those per scope,
    // a save whose first scope named the higher id could hold what the mark
    // wanted while waiting for what the mark held.
    for (const name of ['mark-a', 'mark-z']) {
      const minted = await assets.put(principal, new Blob([`bytes ${name}`]));
      await pool.query(
        `UPDATE asset_entries
            SET id = $2, committed_at = NULL, expires_at = NULL, unreferenced_at = NULL
          WHERE id = $1`,
        [minted, name],
      );
    }
    await documents.declareAssetReferenceTracking();

    let reachedInsert!: () => void;
    const atInsert = new Promise<void>((resolve) => {
      reachedInsert = resolve;
    });
    let release!: () => void;
    const mayProceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const pausingAfterFirstInsert: WithTransaction = async (body) =>
      transactionFor(pool)((queryable) =>
        body({
          async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
            text: string,
            params?: unknown[],
          ): Promise<QueryResult<TRow>> {
            const answer = await queryable.query<TRow>(text, params);
            if (!paused && text.includes('INSERT INTO document_asset_refs')) {
              paused = true;
              reachedInsert();
              await mayProceed;
            }
            return answer;
          },
        }),
      );

    const saving = pausingAfterFirstInsert((queryable) =>
      syncStageAssetReferences(queryable, {
        stageId: 'mark-stage',
        scopes: [
          // Higher id first: the order the per-scope inserts used to follow.
          { scope: 'stage', sceneId: '', candidates: ['mark-z'] },
          { scope: 'scene', sceneId: 'mark-scene', candidates: ['mark-a'] },
        ],
      }),
    ).then(
      () => 'committed',
      (error: unknown) => `failed: ${String(error)}`,
    );
    await atInsert;

    const marking = new AssetCollector(pool as Queryable, bytes, {
      withTransaction: transactionFor(pool),
      documentReferences: true,
      graceMs: 60 * 60 * 1000,
    })
      .collectPass()
      .then(
        (pass) => `resolved ${pass.legacyEntriesCommitted}`,
        (error: unknown) => `failed: ${String(error)}`,
      );
    await settleForLockWaiter(pool);
    release();

    expect(await saving).toBe('committed');
    // The mark queued behind the save and then found both rows committed by
    // it, which the predicate re-check under the lock drops from the batch --
    // so it marks nothing and, crucially, is not aborted.
    expect(await marking).toBe('resolved 0');
    const rows = await pool.query<{ id: string; committed: boolean }>(
      `SELECT id, committed_at IS NOT NULL AS committed FROM asset_entries ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { id: 'mark-a', committed: true },
      { id: 'mark-z', committed: true },
    ]);
  });

  test('two saves sharing asset ids both complete', async () => {
    // Two documents of one principal naming the same assets -- a slide copied
    // between courses -- saved at the same time. Each locks the entry rows it
    // commits; unordered, the two can hold what the other wants, and the
    // deadlock victim's save is aborted. Ordered, they queue.
    const shared: string[] = [];
    for (const index of [0, 1, 2, 3]) {
      shared.push(await assets.put(principal, new Blob([`shared save ${index}`])));
    }
    const namingAll = (stageId: string, refs: string[]): MaicDocument =>
      ({
        stage: { id: stageId, name: 'Shared Course', createdAt: 1000, updatedAt: 2000 },
        scenes: [
          {
            id: `${stageId}-scene`,
            stageId,
            title: `${stageId}-scene`,
            order: 0,
            type: 'slide',
            content: {
              type: 'slide',
              canvas: {
                id: `canvas-${stageId}`,
                elements: refs.map((src) => ({ type: 'image', src })),
              },
            },
          },
        ],
      }) as unknown as MaicDocument;

    // Opposite document orders, so nothing but the sort decides the lock order.
    const results = await Promise.allSettled([
      documents.saveDocument(namingAll('share-a', shared)),
      documents.saveDocument(namingAll('share-b', [...shared].reverse())),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await pool.query<{ asset_id: string }>(
      'SELECT DISTINCT asset_id FROM document_asset_refs ORDER BY asset_id',
    );
    expect(rows.rows.map((row) => row.asset_id)).toEqual([...shared].sort());
  });

  test('a backfill that cannot lock its document reports both the contention and the document', async () => {
    // Contention with a document to name keeps both facts: the typed error is
    // the cause, so `instanceof` still answers "retry", and `stageId` says
    // which document stalled the walk.
    await documents.saveDocument(stageWithImage('stalled-stage', 'stalled-scene', 'unallocated'));
    const legacy = await assets.put(principal, new Blob(['stalled legacy'])); // gives the walk a reason
    await pool.query(
      `UPDATE asset_entries SET committed_at = NULL, expires_at = NULL WHERE id = $1`,
      [legacy],
    );
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT data FROM document_stages WHERE id = $1 FOR UPDATE', [
        'stalled-stage',
      ]);

      const failure = await new AssetCollector(pool as Queryable, bytes, {
        withTransaction: impatientTransaction(pool),
        documentReferences: true,
        graceMs: 0,
      })
        .collectPass()
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AssetCollectionFailure);
      expect((failure as AssetCollectionFailure).stageId).toBe('stalled-stage');
      const cause = (failure as AssetCollectionFailure).cause;
      expect(cause).toBeInstanceOf(StorageLockUnavailableError);
      expect((cause as StorageLockUnavailableError).reason).toBe('lock-timeout');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    // Nothing was marked, so the entry level released nothing.
    const entry = await pool.query<{ committed_at: Date | null }>(
      'SELECT committed_at FROM asset_entries WHERE id = $1',
      [legacy],
    );
    expect(entry.rows[0]?.committed_at).toBeNull();
  });

  describe('declaring that this deployment maintains references', () => {
    const markers = async (): Promise<number> =>
      (await pool.query('SELECT singleton FROM asset_reference_tracking')).rows.length;

    test('a deployment that has not written yet is refused, and the declaration lifts it', async () => {
      // The state a cold install is in: schemas ensured, documents present,
      // nobody has saved anything since the deploy. Nothing has written the
      // marker, so the entry level refuses on every interval -- the backfill
      // cannot even start -- and a host watching for that refusal reads a
      // healthy deployment as a broken pairing.
      const legacy = await assets.put(principal, new Blob(['cold install bytes']));
      const untracked = new PgDocumentStore(pool as Queryable, {
        withTransaction: transactionFor(pool),
      });
      await untracked.saveDocument(stageWithImage('cold-stage', 'cold-scene', legacy));
      await pool.query(
        `UPDATE asset_entries SET committed_at = NULL, expires_at = NULL WHERE id = $1`,
        [legacy],
      );
      const collector = (): AssetCollector =>
        new AssetCollector(pool as Queryable, bytes, {
          withTransaction: transactionFor(pool),
          documentReferences: true,
          graceMs: 60 * 60 * 1000,
        });

      await expect(collector().collectPass()).rejects.toBeInstanceOf(
        AssetReferenceTrackingNotEnabledError,
      );
      expect(await markers()).toBe(0);

      await documents.declareAssetReferenceTracking();

      // Eligible immediately, rather than after the first write that happens
      // to arrive: the walk runs and the legacy entry is marked.
      const pass = await collector().collectPass();
      expect(pass.backfilledDocuments).toBeGreaterThan(0);
      expect(pass.legacyEntriesCommitted).toBe(1);
    });

    test('is idempotent and writes nothing else', async () => {
      await documents.declareAssetReferenceTracking();
      await documents.declareAssetReferenceTracking();

      expect(await markers()).toBe(1);
      // No reference row, no document, no lifecycle column touched.
      expect((await pool.query('SELECT 1 FROM document_asset_refs')).rows).toEqual([]);
      expect((await pool.query('SELECT 1 FROM document_stages')).rows).toEqual([]);
      expect((await pool.query('SELECT 1 FROM asset_entries')).rows).toEqual([]);
    });

    test('a store that does not maintain references cannot declare that anything does', async () => {
      const untracked = new PgDocumentStore(pool as Queryable, {
        withTransaction: transactionFor(pool),
      });

      await expect(untracked.declareAssetReferenceTracking()).rejects.toBeInstanceOf(
        DocumentAssetReferencesDisabledError,
      );

      // Refused before any write: the marker it would have silenced the
      // collector with is not there.
      expect(await markers()).toBe(0);
    });
  });

  describe('releasing an allocation no document claimed', () => {
    const entryExists = async (id: string): Promise<boolean> => {
      const rows = await pool.query('SELECT 1 FROM asset_entries WHERE id = $1', [id]);
      return rows.rows.length === 1;
    };

    const blobStamp = async (id: string): Promise<Date | null | undefined> => {
      const rows = await pool.query<{ unreferenced_at: Date | null }>(
        `SELECT blobs.unreferenced_at
           FROM asset_entries AS entries
           JOIN asset_blobs AS blobs ON blobs.content_hash = entries.content_hash
          WHERE entries.id = $1`,
        [id],
      );
      return rows.rows[0]?.unreferenced_at;
    };
    const hashOf = async (id: string): Promise<string> => {
      const rows = await pool.query<{ content_hash: string }>(
        'SELECT content_hash FROM asset_entries WHERE id = $1',
        [id],
      );
      return rows.rows[0]!.content_hash;
    };
    const blobStampByHash = async (hash: string): Promise<Date | null | undefined> => {
      const rows = await pool.query<{ unreferenced_at: Date | null }>(
        'SELECT unreferenced_at FROM asset_blobs WHERE content_hash = $1',
        [hash],
      );
      return rows.rows[0]?.unreferenced_at;
    };

    test('deletes a pending, unreferenced entry and stamps its blob like remove()', async () => {
      const released = await assets.put(principal, new Blob(['never claimed']));
      const removed = await assets.put(principal, new Blob(['removed instead']));
      const releasedHash = await hashOf(released);
      const removedHash = await hashOf(removed);
      expect(await blobStamp(released)).toBeNull();

      await expect(assets.releasePending(principal, released)).resolves.toBe(true);
      await assets.remove(principal, removed);

      expect(await entryExists(released)).toBe(false);
      // Both paths leave the bytes stamped for the blob pass, and nothing else.
      expect(await blobStampByHash(releasedHash)).toBeInstanceOf(Date);
      expect(await blobStampByHash(removedHash)).toBeInstanceOf(Date);
      await expect(assets.releasePending(principal, released)).resolves.toBe(false);
    });

    test('does not stamp a blob another entry still names', async () => {
      const bytes = 'shared by two entries';
      const released = await assets.put(principal, new Blob([bytes]));
      const kept = await assets.put(principal, new Blob([bytes]));

      await expect(assets.releasePending(principal, released)).resolves.toBe(true);

      expect(await blobStamp(kept)).toBeNull();
    });

    test('keeps an entry whose reference a reference-only writer commits meanwhile', async () => {
      // The backfill's shape: insert a reference row (KEY SHARE on the entry),
      // never update the entry. A release that folds its reference check into
      // the locking or deleting statement waits on that lock, keeps its stale
      // "no reference" answer, and cascades the committed row away.
      const id = await assets.put(principal, new Blob(['backfilled meanwhile']));
      const backfill = await pool.connect();
      try {
        await backfill.query('BEGIN');
        await backfill.query(
          `INSERT INTO document_asset_refs (stage_id, scope, scene_id, asset_id)
           VALUES ('backfill-stage', 'scene', 'backfill-scene', $1)`,
          [id],
        );
        const releasing = assets.releasePending(principal, id);
        await waitForLockWaiter(pool);
        await backfill.query('COMMIT');

        await expect(releasing).resolves.toBe(false);
      } finally {
        backfill.release();
      }

      expect(await entryExists(id)).toBe(true);
      const refs = await pool.query('SELECT 1 FROM document_asset_refs WHERE asset_id = $1', [id]);
      expect(refs.rows).toHaveLength(1);
    });

    test('leaves an entry a document committed and references', async () => {
      const id = await assets.put(principal, new Blob(['claimed by a course']));
      await documents.saveDocument(stageWithImage('release-stage', 'release-scene', id));

      await expect(assets.releasePending(principal, id)).resolves.toBe(false);
      expect(await entryExists(id)).toBe(true);
    });

    test('leaves a committed entry whose references were withdrawn', async () => {
      const id = await assets.put(principal, new Blob(['committed then withdrawn']));
      await documents.saveDocument(stageWithImage('released-stage', 'released-scene', id));
      await documents.withdrawAssetReferences('released-stage');

      await expect(assets.releasePending(principal, id)).resolves.toBe(false);
      expect(await entryExists(id)).toBe(true);
    });

    test('leaves another principal s pending entry', async () => {
      const id = await assets.put(principal, new Blob(['someone else s']));

      await expect(assets.releasePending({ key: 'someone-else' }, id)).resolves.toBe(false);
      expect(await entryExists(id)).toBe(true);
    });
  });

  describe('withdrawing references from a tombstoned document', () => {
    const refsOf = async (stageId: string): Promise<string[]> => {
      const rows = await pool.query<{ asset_id: string }>(
        'SELECT asset_id FROM document_asset_refs WHERE stage_id = $1 ORDER BY asset_id',
        [stageId],
      );
      return rows.rows.map((row) => row.asset_id);
    };
    const withdrawals = async (): Promise<string[]> => {
      const rows = await pool.query<{ stage_id: string }>(
        'SELECT stage_id FROM document_asset_withdrawals ORDER BY stage_id',
      );
      return rows.rows.map((row) => row.stage_id);
    };
    const stampOf = async (id: string): Promise<Date | null> => {
      const rows = await pool.query<{ unreferenced_at: Date | null }>(
        'SELECT unreferenced_at FROM asset_entries WHERE id = $1',
        [id],
      );
      return rows.rows[0]?.unreferenced_at ?? null;
    };

    test('releases the document s references and stamps what loses its last one', async () => {
      const id = await assets.put(principal, new Blob(['tombstoned bytes']));
      await documents.saveDocument(stageWithImage('tomb-stage', 'tomb-scene', id));
      expect(await refsOf('tomb-stage')).toEqual([id]);

      await expect(documents.withdrawAssetReferences('tomb-stage')).resolves.toBe(true);

      expect(await refsOf('tomb-stage')).toEqual([]);
      expect(await stampOf(id)).not.toBeNull();
      // The document is untouched: this is the half of deleteDocument that
      // releases assets, and a host that keeps its rows keeps its rows.
      expect(
        (await pool.query('SELECT id FROM document_stages WHERE id = $1', ['tomb-stage'])).rows,
      ).toHaveLength(1);
      expect(await documents.loadDocument('tomb-stage')).not.toBeNull();
    });

    test('is idempotent, and says it found the document either time', async () => {
      const id = await assets.put(principal, new Blob(['twice withdrawn']));
      await documents.saveDocument(stageWithImage('twice-stage', 'twice-scene', id));

      expect(await documents.withdrawAssetReferences('twice-stage')).toBe(true);
      const first = await stampOf(id);
      expect(await documents.withdrawAssetReferences('twice-stage')).toBe(true);

      // `true` is "this store found the document", not "something changed" --
      // the document is still there. And the second call must not push the
      // grace period out by re-stamping.
      expect(await stampOf(id)).toEqual(first);
      expect(await refsOf('twice-stage')).toEqual([]);
    });

    test('an asset another document still names is not stamped', async () => {
      const shared = await assets.put(principal, new Blob(['shared bytes']));
      await documents.saveDocument(stageWithImage('shared-a', 'shared-scene', shared));
      await documents.saveDocument(stageWithImage('shared-b', 'shared-scene', shared));

      expect(await documents.withdrawAssetReferences('shared-a')).toBe(true);

      expect(await refsOf('shared-a')).toEqual([]);
      expect(await refsOf('shared-b')).toEqual([shared]);
      expect(await stampOf(shared)).toBeNull();
    });

    test('a document in another scope is withdrawn from nothing, and is not distinguishable from an absent one', async () => {
      const id = await assets.put(principal, new Blob(['owned bytes']));
      const owned = new PgDocumentStore(pool as Queryable, {
        withTransaction: transactionFor(pool),
        trackAssetReferences: true,
        documentOwnership: CONTRACT_OWNERSHIP,
      }).forOwner('withdraw-owner-a');
      await owned.saveDocument(stageWithImage('owner-stage', 'owner-scene', id));
      const foreign = new PgDocumentStore(pool as Queryable, {
        withTransaction: transactionFor(pool),
        trackAssetReferences: true,
        documentOwnership: CONTRACT_OWNERSHIP,
      }).forOwner('withdraw-owner-b');

      expect(await foreign.withdrawAssetReferences('owner-stage')).toBe(false);
      expect(await foreign.withdrawAssetReferences('no-such-stage')).toBe(false);

      // Nothing of the owner's was touched by either answer.
      expect(await refsOf('owner-stage')).toEqual([id]);
      expect(await stampOf(id)).toBeNull();
      expect(await owned.withdrawAssetReferences('owner-stage')).toBe(true);
      expect(await stampOf(id)).not.toBeNull();
    });

    test('a store that does not maintain references refuses rather than answering', async () => {
      const id = await assets.put(principal, new Blob(['untracked bytes']));
      await documents.saveDocument(stageWithImage('untracked-stage', 'untracked-scene', id));
      const untracked = new PgDocumentStore(pool as Queryable, {
        withTransaction: transactionFor(pool),
      });

      await expect(untracked.withdrawAssetReferences('untracked-stage')).rejects.toBeInstanceOf(
        DocumentAssetReferencesDisabledError,
      );

      // Answering "nothing to withdraw" instead would let a host retire the
      // document believing its assets were released.
      expect(await refsOf('untracked-stage')).toEqual([id]);
      expect(await stampOf(id)).toBeNull();
    });

    test('the backfill does not re-reference what a withdrawal released', async () => {
      // The document rows stay, so the stored JSON still names the asset. A
      // one-time backfill that walked it afterwards used to re-insert the
      // reference row, leaving the entry both referenced (so the entry pass
      // skips it) and stamped (and nothing rewrites a retired document to
      // clear that) -- a permanent leak, which is the failure withdrawing was
      // added to prevent.
      const id = await assets.put(principal, new Blob(['withdrawn bytes']));
      const hash = (await contentHashOf(new Blob(['withdrawn bytes']))).contentHash;
      await documents.saveDocument(stageWithImage('race-tomb-stage', 'race-tomb-scene', id));
      await documents.withdrawAssetReferences('race-tomb-stage');
      // A legacy entry, so the walk runs at all.
      const legacy = await assets.put(principal, new Blob(['legacy company']));
      await pool.query(
        `UPDATE asset_entries SET committed_at = NULL, expires_at = NULL WHERE id = $1`,
        [legacy],
      );

      // A pass that completes the walk. The document must come out of it with
      // no reference row: that is the regression.
      const hour = 60 * 60 * 1000;
      const collector = (): AssetCollector =>
        new AssetCollector(pool as Queryable, bytes, {
          withTransaction: transactionFor(pool),
          documentReferences: true,
          graceMs: hour,
        });
      const walked = await collector().collectPass();
      expect(walked.backfilledDocuments).toBeGreaterThan(0);
      expect(await refsOf('race-tomb-stage')).toEqual([]);
      expect(await stampOf(id)).not.toBeNull();

      // Past the grace period, explicitly rather than by clock luck.
      await pool.query(
        `UPDATE asset_entries SET unreferenced_at = now() - interval '2 hours' WHERE id = $1`,
        [id],
      );
      const released = await collector().collectPass();

      expect(released.entriesCollected).toBe(1);
      expect((await pool.query('SELECT id FROM asset_entries WHERE id = $1', [id])).rows).toEqual(
        [],
      );
      // And the blob follows, which is the point of releasing the entry.
      await pool.query(
        `UPDATE asset_blobs SET unreferenced_at = now() - interval '2 hours'
          WHERE content_hash = $1`,
        [hash],
      );
      expect((await collector().collectPass()).collected).toBe(1);
      expect(
        (await pool.query('SELECT content_hash FROM asset_blobs WHERE content_hash = $1', [hash]))
          .rows,
      ).toEqual([]);
    });

    /**
     * The walk must re-reference whatever a live, unwalked document names,
     * stamp or no stamp.
     *
     * While the walk is behind, a stamp says only "no reference ROW exists",
     * and an unwalked pre-tracking document has no rows by definition -- so an
     * entry it names looks unreferenced to every other writer, and any write
     * that drops that entry elsewhere stamps it. A walk that refused to
     * re-reference a stamped entry would leave the live document with no row
     * and the entry pass would delete its media. Re-referencing is the safe
     * direction: `releaseEntries` skips a referenced entry, and if the live
     * document later drops it for real, the stamp it already carries is past
     * grace and it goes then.
     *
     * Both cases below set the stamp from a DIFFERENT document's ordinary
     * write, which is why the withdrawal record cannot help: the live document
     * was never retired.
     */
    const liveSharerKeepsItsAsset = async (
      label: string,
      dropTheOtherHolder: (stageId: string, sceneId: string, ref: string) => Promise<void>,
    ): Promise<void> => {
      const shared = await assets.put(principal, new Blob([`${label} bytes`]));
      const untracked = new PgDocumentStore(pool as Queryable, {
        withTransaction: transactionFor(pool),
      });
      // Pre-tracking and still live: named in stored JSON, no reference row.
      await untracked.saveDocument(stageWithImage(`${label}-live`, `${label}-scene`, shared));
      // A tracked document that also names it, and then stops.
      await documents.saveDocument(stageWithImage(`${label}-other`, `${label}-scene`, shared));
      await dropTheOtherHolder(`${label}-other`, `${label}-scene`, shared);
      expect(await stampOf(shared)).not.toBeNull();
      const legacy = await assets.put(principal, new Blob([`${label} legacy`]));
      await pool.query(
        `UPDATE asset_entries SET committed_at = NULL, expires_at = NULL WHERE id = $1`,
        [legacy],
      );

      const hour = 60 * 60 * 1000;
      const collector = (): AssetCollector =>
        new AssetCollector(pool as Queryable, bytes, {
          withTransaction: transactionFor(pool),
          documentReferences: true,
          graceMs: hour,
        });
      expect((await collector().collectPass()).backfilledDocuments).toBeGreaterThan(0);

      // The live document got its row back. The stamp is still there -- the
      // backfill inserts rows and touches no lifecycle column -- so the entry
      // is referenced AND stamped, which is precisely the state that is safe:
      // being referenced is what protects it, and the stale stamp only decides
      // how soon it goes once it stops being referenced.
      expect(await refsOf(`${label}-live`)).toEqual([shared]);
      expect(await stampOf(shared)).not.toBeNull();
      await pool.query(
        `UPDATE asset_entries SET unreferenced_at = now() - interval '2 hours' WHERE id = $1`,
        [shared],
      );

      expect((await collector().collectPass()).entriesCollected).toBe(0);
      expect((await assets.resolve(principal, shared))?.bytes).toEqual(
        new TextEncoder().encode(`${label} bytes`),
      );

      // The other half of "safe direction": once the live document really
      // stops naming it, the row goes and it is collected on the next pass.
      await documents.saveDocument(
        stageWithImage(`${label}-live`, `${label}-scene`, 'unallocated'),
      );
      expect(await refsOf(`${label}-live`)).toEqual([]);
      await pool.query(
        `UPDATE asset_entries SET unreferenced_at = now() - interval '2 hours' WHERE id = $1`,
        [shared],
      );
      expect((await collector().collectPass()).entriesCollected).toBe(1);
      expect(
        (await pool.query('SELECT id FROM asset_entries WHERE id = $1', [shared])).rows,
      ).toEqual([]);
    };

    test('a live unwalked document keeps an asset another document s deletion stamped', async () => {
      await liveSharerKeepsItsAsset('d2', async (stageId) => {
        await documents.deleteDocument(stageId);
      });
    });

    test('a live unwalked document keeps an asset another document s edit stamped', async () => {
      await liveSharerKeepsItsAsset('d3', async (stageId, sceneId) => {
        // Same stage, same scene, no longer naming the asset.
        await documents.putScene(
          stageId,
          stageWithImage(stageId, sceneId, 'unallocated').scenes[0],
        );
      });
    });

    test('withdrawing a document that predates tracking is honoured too', async () => {
      // The mirror case, and the one a stamp alone cannot cover: this document
      // has no reference rows to remove, so the withdrawal stamps nothing, and
      // only the recorded withdrawal can keep the walk from reading its JSON
      // and referencing the entry it names.
      const legacy = await assets.put(principal, new Blob(['pre-tracking bytes']));
      const untracked = new PgDocumentStore(pool as Queryable, {
        withTransaction: transactionFor(pool),
      });
      await untracked.saveDocument(stageWithImage('pre-stage', 'pre-scene', legacy));
      await pool.query(
        `UPDATE asset_entries SET committed_at = NULL, expires_at = NULL WHERE id = $1`,
        [legacy],
      );
      expect(await refsOf('pre-stage')).toEqual([]);

      expect(await documents.withdrawAssetReferences('pre-stage')).toBe(true);

      // The walk must skip it, so the legacy marking finds the entry
      // referenced by nothing and stamps it.
      const hour = 60 * 60 * 1000;
      const collector = (): AssetCollector =>
        new AssetCollector(pool as Queryable, bytes, {
          withTransaction: transactionFor(pool),
          documentReferences: true,
          graceMs: hour,
        });
      const walked = await collector().collectPass();
      expect(walked.legacyEntriesCommitted).toBeGreaterThan(0);
      expect(await refsOf('pre-stage')).toEqual([]);
      expect(await stampOf(legacy)).not.toBeNull();

      // (iii) again: the stamp is `now()`, so the entry drains after grace and
      // not on the pass that stamped it.
      expect((await collector().collectPass()).entriesCollected).toBe(0);
      await pool.query(
        `UPDATE asset_entries SET unreferenced_at = now() - interval '2 hours' WHERE id = $1`,
        [legacy],
      );
      const released = await collector().collectPass();

      expect(released.entriesCollected).toBe(1);
      expect(
        (await pool.query('SELECT id FROM asset_entries WHERE id = $1', [legacy])).rows,
      ).toEqual([]);
    });

    test('a live document keeps an asset a retired one also named', async () => {
      // The reason the withdrawal does not stamp by enumerating the retired
      // document's JSON: a shared id whose other holder the walk had not
      // reached yet would be released out from under it. The withdrawal stamps
      // only what actually lost its last row, and the walk settles the rest.
      const shared = await assets.put(principal, new Blob(['shared pre-tracking']));
      const untracked = new PgDocumentStore(pool as Queryable, {
        withTransaction: transactionFor(pool),
      });
      await untracked.saveDocument(stageWithImage('live-share', 'live-scene', shared));
      await untracked.saveDocument(stageWithImage('retired-share', 'retired-scene', shared));
      await pool.query(
        `UPDATE asset_entries SET committed_at = NULL, expires_at = NULL WHERE id = $1`,
        [shared],
      );

      expect(await documents.withdrawAssetReferences('retired-share')).toBe(true);
      await new AssetCollector(pool as Queryable, bytes, {
        withTransaction: transactionFor(pool),
        documentReferences: true,
        graceMs: 60 * 60 * 1000,
      }).collectPass();

      // The live document's walk referenced it; the retired one's was skipped.
      expect(await refsOf('live-share')).toEqual([shared]);
      expect(await refsOf('retired-share')).toEqual([]);
      expect(await stampOf(shared)).toBeNull();
      const released = await new AssetCollector(pool as Queryable, bytes, {
        withTransaction: transactionFor(pool),
        documentReferences: true,
        graceMs: 0,
      }).collectPass();
      expect(released.entriesCollected).toBe(0);
    });

    test('deleting a withdrawn document takes its withdrawal record with it', async () => {
      // The record is a fact about a document. Left behind, it would be
      // inherited by whatever later claims the id -- the walk would skip that
      // document, and on a deployment where some writer does not track
      // references there would be no write to clear it.
      const id = await assets.put(principal, new Blob(['deleted after withdrawal']));
      await documents.saveDocument(stageWithImage('gone-stage', 'gone-scene', id));
      await documents.withdrawAssetReferences('gone-stage');
      expect(await withdrawals()).toEqual(['gone-stage']);

      await documents.deleteDocument('gone-stage');

      expect(await withdrawals()).toEqual([]);
      expect(
        (await pool.query('SELECT id FROM document_stages WHERE id = $1', ['gone-stage'])).rows,
      ).toEqual([]);
    });

    test('saving the stage again re-establishes its references', async () => {
      // How a host un-retires a course: no special path, just a write.
      const id = await assets.put(principal, new Blob(['restored bytes']));
      const document = stageWithImage('restore-stage', 'restore-scene', id);
      await documents.saveDocument(document);
      await documents.withdrawAssetReferences('restore-stage');
      expect(await stampOf(id)).not.toBeNull();

      await documents.saveDocument(document);

      expect(await refsOf('restore-stage')).toEqual([id]);
      expect(await stampOf(id)).toBeNull();
      // And the withdrawal is forgotten, so the walk may read it again.
      expect(await withdrawals()).toEqual([]);
    });

    test('an incremental write after a withdrawal re-references only its own scope', async () => {
      const id = await assets.put(principal, new Blob(['scene bytes']));
      const document = stageWithImage('partial-stage', 'partial-scene', id);
      await documents.saveDocument(document);
      await documents.withdrawAssetReferences('partial-stage');

      await documents.putScene('partial-stage', document.scenes[0]);

      expect(await refsOf('partial-stage')).toEqual([id]);
      expect(await stampOf(id)).toBeNull();
    });
  });

  test('removing the entry cascades its reference rows away', async () => {
    const id = await assets.put(principal, new Blob(['cascade bytes']));
    await documents.saveDocument(stageWithImage('cascade-stage', 'cascade-scene', id));

    await assets.remove(principal, id);

    expect((await pool.query('SELECT 1 FROM document_asset_refs')).rows).toEqual([]);
  });

  describe('reference roots', () => {
    const principals = [principal.key];
    const HOUR = 60 * 60 * 1000;

    const change = (queryable: Queryable, input: Omit<ChangeAssetRootsInput, 'principals'>) =>
      changeAssetRoots(queryable, { principals, ...input });
    const addTo = (rootId: string, id: string) => ({
      add: [{ rootKind: 'material', rootId, assetIds: [id] }],
    });
    const removeFrom = (rootId: string, id: string) => ({
      remove: [{ rootKind: 'material', rootId, assetIds: [id] }],
    });
    const referenceIn = (queryable: Queryable, stageId: string, id: string) =>
      syncDocumentAssetReferences(queryable, {
        stageId,
        scope: { scope: 'scene', sceneId: 'scene-a', candidates: [id] },
      });
    const stampOf = async (id: string): Promise<Date | null | undefined> =>
      (
        await pool.query<{ unreferenced_at: Date | null }>(
          'SELECT unreferenced_at FROM asset_entries WHERE id = $1',
          [id],
        )
      ).rows[0]?.unreferenced_at;
    const rootsOf = async (id: string): Promise<string[]> =>
      (
        await pool.query<{ root_id: string }>(
          'SELECT root_id FROM asset_root_refs WHERE asset_id = $1 ORDER BY root_id',
          [id],
        )
      ).rows.map((row) => row.root_id);
    const entryExists = async (id: string): Promise<boolean> =>
      (await pool.query('SELECT 1 FROM asset_entries WHERE id = $1', [id])).rows.length > 0;
    const passAt = (now: Date, graceMs = 0) =>
      new AssetCollector(pool as Queryable, bytes, {
        withTransaction: transactionFor(pool),
        documentReferences: true,
        graceMs,
        now: () => now,
      }).collectPass();

    const backendPid = async (queryable: Queryable): Promise<number> =>
      Number(
        (await queryable.query<{ pid: number | string }>('SELECT pg_backend_pid() AS pid')).rows[0]!
          .pid,
      );

    /**
     * Wait until some backend is blocked by THIS holder's locks. Narrower than
     * waitForLockWaiter, which any lock wait anywhere in the database would
     * satisfy -- another suite's, say -- and so could let a test go on before
     * its own second transaction had actually queued behind its holder.
     */
    const waitUntilBlockedBy = async (holderPid: number): Promise<void> => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const blocked = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`,
          [holderPid],
        );
        if (blocked.rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('nothing queued behind the holder: the operations never contended');
    };

    /**
     * Run `first` in a transaction held open, start `second` in its own, prove
     * `second` is waiting on a lock `first` holds, then commit `first` and let
     * `second` finish. A `second` that did not contend fails here rather than
     * passing by luck of timing.
     */
    const serialized = async (
      first: (queryable: Queryable) => Promise<unknown>,
      second: (queryable: Queryable) => Promise<unknown>,
    ): Promise<void> => {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        const holderPid = await backendPid(holder as Queryable);
        await first(holder as Queryable);
        const waiting = transactionFor(pool)((queryable) => second(queryable));
        await waitUntilBlockedBy(holderPid);
        await holder.query('COMMIT');
        await waiting;
      } catch (error) {
        await holder.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        holder.release();
      }
    };

    beforeEach(async () => {
      await pool.query(
        `INSERT INTO asset_reference_tracking (singleton, enabled_at)
         VALUES (TRUE, now()) ON CONFLICT DO NOTHING`,
      );
    });

    test('provisions the cascading root foreign key', async () => {
      const foreignKey = await pool.query<{ delete_rule: string }>(
        `SELECT delete_rule
           FROM information_schema.referential_constraints
          WHERE constraint_schema = current_schema()
            AND constraint_name = 'asset_root_refs_asset_id_fkey'`,
      );
      expect(foreignKey.rows).toEqual([{ delete_rule: 'CASCADE' }]);
    });

    describe('the generic mutation paths against a concurrent root writer', () => {
      /**
       * Wait until `waiter` itself queues behind `holder`, not merely until
       * someone does. Gives up well inside the test timeout, so a failure
       * reaches the cleanup below instead of leaving a paused transaction
       * holding its locks.
       */
      const waitUntilWaiting = async (waiter: number, holder: number): Promise<void> => {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const blocked = await pool.query<{ blocked: boolean }>(
            'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked',
            [waiter, holder],
          );
          if (blocked.rows[0]?.blocked) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('the operation under test never queued behind the holder');
      };

      /**
       * A store whose transaction reports its own backend pid once it has begun
       * and, when `pauseAfter` matches a statement, stops right after it --
       * holding every lock taken so far -- until `release` is called.
       */
      const instrumentedStore = (pauseAfter?: RegExp) => {
        let reportPid!: (pid: number) => void;
        const pid = new Promise<number>((resolve) => {
          reportPid = resolve;
        });
        let reachedPause!: () => void;
        const paused = new Promise<void>((resolve) => {
          reachedPause = resolve;
        });
        let release!: () => void;
        const mayProceed = new Promise<void>((resolve) => {
          release = resolve;
        });
        const withTransaction: WithTransaction = async (body) => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            reportPid(await backendPid(client as Queryable));
            const result = await body({
              async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
                text: string,
                params?: unknown[],
              ): Promise<QueryResult<TRow>> {
                const answer = await (client as Queryable).query<TRow>(text, params);
                if (pauseAfter?.test(text)) {
                  reachedPause();
                  await mayProceed;
                }
                return answer;
              },
            });
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        };
        const store = new PgAssetStore(pool as Queryable, { byteStore: bytes, withTransaction });
        return { store, pid, paused, release };
      };

      /** A root writer in a transaction of its own, reporting its backend pid. */
      const startRootWriter = (id: string) => {
        let reportPid!: (pid: number) => void;
        const pid = new Promise<number>((resolve) => {
          reportPid = resolve;
        });
        const done = transactionFor(pool)(async (queryable) => {
          reportPid(await backendPid(queryable));
          await change(queryable, addTo('material-1', id));
        });
        return { pid, done };
      };

      /**
       * Hold a committed-later root on `id` in an open transaction, start
       * `mutate` on an instrumented store, prove that store's own backend is
       * waiting on the holder, then commit the root. Whatever fails on the way,
       * the holder rolls back and `mutate` is settled before this returns.
       */
      const mutateBehindRoot = async (
        id: string,
        mutate: (store: PgAssetStore) => Promise<unknown>,
      ): Promise<{ mutation: Promise<unknown> }> => {
        const holder = await pool.connect();
        const mutator = instrumentedStore();
        let mutation: Promise<unknown> | undefined;
        try {
          await holder.query('BEGIN');
          const holderPid = await backendPid(holder as Queryable);
          await change(holder as Queryable, addTo('material-1', id));
          mutation = mutate(mutator.store);
          mutation.catch(() => undefined);
          await waitUntilWaiting(await mutator.pid, holderPid);
          await holder.query('COMMIT');
          return { mutation };
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          holder.release();
          await mutation?.catch(() => undefined);
        }
      };

      /**
       * Pause `mutate` right after `pauseAfter` with its entry lock held, start
       * a root writer, prove the root writer's own backend waits on it, then let
       * the mutation finish. The pause is lifted and both sides are settled
       * whatever fails on the way.
       */
      const rootBehindMutation = async (
        id: string,
        pauseAfter: RegExp,
        mutate: (store: PgAssetStore) => Promise<unknown>,
      ): Promise<{ mutation: Promise<unknown>; rooting: Promise<void> }> => {
        const mutator = instrumentedStore(pauseAfter);
        const mutation = mutate(mutator.store);
        mutation.catch(() => undefined);
        let rooting: Promise<void> | undefined;
        try {
          await Promise.race([
            mutator.paused,
            mutation.then(() => {
              throw new Error('the mutation finished without reaching its pause point');
            }),
          ]);
          const writer = startRootWriter(id);
          rooting = writer.done;
          rooting.catch(() => undefined);
          await waitUntilWaiting(await writer.pid, await mutator.pid);
        } finally {
          mutator.release();
          await Promise.allSettled([mutation, rooting ?? Promise.resolve()]);
        }
        return { mutation, rooting };
      };

      const textOf = async (id: string): Promise<string | undefined> => {
        const read = await assets.resolve(principal, id);
        return read ? Buffer.from(read.bytes).toString() : undefined;
      };

      test('a remove that queues behind a root writer sees the committed root and refuses', async () => {
        const id = await assets.put(principal, new Blob(['rooted while waiting']));

        // The remove's FOR UPDATE waits on the root writer's entry lock; the
        // root commits first, and the check after the wait must see it. A
        // check folded into the DELETE would keep its older snapshot, delete
        // the entry and cascade the fresh root away.
        const { mutation } = await mutateBehindRoot(id, (store) => store.remove(principal, id));

        await expect(mutation).rejects.toBeInstanceOf(AssetRootedError);
        expect(await entryExists(id)).toBe(true);
        expect(await rootsOf(id)).toEqual(['material-1']);
      });

      test('a root writer that queues behind a remove finds the entry gone', async () => {
        const id = await assets.put(principal, new Blob(['removed first']));

        const { mutation, rooting } = await rootBehindMutation(
          id,
          /^\s*DELETE FROM asset_entries/,
          (store) => store.remove(principal, id),
        );

        await mutation;
        await expect(rooting).rejects.toBeInstanceOf(AssetRootTargetError);
        expect(await entryExists(id)).toBe(false);
        expect(await rootsOf(id)).toEqual([]);
      });

      test('a replace that queues behind a root writer refuses and keeps the bytes', async () => {
        const id = await assets.put(principal, new Blob(['original bytes']));

        const { mutation } = await mutateBehindRoot(id, (store) =>
          store.replace(principal, id, new Blob(['replacement'])),
        );

        await expect(mutation).rejects.toBeInstanceOf(AssetRootedError);
        expect(await textOf(id)).toBe('original bytes');
        expect(await rootsOf(id)).toEqual(['material-1']);
      });

      test('a root writer that queues behind a replace roots the replaced entry', async () => {
        const id = await assets.put(principal, new Blob(['before replace']));

        const { mutation, rooting } = await rootBehindMutation(
          id,
          /^\s*UPDATE asset_entries/,
          (store) => store.replace(principal, id, new Blob(['after replace'])),
        );

        await mutation;
        await rooting;
        expect(await textOf(id)).toBe('after replace');
        expect(await rootsOf(id)).toEqual(['material-1']);
      });
    });

    describe('the reference-rule version', () => {
      const ruleVersion = async (): Promise<number> =>
        Number(
          (
            await pool.query<{ v: number }>(
              'SELECT rule_version AS v FROM asset_reference_tracking',
            )
          ).rows[0]!.v,
        );
      const setRuleVersion = (version: number) =>
        pool.query('UPDATE asset_reference_tracking SET rule_version = $1', [version]);

      test('a root change raises a marker an older writer left', async () => {
        const id = await assets.put(principal, new Blob(['raises the version']));
        await setRuleVersion(1);
        await transactionFor(pool)((queryable) => change(queryable, addTo('material-v', id)));
        expect(await ruleVersion()).toBe(ASSET_REFERENCE_RULE_VERSION);
        await setRuleVersion(1);
        await transactionFor(pool)((queryable) => change(queryable, removeFrom('material-v', id)));
        expect(await ruleVersion()).toBe(ASSET_REFERENCE_RULE_VERSION);
      });

      test('once raised, a writer does not queue on the marker row', async () => {
        await setRuleVersion(ASSET_REFERENCE_RULE_VERSION);
        const holder = await pool.connect();
        try {
          await holder.query('BEGIN');
          const holderPid = await backendPid(holder as Queryable);
          await holder.query('SELECT 1 FROM asset_reference_tracking FOR UPDATE');
          // Raised already: the write finishes while the marker row is held.
          await transactionFor(pool)((queryable) => recordAssetReferenceTracking(queryable));

          // Not raised yet: the write does wait for the row, which is what
          // shows this test can tell the two apart.
          await holder.query('COMMIT');
          await pool.query('UPDATE asset_reference_tracking SET rule_version = 1');
          await holder.query('BEGIN');
          await holder.query('SELECT 1 FROM asset_reference_tracking FOR UPDATE');
          const raising = transactionFor(pool)((queryable) =>
            recordAssetReferenceTracking(queryable),
          );
          await waitUntilBlockedBy(holderPid);
          await holder.query('COMMIT');
          await raising;
          expect(await ruleVersion()).toBe(ASSET_REFERENCE_RULE_VERSION);
        } catch (error) {
          await holder.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          holder.release();
        }
      });

      test('a version raised while a pass waits on an entry stops the deletion', async () => {
        await setRuleVersion(ASSET_REFERENCE_RULE_VERSION);
        const id = await assets.put(principal, new Blob(['kept by a newer kind']));
        await transactionFor(pool)((queryable) => change(queryable, addTo('material-x', id)));
        await transactionFor(pool)((queryable) => change(queryable, removeFrom('material-x', id)));
        expect(await stampOf(id)).not.toBeNull();

        // A writer of a newer kind holds the entry, as its reference row's
        // foreign key would, and raises the version before it lets go.
        const holder = await pool.connect();
        try {
          await holder.query('BEGIN');
          const holderPid = await backendPid(holder as Queryable);
          await holder.query('SELECT 1 FROM asset_entries WHERE id = $1 FOR KEY SHARE', [id]);
          const pass = passAt(new Date(Date.now() + HOUR)).catch((error: unknown) => error);
          await waitUntilBlockedBy(holderPid);
          await holder.query('UPDATE asset_reference_tracking SET rule_version = $1', [
            ASSET_REFERENCE_RULE_VERSION + 1,
          ]);
          await holder.query('COMMIT');

          const failure = await pass;
          expect(failure).toBeInstanceOf(AssetReferenceRuleVersionError);
          expect(failure).toMatchObject({ databaseVersion: ASSET_REFERENCE_RULE_VERSION + 1 });
          expect(await entryExists(id)).toBe(true);
        } catch (error) {
          await holder.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          holder.release();
          await setRuleVersion(ASSET_REFERENCE_RULE_VERSION);
        }
      });
    });

    test('an entry held only by a root outlives its pending deadline', async () => {
      const id = await assets.put(principal, new Blob(['rooted only']));
      await transactionFor(pool)((queryable) => change(queryable, addTo('material-1', id)));

      const lifecycle = await pool.query<{ committed_at: Date | null; expires_at: Date | null }>(
        'SELECT committed_at, expires_at FROM asset_entries WHERE id = $1',
        [id],
      );
      expect(lifecycle.rows[0]?.committed_at).not.toBeNull();
      expect(lifecycle.rows[0]?.expires_at).toBeNull();
      const pass = await passAt(new Date(Date.now() + 3 * 24 * HOUR));
      expect(pass.entriesCollected).toBe(0);
      expect(await entryExists(id)).toBe(true);
    });

    test('a course withdrawal leaves a rooted entry alone; letting go of both drains it', async () => {
      const id = await assets.put(principal, new Blob(['held twice']));
      await referenceIn(pool as Queryable, 'course-1', id);
      await transactionFor(pool)((queryable) => change(queryable, addTo('material-1', id)));

      await transactionFor(pool)((queryable) =>
        removeDocumentAssetReferences(queryable, { stageId: 'course-1' }),
      );
      expect(await stampOf(id)).toBeNull();
      expect((await passAt(new Date(Date.now() + 2 * HOUR))).entriesCollected).toBe(0);

      await transactionFor(pool)((queryable) => change(queryable, removeFrom('material-1', id)));
      expect(await stampOf(id)).not.toBeNull();
      expect((await passAt(new Date(), HOUR)).entriesCollected).toBe(0);
      expect((await passAt(new Date(Date.now() + 2 * HOUR), HOUR)).entriesCollected).toBe(1);
      expect(await entryExists(id)).toBe(false);
    });

    test('adding a root clears a stamp the entry already carries', async () => {
      const id = await assets.put(principal, new Blob(['brought back']));
      await referenceIn(pool as Queryable, 'course-1', id);
      await removeDocumentAssetReferences(pool as Queryable, { stageId: 'course-1' });
      expect(await stampOf(id)).not.toBeNull();

      await transactionFor(pool)((queryable) => change(queryable, addTo('material-1', id)));

      expect(await stampOf(id)).toBeNull();
    });

    test('a root added while the collector waits keeps the entry', async () => {
      const id = await assets.put(principal, new Blob(['rescued']));
      await pool.query(
        `UPDATE asset_entries SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1`,
        [id],
      );

      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        const holderPid = await backendPid(holder as Queryable);
        await change(holder as Queryable, addTo('material-1', id));
        const releasing = passAt(new Date());
        await waitUntilBlockedBy(holderPid);
        await holder.query('COMMIT');
        expect((await releasing).entriesCollected).toBe(0);
      } finally {
        holder.release();
      }

      expect(await entryExists(id)).toBe(true);
      expect(await rootsOf(id)).toEqual(['material-1']);
    });

    test('a root added after the collector took the entry is refused, not left dangling', async () => {
      const id = await assets.put(principal, new Blob(['already gone']));
      await pool.query(
        `UPDATE asset_entries SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1`,
        [id],
      );
      // The collector's release transaction, held open after its DELETE.
      let signalDeleted!: () => void;
      const deleted = new Promise<void>((resolve) => {
        signalDeleted = resolve;
      });
      let allowCommit!: () => void;
      const mayCommit = new Promise<void>((resolve) => {
        allowCommit = resolve;
      });
      let releasePid = 0;
      const holdAfterRelease: WithTransaction = async (body) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const pid = await backendPid(client as Queryable);
          let released = false;
          const result = await body({
            async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
              text: string,
              params?: unknown[],
            ): Promise<QueryResult<TRow>> {
              if (text.startsWith('DELETE FROM asset_entries')) released = true;
              return (client as Queryable).query<TRow>(text, params);
            },
          });
          if (released) {
            releasePid = pid;
            signalDeleted();
            await mayCommit;
          }
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      };
      const releasing = new AssetCollector(pool as Queryable, bytes, {
        withTransaction: holdAfterRelease,
        documentReferences: true,
        graceMs: 0,
      }).collectPass();
      await deleted;

      // Settled into a value at once: it rejects while `releasing` is still
      // being awaited, and an unobserved rejection would fail the run.
      const rooting = transactionFor(pool)((queryable) =>
        change(queryable, addTo('material-1', id)),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitUntilBlockedBy(releasePid);
      allowCommit();

      expect((await releasing).entriesCollected).toBe(1);
      expect(await rooting).toBeInstanceOf(AssetRootTargetError);
      expect(await entryExists(id)).toBe(false);
      expect(await rootsOf(id)).toEqual([]);
    });

    test('the legacy mark and the standing sweep do not stamp a rooted entry', async () => {
      // Roots written directly, bypassing changeAssetRoots, so each entry keeps
      // the exact state the collector predicate under test selects on.
      const legacy = await assets.put(principal, new Blob(['legacy rooted']));
      await pool.query(
        'UPDATE asset_entries SET committed_at = NULL, expires_at = NULL WHERE id = $1',
        [legacy],
      );
      const swept = await assets.put(principal, new Blob(['swept rooted']));
      await pool.query(
        'UPDATE asset_entries SET committed_at = now(), expires_at = NULL WHERE id = $1',
        [swept],
      );
      await pool.query(
        `INSERT INTO asset_root_refs (root_kind, root_id, asset_id)
         VALUES ('material', 'legacy-owner', $1), ('material', 'swept-owner', $2)`,
        [legacy, swept],
      );

      // First pass: the (empty) walk completes and the legacy entry is marked.
      // Second pass: the standing sweep reaches the committed ones.
      expect((await passAt(new Date())).legacyEntriesCommitted).toBe(1);
      await passAt(new Date());

      for (const id of [legacy, swept]) {
        const row = await pool.query<{ committed_at: Date | null; unreferenced_at: Date | null }>(
          'SELECT committed_at, unreferenced_at FROM asset_entries WHERE id = $1',
          [id],
        );
        expect(row.rows[0]?.committed_at).not.toBeNull();
        expect(row.rows[0]?.unreferenced_at).toBeNull();
      }
      expect((await passAt(new Date(Date.now() + 3 * 24 * HOUR))).entriesCollected).toBe(0);
      expect(await entryExists(legacy)).toBe(true);
      expect(await entryExists(swept)).toBe(true);
    });

    test('a rooted entry carrying a stale stamp reaches the final check and is kept', async () => {
      const id = await assets.put(principal, new Blob(['kept by its root']));
      await transactionFor(pool)((queryable) => change(queryable, addTo('material-1', id)));
      // Past grace on the column alone: only the release's post-lock
      // reference check can keep it.
      await pool.query(
        `UPDATE asset_entries SET unreferenced_at = now() - interval '2 days' WHERE id = $1`,
        [id],
      );

      expect((await passAt(new Date(), HOUR)).entriesCollected).toBe(0);
      expect(await entryExists(id)).toBe(true);
      expect(await rootsOf(id)).toEqual(['material-1']);
    });

    test('a course withdrawal and a root being added serialize, in either order', async () => {
      for (const withdrawFirst of [true, false]) {
        const id = await assets.put(principal, new Blob([`withdraw-${withdrawFirst}`]));
        const stageId = `course-${withdrawFirst}`;
        await referenceIn(pool as Queryable, stageId, id);
        const withdraw = (queryable: Queryable) =>
          removeDocumentAssetReferences(queryable, { stageId });
        const root = (queryable: Queryable) => change(queryable, addTo(`material-${id}`, id));

        await (withdrawFirst ? serialized(withdraw, root) : serialized(root, withdraw));

        expect(await rootsOf(id)).toEqual([`material-${id}`]);
        expect(await stampOf(id)).toBeNull();
      }
    });

    test('a root being removed and a course reference being added serialize, in either order', async () => {
      for (const unrootFirst of [true, false]) {
        const id = await assets.put(principal, new Blob([`unroot-${unrootFirst}`]));
        await transactionFor(pool)((queryable) => change(queryable, addTo('material-1', id)));
        const unroot = (queryable: Queryable) => change(queryable, removeFrom('material-1', id));
        const reference = (queryable: Queryable) =>
          referenceIn(queryable, `course-${unrootFirst}`, id);

        await (unrootFirst ? serialized(unroot, reference) : serialized(reference, unroot));

        expect(await rootsOf(id)).toEqual([]);
        expect(await stampOf(id)).toBeNull();
      }
    });

    test('adding and removing roots of one entry serialize on its row lock, in either order', async () => {
      for (const removeFirst of [true, false]) {
        const id = await assets.put(principal, new Blob([`move-${removeFirst}`]));
        await transactionFor(pool)((queryable) => change(queryable, addTo('material-a', id)));
        const remove = (queryable: Queryable) => change(queryable, removeFrom('material-a', id));
        const add = (queryable: Queryable) => change(queryable, addTo('material-b', id));

        await (removeFirst ? serialized(remove, add) : serialized(add, remove));

        expect(await rootsOf(id)).toEqual(['material-b']);
        expect(await stampOf(id)).toBeNull();
      }
    });
  });
});
