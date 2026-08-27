import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import {
  ensureOwnerMaterialSchema,
  finalizeOwnerMaterial,
  ownerMaterialQuotaLockKey,
  reclaimStaleOwnerMaterialUploads,
  recordOwnerMaterialAsset,
  registerOwnerMaterial,
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
  assetId: '',
  extraction: { status: 'idle' },
  ...overrides,
});

/** Insert an `uploading` row directly, e.g. one old enough to reclaim. */
async function insertRawUpload(
  db: PGlite,
  row: {
    id: string;
    ownerId?: string;
    assetId?: string;
    bytes?: number;
    status?: string;
    createdAt?: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO owner_material
       (id, owner_id, kind, mime, bytes, original_name, asset_id, sha256,
        status, extraction, created_at)
     VALUES ($1, $2, 'source', 'application/pdf', $3, 'stale.pdf', $4, NULL,
             $5, NULL, $6)`,
    [
      row.id,
      row.ownerId ?? 'owner-1',
      row.bytes ?? 10,
      row.assetId ?? '',
      row.status ?? 'uploading',
      row.createdAt ?? Date.now(),
    ],
  );
}

async function rowById(db: PGlite, id: string): Promise<Record<string, unknown> | null> {
  const result = await db.query<Record<string, unknown>>(
    'SELECT id, asset_id, status FROM owner_material WHERE id = $1',
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
    expect(record.assetId).toBe('');

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

  it('records the asset id on the uploading reservation before finalize', async () => {
    const limits = { maxCount: 10, maxTotalBytes: 1_000 };
    await registerOwnerMaterial(pool as unknown as ConnectableQueryable, input(), limits);
    await recordOwnerMaterialAsset(pool as unknown as ConnectableQueryable, 'mat_1', 'asset-abc');
    const before = await rowById(pool.db, 'mat_1');
    expect(before).toMatchObject({ asset_id: 'asset-abc', status: 'uploading' });

    const finalized = await finalizeOwnerMaterial(
      pool as unknown as ConnectableQueryable,
      'mat_1',
      100,
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      'asset-abc',
    );
    expect(finalized.status).toBe('ready');
    expect(finalized.assetId).toBe('asset-abc');
  });

  it('reclaims a crashed reservation and its recorded asset entry (crash between put and finalize)', async () => {
    // Simulate the crash point: the put committed and the asset id was durably
    // recorded on the still-uploading reservation, but finalize never ran.
    await registerOwnerMaterial(pool as unknown as ConnectableQueryable, input(), {
      maxCount: 10,
      maxTotalBytes: 1_000,
    });
    await recordOwnerMaterialAsset(pool as unknown as ConnectableQueryable, 'mat_1', 'asset-crash');
    await pool.query('UPDATE owner_material SET created_at = $2 WHERE id = $1', [
      'mat_1',
      Date.now() - 25 * 60 * 60 * 1_000,
    ]);

    const removeAsset = vi.fn(async (assetId: string) => {
      // The reservation must still exist when its asset entry is removed: the
      // pointer is deleted only after the bytes are confirmed reclaimed.
      const stillPresent = await pool.db.query<{ id: string }>(
        'SELECT id FROM owner_material WHERE id = $1',
        ['mat_1'],
      );
      expect(stillPresent.rows).toHaveLength(1);
      expect(assetId).toBe('asset-crash');
    });

    await reclaimStaleOwnerMaterialUploads(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      removeAsset,
    );

    expect(removeAsset).toHaveBeenCalledTimes(1);
    expect(removeAsset).toHaveBeenCalledWith('asset-crash');
    expect(await rowById(pool.db, 'mat_1')).toBeNull();
  });

  it('keeps a stale reservation when its asset removal fails and retries on the next pass', async () => {
    await insertRawUpload(pool.db, {
      id: 'mat_stale',
      assetId: 'asset-stubborn',
      createdAt: Date.now() - 25 * 60 * 60 * 1_000,
    });

    const removeAsset = vi
      .fn()
      .mockRejectedValueOnce(new Error('registry unavailable'))
      .mockResolvedValue(undefined);

    await reclaimStaleOwnerMaterialUploads(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      removeAsset,
    );
    // First pass: removal failed, so the reservation stays for the next pass.
    expect(await rowById(pool.db, 'mat_stale')).not.toBeNull();

    await reclaimStaleOwnerMaterialUploads(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      removeAsset,
    );
    expect(removeAsset).toHaveBeenCalledTimes(2);
    expect(await rowById(pool.db, 'mat_stale')).toBeNull();
  });

  it('deletes stale asset-less reservations without touching the registry', async () => {
    await insertRawUpload(pool.db, {
      id: 'mat_empty',
      assetId: '',
      createdAt: Date.now() - 25 * 60 * 60 * 1_000,
    });

    const removeAsset = vi.fn().mockResolvedValue(undefined);
    await reclaimStaleOwnerMaterialUploads(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      removeAsset,
    );

    expect(removeAsset).not.toHaveBeenCalled();
    expect(await rowById(pool.db, 'mat_empty')).toBeNull();
  });

  it('leaves fresh uploads and ready rows alone', async () => {
    await insertRawUpload(pool.db, { id: 'mat_fresh', assetId: 'asset-fresh' });
    await insertRawUpload(pool.db, {
      id: 'mat_old_ready',
      assetId: 'asset-ready',
      status: 'ready',
      createdAt: Date.now() - 25 * 60 * 60 * 1_000,
    });

    const removeAsset = vi.fn().mockResolvedValue(undefined);
    await reclaimStaleOwnerMaterialUploads(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      removeAsset,
    );

    expect(removeAsset).not.toHaveBeenCalled();
    expect(await rowById(pool.db, 'mat_fresh')).toMatchObject({ status: 'uploading' });
    expect(await rowById(pool.db, 'mat_old_ready')).toMatchObject({ status: 'ready' });
  });

  it('derives a per-owner lock key that does not collide with the asset registry key', () => {
    expect(ownerMaterialQuotaLockKey('owner-1')).toBe('owner-materials:owner-1:quota');
    expect(ownerMaterialQuotaLockKey('owner-1')).not.toBe('owner-materials:owner-1');
  });
});
