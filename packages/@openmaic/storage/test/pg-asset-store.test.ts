import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { AssetMeta, AssetRef, BinaryBlob, StorageProvider } from '@openmaic/dsl';
import { contentHashOf, ObjectUrlCache, type ContentHash } from '../src/asset/blob.js';
import type { AssetByteStore } from '../src/asset/byte-store.js';
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

function serializedTransactions(db: PGlite): WithTransaction {
  let tail = Promise.resolve();
  return <T>(body: (queryable: Queryable) => Promise<T>): Promise<T> => {
    const result = tail.then(() => db.transaction((tx: Queryable) => body(tx)));
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
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

  test('an entry whose bytes are gone resolves as a miss', async () => {
    const id = await store.put(PRINCIPAL, blob('missing bytes'));
    await db.query('UPDATE asset_blobs SET bytes = NULL');
    expect(await store.resolve(PRINCIPAL, id)).toBeNull();
  });

  test('logical quota counts every principal entry and runs before byte writes', async () => {
    const writes: string[] = [];
    const observingBytes: AssetByteStore = {
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
    expect(writes).toEqual(['write', 'write']);
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
    expect(existing.map((sql) => sql.split(' ')[0])).toEqual([
      'INSERT',
      'INSERT',
      'UPDATE',
      'INSERT',
    ]);
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

  test('a failed registry transaction leaves an orphan which the collector removes', async () => {
    const failing = new PgAssetStore(db, {
      byteStore,
      withTransaction: async () => {
        throw new Error('injected transaction failure');
      },
    });
    const data = blob('crash window');
    const { contentHash } = await contentHashOf(data);
    await expect(failing.put(PRINCIPAL, data)).rejects.toThrow(/registry put failed/);
    expect((await db.query('SELECT * FROM asset_entries')).rows).toEqual([]);
    expect(await byteStore.read(contentHash)).toEqual(bytes('crash window'));

    await db.query(
      `UPDATE asset_blobs
          SET unreferenced_at = '2000-01-01T00:00:00.000Z'
        WHERE content_hash = $1`,
      [contentHash],
    );
    const collector = new AssetCollector(db, byteStore, {
      withTransaction: transactions(db),
      graceMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(await collector.collect()).toBe(1);
    expect(await byteStore.read(contentHash)).toBeNull();
    expect((await db.query('SELECT * FROM asset_blobs')).rows).toEqual([]);
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

  test('a put adopting bytes while the collector holds the row lock resolves afterwards', async () => {
    const local = new PGlite();
    await local.waitReady;
    await ensureAssetSchema(local);
    const memory = new MemoryByteStore();
    const serialized = serializedTransactions(local);
    const registry = new PgAssetStore(local, { byteStore: memory, withTransaction: serialized });
    const data = blob('adopting write');
    const id = await registry.put(PRINCIPAL, data);
    await registry.remove(PRINCIPAL, id);
    await local.query(`UPDATE asset_blobs SET unreferenced_at = '2000-01-01T00:00:00.000Z'`);

    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const mayCollect = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collector = new AssetCollector(local, memory, {
      graceMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      withTransaction: (body) =>
        serialized((queryable) =>
          body({
            async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
              text: string,
              params?: unknown[],
            ): Promise<QueryResult<TRow>> {
              const result = await queryable.query<TRow>(text, params);
              if (text.includes('FOR UPDATE')) {
                locked();
                await mayCollect;
              }
              return result;
            },
          }),
        ),
    });

    const collection = collector.collect();
    await lockHeld;
    let firstWrite!: () => void;
    const bytesWritten = new Promise<void>((resolve) => {
      firstWrite = resolve;
    });
    memory.onWrite = firstWrite;
    const adoption = registry.put(PRINCIPAL, data);
    await bytesWritten;
    memory.onWrite = undefined;
    release();

    expect(await collection).toBe(1);
    const adoptedId = await adoption;
    expect(await registry.resolve(PRINCIPAL, adoptedId)).toMatchObject({
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
