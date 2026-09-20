import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PgKVStore, ensureKVSchema, type PgKVStoreOptions } from '../src/kv/pg.js';
import { KVScopeViolationError } from '../src/kv/types.js';
import type { Queryable } from '../src/runtime/pg.js';

function options(db: PGlite): PgKVStoreOptions {
  return { withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)) };
}

/**
 * `'refused'` when a device-scoped call was turned away with a scope violation,
 * and otherwise the breach spelled out, so a red run names what got through
 * rather than reporting a bare "promise resolved".
 */
async function refusalOf(attempt: Promise<unknown>): Promise<string> {
  return attempt.then(
    () => 'device scope crossed the network boundary',
    (error: unknown) =>
      error instanceof KVScopeViolationError
        ? 'refused'
        : `device scope crossed the network boundary: ${String(error)}`,
  );
}

describe('PgKVStore', () => {
  let db: PGlite;
  let store: PgKVStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.transaction((tx: Queryable) => ensureKVSchema(tx));
    store = new PgKVStore(options(db));
  });

  afterEach(async () => {
    await db.close();
  });

  test('device scope never crosses the network boundary', async () => {
    expect(await refusalOf(store.set('owner-1', 'k', 1, 'device'))).toBe('refused');
    expect(await refusalOf(store.get('owner-1', 'k', 'device'))).toBe('refused');
  });

  test('account partition never leaks across owners', async () => {
    await store.set('owner-1', 'settings', { voice: 'a' });
    await store.set('owner-2', 'settings', { voice: 'b' });
    expect(await store.get('owner-1', 'settings')).toEqual({ voice: 'a' });
    expect(await store.get('owner-2', 'settings')).toEqual({ voice: 'b' });
    expect(await store.keys('owner-1')).toEqual(['settings']);
  });
});
