import { describe, expect, it, vi, afterEach } from 'vitest';
vi.mock('server-only', () => ({}));
import { PGlite } from '@electric-sql/pglite';
import { PgAssetStore, ensureAssetSchema, type Queryable } from '@openmaic/storage/asset/pg';

import {
  lazyAssetByteStore,
  configuredLazyAssetByteStore,
} from '@/lib/persistence/asset-byte-store';
import {
  configureAssetByteStore,
  resetPersistenceHooksForTests,
} from '@/lib/server/persistence-hooks/registry';

const remote = vi.hoisted(() => ({
  write: vi.fn(async (_hash: string, _bytes: Uint8Array, options?: { signal?: AbortSignal }) => {
    options?.signal?.throwIfAborted();
  }),
  read: vi.fn(async () => null),
  delete: vi.fn(async () => {}),
  writesOutsideRegistryDatabase: true as const,
}));
vi.mock('@openmaic/storage/asset/s3-bytes', () => ({ loadS3AssetByteStore: async () => remote }));
afterEach(() => {
  resetPersistenceHooksForTests();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/**
 * The registry's own duck-type predicate for a transaction-pinned byte writer
 * (packages/@openmaic/storage/src/asset/pg.ts `hasTransactionalWriter`), kept
 * in sync here so the app-level wrapper is pinned to the exact check the
 * registry performs.
 */
function hasTransactionalWriter(store: object): boolean {
  return 'writeWith' in store && typeof (store as { writeWith?: unknown }).writeWith === 'function';
}

const PRINCIPAL = { key: 'asset-byte-store-test' } as const;
const blob = (value: string): Blob => new Blob([value], { type: 'text/plain' });

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function recordingQueryable(queryable: Queryable, statements: string[]): Queryable {
  return {
    async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) {
      statements.push(normalizeSql(text));
      return queryable.query<TRow>(text, params);
    },
  };
}

describe('lazyAssetByteStore transactional capability', () => {
  it.each(['built-in', 'host'] as const)(
    'forwards cancellation through the lazy %s byte store',
    async (kind) => {
      const db = new PGlite();
      try {
        resetPersistenceHooksForTests();
        if (kind === 'host')
          configureAssetByteStore({ name: 'test-byte-store', create: () => remote });
        vi.stubEnv('ASSET_S3_BUCKET', 'valid-bucket-name');
        const bytes =
          kind === 'host'
            ? configuredLazyAssetByteStore(db)
            : lazyAssetByteStore('valid-bucket-name', db);
        const controller = new AbortController();
        controller.abort();
        const hash = 'sha256-fixture' as Parameters<typeof bytes.write>[0];
        await expect(
          bytes.write(hash, new Uint8Array([1]), { signal: controller.signal }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(remote.write).toHaveBeenCalledWith(hash, new Uint8Array([1]), {
          signal: controller.signal,
        });
      } finally {
        await db.close();
      }
    },
  );
  it('preserves the no-bucket layer transaction-pinned byte methods (the deadlock fix)', async () => {
    const db = new PGlite();
    await db.waitReady;
    const wrapped = lazyAssetByteStore(undefined, db);

    // Red before the fix: the wrapper returned a bare { write, read, delete }
    // and dropped writeWith/readWith, so the registry's duck-type check failed
    // and put() fell back to the byte store's own pooled connection -- which
    // blocks forever on the blob-row lock the registry transaction just took
    // when the bytes live in the same PostgreSQL (the self-deadlock).
    expect(hasTransactionalWriter(wrapped)).toBe(true);
    expect('readWith' in wrapped).toBe(true);
    await db.close();
  });

  it('keeps the S3 case free of transactional methods while preserving lazy signing', () => {
    const db = new PGlite();
    const wrapped = lazyAssetByteStore('valid-bucket-name', db);

    // S3 has no transactional writer, so nothing is forwarded there; the
    // wrapper still declares the bytes out-of-registry (the flag the registry
    // checks before allowing a plain in-transaction write) and keeps its
    // lazy-probing signReadUrl.
    expect(hasTransactionalWriter(wrapped)).toBe(false);
    expect('readWith' in wrapped).toBe(false);
    expect(wrapped.writesOutsideRegistryDatabase).toBe(true);
    expect(typeof (wrapped as { signReadUrl?: unknown }).signReadUrl).toBe('function');
  });

  it('routes put() and resolve() byte traffic through the registry transaction when no bucket is configured', async () => {
    const db = new PGlite();
    await db.waitReady;
    await ensureAssetSchema(db);
    const statements: string[] = [];
    const store = new PgAssetStore(db, {
      byteStore: lazyAssetByteStore(undefined, db),
      withTransaction: (body) =>
        db.transaction((tx: Queryable) => body(recordingQueryable(tx, statements))),
    });

    const id = await store.put(PRINCIPAL, blob('routed bytes'));
    // The write transaction's statements: the lock-wait budget, the blob-row
    // claim, the byte write via the forwarded writeWith (an UPDATE on the
    // transaction-pinned queryable, not an INSERT issued from the byte store's
    // own connection), then the entry. This is the shape that used to be an
    // INSERT-on-a-second-connection (the deadlock) before the wrapper
    // forwarded writeWith.
    expect(statements.map((sql) => sql.split(' ')[0])).toEqual([
      'SET',
      'INSERT',
      'UPDATE',
      'INSERT',
    ]);
    expect(statements[2]).toContain('UPDATE asset_blobs');

    statements.length = 0;
    const asset = await store.resolve(PRINCIPAL, id);
    expect(asset?.bytes).toEqual(new TextEncoder().encode('routed bytes'));
    // resolve's byte read also goes through the pinned queryable (readWith):
    // entry lookup, blob-row FOR SHARE, then the byte read -- three SELECTs on
    // the transaction connection, no second-connection read.
    expect(statements.map((sql) => sql.split(' ')[0])).toEqual(['SELECT', 'SELECT', 'SELECT']);
    expect(statements[2]).toContain('SELECT bytes FROM asset_blobs');
    await db.close();
  });
});
