/**
 * Owner material uploads in the asset pool, against a real provider on
 * PGlite: allocation and publication, the cleanup deletes and their root
 * withdrawal, and the pool-first reader.
 */
import { createHash, randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withMaterialRoots } from '@/lib/persistence/material-roots';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import {
  abandonOwnerMaterial,
  allocateOwnerMaterialBytes,
  publishOwnerMaterialUpload,
  reclaimStaleOwnerMaterialUploads,
  registerOwnerMaterial,
  type OwnerMaterialPersistence,
} from '@/lib/persistence/owner-materials';
import {
  getServerPersistenceProvider,
  type ServerPersistenceProvider,
} from '@/lib/persistence/server-provider';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import {
  OwnerMaterialBytesUnavailableError,
  readOwnerMaterialBytes,
} from '@/lib/server/materials/owner-material-bytes';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  async query<TRow>(text: string, params?: unknown[]) {
    return (await this.db.query(text, params)) as { rows: TRow[] };
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {}
}

const OWNER = 'user:alice';
const ACCOUNT = 'user:alice-account';
const BYTES = Buffer.from('lesson bytes');
const DIGEST = createHash('sha256').update(BYTES).digest('hex');

describe('owner material uploads in the asset pool', () => {
  let db: PGlite;
  let pool: PGlitePool;
  let provider: ServerPersistenceProvider;
  /** The material byte store, for rows from before the pool. */
  let objects: Map<string, Buffer>;

  beforeEach(async () => {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const databaseUrl = `postgres://owner-material-pool-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    provider = await getServerPersistenceProvider(databaseUrl, () => pool as never);
    objects = new Map();
    setMaterialByteStoreForTests({
      deletePrefix: async () => {
        throw new Error('Unexpected deletePrefix in this byte-store fixture');
      },
      list: async () => {
        throw new Error('Unexpected list in this byte-store fixture');
      },
      put: async (key, body) => void objects.set(key, Buffer.from(body as Uint8Array)),
      get: async (key) => {
        const value = objects.get(key);
        if (!value) throw new Error(`missing material bytes: ${key}`);
        return value;
      },
      delete: async (key) => void objects.delete(key),
    });
  });

  afterEach(async () => {
    setMaterialByteStoreForTests(null);
    vi.unstubAllEnvs();
    await db.close();
  });

  const reserve = (id: string, ossKey = '') =>
    registerOwnerMaterial(
      pool as unknown as ConnectableQueryable,
      {
        id,
        ownerId: OWNER,
        kind: 'source',
        mime: 'application/pdf',
        bytes: BYTES.byteLength,
        originalName: `${id}.pdf`,
        ossKey,
        extraction: { status: 'idle' },
      },
      { maxCount: 100, maxTotalBytes: 1_000_000 },
    );
  const allocate = () => allocateOwnerMaterialBytes(provider, OWNER, BYTES, 'application/pdf');
  const publish = (id: string, assetId: string, persistence: OwnerMaterialPersistence = provider) =>
    publishOwnerMaterialUpload(persistence, OWNER, id, {
      assetId,
      bytes: BYTES.byteLength,
      sha256: 'digest',
    });
  const rowOf = async (id: string) =>
    (
      await db.query<{ status: string; asset_id: string | null; oss_key: string }>(
        'SELECT status, asset_id, oss_key FROM owner_material WHERE id = $1',
        [id],
      )
    ).rows[0];
  const rootsOf = async (materialId: string): Promise<string[]> =>
    (
      await db.query<{ asset_id: string }>(
        `SELECT asset_id FROM asset_root_refs WHERE root_kind = 'material' AND root_id = $1`,
        [materialId],
      )
    ).rows.map((row) => row.asset_id);
  const entryOf = async (id: string) =>
    (
      await db.query<{
        committed_at: unknown;
        expires_at: unknown;
        unreferenced_at: unknown;
      }>('SELECT committed_at, expires_at, unreferenced_at FROM asset_entries WHERE id = $1', [id])
    ).rows[0];

  /** The provider, with every statement `failOn` matches failing inside its transaction. */
  const failingOn = (failOn: RegExp): OwnerMaterialPersistence => ({
    pool: provider.pool,
    assetStoreIn: provider.assetStoreIn,
    withTransaction: ((body: (tx: Queryable) => Promise<unknown>) =>
      provider.withTransaction((tx) =>
        body({
          query: (text: string, params?: unknown[]) => {
            if (failOn.test(text)) throw new Error('injected statement failure');
            return tx.query(text, params as never);
          },
        } as Queryable),
      )) as WithTransaction,
  });

  describe('allocation and publication', () => {
    it('publishes the pointer, the root and ready together, and writes no byte-store object', async () => {
      await reserve('mat_new');
      const assetId = await allocate();
      // Allocated, not yet published: a pending entry nothing names.
      expect((await entryOf(assetId))?.expires_at).not.toBeNull();

      const published = await publish('mat_new', assetId);

      expect(published).toMatchObject({ id: 'mat_new', status: 'ready', assetId, ossKey: '' });
      expect(await rootsOf('mat_new')).toEqual([assetId]);
      const entry = await entryOf(assetId);
      expect(entry?.committed_at).not.toBeNull();
      expect(entry?.expires_at).toBeNull();
      expect(objects.size).toBe(0);
      expect(await readOwnerMaterialBytes(published as never)).toEqual(BYTES);
    });

    it('rolls the root and the pointer back when the publication fails after the root call', async () => {
      await reserve('mat_failing');
      const assetId = await allocate();

      await expect(
        publish(
          'mat_failing',
          assetId,
          failingOn(/SET bytes = \$2, sha256 = \$3, status = 'ready'/),
        ),
      ).rejects.toThrow('injected statement failure');

      expect(await rowOf('mat_failing')).toMatchObject({ status: 'uploading', asset_id: null });
      expect(await rootsOf('mat_failing')).toEqual([]);
      // The allocation stays pending, to expire like any unpublished entry.
      expect((await entryOf(assetId))?.committed_at).toBeNull();
      expect((await entryOf(assetId))?.expires_at).not.toBeNull();

      await abandonOwnerMaterial(provider, OWNER, 'mat_failing');
      expect(await rowOf('mat_failing')).toBeUndefined();
      expect(await entryOf(assetId)).toBeDefined();
    });

    it('leaves a publication whose answer was lost intact when the reservation is then abandoned', async () => {
      await reserve('mat_lost_reply');
      const assetId = await allocate();
      const lostReply: OwnerMaterialPersistence = {
        ...provider,
        withTransaction: (async (body: (tx: Queryable) => Promise<unknown>) => {
          await provider.withTransaction(body);
          throw new Error('connection reset after COMMIT');
        }) as WithTransaction,
      };

      await expect(publish('mat_lost_reply', assetId, lostReply)).rejects.toThrow(
        'connection reset after COMMIT',
      );
      // What the upload route does next: abandon. It only matches `uploading`.
      await abandonOwnerMaterial(provider, OWNER, 'mat_lost_reply');

      expect(await rowOf('mat_lost_reply')).toMatchObject({ status: 'ready', asset_id: assetId });
      expect(await rootsOf('mat_lost_reply')).toEqual([assetId]);
      expect(
        await readOwnerMaterialBytes({
          id: 'mat_lost_reply',
          ownerId: OWNER,
          assetId,
          ossKey: '',
          sha256: DIGEST,
        }),
      ).toEqual(BYTES);
    });

    it('refuses to replace a pointer the row already has, and writes nothing', async () => {
      await reserve('mat_pointed');
      const first = await allocate();
      await withMaterialRoots(
        provider,
        { ownerId: OWNER, fence: 'request', materialIds: ['mat_pointed'] },
        async ({ tx, changeRoots }) => {
          await changeRoots({ add: [{ materialId: 'mat_pointed', assetIds: [first] }] });
          await tx.query('UPDATE owner_material SET asset_id = $2 WHERE id = $1', [
            'mat_pointed',
            first,
          ]);
        },
      );
      const second = await allocate();

      await expect(publish('mat_pointed', second)).resolves.toBe('refused');

      expect(await rowOf('mat_pointed')).toMatchObject({ status: 'uploading', asset_id: first });
      expect(await rootsOf('mat_pointed')).toEqual([first]);
      expect((await entryOf(second))?.committed_at).toBeNull();
    });
  });

  describe('deleting an uploading row withdraws its roots in the same transaction', () => {
    /** A root on an uploading row: never written by an upload, a defensive fixture. */
    const rootedReservation = async (id: string): Promise<string> => {
      await reserve(id);
      const assetId = await allocate();
      await withMaterialRoots(
        provider,
        { ownerId: OWNER, fence: 'request', materialIds: [id] },
        ({ changeRoots }) => changeRoots({ add: [{ materialId: id, assetIds: [assetId] }] }),
      );
      return assetId;
    };

    it('removes the root with the row and stamps the entry it held', async () => {
      const assetId = await rootedReservation('mat_rooted_upload');

      await abandonOwnerMaterial(provider, OWNER, 'mat_rooted_upload');

      expect(await rowOf('mat_rooted_upload')).toBeUndefined();
      expect(await rootsOf('mat_rooted_upload')).toEqual([]);
      expect((await entryOf(assetId))?.unreferenced_at).not.toBeNull();
    });

    it('keeps the root and the row together when the delete fails after the withdrawal', async () => {
      const assetId = await rootedReservation('mat_rooted_kept');

      await expect(
        abandonOwnerMaterial(failingOn(/^DELETE FROM owner_material/), OWNER, 'mat_rooted_kept'),
      ).rejects.toThrow('injected statement failure');

      expect(await rowOf('mat_rooted_kept')).toMatchObject({ status: 'uploading' });
      expect(await rootsOf('mat_rooted_kept')).toEqual([assetId]);
      expect((await entryOf(assetId))?.unreferenced_at).toBeNull();
    });

    const ageOut = (id: string) =>
      db.query('UPDATE owner_material SET created_at = $2 WHERE id = $1', [
        id,
        Date.now() - 25 * 60 * 60 * 1_000,
      ]);

    it('the stale-upload reclaim withdraws the root with the row as well', async () => {
      const assetId = await rootedReservation('mat_rooted_stale');
      await ageOut('mat_rooted_stale');
      const deleteBytes = vi.fn(async () => undefined);

      await reclaimStaleOwnerMaterialUploads(provider, OWNER, deleteBytes);

      // A pool-era reservation names no object, so no byte deletion is asked for.
      expect(deleteBytes).not.toHaveBeenCalled();
      expect(await rowOf('mat_rooted_stale')).toBeUndefined();
      expect(await rootsOf('mat_rooted_stale')).toEqual([]);
      expect((await entryOf(assetId))?.unreferenced_at).not.toBeNull();
    });

    it('the stale-upload reclaim keeps root and row together when its delete fails', async () => {
      const assetId = await rootedReservation('mat_rooted_stale_kept');
      await ageOut('mat_rooted_stale_kept');

      await expect(
        reclaimStaleOwnerMaterialUploads(
          failingOn(/^DELETE FROM owner_material/),
          OWNER,
          async () => undefined,
        ),
      ).rejects.toThrow('injected statement failure');

      expect(await rowOf('mat_rooted_stale_kept')).toMatchObject({ status: 'uploading' });
      expect(await rootsOf('mat_rooted_stale_kept')).toEqual([assetId]);
      expect((await entryOf(assetId))?.unreferenced_at).toBeNull();
    });

    it('never deletes a published row', async () => {
      await reserve('mat_ready');
      const assetId = await allocate();
      await publish('mat_ready', assetId);

      await abandonOwnerMaterial(provider, OWNER, 'mat_ready');

      expect(await rowOf('mat_ready')).toMatchObject({ status: 'ready', asset_id: assetId });
      expect(await rootsOf('mat_ready')).toEqual([assetId]);
    });
  });

  describe('the pool-first reader', () => {
    it('reads a row from before the pool by its object key', async () => {
      objects.set('materials/legacy', BYTES);
      expect(
        await readOwnerMaterialBytes({
          id: 'mat_legacy',
          ownerId: OWNER,
          assetId: null,
          ossKey: 'materials/legacy',
          sha256: DIGEST,
        }),
      ).toEqual(BYTES);
    });

    it('reads from the pool when its record predates the backfill that deleted the object', async () => {
      await reserve('mat_migrated', 'materials/migrated');
      // The backfill's order: publish the pointer and root, then delete the object.
      const assetId = await allocate();
      await withMaterialRoots(
        provider,
        { ownerId: OWNER, fence: 'background', materialIds: ['mat_migrated'] },
        async ({ tx, changeRoots }) => {
          await changeRoots({ add: [{ materialId: 'mat_migrated', assetIds: [assetId] }] });
          await tx.query('UPDATE owner_material SET asset_id = $2 WHERE id = $1', [
            'mat_migrated',
            assetId,
          ]);
        },
      );
      // The record a reader took before all of that.
      const stale = {
        id: 'mat_migrated',
        ownerId: OWNER,
        assetId: null,
        ossKey: 'materials/migrated',
        sha256: DIGEST,
      };

      expect(await readOwnerMaterialBytes(stale)).toEqual(BYTES);
    });

    it('reads under the owner the row has now when a claim moved it after the record was read', async () => {
      await reserve('mat_claimed');
      const assetId = await allocate();
      await publish('mat_claimed', assetId);
      const beforeClaim = { id: 'mat_claimed', ownerId: OWNER, assetId, ossKey: '', sha256: null };
      // What a claim does to these two rows, in its one transaction.
      await db.query('UPDATE owner_material SET owner_id = $2 WHERE id = $1', [
        'mat_claimed',
        ACCOUNT,
      ]);
      await db.query('UPDATE asset_entries SET principal = $2 WHERE id = $1', [
        assetId,
        assetPrincipalForOwner(ACCOUNT).key,
      ]);

      expect(await readOwnerMaterialBytes(beforeClaim)).toEqual(BYTES);
    });

    it('reports bytes that are nowhere as unavailable', async () => {
      await reserve('mat_nowhere', 'materials/gone');

      await expect(
        readOwnerMaterialBytes({
          id: 'mat_nowhere',
          ownerId: OWNER,
          assetId: null,
          ossKey: 'materials/gone',
          sha256: DIGEST,
        }),
      ).rejects.toBeInstanceOf(OwnerMaterialBytesUnavailableError);
    });

    it('refuses an old object that does not match its recorded digest, or has none', async () => {
      objects.set('materials/damaged', Buffer.from('lesson bytEs'));
      objects.set('materials/undigested', BYTES);
      const legacy = (id: string, ossKey: string, sha256: string | null) =>
        readOwnerMaterialBytes({ id, ownerId: OWNER, assetId: null, ossKey, sha256 });

      await expect(legacy('mat_damaged', 'materials/damaged', DIGEST)).rejects.toBeInstanceOf(
        OwnerMaterialBytesUnavailableError,
      );
      await expect(legacy('mat_undigested', 'materials/undigested', null)).rejects.toBeInstanceOf(
        OwnerMaterialBytesUnavailableError,
      );
    });

    /**
     * A ready row the backfill moved but whose old object it could not delete:
     * a pointer and a root, and still its `oss_key`.
     */
    const retainedOldObject = async (id: string, old: Buffer = BYTES) => {
      const ossKey = `materials/${id}`;
      await reserve(id, ossKey);
      await db.query(`UPDATE owner_material SET status = 'ready', sha256 = $2 WHERE id = $1`, [
        id,
        DIGEST,
      ]);
      objects.set(ossKey, old);
      const assetId = await allocate();
      await withMaterialRoots(
        provider,
        { ownerId: OWNER, fence: 'background', materialIds: [id] },
        async ({ tx, changeRoots }) => {
          await changeRoots({ add: [{ materialId: id, assetIds: [assetId] }] });
          await tx.query('UPDATE owner_material SET asset_id = $2 WHERE id = $1', [id, assetId]);
        },
      );
      return { id, ownerId: OWNER, assetId, ossKey, sha256: DIGEST };
    };

    it('reads the retained old object when the pool has no entry for the pointer', async () => {
      const record = await retainedOldObject('mat_retained');
      await db.query('DELETE FROM asset_entries WHERE id = $1', [record.assetId]);

      expect(await readOwnerMaterialBytes(record)).toEqual(BYTES);
    });

    it('reads the retained old object when every pool read throws', async () => {
      const record = await retainedOldObject('mat_retained_throws');
      const resolve = vi
        .spyOn(Object.getPrototypeOf(provider.assetStore), 'resolve')
        .mockRejectedValue(new Error('pool unavailable'));

      try {
        expect(await readOwnerMaterialBytes(record)).toEqual(BYTES);
        // The first read and the fenced retry both tried the pool.
        expect(resolve).toHaveBeenCalledTimes(2);
      } finally {
        resolve.mockRestore();
      }
    });

    it('reads the retained old object after a SQL error in the fenced pool read, and the connection recovers', async () => {
      const record = await retainedOldObject('mat_retained_sql');
      // Every pool read now fails in the database, leaving its transaction aborted.
      await db.query('ALTER TABLE asset_entries RENAME TO asset_entries_away');
      try {
        expect(await readOwnerMaterialBytes(record)).toEqual(BYTES);
        // Not left inside an aborted transaction.
        expect((await db.query<{ one: number }>('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
      } finally {
        await db.query('ALTER TABLE asset_entries_away RENAME TO asset_entries');
      }
    });

    it('refuses a retained old object that does not match its recorded digest', async () => {
      const record = await retainedOldObject('mat_retained_damaged', Buffer.from('lesson bytEs'));
      await db.query('DELETE FROM asset_entries WHERE id = $1', [record.assetId]);

      await expect(readOwnerMaterialBytes(record)).rejects.toBeInstanceOf(
        OwnerMaterialBytesUnavailableError,
      );
    });

    it('refuses a damaged retained old object when every pool read throws', async () => {
      const record = await retainedOldObject(
        'mat_retained_damaged_throws',
        Buffer.from('lesson bytEs'),
      );
      const resolve = vi
        .spyOn(Object.getPrototypeOf(provider.assetStore), 'resolve')
        .mockRejectedValue(new Error('pool unavailable'));

      try {
        await expect(readOwnerMaterialBytes(record)).rejects.toBeInstanceOf(
          OwnerMaterialBytesUnavailableError,
        );
      } finally {
        resolve.mockRestore();
      }
    });

    it('takes the digest from the fenced re-read, not from a stale record', async () => {
      const record = await retainedOldObject('mat_retained_stale_digest');
      await db.query('DELETE FROM asset_entries WHERE id = $1', [record.assetId]);

      // A record taken before the pointer: no pointer, no digest of its own.
      expect(
        await readOwnerMaterialBytes({ ...record, assetId: null, ossKey: '', sha256: null }),
      ).toEqual(BYTES);
    });
  });
});
