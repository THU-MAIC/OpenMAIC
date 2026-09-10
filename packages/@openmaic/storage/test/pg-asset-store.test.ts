import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { AssetMeta, AssetRef, BinaryBlob, StorageProvider } from '@openmaic/dsl';
import { contentHashOf, ObjectUrlCache, type ContentHash } from '../src/asset/blob.js';
import type { AssetByteStore, AssetSignedReadHeaders } from '../src/asset/byte-store.js';
import { AssetCollector } from '../src/asset/collector.js';
import { __setAssetIdFactoryForTesting, type AssetId } from '../src/asset/id.js';
import { PgAssetByteStore } from '../src/asset/pg-bytes.js';
import {
  ASSET_PG_SCHEMA,
  PgAssetStore,
  ensureAssetSchema,
  type PgAssetStoreOptions,
  type QueryResult,
  type Queryable,
  type WithTransaction,
} from '../src/asset/pg.js';
import { AssetNotFoundError, AssetQuotaExceededError } from '../src/asset/types.js';
import {
  commonDigestEncodings,
  expectNoDigestSubstring,
  runAssetStoreContract,
} from './asset-contract.js';
import { blobForObjectUrl } from './setup.js';

const PRINCIPAL = { key: 'principal-a' } as const;
const OTHER_PRINCIPAL = { key: 'principal-b' } as const;
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const blob = (value: string, type = 'text/plain'): Blob => new Blob([value], { type });

function transactions(db: PGlite): WithTransaction {
  return (body) => db.transaction((tx: Queryable) => body(tx));
}

function options(
  db: PGlite,
  byteStore: AssetByteStore,
  extra: Partial<PgAssetStoreOptions> = {},
): PgAssetStoreOptions {
  return { withTransaction: transactions(db), byteStore, ...extra };
}

interface UrlIdentity {
  revision: number;
  mime: string;
}

class LazyPgProvider implements StorageProvider {
  readonly db = new PGlite();
  readonly byteStore = new PgAssetByteStore(this.db);
  readonly registry = new PgAssetStore(this.db, options(this.db, this.byteStore));
  readonly ready = this.db.waitReady.then(() => ensureAssetSchema(this.db));
  private readonly urls = new ObjectUrlCache<UrlIdentity>(
    (left, right) => left.revision === right.revision && left.mime === right.mime,
  );

  async put(data: BinaryBlob, meta?: AssetMeta): Promise<AssetId> {
    await this.ready;
    return this.registry.put(PRINCIPAL, data, meta);
  }

  async resolve(ref: AssetRef): Promise<string | null> {
    await this.ready;
    const asset = await this.registry.resolve(PRINCIPAL, ref);
    if (!asset) {
      await this.urls.invalidate(ref);
      return null;
    }
    const identity = { revision: asset.revision, mime: asset.mime };
    return this.urls.resolve(ref, identity, async () => ({
      identity,
      url: URL.createObjectURL(
        new Blob(
          [
            asset.bytes.buffer.slice(
              asset.bytes.byteOffset,
              asset.bytes.byteOffset + asset.bytes.byteLength,
            ) as ArrayBuffer,
          ],
          { type: asset.mime },
        ),
      ),
    }));
  }

  async remove(ref: AssetRef): Promise<void> {
    await this.ready;
    await this.registry.remove(PRINCIPAL, ref);
    await this.urls.invalidate(ref);
  }

  async replace(ref: AssetId, data: Blob, meta?: AssetMeta): Promise<void> {
    await this.ready;
    await this.registry.replace(PRINCIPAL, ref, data, meta);
    await this.urls.invalidate(ref);
  }

  async close(): Promise<void> {
    await this.urls.close();
    await this.db.close();
  }
}

