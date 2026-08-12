import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { contentHashOf } from '../src/asset/blob.js';
import { PgAssetByteStore } from '../src/asset/pg-bytes.js';
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
