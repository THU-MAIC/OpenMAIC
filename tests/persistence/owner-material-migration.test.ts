/**
 * The backfill of pre-pool material uploads into the asset pool
 * (`lib/server/materials/migrate-to-pool.ts`), on the extraction harness: a
 * real provider and real claims over PGlite, with a material byte store held
 * in memory so a test can watch every read and delete of an old object.
 */
import { createHash, randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { claimOwner } from '@/lib/persistence/owner-claims';
import { finalizeOwnerMaterial, registerOwnerMaterial } from '@/lib/persistence/owner-materials';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import {
  migrateOwnerMaterialsToPool,
  removeDeletedOriginals,
} from '@/lib/server/materials/migrate-to-pool';
import { readOwnerMaterialBytes } from '@/lib/server/materials/owner-material-bytes';

import {
  ACCOUNT,
  ANON,
  bootExtractionHarness,
  type ExtractionHarness,
  type ExtractionScenarioPool,
} from './_owner-extraction-scenarios';

/**
 * The PGlite pool, with a way to make one statement of a transaction fail, or
 * to lose the answer of a COMMIT that did happen.
 */
class FaultyPool implements ExtractionScenarioPool {
  /** Fail the first statement this matches, inside its transaction. */
  failOn: RegExp | undefined;
  /** Fail a direct pool query this matches (outside any transaction). */
  failDirect: RegExp | undefined;
  /** Once a statement this matches ran, throw right after that transaction's COMMIT. */
  loseCommitAfter: RegExp | undefined;

  constructor(readonly db: PGlite) {}

  async query<TRow>(text: string, params?: unknown[]) {
    if (this.failDirect?.test(text)) {
      this.failDirect = undefined;
      throw new Error('injected query failure');
    }
    return (await this.db.query(text, params)) as { rows: TRow[] };
  }

  async connect() {
    let loseThisCommit = false;
    return {
      query: async (text: string, params?: unknown[]) => {
        if (this.failOn?.test(text)) {
          this.failOn = undefined;
          throw new Error('injected statement failure');
        }
        if (this.loseCommitAfter?.test(text)) {
          this.loseCommitAfter = undefined;
          loseThisCommit = true;
        }
        const answer = await this.db.query(text, params);
        if (loseThisCommit && /^\s*COMMIT/i.test(text)) {
          loseThisCommit = false;
          throw new Error('connection reset after COMMIT');
        }
        return answer;
      },
      release() {},
    };
  }

  async end() {}
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// Each case boots the extraction harness (schemas, claim participants) on a
// fresh PGlite, which outlasts the default 5 s under a loaded parallel run.
describe('backfilling pre-pool material uploads into the asset pool', { timeout: 20_000 }, () => {
  let db: PGlite | undefined;
  let pool: FaultyPool;
  let h: ExtractionHarness;
  /** The material byte store: object key -> bytes. */
  let objects: Map<string, Buffer>;
  let deletes: string[];
  /** Runs inside the next read of an object, before it answers. */
  let onRead: ((key: string) => Promise<void>) | undefined;
  let failDelete = false;

  async function boot(env: Record<string, string> = {}) {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const databaseUrl = `postgres://owner-material-migration-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    db = new PGlite();
    await db.waitReady;
    pool = new FaultyPool(db);
    h = await bootExtractionHarness(pool, databaseUrl);
    objects = new Map();
    deletes = [];
    onRead = undefined;
    failDelete = false;
    setMaterialByteStoreForTests({
      deletePrefix: async (prefix) => {
        for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key);
      },
      list: async () => {
        throw new Error('Unexpected list in this byte-store fixture');
      },
      put: async (key, body) => void objects.set(key, Buffer.from(body as Uint8Array)),
      get: async (key) => {
        const hook = onRead;
        onRead = undefined;
        await hook?.(key);
        const value = objects.get(key);
        if (!value) throw new Error(`missing material bytes: ${key}`);
        return value;
      },
      delete: async (key) => {
        if (failDelete) throw new Error('byte store unavailable');
        deletes.push(key);
        objects.delete(key);
      },
    });
  }

  afterEach(async () => {
    setMaterialByteStoreForTests(null);
    vi.unstubAllEnvs();
    await db?.close();
    db = undefined;
  });

  /** A ready source as uploads made it before the pool: an object, no pointer. */
  async function legacySource(
    id: string,
    seed: { owner?: string; bytes?: Buffer; sha256?: string | null; object?: boolean } = {},
  ): Promise<Buffer> {
    const bytes = seed.bytes ?? Buffer.from(`%PDF-${id}`);
    await registerOwnerMaterial(
      h.pool as unknown as ConnectableQueryable,
      {
        id,
        ownerId: seed.owner ?? ANON,
        kind: 'source',
        mime: 'application/pdf',
        bytes: bytes.byteLength,
        originalName: `${id}.pdf`,
        ossKey: `objects/${id}`,
        extraction: { status: 'pending' },
      },
      { maxCount: 100, maxTotalBytes: 1_000_000 },
    );
    await finalizeOwnerMaterial(h.pool as never, id, bytes.byteLength, digest(bytes));
    if (seed.sha256 !== undefined) {
      await h.pool.query('UPDATE owner_material SET sha256 = $2 WHERE id = $1', [id, seed.sha256]);
    }
    if (seed.object !== false) objects.set(`objects/${id}`, bytes);
    return bytes;
  }

  const rowOf = async (id: string) =>
    (
      await h.pool.query<{ owner_id: string; asset_id: string | null; oss_key: string }>(
        'SELECT owner_id, asset_id, oss_key FROM owner_material WHERE id = $1',
        [id],
      )
    ).rows[0];
  const rootsOf = async (id: string): Promise<string[]> =>
    (
      await h.pool.query<{ asset_id: string }>(
        `SELECT asset_id FROM asset_root_refs WHERE root_kind = 'material' AND root_id = $1`,
        [id],
      )
    ).rows.map((row) => row.asset_id);
  const entryOf = async (id: string) =>
    (
      await h.pool.query<{ principal: string; committed_at: unknown; expires_at: unknown }>(
        'SELECT principal, committed_at, expires_at FROM asset_entries WHERE id = $1',
        [id],
      )
    ).rows[0];
  const entryCount = async (): Promise<number> =>
    (await h.pool.query('SELECT id FROM asset_entries')).rows.length;
  const run = () => migrateOwnerMaterialsToPool({ batchSize: 2, pauseMs: 0 });
  const zero = {
    scanned: 0,
    migrated: 0,
    oldBytesRemoved: 0,
    skippedMissing: 0,
    skippedDigest: 0,
    skippedQuota: 0,
    skippedLost: 0,
    failed: 0,
  };

  it('moves every ready source into the pool, then deletes its old object, across batches', async () => {
    await boot();
    const a = await legacySource('mat-a');
    const b = await legacySource('mat-b');
    const c = await legacySource('mat-c');
    // A session's own copy, and a record taken before the backfill.
    objects.set('materials/session-1/copy/raw', a);
    const before = {
      id: 'mat-a',
      ownerId: ANON,
      assetId: null,
      ossKey: 'objects/mat-a',
      sha256: digest(a),
    };

    expect(await run()).toEqual({ ...zero, scanned: 3, migrated: 3, oldBytesRemoved: 3 });

    for (const [id, bytes] of [
      ['mat-a', a],
      ['mat-b', b],
      ['mat-c', c],
    ] as const) {
      const row = await rowOf(id);
      expect(row?.oss_key).toBe('');
      expect(await rootsOf(id)).toEqual([row!.asset_id]);
      expect((await entryOf(row!.asset_id!))?.committed_at).not.toBeNull();
      expect(
        await readOwnerMaterialBytes({
          id,
          ownerId: ANON,
          assetId: row!.asset_id,
          ossKey: '',
          sha256: digest(bytes),
        }),
      ).toEqual(bytes);
    }
    expect(deletes.sort()).toEqual(['objects/mat-a', 'objects/mat-b', 'objects/mat-c']);
    // Session copies are the sessions' own: never deleted.
    expect(objects.get('materials/session-1/copy/raw')).toEqual(a);
    // A reader holding the record from before still reads the bytes.
    expect(await readOwnerMaterialBytes(before)).toEqual(a);
  });

  it('does not backfill classic originals or results, regardless of obsolete retention values', async () => {
    await boot();
    for (const status of ['idle', 'failed', 'extracting', 'ready']) {
      const id = `classic-${status}`;
      await legacySource(id);
      const extraction =
        status === 'ready'
          ? { status, resultKey: `objects/${id}.extraction/result.json` }
          : { status };
      await h.pool.query(
        `UPDATE owner_material SET extraction = $2::jsonb, retention = 'library' WHERE id = $1`,
        [id, JSON.stringify(extraction)],
      );
      if (status === 'ready') objects.set(extraction.resultKey!, Buffer.from('preserved result'));
    }
    expect(await run()).toEqual(zero);
    for (const status of ['idle', 'failed', 'extracting', 'ready']) {
      expect(await rowOf(`classic-${status}`)).toMatchObject({
        asset_id: null,
        oss_key: `objects/classic-${status}`,
      });
      expect(objects.has(`objects/classic-${status}`)).toBe(true);
    }
    expect(objects.has('objects/classic-ready.extraction/result.json')).toBe(true);
    expect(deletes).toEqual([]);
  });

  it('rechecks processing format before publishing a backfill selected before a retry', async () => {
    await boot();
    await legacySource('format-changed');
    onRead = async () => {
      await h.pool.query(
        `UPDATE owner_material SET extraction = '{"status":"extracting"}' WHERE id = 'format-changed'`,
      );
    };
    expect(await run()).toMatchObject({ scanned: 1, migrated: 0, skippedLost: 1 });
    expect(await rowOf('format-changed')).toMatchObject({
      asset_id: null,
      oss_key: 'objects/format-changed',
    });
    expect(deletes).toEqual([]);
  });

  it('changes nothing on a second pass', async () => {
    await boot();
    await legacySource('mat-a');
    await run();
    const after = await rowOf('mat-a');
    const entries = await entryCount();

    expect(await run()).toEqual(zero);
    expect(await rowOf('mat-a')).toEqual(after);
    expect(await entryCount()).toBe(entries);
  });

  it('finishes the delete on the next pass when it failed after the pointer committed', async () => {
    await boot();
    const bytes = await legacySource('mat-a');
    failDelete = true;

    expect(await run()).toMatchObject({ migrated: 1, oldBytesRemoved: 0, failed: 1 });
    const pointed = await rowOf('mat-a');
    expect(pointed?.asset_id).not.toBeNull();
    expect(pointed?.oss_key).toBe('objects/mat-a');
    expect(objects.get('objects/mat-a')).toEqual(bytes);

    failDelete = false;
    expect(await run()).toEqual({ ...zero, scanned: 1, oldBytesRemoved: 1 });
    expect(await rowOf('mat-a')).toEqual({ ...pointed, oss_key: '' });
    expect(objects.has('objects/mat-a')).toBe(false);
  });

  it('deletes nothing when the publication fails, and retries it on the next pass', async () => {
    await boot();
    const bytes = await legacySource('mat-a');
    pool.failOn = /UPDATE owner_material SET asset_id = \$2 WHERE id = \$1/;

    expect(await run()).toMatchObject({ scanned: 1, migrated: 0, failed: 1 });
    expect(await rowOf('mat-a')).toMatchObject({ asset_id: null, oss_key: 'objects/mat-a' });
    expect(await rootsOf('mat-a')).toEqual([]);
    expect(deletes).toEqual([]);
    expect(objects.get('objects/mat-a')).toEqual(bytes);
    // A publication that threw is not known to have failed: its allocation
    // stays, pending, for the collector.
    const kept = (
      await h.pool.query<{ committed_at: unknown }>('SELECT committed_at FROM asset_entries')
    ).rows;
    expect(kept).toEqual([{ committed_at: null }]);

    expect(await run()).toMatchObject({ migrated: 1, oldBytesRemoved: 1, failed: 0 });
  });

  it('deletes nothing when a publication that committed lost its answer', async () => {
    await boot();
    const bytes = await legacySource('mat-a');
    pool.loseCommitAfter = /UPDATE owner_material SET asset_id = \$2 WHERE id = \$1/;

    expect(await run()).toMatchObject({ scanned: 1, migrated: 0, failed: 1 });
    // It did commit, but this pass cannot know: the object stays, and so does
    // the allocation, which the row now names.
    const pointed = await rowOf('mat-a');
    expect(pointed?.asset_id).not.toBeNull();
    expect(deletes).toEqual([]);
    expect(objects.get('objects/mat-a')).toEqual(bytes);
    expect(await entryCount()).toBe(1);
    expect(await rootsOf('mat-a')).toEqual([pointed!.asset_id]);
    expect(
      await readOwnerMaterialBytes({
        id: 'mat-a',
        ownerId: ANON,
        assetId: pointed!.asset_id,
        ossKey: '',
        sha256: digest(bytes),
      }),
    ).toEqual(bytes);

    // The next pass goes by the committed row: no second publication.
    expect(await run()).toEqual({ ...zero, scanned: 1, oldBytesRemoved: 1 });
    expect(await rootsOf('mat-a')).toHaveLength(1);
  });

  it('deletes nothing when the re-read of the committed row fails', async () => {
    await boot();
    const bytes = await legacySource('mat-a');
    pool.failDirect = /SELECT asset_id, oss_key, deleted_at FROM owner_material WHERE id = \$1/;

    expect(await run()).toMatchObject({ scanned: 1, migrated: 1, oldBytesRemoved: 0, failed: 1 });
    expect(deletes).toEqual([]);
    expect(objects.get('objects/mat-a')).toEqual(bytes);
  });

  it('skips a missing object, a digest it cannot trust and a full pool, leaving each as it was', async () => {
    await boot({ ASSET_QUOTA_BYTES: '20' });
    await legacySource('mat-missing', { object: false });
    await legacySource('mat-no-digest', { sha256: null });
    await legacySource('mat-wrong-digest', { sha256: 'f'.repeat(64) });
    await legacySource('mat-too-big', { bytes: Buffer.alloc(64, 1) });
    const before = await Promise.all(
      ['mat-missing', 'mat-no-digest', 'mat-wrong-digest', 'mat-too-big'].map(rowOf),
    );

    expect(await run()).toEqual({
      ...zero,
      scanned: 4,
      skippedMissing: 1,
      skippedDigest: 2,
      skippedQuota: 1,
    });
    expect(
      await Promise.all(
        ['mat-missing', 'mat-no-digest', 'mat-wrong-digest', 'mat-too-big'].map(rowOf),
      ),
    ).toEqual(before);
    expect(deletes).toEqual([]);
  });

  it('leaves rows that have nothing to move alone', async () => {
    await boot();
    // A pre-byte-store row: ready, but no object and no pointer.
    await legacySource('mat-empty', { object: false });
    await h.pool.query(`UPDATE owner_material SET oss_key = '' WHERE id = 'mat-empty'`);
    // A reservation still uploading.
    await registerOwnerMaterial(
      h.pool as unknown as ConnectableQueryable,
      {
        id: 'mat-uploading',
        ownerId: ANON,
        kind: 'source',
        bytes: 1,
        ossKey: 'objects/u',
      },
      { maxCount: 100, maxTotalBytes: 1_000_000 },
    );

    expect(await run()).toEqual(zero);
    expect(await rowOf('mat-empty')).toMatchObject({ asset_id: null, oss_key: '' });
    expect(deletes).toEqual([]);
  });

  it('leaves a deleted source to the cleanup pass', async () => {
    await boot();
    // A deletion whose own cleanup of the old object did not happen.
    const bytes = await legacySource('mat-deleted');
    await h.pool.query(`UPDATE owner_material SET deleted_at = 1 WHERE id = 'mat-deleted'`);

    expect(await run()).toEqual(zero);
    expect(await rowOf('mat-deleted')).toMatchObject({ oss_key: 'objects/mat-deleted' });
    expect(objects.get('objects/mat-deleted')).toEqual(bytes);
    expect(deletes).toEqual([]);
  });

  it('gives up on a row another backfill published first, keeps that one pointer, and removes its own allocation', async () => {
    await boot();
    const bytes = await legacySource('mat-a');
    // While this pass reads the object, a second pass migrates the same row
    // from start to finish.
    let second: Awaited<ReturnType<typeof run>> | undefined;
    onRead = async () => {
      objects.set('objects/mat-a', bytes);
      second = await run();
      // The second pass deleted the object; this pass had already read it.
      objects.set('objects/mat-a', bytes);
    };

    expect(await run()).toMatchObject({ scanned: 1, migrated: 0, skippedLost: 1 });

    expect(second).toMatchObject({ migrated: 1, oldBytesRemoved: 1 });
    const row = await rowOf('mat-a');
    expect(await rootsOf('mat-a')).toEqual([row!.asset_id]);
    // The loser's allocation, which nothing names, is gone: only the winner's
    // entry is left, and only it counts against the owner's quota.
    const entries = (
      await h.pool.query<{ id: string; committed_at: unknown }>(
        'SELECT id, committed_at FROM asset_entries ORDER BY id',
      )
    ).rows;
    expect(entries.map((entry) => entry.id)).toEqual([row!.asset_id]);
    expect(entries[0]?.committed_at).not.toBeNull();
  });

  it('removes its allocation when the row was deleted before the publication', async () => {
    await boot();
    const bytes = await legacySource('mat-a');
    onRead = async () => {
      await h.pool.query(`UPDATE owner_material SET deleted_at = 1 WHERE id = 'mat-a'`);
    };

    expect(await run()).toMatchObject({ scanned: 1, migrated: 0, skippedLost: 1, failed: 0 });
    expect(await entryCount()).toBe(0);
    expect(await rootsOf('mat-a')).toEqual([]);
    expect(deletes).toEqual([]);
    expect(objects.get('objects/mat-a')).toEqual(bytes);
  });

  it('removes a losing allocation made for the account after a claim, under the account', async () => {
    await boot();
    const bytes = await legacySource('mat-a');
    // The claim lands before this pass allocates, so its allocation is made
    // for the account; the second pass then publishes first.
    onRead = async () => {
      await claimOwner(ANON, ACCOUNT, { provider: h.provider });
      objects.set('objects/mat-a', bytes);
      await run();
      objects.set('objects/mat-a', bytes);
    };

    expect(await run()).toMatchObject({ scanned: 1, migrated: 0, skippedLost: 1 });

    const row = await rowOf('mat-a');
    expect(row?.owner_id).toBe(ACCOUNT);
    const entries = (
      await h.pool.query<{ id: string; principal: string }>(
        'SELECT id, principal FROM asset_entries',
      )
    ).rows;
    expect(entries).toEqual([
      { id: row!.asset_id, principal: assetPrincipalForOwner(ACCOUNT).key },
    ]);
  });

  it('leaves a losing allocation to expire when removing it fails, without failing the row', async () => {
    await boot();
    const bytes = await legacySource('mat-a');
    onRead = async () => {
      objects.set('objects/mat-a', bytes);
      await run();
      objects.set('objects/mat-a', bytes);
    };
    pool.failOn = /^\s*DELETE FROM asset_entries/;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await run()).toMatchObject({ scanned: 1, migrated: 0, skippedLost: 1, failed: 0 });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unused allocation for material mat-a left to expire'),
      expect.anything(),
    );
    // The winner's entry, and this pass's allocation, kept to expire.
    expect(await entryCount()).toBe(2);
  });

  it('follows a claim that lands mid-backfill to the account', async () => {
    await boot();
    const bytes = await legacySource('mat-a');
    onRead = async () => {
      await claimOwner(ANON, ACCOUNT, { provider: h.provider });
    };

    expect(await run()).toMatchObject({ migrated: 1, oldBytesRemoved: 1, failed: 0 });

    const row = await rowOf('mat-a');
    expect(row?.owner_id).toBe(ACCOUNT);
    expect((await entryOf(row!.asset_id!))?.principal).toBe(assetPrincipalForOwner(ACCOUNT).key);
    expect(await rootsOf('mat-a')).toEqual([row!.asset_id]);
    expect(
      await readOwnerMaterialBytes({
        id: 'mat-a',
        ownerId: ACCOUNT,
        assetId: row!.asset_id,
        ossKey: '',
        sha256: digest(bytes),
      }),
    ).toEqual(bytes);
  });

  describe('the cleanup pass for deleted sources', () => {
    const clean = () => removeDeletedOriginals({ batchSize: 2, pauseMs: 0 });
    const deleted = async (id: string) => {
      await legacySource(id);
      await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', [id]);
    };

    it('removes the old objects of deleted sources, across batches, without migrating them', async () => {
      await boot();
      for (const id of ['mat-a', 'mat-b', 'mat-c']) await deleted(id);

      expect(await clean()).toEqual({ scanned: 3, oldBytesRemoved: 3, failed: 0 });
      for (const id of ['mat-a', 'mat-b', 'mat-c']) {
        expect(await rowOf(id)).toMatchObject({ asset_id: null, oss_key: '' });
        expect(await rootsOf(id)).toEqual([]);
      }
      expect(deletes).toEqual(['objects/mat-a', 'objects/mat-b', 'objects/mat-c']);
      expect(await entryCount()).toBe(0);
      expect(await clean()).toEqual({ scanned: 0, oldBytesRemoved: 0, failed: 0 });
    });

    it('leaves the objects of live sources to the backfill', async () => {
      await boot();
      // Pointer committed, old object kept by a failed delete: only the
      // flagged backfill may remove it.
      const moved = await legacySource('mat-moved');
      failDelete = true;
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(await run()).toMatchObject({ migrated: 1, failed: 1 });
      failDelete = false;
      // Not moved at all.
      const unmoved = await legacySource('mat-unmoved');

      expect(await clean()).toEqual({ scanned: 0, oldBytesRemoved: 0, failed: 0 });
      expect(deletes).toEqual([]);
      expect(objects.get('objects/mat-moved')).toEqual(moved);
      expect(objects.get('objects/mat-unmoved')).toEqual(unmoved);
      expect(await rowOf('mat-moved')).toMatchObject({ oss_key: 'objects/mat-moved' });
    });

    it('keeps oss_key when the re-read or the delete fails, for the next pass', async () => {
      await boot();
      await deleted('mat-a');
      await deleted('mat-b');
      pool.failDirect = /SELECT asset_id, oss_key, deleted_at FROM owner_material WHERE id = \$1/;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(await clean()).toEqual({ scanned: 2, oldBytesRemoved: 1, failed: 1 });
      expect(await rowOf('mat-a')).toMatchObject({ oss_key: 'objects/mat-a' });
      expect(objects.has('objects/mat-a')).toBe(true);

      failDelete = true;
      expect(await clean()).toEqual({ scanned: 1, oldBytesRemoved: 0, failed: 1 });
      expect(await rowOf('mat-a')).toMatchObject({ oss_key: 'objects/mat-a' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('old original for material mat-a left for the next pass'),
        expect.anything(),
      );

      failDelete = false;
      expect(await clean()).toEqual({ scanned: 1, oldBytesRemoved: 1, failed: 0 });
      expect(await rowOf('mat-a')).toMatchObject({ oss_key: '' });
      expect(objects.has('objects/mat-a')).toBe(false);
    });
  });
});
