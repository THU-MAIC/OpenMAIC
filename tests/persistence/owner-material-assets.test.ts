import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import type { Queryable, WithTransaction } from '@openmaic/storage/runtime/pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureOwnerMaterialSchema,
  getReadyOwnerMaterial,
} from '@/lib/persistence/owner-materials';
import type { MaterialByteStore } from '@/lib/server/materials/bytes';
import { ownerMaterialObjectKey } from '@/lib/server/materials/object-keys';
import {
  deleteOwnedMaterial,
  resolveOwnedReadyMaterialAsset,
  resolveOwnedReadyMaterialAssetsForSnapshot,
} from '@/lib/server/materials/owner-assets';

const MATERIAL_A = `mat_${'0'.repeat(26)}`;
const MATERIAL_B = `mat_${'1'.repeat(26)}`;
const EXAM_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
]);

function transactionFor(db: PGlite): WithTransaction {
  return (body) => db.transaction((transaction: Queryable) => body(transaction));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function memoryByteStore(bytes: Map<string, Buffer>): MaterialByteStore {
  return {
    put: async (key, body) => void bytes.set(key, Buffer.from(body as Uint8Array)),
    get: async (key) => {
      const value = bytes.get(key);
      if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return Buffer.from(value);
    },
    delete: async (key) => void bytes.delete(key),
  };
}

describe('owner material asset authority and lifecycle', () => {
  let db: PGlite;
  let objects: Map<string, Buffer>;
  let byteStore: MaterialByteStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureOwnerMaterialSchema(db);
    objects = new Map();
    byteStore = memoryByteStore(objects);
  });

  afterEach(async () => {
    await db.close();
  });

  async function insertReady(ownerId: string, materialId: string, body = Buffer.from('paper')) {
    const ossKey = ownerMaterialObjectKey(ownerId, materialId);
    objects.set(ossKey, Buffer.from(body));
    await db.query(
      `INSERT INTO owner_material
         (id, owner_id, kind, mime, bytes, original_name, oss_key, sha256,
          status, extraction, created_at)
       VALUES ($1, $2, 'source', 'application/pdf', $3, 'paper.pdf', $4, $5,
               'ready', '{"status":"idle"}'::jsonb, $6)`,
      [
        materialId,
        ownerId,
        body.byteLength,
        ossKey,
        createHash('sha256').update(body).digest('hex'),
        Date.now(),
      ],
    );
    return { ossKey, body };
  }

  it('resolves only owner-matched ready bytes with matching length and digest', async () => {
    const { body, ossKey } = await insertReady('owner-a', MATERIAL_A);
    const resolved = await resolveOwnedReadyMaterialAsset('owner-a', MATERIAL_A, {
      queryable: db,
      byteStore,
    });
    expect(resolved).toMatchObject({
      ownerMaterialId: MATERIAL_A,
      mimeType: 'application/pdf',
      byteLength: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    expect(resolved?.bytes).toEqual(body);

    await expect(
      resolveOwnedReadyMaterialAsset('owner-b', MATERIAL_A, { queryable: db, byteStore }),
    ).resolves.toBeNull();
    await expect(
      resolveOwnedReadyMaterialAsset('owner-a', '../bad', { queryable: db, byteStore }),
    ).resolves.toBeNull();

    objects.set(ossKey, Buffer.from('tampered'));
    await expect(
      resolveOwnedReadyMaterialAsset('owner-a', MATERIAL_A, { queryable: db, byteStore }),
    ).resolves.toBeNull();
  });

  it('locks same-owner active source rows in stable order and verifies bytes inside the transaction', async () => {
    const sourceB = await insertReady('owner-a', MATERIAL_B, Buffer.from('answer'));
    const sourceA = await insertReady('owner-a', MATERIAL_A, Buffer.from('question'));
    let transactionOpen = false;
    let lockQuery = '';
    const withTransaction: WithTransaction = async (body) => {
      transactionOpen = true;
      try {
        return await db.transaction((transaction: Queryable) =>
          body({
            query: <TRow extends Record<string, unknown>>(text: string, params?: unknown[]) => {
              lockQuery = text;
              return transaction.query<TRow>(text, params);
            },
          }),
        );
      } finally {
        transactionOpen = false;
      }
    };
    const getBytes = vi.fn(async (key: string) => {
      expect(transactionOpen).toBe(true);
      return byteStore.get(key);
    });

    const result = await resolveOwnedReadyMaterialAssetsForSnapshot(
      'owner-a',
      [MATERIAL_B, MATERIAL_A, MATERIAL_B],
      { allowedMimeTypes: EXAM_MIME_TYPES },
      { withTransaction, byteStore: { ...byteStore, get: getBytes } },
    );

    expect(result).toMatchObject({
      ok: true,
      assets: [
        { ownerMaterialId: MATERIAL_A, bytes: sourceA.body },
        { ownerMaterialId: MATERIAL_B, bytes: sourceB.body },
      ],
    });
    expect(getBytes).toHaveBeenCalledTimes(2);
    expect(lockQuery).toContain('WHERE owner_id = $1');
    expect(lockQuery).toContain("AND kind = 'source'");
    expect(lockQuery).toContain("AND status = 'ready'");
    expect(lockQuery).toContain('AND deleted_at IS NULL');
    expect(lockQuery).toContain('ORDER BY id');
    expect(lockQuery).toContain('FOR UPDATE');
  });

  it('fails closed for foreign, deleted, derived, invalid, or unsupported-MIME sources', async () => {
    await insertReady('owner-b', MATERIAL_A);
    await expect(
      resolveOwnedReadyMaterialAssetsForSnapshot(
        'owner-a',
        [MATERIAL_A],
        { allowedMimeTypes: EXAM_MIME_TYPES },
        { withTransaction: transactionFor(db), byteStore },
      ),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });

    await db.query('UPDATE owner_material SET owner_id = $2, deleted_at = $3 WHERE id = $1', [
      MATERIAL_A,
      'owner-a',
      Date.now(),
    ]);
    await expect(
      resolveOwnedReadyMaterialAssetsForSnapshot(
        'owner-a',
        [MATERIAL_A],
        { allowedMimeTypes: EXAM_MIME_TYPES },
        { withTransaction: transactionFor(db), byteStore },
      ),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });

    await db.query("UPDATE owner_material SET deleted_at = NULL, kind = 'web' WHERE id = $1", [
      MATERIAL_A,
    ]);
    await expect(
      resolveOwnedReadyMaterialAssetsForSnapshot(
        'owner-a',
        [MATERIAL_A],
        { allowedMimeTypes: EXAM_MIME_TYPES },
        { withTransaction: transactionFor(db), byteStore },
      ),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });

    await db.query("UPDATE owner_material SET kind = 'source', mime = 'video/mp4' WHERE id = $1", [
      MATERIAL_A,
    ]);
    await expect(
      resolveOwnedReadyMaterialAssetsForSnapshot(
        'owner-a',
        [MATERIAL_A],
        { allowedMimeTypes: EXAM_MIME_TYPES },
        { withTransaction: transactionFor(db), byteStore },
      ),
    ).resolves.toEqual({ ok: false, reason: 'unsupported_mime' });

    await expect(
      resolveOwnedReadyMaterialAssetsForSnapshot(
        'owner-a',
        ['../bad'],
        { allowedMimeTypes: EXAM_MIME_TYPES },
        { withTransaction: transactionFor(db), byteStore },
      ),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('distinguishes unavailable source bytes from length or digest integrity failure', async () => {
    const { ossKey, body } = await insertReady('owner-a', MATERIAL_A);
    const resolve = () =>
      resolveOwnedReadyMaterialAssetsForSnapshot(
        'owner-a',
        [MATERIAL_A],
        { allowedMimeTypes: EXAM_MIME_TYPES },
        { withTransaction: transactionFor(db), byteStore },
      );

    await db.query('UPDATE owner_material SET bytes = $2 WHERE id = $1', [
      MATERIAL_A,
      body.byteLength + 1,
    ]);
    await expect(resolve()).resolves.toEqual({ ok: false, reason: 'integrity_failed' });

    await db.query('UPDATE owner_material SET bytes = $2 WHERE id = $1', [
      MATERIAL_A,
      body.byteLength,
    ]);
    objects.set(ossKey, Buffer.from('tampered'));
    await expect(resolve()).resolves.toEqual({ ok: false, reason: 'integrity_failed' });

    objects.delete(ossKey);
    await expect(resolve()).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('lets a snapshot that locks first capture bytes before owner deletion proceeds', async () => {
    const { body } = await insertReady('owner-a', MATERIAL_A);
    const readStarted = deferred();
    const releaseRead = deferred();
    const lockingByteStore: MaterialByteStore = {
      ...byteStore,
      get: async (key) => {
        readStarted.resolve();
        await releaseRead.promise;
        return byteStore.get(key);
      },
    };

    const snapshot = resolveOwnedReadyMaterialAssetsForSnapshot(
      'owner-a',
      [MATERIAL_A],
      { allowedMimeTypes: EXAM_MIME_TYPES },
      { withTransaction: transactionFor(db), byteStore: lockingByteStore },
    );
    await readStarted.promise;

    let deletionSettled = false;
    const deletion = deleteOwnedMaterial('owner-a', MATERIAL_A, { queryable: db, byteStore }).then(
      (result) => {
        deletionSettled = true;
        return result;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deletionSettled).toBe(false);

    releaseRead.resolve();
    await expect(snapshot).resolves.toMatchObject({
      ok: true,
      assets: [{ ownerMaterialId: MATERIAL_A, bytes: body }],
    });
    await expect(deletion).resolves.toBe('deleted');
  });

  it('rejects a new snapshot after owner deletion has tombstoned the source', async () => {
    await insertReady('owner-a', MATERIAL_A);
    const deleteStarted = deferred();
    const releaseDelete = deferred();
    const deletingByteStore: MaterialByteStore = {
      ...byteStore,
      delete: async (key) => {
        deleteStarted.resolve();
        await releaseDelete.promise;
        return byteStore.delete(key);
      },
    };
    const deletion = deleteOwnedMaterial('owner-a', MATERIAL_A, {
      queryable: db,
      byteStore: deletingByteStore,
    });
    await deleteStarted.promise;

    await expect(
      resolveOwnedReadyMaterialAssetsForSnapshot(
        'owner-a',
        [MATERIAL_A],
        { allowedMimeTypes: EXAM_MIME_TYPES },
        { withTransaction: transactionFor(db), byteStore },
      ),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });

    releaseDelete.resolve();
    await expect(deletion).resolves.toBe('deleted');
  });

  it('tombstones before byte deletion and purges only after deletion succeeds', async () => {
    const { ossKey } = await insertReady('owner-a', MATERIAL_A);
    const deleteBytes = vi.fn(async (key: string) => {
      const row = await db.query<{ deleted_at: number | null }>(
        'SELECT deleted_at FROM owner_material WHERE owner_id = $1 AND id = $2',
        ['owner-a', MATERIAL_A],
      );
      expect(row.rows[0]?.deleted_at).not.toBeNull();
      objects.delete(key);
    });
    const store = { ...byteStore, delete: deleteBytes };

    await expect(
      deleteOwnedMaterial('owner-a', MATERIAL_A, { queryable: db, byteStore: store }),
    ).resolves.toBe('deleted');
    expect(deleteBytes).toHaveBeenCalledWith(ossKey);
    expect(objects.has(ossKey)).toBe(false);
    expect(await getReadyOwnerMaterial(db, 'owner-a', MATERIAL_A)).toBeNull();
    const rows = await db.query('SELECT id FROM owner_material WHERE id = $1', [MATERIAL_A]);
    expect(rows.rows).toHaveLength(0);
    await expect(
      deleteOwnedMaterial('owner-a', MATERIAL_A, { queryable: db, byteStore: store }),
    ).resolves.toBe('absent');
  });

  it('purges a migrated keyless row without asking the byte store to delete its root', async () => {
    await db.close();
    db = new PGlite();
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
    await db.query(
      `INSERT INTO owner_material
         (id, owner_id, kind, mime, bytes, original_name, asset_id, sha256,
          status, extraction, created_at)
       VALUES ($1, 'owner-a', 'source', 'application/pdf', 2048, 'legacy.pdf',
               'legacy-asset-1', NULL,
               'ready', NULL, $2)`,
      [MATERIAL_A, 1_600_000_000_000],
    );
    await ensureOwnerMaterialSchema(db);
    const migrated = await db.query<{ deleted_at: number | null; oss_key: string }>(
      'SELECT deleted_at, oss_key FROM owner_material WHERE id = $1',
      [MATERIAL_A],
    );
    expect(migrated.rows[0]).toMatchObject({
      deleted_at: expect.any(Number),
      oss_key: '',
    });
    const deleteBytes = vi.fn(byteStore.delete.bind(byteStore));

    await expect(
      deleteOwnedMaterial('owner-a', MATERIAL_A, {
        queryable: db,
        byteStore: { ...byteStore, delete: deleteBytes },
      }),
    ).resolves.toBe('deleted');

    expect(deleteBytes).not.toHaveBeenCalled();
    const rows = await db.query('SELECT id FROM owner_material WHERE id = $1', [MATERIAL_A]);
    expect(rows.rows).toHaveLength(0);
  });

  it('keeps a non-visible tombstone when byte deletion fails and retries idempotently', async () => {
    const { ossKey } = await insertReady('owner-a', MATERIAL_A);
    const deleteBytes = vi
      .fn<(key: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('byte store unavailable'))
      .mockImplementation(async (key) => void objects.delete(key));
    const store = { ...byteStore, delete: deleteBytes };

    await expect(
      deleteOwnedMaterial('owner-a', MATERIAL_A, { queryable: db, byteStore: store }),
    ).rejects.toThrow('byte store unavailable');
    expect(await getReadyOwnerMaterial(db, 'owner-a', MATERIAL_A)).toBeNull();
    const tombstone = await db.query<{ deleted_at: number | null; oss_key: string }>(
      'SELECT deleted_at, oss_key FROM owner_material WHERE id = $1',
      [MATERIAL_A],
    );
    expect(tombstone.rows[0]).toMatchObject({ oss_key: ossKey });
    expect(tombstone.rows[0]?.deleted_at).not.toBeNull();
    expect(objects.has(ossKey)).toBe(true);

    await expect(
      deleteOwnedMaterial('owner-a', MATERIAL_A, { queryable: db, byteStore: store }),
    ).resolves.toBe('deleted');
    expect(deleteBytes).toHaveBeenCalledTimes(2);
  });

  it('retains the tombstone pointer when metadata purge fails after byte deletion', async () => {
    const { ossKey } = await insertReady('owner-a', MATERIAL_A);
    let failPurge = true;
    const queryable = {
      query: <TRow>(text: string, params?: unknown[]) => {
        if (failPurge && text.includes('DELETE FROM owner_material')) {
          failPurge = false;
          return Promise.reject(new Error('metadata purge failed'));
        }
        return db.query<TRow>(text, params);
      },
    };

    await expect(
      deleteOwnedMaterial('owner-a', MATERIAL_A, { queryable, byteStore }),
    ).rejects.toThrow('metadata purge failed');
    expect(objects.has(ossKey)).toBe(false);
    const retained = await db.query<{ deleted_at: number | null; oss_key: string }>(
      'SELECT deleted_at, oss_key FROM owner_material WHERE id = $1',
      [MATERIAL_A],
    );
    expect(retained.rows[0]?.deleted_at).not.toBeNull();
    expect(retained.rows[0]?.oss_key).toBe(ossKey);

    await expect(
      deleteOwnedMaterial('owner-a', MATERIAL_A, { queryable, byteStore }),
    ).resolves.toBe('deleted');
  });

  it('does not read or delete another owner material even when its id is known', async () => {
    const { ossKey } = await insertReady('owner-b', MATERIAL_B);
    const deleteBytes = vi.fn(byteStore.delete.bind(byteStore));

    await expect(
      deleteOwnedMaterial('owner-a', MATERIAL_B, {
        queryable: db,
        byteStore: { ...byteStore, delete: deleteBytes },
      }),
    ).resolves.toBe('absent');
    expect(deleteBytes).not.toHaveBeenCalled();
    expect(objects.has(ossKey)).toBe(true);
    expect(await getReadyOwnerMaterial(db, 'owner-b', MATERIAL_B)).not.toBeNull();
  });
});
