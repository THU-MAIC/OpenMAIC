import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { contentHashOf } from '../src/asset/blob.js';
import { PgAssetByteStore, type AssetByteStore } from '../src/asset/pg-bytes.js';
import { ensureAssetSchema } from '../src/asset/pg.js';
import { expectNoDigestSubstring } from './asset-contract.js';
import { runAssetByteStoreContract } from './asset-byte-store-contract.js';

describe('PgAssetByteStore with PGlite', () => {
  let db: PGlite;
  let store: PgAssetByteStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAssetSchema(db);
    store = new PgAssetByteStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  runAssetByteStoreContract('PostgreSQL bytes (PGlite)', () => store);

  test('sanitizes query failures so the digest cannot escape', async () => {
    const data = new Blob(['postgres byte failure']);
    const { contentHash, bytes } = await contentHashOf(data);
    const failing = new PgAssetByteStore({
      async query() {
        throw new Error(contentHash);
      },
    });
    for (const operation of [
      () => failing.write(contentHash, new Uint8Array(bytes)),
      () => failing.read(contentHash),
      () => failing.delete(contentHash),
    ]) {
      let thrown: unknown;
      try {
        await operation();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      await expectNoDigestSubstring(String(thrown), data);
    }
  });
});

describe('PgAssetByteStore.withPrefix with PGlite', () => {
  let db: PGlite;
  let store: PgAssetByteStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAssetSchema(db);
    store = new PgAssetByteStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  runAssetByteStoreContract('PostgreSQL prefixed bytes (PGlite)', () =>
    store.withPrefix('render/job-a/'),
  );

  test('keeps namespaces apart and out of the course registry', async () => {
    const data = new Blob(['namespaced bytes']);
    const { contentHash, bytes } = await contentHashOf(data);
    const a = store.withPrefix('render/job-a/');
    const b = store.withPrefix('render/job-b/');
    await a.write(contentHash, new Uint8Array(bytes));

    expect(await a.read(contentHash)).toEqual(new Uint8Array(bytes));
    expect(await b.read(contentHash)).toBeNull();
    expect(await store.read(contentHash)).toBeNull();
    const blobs = await db.query('SELECT 1 FROM asset_blobs');
    expect(blobs.rows).toHaveLength(0);

    await b.delete(contentHash);
    expect(await a.read(contentHash)).toEqual(new Uint8Array(bytes));
    // A nested namespace is its own prefix, not its parent's.
    const nested = a.withPrefix!('input/');
    expect(await nested.read(contentHash)).toBeNull();
    await nested.write(contentHash, new Uint8Array(bytes));
    const rows = await db.query<{ prefix: string }>(
      'SELECT prefix FROM asset_prefixed_bytes ORDER BY prefix',
    );
    expect(rows.rows.map((row) => row.prefix)).toEqual(['render/job-a/', 'render/job-a/input/']);
  });

  test('refuses an empty or malformed namespace', () => {
    expect(() => store.withPrefix('')).toThrow('must not be empty');
    for (const prefix of ['render', '../x/', 'a//', '/abs/', 'a b/']) {
      expect(() => store.withPrefix(prefix)).toThrow('Invalid object namespace');
    }
    expect(() => store.withPrefix('render/').withPrefix!('')).toThrow('must not be empty');
  });

  test('does not declare bytes outside the registry database', () => {
    expect((store as AssetByteStore).writesOutsideRegistryDatabase).toBeUndefined();
    expect(store.withPrefix('render/').writesOutsideRegistryDatabase).toBeUndefined();
  });
});
