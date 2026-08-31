import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import {
  abandonOwnerMaterial,
  ensureOwnerMaterialSchema,
  finalizeOwnerMaterial,
  getReadyOwnerMaterial,
  getReadyOwnerMaterials,
  listOwnerMaterials,
  ownerMaterialQuotaLockKey,
  reclaimStaleOwnerMaterialUploads,
  registerOwnerMaterial,
  renewOwnerMaterialUploadLease,
  type RegisterOwnerMaterialInput,
} from '@/lib/persistence/owner-materials';

/** The node-postgres pool surface, backed by the single-connection PGlite. */
class PGlitePool {
  readonly statements: string[] = [];

  constructor(readonly db: PGlite) {}

  query<TRow>(text: string, params?: unknown[]) {
    this.statements.push(text);
    return this.db.query<TRow>(text, params);
  }

  async connect() {
    return {
      query: <TRow>(text: string, params?: unknown[]) => {
        this.statements.push(text);
        return this.db.query<TRow>(text, params);
      },
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

const input = (
  overrides: Partial<RegisterOwnerMaterialInput> = {},
): RegisterOwnerMaterialInput => ({
  id: 'mat_1',
  ownerId: 'owner-1',
  kind: 'source',
  mime: 'application/pdf',
  bytes: 100,
  originalName: 'a.pdf',
  ossKey: 'materials/owner-1/mat_1',
  extraction: { status: 'idle' },
  ...overrides,
});

/** Insert an `uploading` row directly, e.g. one old enough to reclaim. */
async function insertRawUpload(
  db: PGlite,
  row: {
    id: string;
    ownerId?: string;
    ossKey?: string;
    bytes?: number;
    status?: string;
    createdAt?: number;
    sha256?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO owner_material
       (id, owner_id, kind, mime, bytes, original_name, oss_key, sha256,
        status, extraction, created_at)
     VALUES ($1, $2, 'source', 'application/pdf', $3, 'stale.pdf', $4, $5,
              $6, NULL, $7)`,
    [
      row.id,
      row.ownerId ?? 'owner-1',
      row.bytes ?? 10,
      row.ossKey ??
        (row.status === 'ready' ? `materials/${row.ownerId ?? 'owner-1'}/${row.id}` : ''),
      row.sha256 === undefined ? (row.status === 'ready' ? 'a'.repeat(64) : null) : row.sha256,
      row.status ?? 'uploading',
      row.createdAt ?? Date.now(),
    ],
  );
}

async function rowById(db: PGlite, id: string): Promise<Record<string, unknown> | null> {
  const result = await db.query<Record<string, unknown>>(
    'SELECT id, oss_key, status, deleted_at FROM owner_material WHERE id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}

describe('owner material reservations', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    await ensureOwnerMaterialSchema(db);
    pool = new PGlitePool(db);
  });

  afterEach(async () => {
    await pool.end();
  });

  it('takes the per-owner advisory lock before the quota read and inserts one uploading row', async () => {
    const record = await registerOwnerMaterial(pool as unknown as ConnectableQueryable, input(), {
      maxCount: 10,
      maxTotalBytes: 1_000,
    });
    expect(record.id).toBe('mat_1');
    expect(record.status).toBe('uploading');
    expect(record.ossKey).toBe('materials/owner-1/mat_1');

    const lockStatement = pool.statements.findIndex((statement) =>
      statement.includes('pg_advisory_xact_lock(hashtextextended($1, 0))'),
    );
    const usageStatement = pool.statements.findIndex((statement) => statement.includes('COUNT(*)'));
    const insertStatement = pool.statements.findIndex((statement) =>
      statement.includes('INSERT INTO'),
    );
    expect(lockStatement).toBeGreaterThanOrEqual(0);
    expect(usageStatement).toBeGreaterThan(lockStatement);
    expect(insertStatement).toBeGreaterThan(usageStatement);
  });

  it('rejects a reservation when the owner count quota is already spent', async () => {
    const limits = { maxCount: 1, maxTotalBytes: 1_000 };
    await registerOwnerMaterial(pool as unknown as ConnectableQueryable, input(), limits);
    await expect(
      registerOwnerMaterial(
        pool as unknown as ConnectableQueryable,
        input({ id: 'mat_2' }),
        limits,
      ),
    ).rejects.toMatchObject({ name: 'MaterialQuotaExceededError', quota: 'count', maximum: 1 });
    const rows = await pool.query<{ id: string }>('SELECT id FROM owner_material');
    expect(rows.rows).toHaveLength(1);
  });

  it('rejects a reservation when the owner byte quota would be exceeded', async () => {
    const limits = { maxCount: 10, maxTotalBytes: 100 };
    await registerOwnerMaterial(
      pool as unknown as ConnectableQueryable,
      input({ bytes: 80 }),
      limits,
    );
    await expect(
      registerOwnerMaterial(
        pool as unknown as ConnectableQueryable,
        input({ id: 'mat_2', bytes: 30 }),
        limits,
      ),
    ).rejects.toMatchObject({ name: 'MaterialQuotaExceededError', quota: 'bytes', maximum: 100 });
  });

  it('keeps the object key on the reservation through finalize', async () => {
    const limits = { maxCount: 10, maxTotalBytes: 1_000 };
    await registerOwnerMaterial(pool as unknown as ConnectableQueryable, input(), limits);
    const before = await rowById(pool.db, 'mat_1');
    expect(before).toMatchObject({ oss_key: 'materials/owner-1/mat_1', status: 'uploading' });

    const finalized = await finalizeOwnerMaterial(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      'mat_1',
      100,
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(finalized.status).toBe('ready');
    expect(finalized.ossKey).toBe('materials/owner-1/mat_1');
  });

  it('requires owner plus material id for finalize and abandon operations', async () => {
    const limits = { maxCount: 10, maxTotalBytes: 1_000 };
    await registerOwnerMaterial(pool as unknown as ConnectableQueryable, input(), limits);
    await expect(
      finalizeOwnerMaterial(
        pool as unknown as ConnectableQueryable,
        'owner-2',
        'mat_1',
        100,
        'a'.repeat(64),
      ),
    ).rejects.toThrow('cannot be finalized');
    expect(await rowById(pool.db, 'mat_1')).toMatchObject({ status: 'uploading' });

    await abandonOwnerMaterial(pool as unknown as ConnectableQueryable, 'owner-2', 'mat_1');
    expect(await rowById(pool.db, 'mat_1')).not.toBeNull();
    await abandonOwnerMaterial(pool as unknown as ConnectableQueryable, 'owner-1', 'mat_1');
    expect(await rowById(pool.db, 'mat_1')).toBeNull();
  });

  it('reads ready materials only through the matching owner partition', async () => {
    await insertRawUpload(pool.db, {
      id: 'mat_owner_a',
      ownerId: 'owner-a',
      status: 'ready',
      createdAt: 10,
    });
    await insertRawUpload(pool.db, {
      id: 'mat_owner_b',
      ownerId: 'owner-b',
      status: 'ready',
      createdAt: 20,
    });
    await insertRawUpload(pool.db, {
      id: 'mat_uploading',
      ownerId: 'owner-a',
      status: 'uploading',
      createdAt: 30,
    });

    await expect(getReadyOwnerMaterial(pool.db, 'owner-a', 'mat_owner_a')).resolves.toMatchObject({
      id: 'mat_owner_a',
      ownerId: 'owner-a',
    });
    await expect(getReadyOwnerMaterial(pool.db, 'owner-b', 'mat_owner_a')).resolves.toBeNull();
    await expect(getReadyOwnerMaterial(pool.db, 'owner-a', 'mat_uploading')).resolves.toBeNull();
    await expect(
      getReadyOwnerMaterials(pool.db, 'owner-a', ['mat_owner_b', 'mat_owner_a']),
    ).resolves.toEqual([expect.objectContaining({ id: 'mat_owner_a' })]);
    await expect(listOwnerMaterials(pool.db, 'owner-a')).resolves.toEqual([
      expect.objectContaining({ id: 'mat_owner_a' }),
    ]);
  });

  it('reclaims a crashed reservation and its recorded byte object', async () => {
    await registerOwnerMaterial(
      pool as unknown as ConnectableQueryable,
      input({
        ossKey: 'materials/owner-1/mat-crash',
      }),
      {
        maxCount: 10,
        maxTotalBytes: 1_000,
      },
    );
    await pool.query('UPDATE owner_material SET created_at = $2 WHERE id = $1', [
      'mat_1',
      Date.now() - 25 * 60 * 60 * 1_000,
    ]);

    const deleteBytes = vi.fn(async (objectKey: string) => {
      // The reservation must still exist when its byte object is removed: the
      // pointer is deleted only after the bytes are confirmed reclaimed.
      const stillPresent = await pool.db.query<{ id: string }>(
        'SELECT id FROM owner_material WHERE id = $1',
        ['mat_1'],
      );
      expect(stillPresent.rows).toHaveLength(1);
      expect(objectKey).toBe('materials/owner-1/mat-crash');
    });

    await reclaimStaleOwnerMaterialUploads(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      deleteBytes,
    );

    expect(deleteBytes).toHaveBeenCalledTimes(1);
    expect(deleteBytes).toHaveBeenCalledWith('materials/owner-1/mat-crash');
    expect(await rowById(pool.db, 'mat_1')).toBeNull();
  });

  it('fences finalize before deleting bytes from a claimed stale reservation', async () => {
    await insertRawUpload(pool.db, {
      id: 'mat_stale_race',
      ossKey: 'materials/owner-1/mat-stale-race',
      createdAt: Date.now() - 25 * 60 * 60 * 1_000,
    });
    const deleteBytes = vi.fn(async () => {
      await expect(
        finalizeOwnerMaterial(
          pool as unknown as ConnectableQueryable,
          'owner-1',
          'mat_stale_race',
          100,
          'a'.repeat(64),
        ),
      ).rejects.toThrow('cannot be finalized');
    });

    await reclaimStaleOwnerMaterialUploads(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      deleteBytes,
    );

    expect(deleteBytes).toHaveBeenCalledOnce();
    expect(await rowById(pool.db, 'mat_stale_race')).toBeNull();
  });

  it('renews a live upload before byte write and refuses a reclaimed reservation', async () => {
    await insertRawUpload(pool.db, {
      id: 'mat_live',
      createdAt: Date.now() - 25 * 60 * 60 * 1_000,
    });

    await expect(
      renewOwnerMaterialUploadLease(pool as unknown as ConnectableQueryable, 'owner-1', 'mat_live'),
    ).resolves.toBe(true);
    await reclaimStaleOwnerMaterialUploads(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      vi.fn(),
    );
    expect(await rowById(pool.db, 'mat_live')).not.toBeNull();

    await pool.db.query('UPDATE owner_material SET deleted_at = $2 WHERE id = $1', [
      'mat_live',
      Date.now(),
    ]);
    await expect(
      renewOwnerMaterialUploadLease(pool as unknown as ConnectableQueryable, 'owner-1', 'mat_live'),
    ).resolves.toBe(false);
  });

  it('keeps a stale reservation when byte deletion fails and retries on the next pass', async () => {
    await insertRawUpload(pool.db, {
      id: 'mat_stale',
      ossKey: 'materials/owner-1/mat-stubborn',
      createdAt: Date.now() - 25 * 60 * 60 * 1_000,
    });

    const deleteBytes = vi
      .fn()
      .mockRejectedValueOnce(new Error('registry unavailable'))
      .mockResolvedValue(undefined);

    await reclaimStaleOwnerMaterialUploads(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      deleteBytes,
    );
    // First pass: removal failed, so the reservation stays for the next pass.
    expect(await rowById(pool.db, 'mat_stale')).toMatchObject({
      status: 'uploading',
      deleted_at: expect.any(Number),
    });

    await reclaimStaleOwnerMaterialUploads(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      deleteBytes,
    );
    expect(deleteBytes).toHaveBeenCalledTimes(2);
    expect(await rowById(pool.db, 'mat_stale')).toBeNull();
  });

  it('deletes stale keyless reservations without touching the byte store', async () => {
    await insertRawUpload(pool.db, {
      id: 'mat_empty',
      ossKey: '',
      createdAt: Date.now() - 25 * 60 * 60 * 1_000,
    });

    const deleteBytes = vi.fn().mockResolvedValue(undefined);
    await reclaimStaleOwnerMaterialUploads(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      deleteBytes,
    );

    expect(deleteBytes).not.toHaveBeenCalled();
    expect(await rowById(pool.db, 'mat_empty')).toBeNull();
  });

  it('leaves fresh uploads and ready rows alone', async () => {
    await insertRawUpload(pool.db, { id: 'mat_fresh', ossKey: 'materials/owner-1/fresh' });
    await insertRawUpload(pool.db, {
      id: 'mat_old_ready',
      ossKey: 'materials/owner-1/ready',
      status: 'ready',
      createdAt: Date.now() - 25 * 60 * 60 * 1_000,
    });

    const deleteBytes = vi.fn().mockResolvedValue(undefined);
    await reclaimStaleOwnerMaterialUploads(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      deleteBytes,
    );

    expect(deleteBytes).not.toHaveBeenCalled();
    expect(await rowById(pool.db, 'mat_fresh')).toMatchObject({ status: 'uploading' });
    expect(await rowById(pool.db, 'mat_old_ready')).toMatchObject({ status: 'ready' });
  });

  it('upgrades a table created by the asset-id era schema', async () => {
    const db = new PGlite();
    await db.waitReady;
    await db.query(`CREATE TABLE owner_material (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      derived_from TEXT,
      mime TEXT,
      bytes DOUBLE PRECISION NOT NULL,
      original_name TEXT,
      asset_id TEXT NOT NULL,
      sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      extraction JSONB,
      created_at DOUBLE PRECISION NOT NULL,
      deleted_at DOUBLE PRECISION
    )`);
    // A real pre-existing deployment has rows: the legacy row must survive the
    // upgrade, its dropped asset_id discarded and its oss_key backfilled with
    // the '' "no bytes recorded" sentinel.
    await db.query(
      `INSERT INTO owner_material
         (id, owner_id, kind, mime, bytes, original_name, asset_id, sha256,
          status, extraction, created_at)
       VALUES ($1, 'owner-1', 'source', 'application/pdf', 2048, 'legacy.pdf',
               'legacy-asset-1', NULL, 'ready', NULL, $2)`,
      ['mat_legacy', 1_600_000_000_000],
    );
    await ensureOwnerMaterialSchema(db);
    // Idempotency on the real deployment shape: a second pass must be a clean
    // no-op (ADD COLUMN IF NOT EXISTS / DROP COLUMN IF EXISTS), not a DDL error.
    await ensureOwnerMaterialSchema(db);
    const legacyRow = await db.query<{
      oss_key: string;
      status: string;
      deleted_at: number | null;
    }>('SELECT oss_key, status, deleted_at FROM owner_material WHERE id = $1', ['mat_legacy']);
    expect(legacyRow.rows[0]).toMatchObject({
      oss_key: '',
      status: 'ready',
      deleted_at: expect.any(Number),
    });
    const oldPool = new PGlitePool(db);
    await expect(listOwnerMaterials(oldPool, 'owner-1')).resolves.toEqual([]);
    await expect(getReadyOwnerMaterial(oldPool, 'owner-1', 'mat_legacy')).resolves.toBeNull();
    await expect(getReadyOwnerMaterials(oldPool, 'owner-1', ['mat_legacy'])).resolves.toEqual([]);
    const record = await registerOwnerMaterial(
      oldPool as unknown as ConnectableQueryable,
      input(),
      // The unavailable legacy row is tombstoned and consumes neither the
      // single count slot nor the exact byte allowance.
      { maxCount: 1, maxTotalBytes: 100 },
    );
    expect(record.status).toBe('uploading');
    expect(record.ossKey).toBe('materials/owner-1/mat_1');
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'owner_material'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toContain('oss_key');
    expect(names).not.toContain('asset_id');
    await oldPool.end();
  });

  it('derives a namespaced per-owner quota lock key', () => {
    expect(ownerMaterialQuotaLockKey('owner-1')).toBe('owner-materials:owner-1:quota');
    expect(ownerMaterialQuotaLockKey('owner-1')).not.toBe('owner-materials:owner-1');
  });
});