describe('PgAssetStore shared contract with PGlite', () => {
  const providers: LazyPgProvider[] = [];

  afterEach(async () => {
    __setAssetIdFactoryForTesting(null);
    await Promise.all(providers.splice(0).map((provider) => provider.close()));
  });

  runAssetStoreContract(
    'PgAssetStore (PGlite)',
    {
      makeStore: () => {
        const provider = new LazyPgProvider();
        providers.push(provider);
        return provider;
      },
      withAllocator: async (allocator, run) => {
        __setAssetIdFactoryForTesting(allocator);
        try {
          return await run();
        } finally {
          __setAssetIdFactoryForTesting(null);
        }
      },
    },
    async (url) => {
      const stored = blobForObjectUrl(url);
      if (!stored) throw new Error('object URL is not registered');
      return new Uint8Array(await stored.arrayBuffer());
    },
  );
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function recordingQueryable(queryable: Queryable, statements: string[]): Queryable {
  return {
    async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<QueryResult<TRow>> {
      statements.push(normalizeSql(text));
      return queryable.query<TRow>(text, params);
    },
  };
}

function recordingTransactions(db: PGlite, statements: string[]): WithTransaction {
  return (body) => db.transaction((tx: Queryable) => body(recordingQueryable(tx, statements)));
}

class MemoryByteStore implements AssetByteStore {
  readonly values = new Map<ContentHash, Uint8Array>();
  onWrite?: () => void;
  // Bytes live in a process-local map, never in the registry's PostgreSQL, so
  // the plain methods cannot contend for its row locks (see
  // AssetByteStore.writesOutsideRegistryDatabase).
  readonly writesOutsideRegistryDatabase = true as const;

  async write(hash: ContentHash, value: Uint8Array): Promise<void> {
    this.values.set(hash, new Uint8Array(value));
    this.onWrite?.();
  }

  async read(hash: ContentHash): Promise<Uint8Array | null> {
    const value = this.values.get(hash);
    return value ? new Uint8Array(value) : null;
  }

  async delete(hash: ContentHash): Promise<void> {
    this.values.delete(hash);
  }
}

describe('PgAssetStore registry behavior with PGlite', () => {
  let db: PGlite;
  let byteStore: PgAssetByteStore;
  let store: PgAssetStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAssetSchema(db);
    byteStore = new PgAssetByteStore(db);
    store = new PgAssetStore(db, options(db, byteStore));
  });

  afterEach(async () => {
    __setAssetIdFactoryForTesting(null);
    await db.close();
  });

  /** Store each value, drop the entry that references it, and age the blob out of any grace. */
  async function unreference(values: readonly string[]): Promise<ContentHash[]> {
    const hashes: ContentHash[] = [];
    for (const value of values) {
      const id = await store.put(PRINCIPAL, blob(value));
      const { contentHash } = await contentHashOf(blob(value));
      await store.remove(PRINCIPAL, id);
      await stampUnreferencedAt(contentHash, '2000-01-01T00:00:00.000Z');
      hashes.push(contentHash);
    }
    return hashes;
  }

  async function stampUnreferencedAt(hash: ContentHash, at: string): Promise<void> {
    await db.query(
      'UPDATE asset_blobs SET unreferenced_at = $2::timestamptz WHERE content_hash = $1',
      [hash, at],
    );
  }

  async function remainingBlobs(): Promise<ContentHash[]> {
    const result = await db.query<{ content_hash: ContentHash }>(
      'SELECT content_hash FROM asset_blobs',
    );
    return result.rows.map((row) => row.content_hash).sort();
  }

  function boundedCollector(batchSize: number, queryable: Queryable = db): AssetCollector {
    return new AssetCollector(queryable, byteStore, {
      withTransaction: transactions(db),
      graceMs: 0,
      batchSize,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
  }

  test('schema is idempotent and has one PGlite-compatible statement per entry', async () => {
    const statements: string[] = [];
    await ensureAssetSchema(recordingQueryable(db, statements));
    await ensureAssetSchema(recordingQueryable(db, statements));
    expect(statements).toEqual([...ASSET_PG_SCHEMA, ...ASSET_PG_SCHEMA].map(normalizeSql));
    expect(ASSET_PG_SCHEMA).toHaveLength(5);
    expect(ASSET_PG_SCHEMA.every((statement) => !statement.includes(';'))).toBe(true);
  });

  test('zero-byte assets get distinct ids backed by one blob row', async () => {
    const first = await store.put(PRINCIPAL, blob(''));
    const second = await store.put(PRINCIPAL, blob(''));
    expect(first).not.toBe(second);
    expect((await db.query('SELECT * FROM asset_entries')).rows).toHaveLength(2);
    expect((await db.query('SELECT * FROM asset_blobs')).rows).toHaveLength(1);
    expect((await store.resolve(PRINCIPAL, first))?.bytes).toEqual(new Uint8Array());
  });

  test('ownership is checked on resolve, replace, and remove', async () => {
    const id = await store.put(PRINCIPAL, blob('private'));
    expect(await store.identify(PRINCIPAL, id)).toEqual({
      mime: 'text/plain',
      revision: 1,
      byteLength: 7,
    });
    expect(await store.identify(OTHER_PRINCIPAL, id)).toBeNull();
    expect(await store.resolve(OTHER_PRINCIPAL, id)).toBeNull();
    await expect(store.replace(OTHER_PRINCIPAL, id, blob('foreign'))).rejects.toBeInstanceOf(
      AssetNotFoundError,
    );
    await store.remove(OTHER_PRINCIPAL, id);
    expect((await store.resolve(PRINCIPAL, id))?.bytes).toEqual(bytes('private'));
  });

  test('replace preserves or replaces metadata and MIME according to omission', async () => {
    const id = await store.put(PRINCIPAL, blob('original', 'image/png'), {
      contentType: '',
      provenance: 'first',
    });
    expect((await store.resolve(PRINCIPAL, id))?.mime).toBe('');

    await store.replace(PRINCIPAL, id, blob('untyped', ''));
    expect(await store.resolve(PRINCIPAL, id)).toMatchObject({ mime: '', revision: 2 });
    let row = await db.query<{ meta: unknown }>('SELECT meta FROM asset_entries WHERE id = $1', [
      id,
    ]);
    expect(row.rows[0]?.meta).toEqual({ contentType: '', provenance: 'first' });

    await store.replace(PRINCIPAL, id, blob('typed', 'audio/mpeg'));
    expect(await store.resolve(PRINCIPAL, id)).toMatchObject({ mime: 'audio/mpeg', revision: 3 });

    await store.replace(PRINCIPAL, id, blob('supplied', 'video/mp4'), {
      contentType: '',
      provenance: 'replacement',
    });
    expect(await store.resolve(PRINCIPAL, id)).toMatchObject({ mime: '', revision: 4 });
    row = await db.query<{ meta: unknown }>('SELECT meta FROM asset_entries WHERE id = $1', [id]);
    expect(row.rows[0]?.meta).toEqual({ contentType: '', provenance: 'replacement' });
  });

  test('rejects JSON-lossy metadata on put and replace without changing entries', async () => {
    const id = await store.put(PRINCIPAL, blob('original', 'image/png'), {
      contentType: 'image/png',
      provenance: 'original',
    });
    const original = (await db.query('SELECT * FROM asset_entries WHERE id = $1', [id])).rows[0];
    const originalBlobs = (await db.query('SELECT * FROM asset_blobs ORDER BY content_hash')).rows;
    const cases: Array<[string, AssetMeta, string, string?]> = [
      [
        'Date',
        { invalid: new Date('2026-01-01T00:00:00.000Z') } as unknown as AssetMeta,
        '/invalid',
        '2026-01-01',
      ],
      [
        'Map',
        { invalid: new Map([['map-secret', 'value']]) } as unknown as AssetMeta,
        '/invalid',
        'map-secret',
      ],
      ['negative zero', { invalid: -0 } as AssetMeta, '/invalid'],
      [
        'nested undefined',
        { nested: { invalid: undefined } } as unknown as AssetMeta,
        '/nested/invalid',
      ],
      ['U+0000', { invalid: 'nul-secret\u0000tail' } as AssetMeta, '/invalid', 'nul-secret'],
    ];

    for (const [name, invalidMeta, path, hiddenValue] of cases) {
      for (const [operation, write] of [
        ['put', () => store.put(PRINCIPAL, blob('new bytes'), invalidMeta)],
        ['replace', () => store.replace(PRINCIPAL, id, blob('replacement'), invalidMeta)],
      ] as const) {
        let thrown: unknown;
        try {
          await write();
        } catch (error) {
          thrown = error;
        }
        expect(thrown, `${operation} ${name}`).toBeInstanceOf(Error);
        expect((thrown as Error).message, `${operation} ${name}`).toContain(`'${path}'`);
        if (hiddenValue !== undefined) {
          expect((thrown as Error).message, `${operation} ${name}`).not.toContain(hiddenValue);
        }
        expect(
          (await db.query('SELECT * FROM asset_entries ORDER BY id')).rows,
          `${operation} ${name}`,
        ).toEqual([original]);
        expect(
          (await db.query('SELECT * FROM asset_blobs ORDER BY content_hash')).rows,
          `${operation} ${name}`,
        ).toEqual(originalBlobs);
      }
    }
  });

  test('accepts plain metadata objects on put and replace', async () => {
    const id = await store.put(PRINCIPAL, blob('plain put'), {
      contentType: 'image/png',
      nested: { accepted: true },
    });
    await expect(
      store.replace(PRINCIPAL, id, blob('plain replace'), {
        contentType: 'audio/mpeg',
        nested: { accepted: ['yes'] },
      }),
    ).resolves.toBe(2);
    expect(
      (await db.query<{ meta: unknown }>('SELECT meta FROM asset_entries WHERE id = $1', [id]))
        .rows[0]?.meta,
    ).toEqual({ contentType: 'audio/mpeg', nested: { accepted: ['yes'] } });
  });

  test('an entry whose bytes are gone resolves as a miss', async () => {
    const id = await store.put(PRINCIPAL, blob('missing bytes'));
    await db.query('UPDATE asset_blobs SET bytes = NULL');
    expect(await store.resolve(PRINCIPAL, id)).toBeNull();
  });

  test('an over-quota replace raises the quota error rather than a generic failure', async () => {
    // The quota check runs inside the write transaction, so the transaction's
    // catch has to let this error through. Collapsing it would answer 500 for
    // a condition the contract gives a status and a code of its own.
    const quotaStore = new PgAssetStore(db, options(db, byteStore, { quotaBytes: 5 }));
    const id = await quotaStore.put(PRINCIPAL, blob('1'));

    await expect(quotaStore.replace(PRINCIPAL, id, blob('123456'))).rejects.toBeInstanceOf(
      AssetQuotaExceededError,
    );
    expect((await quotaStore.resolve(PRINCIPAL, id))?.bytes).toEqual(bytes('1'));
  });

  test('logical quota counts every principal entry and runs before byte writes', async () => {
    const writes: string[] = [];
    const observingBytes: AssetByteStore = {
      // Out-of-registry, like the object store: the write is a counter, and
      // nothing here can contend for the registry's row locks.
      writesOutsideRegistryDatabase: true,
      write: async () => {
        writes.push('write');
      },
      read: async () => null,
      delete: async () => undefined,
    };
    const quotaStore = new PgAssetStore(db, options(db, observingBytes, { quotaBytes: 5 }));
    await quotaStore.put(PRINCIPAL, blob('12345'));
    await expect(quotaStore.put(PRINCIPAL, blob('1'))).rejects.toBeInstanceOf(
      AssetQuotaExceededError,
    );
    // One write for the accepted put, none for the rejected one: the quota check
    // runs before any byte reaches the byte store.
    expect(writes).toEqual(['write']);
  });

  test('principal quota locks use the 64-bit hash function', async () => {
    const statements: string[] = [];
    const instrumented = new PgAssetStore(recordingQueryable(db, statements), {
      byteStore,
      withTransaction: recordingTransactions(db, statements),
      quotaBytes: 10,
    });

    await instrumented.put(PRINCIPAL, blob('lock'));

    // This SQL-text assertion deliberately pins the 64-bit lock key: a
    // behavioral test would depend on unstable collisions in PostgreSQL's
    // internal hash function.
    expect(statements).toContain('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
  });

  test('byte-layer quota errors collapse to generic registry failures', async () => {
    const internalDetail = 'internal byte-layer detail';
    const failingBytes: AssetByteStore = {
      // The failure under test is a byte-layer failure, not the registry's
      // coordination guard; declare the layer out-of-registry like an object
      // store so the guard lets the write through.
      writesOutsideRegistryDatabase: true,
      write: async () => {
        throw new AssetQuotaExceededError(internalDetail);
      },
      read: async () => null,
      delete: async () => undefined,
    };
    const failing = new PgAssetStore(db, options(db, failingBytes));

    let putError: unknown;
    try {
      await failing.put(PRINCIPAL, blob('put'));
    } catch (error) {
      putError = error;
    }
    expect(putError).toBeInstanceOf(Error);
    expect(putError).not.toBeInstanceOf(AssetQuotaExceededError);
    expect((putError as Error).message).toBe('@openmaic/storage: asset registry put failed');
    expect((putError as Error).message).not.toContain(internalDetail);

    const id = await store.put(PRINCIPAL, blob('original'));
    let replaceError: unknown;
    try {
      await failing.replace(PRINCIPAL, id, blob('replacement'));
    } catch (error) {
      replaceError = error;
    }
    expect(replaceError).toBeInstanceOf(Error);
    expect(replaceError).not.toBeInstanceOf(AssetQuotaExceededError);
    expect((replaceError as Error).message).toBe(
      '@openmaic/storage: asset registry replace failed',
    );
    expect((replaceError as Error).message).not.toContain(internalDetail);
  });

  test('put emits an identical statement sequence for existing and new bytes', async () => {
    async function observe(seed: boolean): Promise<string[]> {
      const local = new PGlite();
      await local.waitReady;
      await ensureAssetSchema(local);
      const directBytes = new PgAssetByteStore(local);
      const base = new PgAssetStore(local, options(local, directBytes));
      if (seed) await base.put(PRINCIPAL, blob('statement equality'));

      const statements: string[] = [];
      const recorded = recordingQueryable(local, statements);
      const recordedBytes = new PgAssetByteStore(recorded);
      const instrumented = new PgAssetStore(recorded, {
        byteStore: recordedBytes,
        withTransaction: recordingTransactions(local, statements),
      });
      await instrumented.put(PRINCIPAL, blob(seed ? 'statement equality' : 'brand new'));
      await local.close();
      return statements;
    }

    const existing = await observe(true);
    const fresh = await observe(false);
    expect(existing).toEqual(fresh);
    // Blob row claimed, then bytes, then the entry. The byte write sits between
    // the two registry writes deliberately: it must follow the upsert that takes
    // the blob row's lock, and precede the entry that references it. The write
    // transaction also pins a lock-wait budget first, so a future
    // lock-contention variant of a registry write fails loudly instead of
    // hanging.
    expect(existing.map((sql) => sql.split(' ')[0])).toEqual(['SET', 'INSERT', 'UPDATE', 'INSERT']);
    // The bound is on the write transaction's lock waits, not a silent
    // statement timeout: the wait that must fail loudly is the row-lock wait
    // (the self-deadlock variant), while a long byte write is still allowed to
    // run to completion.
    expect(existing[0]).toContain('lock_timeout');
  });

  test('remove emits the same statements with and without another principal reference', async () => {
    async function observe(shared: boolean): Promise<string[]> {
      const local = new PGlite();
      await local.waitReady;
      await ensureAssetSchema(local);
      const baseBytes = new PgAssetByteStore(local);
      const base = new PgAssetStore(local, options(local, baseBytes));
      const id = await base.put(PRINCIPAL, blob('remove cost'));
      if (shared) await base.put(OTHER_PRINCIPAL, blob('remove cost'));

      const statements: string[] = [];
      const instrumented = new PgAssetStore(recordingQueryable(local, statements), {
        byteStore: baseBytes,
        withTransaction: recordingTransactions(local, statements),
      });
      await instrumented.remove(PRINCIPAL, id);
      await local.close();
      return statements;
    }

    expect(await observe(false)).toEqual(await observe(true));
  });

  test('a transactional byte layer leaves nothing behind when the registry write fails', async () => {
    // Its bytes are written through the registry's own transaction, so a
    // rollback takes them with it. This layer has nothing to reconcile.
    const local = new PGlite();
    await local.waitReady;
    await ensureAssetSchema(local);
    const layer = new PgAssetByteStore(local);
    const failing = new PgAssetStore(local, {
      byteStore: layer,
      withTransaction: (body) =>
        local.transaction(async (tx: Queryable) => {
          await body(tx);
          throw new Error('injected failure after the body committed nothing');
        }) as Promise<never>,
    });
    const data = blob('crash window');
    const { contentHash } = await contentHashOf(data);

    await expect(failing.put(PRINCIPAL, data)).rejects.toThrow(/registry put failed/);

    expect((await local.query('SELECT * FROM asset_entries')).rows).toEqual([]);
    expect((await local.query('SELECT * FROM asset_blobs')).rows).toEqual([]);
    expect(await layer.read(contentHash)).toBeNull();
    await local.close();
  });

  test('a non-transactional byte layer leaves an orphan the collector cannot see', async () => {
    // An object store cannot join the registry transaction, so a rollback
    // strands its bytes -- and strands them with no blob row, which is what
    // puts them beyond reference counting. Recovering them is deployment
    // housekeeping (a lifecycle rule or a bucket-versus-table reconciliation),
    // not something the collector can do.
    const local = new PGlite();
    await local.waitReady;
    await ensureAssetSchema(local);
    const layer = new MemoryByteStore();
    const failing = new PgAssetStore(local, {
      byteStore: layer,
      withTransaction: (body) =>
        local.transaction(async (tx: Queryable) => {
          await body(tx);
          throw new Error('injected failure after the body committed nothing');
        }) as Promise<never>,
    });
    const data = blob('crash window');
    const { contentHash } = await contentHashOf(data);

    await expect(failing.put(PRINCIPAL, data)).rejects.toThrow(/registry put failed/);

    expect((await local.query('SELECT * FROM asset_entries')).rows).toEqual([]);
    expect((await local.query('SELECT * FROM asset_blobs')).rows).toEqual([]);
    expect(await layer.read(contentHash)).toEqual(bytes('crash window'));

    const collector = new AssetCollector(local, layer, {
      withTransaction: transactions(local),
      graceMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(await collector.collect()).toBe(0);
    expect(await layer.read(contentHash)).toEqual(bytes('crash window'));
    await local.close();
  });

  test('a non-transactional byte layer that does not declare out-of-registry writes fails loudly instead of issuing a conflicting write', async () => {
    // The deadlock configuration: a byte store without writeWith whose plain
    // write could hit the same PostgreSQL as the registry. On a real pool the
    // plain write would block forever on the blob-row lock this transaction
    // just took; the guard must refuse the configuration up front, before any
    // row is claimed, so the failure is a loud configuration error instead of
    // a hang. PGlite cannot reproduce the hang (single connection), which is
    // exactly why this must fail at the guard rather than at the database.
    const local = new PGlite();
    await local.waitReady;
    await ensureAssetSchema(local);
    let writes = 0;
    const uncoordinated: AssetByteStore = {
      // Deliberately no writeWith and no writesOutsideRegistryDatabase: this
      // is the broken-wrapper shape that used to deadlock production.
      write: async () => {
        writes += 1;
      },
      read: async () => null,
      delete: async () => undefined,
    };
    const registry = new PgAssetStore(local, options(local, uncoordinated));
    const data = blob('self-deadlock');

    let thrown: unknown;
    try {
      await registry.put(PRINCIPAL, data);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('cannot coordinate byte writes with the registry');
    // The guard fired before the transaction opened: no byte reached the byte
    // store and no blob row was claimed.
    expect(writes).toBe(0);
    expect((await local.query('SELECT * FROM asset_blobs')).rows).toEqual([]);

    // replace is refused the same way.
    const id = await new PgAssetStore(local, options(local, new MemoryByteStore())).put(
      PRINCIPAL,
      blob('existing'),
    );
    const replacing = new PgAssetStore(local, options(local, uncoordinated));
    await expect(replacing.replace(PRINCIPAL, id, data)).rejects.toThrow(
      /cannot coordinate byte writes with the registry/,
    );
    await local.close();
  });

  test('a collector with a non-declaring non-transactional byte layer fails loudly instead of deadlocking', async () => {
    // Same class of trap as the registry write guard, on the collector's
    // delete: a plain delete on the layer's own connection while the
    // collector's transaction holds the blob-row lock would block forever.
    const local = new PGlite();
    await local.waitReady;
    await ensureAssetSchema(local);
    const seed = new PgAssetStore(local, options(local, new MemoryByteStore()));
    const id = await seed.put(PRINCIPAL, blob('collector deadlock'));
    await seed.remove(PRINCIPAL, id);
    await local.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);

    const uncoordinated: AssetByteStore = {
      // No deleteWith, no writesOutsideRegistryDatabase: the broken shape.
      write: async () => undefined,
      read: async () => null,
      delete: async () => undefined,
    };
    const collector = new AssetCollector(local, uncoordinated, {
      withTransaction: transactions(local),
      graceMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    await expect(collector.collect()).rejects.toThrow(
      /cannot coordinate collection with the registry/,
    );
    await local.close();
  });

  test('collector observes grace, re-checks references, and is re-runnable', async () => {
    const oldId = await store.put(PRINCIPAL, blob('old unreferenced'));
    const referencedId = await store.put(PRINCIPAL, blob('still referenced'));
    await store.remove(PRINCIPAL, oldId);
    await db.query(
      `UPDATE asset_blobs
          SET unreferenced_at = '2026-01-01T00:00:00.000Z'
        WHERE unreferenced_at IS NOT NULL`,
    );
    await db.query(
      `UPDATE asset_blobs
          SET unreferenced_at = '2000-01-01T00:00:00.000Z'
        WHERE content_hash = (
          SELECT content_hash FROM asset_entries WHERE id = $1
        )`,
      [referencedId],
    );
    const collector = new AssetCollector(db, byteStore, {
      withTransaction: transactions(db),
      graceMs: 60 * 60 * 1000,
      now: () => new Date('2026-01-01T00:30:00.000Z'),
    });
    expect(await collector.collect()).toBe(0);

    const later = new AssetCollector(db, byteStore, {
      withTransaction: transactions(db),
      graceMs: 60 * 60 * 1000,
      now: () => new Date('2026-01-01T02:00:00.000Z'),
    });
    expect(await later.collect()).toBe(1);
    expect(await later.collect()).toBe(0);
    expect((await store.resolve(PRINCIPAL, referencedId))?.bytes).toEqual(
      bytes('still referenced'),
    );
  });

  test('a pass takes at most its batch size and leaves the rest for the next one', async () => {
    // The first pass over a deployment that accumulated before collection was
    // scheduled is the one whose size is set by history rather than by the
    // interval, and it is the pass this cap exists for.
    await unreference(['batch-a', 'batch-b', 'batch-c', 'batch-d', 'batch-e']);
    const collector = boundedCollector(2);

    expect(await collector.collectPass()).toEqual({ collected: 2, capped: true });
    expect(await remainingBlobs()).toHaveLength(3);
  });

  test('following passes take the remainder, so a capped pass strands nothing', async () => {
    await unreference(['drain-a', 'drain-b', 'drain-c', 'drain-d', 'drain-e']);
    const collector = boundedCollector(2);

    // What a caller draining the backlog does: run while the batch comes back
    // full. `collected` alone cannot say that, which is why `capped` exists.
    const passes: Array<{ collected: number; capped: boolean }> = [];
    do {
      passes.push(await collector.collectPass());
    } while (passes[passes.length - 1]?.capped);

    expect(passes).toEqual([
      { collected: 2, capped: true },
      { collected: 2, capped: true },
      { collected: 1, capped: false },
    ]);
    expect(await remainingBlobs()).toEqual([]);
  });

  test('a bounded pass takes the oldest unreferenced blob, however its digest sorts', async () => {
    // Ordering by content hash would starve this blob: its digest sorts above
    // every other one here, so a bounded pass ordered that way would never
    // reach it while lower digests keep arriving.
    const values = ['sorting-one', 'sorting-two', 'sorting-three', 'sorting-four'];
    const hashes = new Map<string, ContentHash>();
    for (const value of values) hashes.set(value, (await contentHashOf(blob(value))).contentHash);
    const hashOf = (value: string): ContentHash => hashes.get(value) as ContentHash;
    const sortsLast = values.reduce((left, right) => (hashOf(left) > hashOf(right) ? left : right));
    const queue = values.filter((value) => value !== sortsLast);

    await unreference([...queue, sortsLast]);
    // Stamp the newer blobs first and the oldest one last, so heap order --
    // which is what a pass that dropped its ORDER BY would see -- puts the
    // blob that must be collected first anywhere but first.
    for (const [index, value] of queue.entries()) {
      await stampUnreferencedAt(hashOf(value), `200${index + 1}-01-01T00:00:00.000Z`);
    }
    await stampUnreferencedAt(hashOf(sortsLast), '2000-01-01T00:00:00.000Z');

    const statements: string[] = [];
    const collector = boundedCollector(1, recordingQueryable(db, statements));
    expect(await collector.collectPass()).toEqual({ collected: 1, capped: true });
    expect(await remainingBlobs()).toEqual(queue.map(hashOf).sort());

    // The order is asked of the database rather than inherited from a plan.
    // PGlite answers this shape from the partial index on `unreferenced_at`,
    // so a pass that simply dropped its ORDER BY would return these same rows
    // here while starving a real deployment whose planner chose otherwise.
    expect(statements[0]).toContain('ORDER BY unreferenced_at ASC, content_hash ASC LIMIT $2');

    // A blob unreferenced after the queue formed joins its back, so it cannot
    // push the waiting ones further out: the next pass still takes the oldest.
    const { contentHash: newcomer } = await contentHashOf(blob('sorting-newcomer'));
    await unreference(['sorting-newcomer']);
    await stampUnreferencedAt(newcomer, '2004-01-01T00:00:00.000Z');

    expect(await collector.collect()).toBe(1);
    expect(await remainingBlobs()).toEqual([...queue.slice(1).map(hashOf), newcomer].sort());
  });

  test('put writes bytes unconditionally, even when they are already stored', async () => {
    // This is what makes an adopting write safe against the collector. The
    // collector can hold the blob row's lock, delete those bytes and commit
    // while this put's upsert waits; the put then re-claims the row and writes
    // again. A put that skipped the write when the bytes looked present would
    // resolve to nothing -- and would also be branching on prior existence,
    // which the allocation rule forbids.
    const local = new PGlite();
    await local.waitReady;
    await ensureAssetSchema(local);
    const layer = new MemoryByteStore();
    let writes = 0;
    layer.onWrite = () => {
      writes += 1;
    };
    const registry = new PgAssetStore(local, options(local, layer));

    await registry.put(PRINCIPAL, blob('unconditional'));
    await registry.put(PRINCIPAL, blob('unconditional'));

    expect(writes).toBe(2);
    await local.close();
  });

  test('a put re-stores bytes the collector has already removed', async () => {
    const local = new PGlite();
    await local.waitReady;
    await ensureAssetSchema(local);
    const layer = new MemoryByteStore();
    const registry = new PgAssetStore(local, options(local, layer));
    const data = blob('adopting write');
    const { contentHash } = await contentHashOf(data);

    const first = await registry.put(PRINCIPAL, data);
    await registry.remove(PRINCIPAL, first);
    await local.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);
    const collector = new AssetCollector(local, layer, {
      withTransaction: transactions(local),
      graceMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(await collector.collect()).toBe(1);
    expect(await layer.read(contentHash)).toBeNull();

    const adopted = await registry.put(PRINCIPAL, data);
    expect(await registry.resolve(PRINCIPAL, adopted)).toMatchObject({
      bytes: bytes('adopting write'),
      revision: 1,
    });
    await local.close();
  });

  test('every registry error path keeps common digest encodings out of thrown values', async () => {
    const data = blob('digest-sensitive failure');
    const { contentHash } = await contentHashOf(data);
    expect(await commonDigestEncodings(data)).toHaveLength(5);

    const digestFailureBytes: AssetByteStore = {
      // Out-of-registry so the coordination guard does not mask the digest
      // propagation under test.
      writesOutsideRegistryDatabase: true,
      write: async () => {
        throw new Error(contentHash);
      },
      read: async () => {
        throw new Error(contentHash);
      },
      delete: async () => {
        throw new Error(contentHash);
      },
    };
    const failures: Array<() => Promise<unknown>> = [
      () => new PgAssetStore(db, options(db, digestFailureBytes)).put(PRINCIPAL, data),
      async () => {
        const id = await store.put(PRINCIPAL, data);
        return new PgAssetStore(db, options(db, digestFailureBytes)).resolve(PRINCIPAL, id);
      },
      () => store.replace(PRINCIPAL, 'unknown' as AssetId, data),
      async () => {
        const id = await store.put(PRINCIPAL, data);
        return store.replace(OTHER_PRINCIPAL, id, data);
      },
      () => new PgAssetStore(db, options(db, byteStore, { quotaBytes: 0 })).put(PRINCIPAL, data),
      () =>
        new PgAssetStore(db, {
          byteStore: new MemoryByteStore(),
          withTransaction: async () => {
            throw new Error(contentHash);
          },
        }).put(PRINCIPAL, data),
      async () => {
        const id = await store.put(PRINCIPAL, data);
        return new PgAssetStore(db, {
          byteStore,
          withTransaction: async () => {
            throw new Error(contentHash);
          },
        }).resolve(PRINCIPAL, id);
      },
      async () => {
        const id = await store.put(PRINCIPAL, data);
        return new PgAssetStore(db, {
          byteStore,
          withTransaction: async () => {
            throw new Error(contentHash);
          },
        }).remove(PRINCIPAL, id);
      },
      async () => {
        const id = await store.put(PRINCIPAL, data);
        return new PgAssetStore(db, {
          byteStore: new MemoryByteStore(),
          withTransaction: async () => {
            throw new Error(contentHash);
          },
        }).replace(PRINCIPAL, id, data);
      },
    ];

    for (const fail of failures) {
      let thrown: unknown;
      try {
        await fail();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      await expectNoDigestSubstring(String(thrown), data);
    }

    await db.query('TRUNCATE asset_entries, asset_blobs');
    const collectorBytes: AssetByteStore = {
      // Out-of-registry so the collector's deletion guard lets the failing
      // delete through, keeping the digest propagation under test.
      writesOutsideRegistryDatabase: true,
      write: async () => undefined,
      read: async () => null,
      delete: async () => {
        throw new Error(contentHash);
      },
    };
    const collectorStore = new PgAssetStore(db, options(db, collectorBytes));
    const collectorId = await collectorStore.put(PRINCIPAL, data);
    await collectorStore.remove(PRINCIPAL, collectorId);
    await db.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);
    const collector = new AssetCollector(db, collectorBytes, {
      withTransaction: transactions(db),
      graceMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    let collectorError: unknown;
    try {
      await collector.collect();
    } catch (error) {
      collectorError = error;
    }
    expect(collectorError).toBeInstanceOf(Error);
    await expectNoDigestSubstring(String(collectorError), data);
  });
});

describe('PgAssetStore indirect resolution with PGlite', () => {
  let db: PGlite;

  class SigningByteStore extends MemoryByteStore {
    readonly signed: Array<{ hash: ContentHash; headers: AssetSignedReadHeaders }> = [];
    decline = false;

    async signReadUrl(
      hash: ContentHash,
      headers: AssetSignedReadHeaders,
    ): Promise<string | undefined> {
      this.signed.push({ hash, headers });
      return this.decline ? undefined : 'https://objects.example/signed-url';
    }
  }

  const request = (onLabel?: (mime: string) => void) => ({
    label: (mime: string) => {
      onLabel?.(mime);
      return { contentType: 'application/octet-stream', contentDisposition: 'attachment' };
    },
    cacheControl: 'private, no-store',
    expiresInSeconds: 60,
  });

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAssetSchema(db);
  });

  afterEach(async () => {
    __setAssetIdFactoryForTesting(null);
    await db.close();
  });

  test('a byte store without a signer declines indirect resolution', async () => {
    const store = new PgAssetStore(db, options(db, new MemoryByteStore()));
    const id = await store.put(PRINCIPAL, blob('unsigned'));

    await expect(store.resolveIndirect(PRINCIPAL, id, request())).resolves.toBeUndefined();
  });

  test('mints the signed URL from the same ownership-checked read', async () => {
    const byteStore = new SigningByteStore();
    const store = new PgAssetStore(db, options(db, byteStore));
    const data = blob('indirect bytes');
    const id = await store.put(PRINCIPAL, data, { contentType: 'image/png' });
    const { contentHash } = await contentHashOf(data);
    let labelled: string | undefined;

    const result = await store.resolveIndirect(
      PRINCIPAL,
      id,
      request((mime) => {
        labelled = mime;
      }),
    );

    expect(result).toEqual({ url: 'https://objects.example/signed-url', revision: 1 });
    // The signer saw the entry's content hash and the merged headers: the
    // label ran on the recorded media type inside the read.
    expect(byteStore.signed).toHaveLength(1);
    expect(byteStore.signed[0]?.hash).toBe(contentHash);
    expect(byteStore.signed[0]?.headers).toEqual({
      contentType: 'application/octet-stream',
      contentDisposition: 'attachment',
      cacheControl: 'private, no-store',
      expiresInSeconds: 60,
    });
    expect(labelled).toBe('image/png');
  });

  test('unknown and foreign ids miss exactly as resolve does', async () => {
    const byteStore = new SigningByteStore();
    const store = new PgAssetStore(db, options(db, byteStore));
    const id = await store.put(PRINCIPAL, blob('owned'));

    await expect(store.resolveIndirect(PRINCIPAL, 'ast_absent', request())).resolves.toBeNull();
    await expect(store.resolveIndirect(OTHER_PRINCIPAL, id, request())).resolves.toBeNull();
    expect(byteStore.signed).toHaveLength(0);
  });

  test('a signer that declines at call time falls back to direct bytes', async () => {
    const byteStore = new SigningByteStore();
    byteStore.decline = true;
    const store = new PgAssetStore(db, options(db, byteStore));
    const id = await store.put(PRINCIPAL, blob('declined'));

    await expect(store.resolveIndirect(PRINCIPAL, id, request())).resolves.toBeUndefined();
  });

  test('the reported revision follows replace', async () => {
    const byteStore = new SigningByteStore();
    const store = new PgAssetStore(db, options(db, byteStore));
    const id = await store.put(PRINCIPAL, blob('first'));
    await store.replace(PRINCIPAL, id, blob('second'));

    await expect(store.resolveIndirect(PRINCIPAL, id, request())).resolves.toEqual({
      url: 'https://objects.example/signed-url',
      revision: 2,
    });
    const { contentHash } = await contentHashOf(blob('second'));
    expect(byteStore.signed[0]?.hash).toBe(contentHash);
  });
});
