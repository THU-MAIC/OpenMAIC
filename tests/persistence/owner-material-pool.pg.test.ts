/**
 * Owner material pool uploads against real PostgreSQL, where a second
 * connection can actually wait on a lock: an upload's publication queued
 * behind an owner claim, and the pool-first reader's fallback holding the
 * owner's fence against a claim. Every lock wait is asserted on the backend of
 * the operation under test, never on "some backend waits".
 */
import { createHash, randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withMaterialRoots } from '@/lib/persistence/material-roots';
import { registerClaimParticipant, claimOwner } from '@/lib/persistence/owner-claims';
import {
  abandonOwnerMaterial,
  allocateOwnerMaterialBytes,
  finalizeOwnerMaterial,
  publishOwnerMaterialUpload,
  registerOwnerMaterial,
} from '@/lib/persistence/owner-materials';
import { isOwnerRetiredError } from '@/lib/persistence/owner-merges';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import { migrateOwnerMaterialsToPool } from '@/lib/server/materials/migrate-to-pool';
import { readOwnerMaterialBytes } from '@/lib/server/materials/owner-material-bytes';

import {
  ACCOUNT,
  ANON,
  bootExtractionHarness,
  type ExtractionHarness,
} from './_owner-extraction-scenarios';

const contractUrl = process.env.PG_CONTRACT_URL;

if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl) {
  throw new Error('STORAGE_PG_CONTRACT_REQUIRED=1 needs PG_CONTRACT_URL');
}

/**
 * A pool that runs `onQuery` before each statement whose text `match` finds,
 * on the connection that is about to run it, so a test can act at exactly that
 * point of a transaction. Everything else is the real pool.
 */
class HookedPool {
  /** Runs before the `nth` (default first) statement `match` finds, then is cleared. */
  hook: { match: RegExp; nth?: number; run: (client: PoolClient) => Promise<void> } | undefined;
  private seen = 0;

  constructor(readonly pool: Pool) {}

  query(text: string, params?: unknown[]) {
    return this.pool.query(text, params);
  }

  async connect() {
    const client = await this.pool.connect();
    const runHook = async (text: string) => {
      const hook = this.hook;
      if (hook && hook.match.test(text)) {
        this.seen += 1;
        if (this.seen < (hook.nth ?? 1)) return;
        this.hook = undefined;
        this.seen = 0;
        await hook.run(client);
      }
    };
    return {
      async query(text: string, params?: unknown[]) {
        await runHook(text);
        return client.query(text, params);
      },
      release: (error?: Error | boolean) => client.release(error),
    };
  }

  end() {
    return this.pool.end();
  }
}

let serial = 0;

