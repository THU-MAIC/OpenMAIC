import { createHash } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import {
  ensureOwnerMaterialSchema,
  MaterialQuotaExceededError,
  ownerMaterialQuotaLockKey,
  registerOwnerMaterial,
  type RegisterOwnerMaterialInput,
} from '@/lib/persistence/owner-materials';
import type { MaterialByteStore } from '@/lib/server/materials/bytes';
import { ownerMaterialObjectKey } from '@/lib/server/materials/object-keys';
import {
  deleteOwnedMaterial,
  resolveOwnedReadyMaterialAssetsForSnapshot,
} from '@/lib/server/materials/owner-assets';

const contractUrl = process.env.PG_CONTRACT_URL;
const SNAPSHOT_MATERIAL_ID = `mat_${'0'.repeat(26)}`;
const EXAM_MIME_TYPES = new Set(['application/pdf']);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Wait until some backend in this database is blocked on a lock. */
async function waitForLockWaiter(pool: Pool): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const waiting = await pool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()`,
    );
    if (waiting.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no backend blocked on a lock: the reservation never contended');
}

describe.skipIf(!contractUrl)('owner material quota reservations on PostgreSQL', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl });
    await ensureOwnerMaterialSchema(pool as unknown as ConnectableQueryable);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE owner_material');
  });

  afterAll(async () => {
    await pool.end();
  });

  const input = (id: string): RegisterOwnerMaterialInput => ({
    id,
    ownerId: 'owner-1',
    kind: 'source',
    mime: 'application/pdf',
    bytes: 10,
    originalName: `${id}.pdf`,
    ossKey: `materials/owner-1/${id}`,
    extraction: { status: 'idle' },
  });

  it('rejects the second of two concurrent reservations for one remaining slot', async () => {
    // Two separate connections (each register call checks out its own), both
    // racing for the owner's last slot. The per-owner advisory lock serializes
    // the read-check-insert, so exactly one may pass.
    const limits = { maxCount: 1, maxTotalBytes: 10_000 };
    const results = await Promise.allSettled([
      registerOwnerMaterial(pool as unknown as ConnectableQueryable, input('mat-a'), limits),
      registerOwnerMaterial(pool as unknown as ConnectableQueryable, input('mat-b'), limits),
    ]);

    const accepted = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      MaterialQuotaExceededError,
    );

    const rows = await pool.query<{ id: string }>('SELECT id FROM owner_material');
    expect(rows.rows).toHaveLength(1);
  });

  it('parks a concurrent reservation at the per-owner advisory lock before its usage read', async () => {
    // Manual mirror of registerOwnerMaterial's transaction with a barrier after
    // the first usage read: the second connection must wait at the advisory
    // lock, so its usage read runs only after the first reservation commits and
    // sees the consumed slot -- the interleaving that used to double-spend now
    // serializes into one acceptance and one rejection.
    const lockKey = ownerMaterialQuotaLockKey('owner-1');
    const usageSql = `SELECT COUNT(*)::text AS count
        FROM owner_material
       WHERE owner_id = $1 AND kind = 'source' AND deleted_at IS NULL`;
    const insertSql = `INSERT INTO owner_material
        (id, owner_id, kind, mime, bytes, original_name, oss_key, sha256,
         status, extraction, created_at)
      VALUES ($1, 'owner-1', 'source', 'application/pdf', 10, $2, 'materials/owner-1/a',
              NULL, 'uploading', NULL, $3)`;

    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await first.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
      const before = await first.query<{ count: string }>(usageSql, ['owner-1']);
      expect(Number(before.rows[0]!.count)).toBe(0);

      // Start the second reservation. It parks at the advisory lock, so its
      // usage read cannot run until the first reservation commits.
      const secondReservation = (async () => {
        await second.query('BEGIN');
        await second.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
        const usage = await second.query<{ count: string }>(usageSql, ['owner-1']);
        if (Number(usage.rows[0]!.count) >= 1) {
          throw new MaterialQuotaExceededError('count', 1);
        }
        await second.query(insertSql, ['mat-b', 'b.pdf', Date.now()]);
        await second.query('COMMIT');
      })();

      // Barrier after the first usage read: the second connection is genuinely
      // blocked on the advisory lock, before it has read any usage.
      await waitForLockWaiter(pool);

      await first.query(insertSql, ['mat-a', 'a.pdf', Date.now()]);
      await first.query('COMMIT');

      await expect(secondReservation).rejects.toBeInstanceOf(MaterialQuotaExceededError);
      const rows = await pool.query<{ id: string }>('SELECT id FROM owner_material');
      expect(rows.rows.map((row) => row.id)).toEqual(['mat-a']);
    } finally {
      // Release the second connection's transaction (and its advisory lock)
      // whatever happened; the first is already committed or rolled back.
      await second.query('ROLLBACK').catch(() => undefined);
      await first.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('holds the source row lock through byte verification before owner deletion can tombstone it', async () => {
    const body = Buffer.from('authoritative exam source');
    const objectKey = ownerMaterialObjectKey('owner-1', SNAPSHOT_MATERIAL_ID);
    const objects = new Map([[objectKey, body]]);
    const readStarted = deferred();
    const releaseRead = deferred();
    const byteStore: MaterialByteStore = {
      put: async (key, value) => void objects.set(key, Buffer.from(value as Uint8Array)),
      get: async (key) => {
        const value = objects.get(key);
        if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        readStarted.resolve();
        await releaseRead.promise;
        return Buffer.from(value);
      },
      delete: async (key) => void objects.delete(key),
    };
    await pool.query(
      `INSERT INTO owner_material
         (id, owner_id, kind, mime, bytes, original_name, oss_key, sha256,
          status, extraction, created_at)
       VALUES ($1, 'owner-1', 'source', 'application/pdf', $2, 'paper.pdf', $3, $4,
               'ready', '{"status":"idle"}'::jsonb, $5)`,
      [
        SNAPSHOT_MATERIAL_ID,
        body.byteLength,
        objectKey,
        createHash('sha256').update(body).digest('hex'),
        Date.now(),
      ],
    );

    const snapshot = resolveOwnedReadyMaterialAssetsForSnapshot(
      'owner-1',
      [SNAPSHOT_MATERIAL_ID],
      { allowedMimeTypes: EXAM_MIME_TYPES },
      {
        withTransaction: nodePostgresTransaction(pool as unknown as ConnectableQueryable),
        byteStore,
      },
    );
    await readStarted.promise;
    const deletion = deleteOwnedMaterial('owner-1', SNAPSHOT_MATERIAL_ID, {
      queryable: pool,
      byteStore,
    });
    try {
      await waitForLockWaiter(pool);
    } finally {
      releaseRead.resolve();
    }
    await expect(snapshot).resolves.toMatchObject({
      ok: true,
      assets: [{ ownerMaterialId: SNAPSHOT_MATERIAL_ID, bytes: body }],
    });
    await expect(deletion).resolves.toBe('deleted');
    expect(objects.has(objectKey)).toBe(false);
  });
});