describe.skipIf(!contractUrl)('owner material pool uploads on PostgreSQL', () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let schema: string;

  async function boot(): Promise<{ h: ExtractionHarness; hooked: HookedPool }> {
    serial += 1;
    schema = `openmaic_owner_material_pool_test_${serial}`;
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: contractUrl,
      options: `-c search_path=${schema}`,
      max: 8,
    });
    const hooked = new HookedPool(pool);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=owner-material-pool-${serial}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    const h = await bootExtractionHarness(hooked as never, databaseUrl);
    return { h, hooked };
  }

  afterEach(async () => {
    setMaterialByteStoreForTests(null);
    vi.unstubAllEnvs();
    await pool?.end();
    pool = undefined;
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    admin = undefined;
  });

  const backendPid = async (client: { query: PoolClient['query'] }): Promise<number> =>
    Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);

  /**
   * The backend `holder` blocks whose current statement matches `statement`:
   * the operation under test, identified by what it is doing.
   */
  const waiterBehind = async (holder: number, statement: string): Promise<number> => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const found = await admin!.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE $1::int = ANY(pg_blocking_pids(pid)) AND query LIKE $2`,
        [holder, `%${statement}%`],
      );
      if (found.rows[0]) return Number(found.rows[0].pid);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`nothing running ${statement} queued behind backend ${holder}`);
  };

  const reserve = (h: ExtractionHarness, id: string, bytes: Buffer, ossKey = '') =>
    registerOwnerMaterial(
      h.pool as unknown as ConnectableQueryable,
      {
        id,
        ownerId: ANON,
        kind: 'source',
        mime: 'application/pdf',
        bytes: bytes.byteLength,
        originalName: `${id}.pdf`,
        ossKey,
        extraction: { status: 'idle' },
      },
      { maxCount: 100, maxTotalBytes: 1_000_000 },
    );
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

  it('queues an upload publication behind a running claim, then refuses it for the retired owner', async () => {
    // A claim participant that holds the claim open, its identity locks taken
    // and the owner's rows already moved, until the test lets it finish.
    let claimPid!: (pid: number) => void;
    const claimRunning = new Promise<number>((resolve) => {
      claimPid = resolve;
    });
    let finishClaim!: () => void;
    const claimMayFinish = new Promise<void>((resolve) => {
      finishClaim = resolve;
    });
    const { h } = await boot();
    registerClaimParticipant({
      name: `test-hold-${randomUUID()}`,
      order: 10_000,
      async rekey(tx) {
        claimPid(await backendPid(tx as never));
        await claimMayFinish;
      },
    });

    const bytes = Buffer.from('%PDF-queued-publication');
    await reserve(h, 'mat-queued', bytes);
    const assetId = await allocateOwnerMaterialBytes(h.provider, ANON, bytes, 'application/pdf');

    const claiming = claimOwner(ANON, ACCOUNT, { provider: h.provider });
    claiming.catch(() => undefined);
    let publishing: Promise<unknown> | undefined;
    try {
      const holder = await claimRunning;
      publishing = publishOwnerMaterialUpload(h.provider, ANON, 'mat-queued', {
        assetId,
        bytes: bytes.byteLength,
        sha256: digest(bytes),
      });
      publishing.catch(() => undefined);
      // The publication's own backend waits on the claim at the owner fence.
      await waiterBehind(holder, 'pg_advisory_xact_lock_shared');
    } finally {
      finishClaim();
      await Promise.allSettled([claiming, publishing ?? Promise.resolve()]);
    }
    await claiming;

    const outcome = await publishing!.catch((error: unknown) => error);
    expect(isOwnerRetiredError(outcome)).toBe(true);
    const roots = await pool!.query(
      `SELECT 1 FROM asset_root_refs WHERE root_kind = 'material' AND root_id = $1`,
      ['mat-queued'],
    );
    expect(roots.rows).toEqual([]);

    // The route's cleanup follows the claim to where the reservation is now.
    await abandonOwnerMaterial(h.provider, ANON, 'mat-queued');
    const left = await pool!.query('SELECT 1 FROM owner_material WHERE id = $1', ['mat-queued']);
    expect(left.rows).toEqual([]);
  });

  it('holds the owner fence across the reader’s re-read and pool read, so a claim waits', async () => {
    const { h, hooked } = await boot();
    // Nothing in the material byte store: the record's old object is gone.
    setMaterialByteStoreForTests({
      deletePrefix: async () => {
        throw new Error('Unexpected deletePrefix in this byte-store fixture');
      },
      list: async () => {
        throw new Error('Unexpected list in this byte-store fixture');
      },
      put: async () => undefined,
      get: async (key) => {
        throw new Error(`no object ${key}`);
      },
      delete: async () => undefined,
    });
    const bytes = Buffer.from('%PDF-migrated-then-claimed');
    await reserve(h, 'mat-reread', bytes, 'objects/mat-reread');
    await finalizeOwnerMaterial(h.pool as never, 'mat-reread', bytes.byteLength, digest(bytes));
    // What the backfill did meanwhile: pointer and root published.
    const assetId = await allocateOwnerMaterialBytes(h.provider, ANON, bytes, 'application/pdf');
    await withMaterialRoots(
      h.provider,
      { ownerId: ANON, fence: 'background', materialIds: ['mat-reread'] },
      async ({ tx, changeRoots }) => {
        await changeRoots({ add: [{ materialId: 'mat-reread', assetIds: [assetId] }] });
        await tx.query('UPDATE owner_material SET asset_id = $2 WHERE id = $1', [
          'mat-reread',
          assetId,
        ]);
      },
    );
    // The record a reader took before the backfill.
    const stale = {
      id: 'mat-reread',
      ownerId: ANON,
      assetId: null,
      ossKey: 'objects/mat-reread',
      sha256: digest(bytes),
    };

    // Right after the re-read, a claim of the owner starts. It must queue
    // behind the reader's fence until the pool read is done.
    let claiming: Promise<unknown> | undefined;
    hooked.hook = {
      match: /SELECT owner_id, asset_id, oss_key, sha256 FROM owner_material WHERE id = \$1/,
      async run(client) {
        const reader = await backendPid(client);
        claiming = claimOwner(ANON, ACCOUNT, { provider: h.provider });
        claiming.catch(() => undefined);
        await waiterBehind(reader, 'pg_advisory_xact_lock(');
      },
    };

    let read: Buffer | undefined;
    try {
      read = await readOwnerMaterialBytes(stale);
    } finally {
      await claiming?.catch(() => undefined);
    }
    expect(read).toEqual(bytes);
    expect(claiming).toBeDefined();
    await claiming;
    const moved = await pool!.query<{ owner_id: string }>(
      'SELECT owner_id FROM owner_material WHERE id = $1',
      ['mat-reread'],
    );
    expect(moved.rows).toEqual([{ owner_id: ACCOUNT }]);
  });

  /** A ready pre-pool library source on the owner extraction queue, eligible for backfill. */
  async function legacyRow(h: ExtractionHarness, id: string, objects: Map<string, Buffer>) {
    const bytes = Buffer.from(`%PDF-${id}`);
    objects.set(`objects/${id}`, bytes);
    await reserve(h, id, bytes, `objects/${id}`);
    await finalizeOwnerMaterial(h.pool as never, id, bytes.byteLength, digest(bytes));
    await h.pool.query(
      `UPDATE owner_material SET extraction = '{"status":"pending"}'::jsonb WHERE id = $1`,
      [id],
    );
    return bytes;
  }
  const memoryObjects = () => {
    const objects = new Map<string, Buffer>();
    setMaterialByteStoreForTests({
      deletePrefix: async (prefix) => {
        for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key);
      },
      list: async () => {
        throw new Error('Unexpected list in this byte-store fixture');
      },
      put: async (key, body) => void objects.set(key, Buffer.from(body as Uint8Array)),
      get: async (key) => {
        const value = objects.get(key);
        if (!value) throw new Error(`no object ${key}`);
        return value;
      },
      delete: async (key) => void objects.delete(key),
    });
    return objects;
  };
  const entriesOf = async () =>
    (
      await pool!.query<{ id: string; principal: string; committed_at: unknown }>(
        'SELECT id, principal, committed_at FROM asset_entries ORDER BY id',
      )
    ).rows;
  const rootsOf = async (id: string) =>
    (
      await pool!.query<{ asset_id: string }>(
        `SELECT asset_id FROM asset_root_refs WHERE root_kind = 'material' AND root_id = $1`,
        [id],
      )
    ).rows.map((row) => row.asset_id);

  it('serializes two backfills publishing the same row on its row lock: one pointer, one root', async () => {
    const { h, hooked } = await boot();
    const objects = memoryObjects();
    await legacyRow(h, 'mat-twice', objects);

    // The first backfill stops inside its publication, the material row
    // locked, and the second starts then: its own publication must queue on
    // that lock rather than read the row's still-empty pointer.
    let second: ReturnType<typeof migrateOwnerMaterialsToPool> | undefined;
    let firstPid = 0;
    let secondPid = 0;
    hooked.hook = {
      match:
        /SELECT owner_id, status, deleted_at, asset_id, [\s\S]* AS classic FROM owner_material WHERE id = \$1/,
      async run(client) {
        firstPid = await backendPid(client);
        second = migrateOwnerMaterialsToPool({ pauseMs: 0 });
        second.catch(() => undefined);
        secondPid = await waiterBehind(firstPid, 'FOR UPDATE');
      },
    };
    let first: Awaited<ReturnType<typeof migrateOwnerMaterialsToPool>> | undefined;
    try {
      first = await migrateOwnerMaterialsToPool({ pauseMs: 0 });
    } finally {
      await second?.catch(() => undefined);
    }
    const secondReport = await second!;

    expect(secondPid).not.toBe(firstPid);
    expect(first).toMatchObject({ migrated: 1, failed: 0 });
    expect(secondReport).toMatchObject({ migrated: 0, skippedLost: 1, failed: 0 });
    expect(first!.oldBytesRemoved + secondReport.oldBytesRemoved).toBe(1);
    const row = await pool!.query<{ asset_id: string; oss_key: string }>(
      'SELECT asset_id, oss_key FROM owner_material WHERE id = $1',
      ['mat-twice'],
    );
    expect(row.rows[0]!.oss_key).toBe('');
    expect(await rootsOf('mat-twice')).toEqual([row.rows[0]!.asset_id]);
    // Two allocations, one published; the loser removed its own.
    expect(await entriesOf()).toEqual([
      expect.objectContaining({ id: row.rows[0]!.asset_id, committed_at: expect.anything() }),
    ]);
    expect(objects.has('objects/mat-twice')).toBe(false);
  });

  it('follows a claim that lands between a backfill’s allocation and its publication', async () => {
    const { h, hooked } = await boot();
    const objects = memoryObjects();
    const bytes = await legacyRow(h, 'mat-claimed', objects);

    // Before the publication takes its fence (the second fence of the row,
    // after the allocation's), the owner is claimed for real: the row moves
    // and the pending allocation is re-keyed to the account.
    let allocatedUnder: string | undefined;
    hooked.hook = {
      match: /pg_advisory_xact_lock_shared/,
      nth: 2,
      async run() {
        allocatedUnder = (await entriesOf())[0]?.principal;
        await claimOwner(ANON, ACCOUNT, { provider: h.provider });
      },
    };

    const report = await migrateOwnerMaterialsToPool({ pauseMs: 0 });

    expect(allocatedUnder).toBe(assetPrincipalForOwner(ANON).key);
    expect(report).toMatchObject({ migrated: 1, oldBytesRemoved: 1, failed: 0 });
    const row = await pool!.query<{ owner_id: string; asset_id: string; oss_key: string }>(
      'SELECT owner_id, asset_id, oss_key FROM owner_material WHERE id = $1',
      ['mat-claimed'],
    );
    expect(row.rows[0]).toMatchObject({ owner_id: ACCOUNT, oss_key: '' });
    expect(await rootsOf('mat-claimed')).toEqual([row.rows[0]!.asset_id]);
    expect(await entriesOf()).toEqual([
      expect.objectContaining({
        id: row.rows[0]!.asset_id,
        principal: assetPrincipalForOwner(ACCOUNT).key,
      }),
    ]);
    expect(objects.has('objects/mat-claimed')).toBe(false);
    expect(
      await readOwnerMaterialBytes({
        id: 'mat-claimed',
        ownerId: ACCOUNT,
        assetId: row.rows[0]!.asset_id,
        ossKey: '',
        sha256: digest(bytes),
      }),
    ).toEqual(bytes);
  });

  it('reads a retained old object after a SQL error in the fenced pool read, and leaves no aborted transaction', async () => {
    const { h } = await boot();
    const objects = memoryObjects();
    const bytes = await legacyRow(h, 'mat-retained', objects);
    // Migrated, but the old object's delete failed: pointer, root and oss_key.
    const assetId = await allocateOwnerMaterialBytes(h.provider, ANON, bytes, 'application/pdf');
    await withMaterialRoots(
      h.provider,
      { ownerId: ANON, fence: 'background', materialIds: ['mat-retained'] },
      async ({ tx, changeRoots }) => {
        await changeRoots({ add: [{ materialId: 'mat-retained', assetIds: [assetId] }] });
        await tx.query('UPDATE owner_material SET asset_id = $2 WHERE id = $1', [
          'mat-retained',
          assetId,
        ]);
      },
    );
    // Every pool read now fails in the database itself.
    await pool!.query('ALTER TABLE asset_entries RENAME TO asset_entries_away');
    try {
      expect(
        await readOwnerMaterialBytes({
          id: 'mat-retained',
          ownerId: ANON,
          assetId,
          ossKey: 'objects/mat-retained',
          sha256: digest(bytes),
        }),
      ).toEqual(bytes);
      const aborted = await admin!.query(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'idle in transaction (aborted)'`,
      );
      expect(aborted.rows).toEqual([]);
    } finally {
      await pool!.query('ALTER TABLE asset_entries_away RENAME TO asset_entries');
    }
    // The connections are fine afterwards.
    const after = await h.provider.withTransaction((tx) =>
      tx.query<{ n: string }>('SELECT count(*)::text AS n FROM asset_entries'),
    );
    expect(after.rows).toEqual([{ n: '1' }]);
  });

  it('leaves no pending allocation behind when two backfills race over 30 rows', async () => {
    const { h } = await boot();
    const objects = memoryObjects();
    const ids = Array.from({ length: 30 }, (_, i) => `mat-race-${String(i).padStart(2, '0')}`);
    for (const id of ids) await legacyRow(h, id, objects);

    const [a, b] = await Promise.all([
      migrateOwnerMaterialsToPool({ batchSize: 5, pauseMs: 0 }),
      migrateOwnerMaterialsToPool({ batchSize: 5, pauseMs: 0 }),
    ]);

    // Each row was published once, by one of the two.
    expect(a.migrated + b.migrated).toBe(30);
    expect(a.failed + b.failed).toBe(0);
    // They did collide: some allocations lost (the deterministic case is above).
    expect(a.skippedLost + b.skippedLost).toBeGreaterThan(0);
    const entries = await entriesOf();
    expect(entries).toHaveLength(30);
    expect(entries.filter((entry) => entry.committed_at === null)).toEqual([]);
    for (const id of ids) expect(await rootsOf(id)).toHaveLength(1);
  });
});
