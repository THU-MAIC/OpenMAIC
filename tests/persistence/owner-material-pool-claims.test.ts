/**
 * Pool uploads across the parts of the app that own them, on the extraction
 * harness (real provider, real claims, PGlite):
 *
 * - owner-level extraction's default source reader (no `readSource`
 *   override) reads a source in the pool and one from before it; the service
 *   is still not started by the app, this pins the reader it will use;
 * - a claim between an upload's allocation and its publication refuses the
 *   publication, and the cleanup follows the reservation to the account;
 * - a reader holding an owner from before a claim still reads the source.
 */
import { createHash, randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isOwnerRetiredError } from '@/lib/persistence/owner-merges';
import { claimOwner } from '@/lib/persistence/owner-claims';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { readOwnerMaterialBytes } from '@/lib/server/materials/owner-material-bytes';
import {
  abandonOwnerMaterial,
  allocateOwnerMaterialBytes,
  finalizeOwnerMaterial,
  publishOwnerMaterialUpload,
  registerOwnerMaterial,
} from '@/lib/persistence/owner-materials';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';

import {
  ACCOUNT,
  ANON,
  bootExtractionHarness,
  drain,
  ensure,
  stateOf,
  type ExtractionHarness,
  type ExtractionScenarioPool,
} from './_owner-extraction-scenarios';

class PGlitePool implements ExtractionScenarioPool {
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

describe('owner material pool uploads with extraction and claims', () => {
  let db: PGlite | undefined;

  async function boot(): Promise<ExtractionHarness> {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const databaseUrl = `postgres://owner-extraction-pool-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    db = new PGlite();
    await db.waitReady;
    return bootExtractionHarness(new PGlitePool(db), databaseUrl);
  }

  afterEach(async () => {
    setMaterialByteStoreForTests(null);
    vi.unstubAllEnvs();
    await db?.close();
    db = undefined;
  });

  const reserve = (h: ExtractionHarness, id: string, bytes: Buffer, ossKey: string) =>
    registerOwnerMaterial(
      h.pool as unknown as ConnectableQueryable,
      {
        id,
        ownerId: ACCOUNT,
        kind: 'source',
        mime: 'application/pdf',
        bytes: bytes.byteLength,
        originalName: `${id}.pdf`,
        ossKey,
        extraction: { status: 'idle' },
      },
      { maxCount: 100, maxTotalBytes: 1_000_000 },
    );
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

  it('extracts a source that exists only in the pool', async () => {
    const h = await boot();
    const bytes = Buffer.from('%PDF-pool-only');
    // Nothing in the material byte store: a read by object key would fail.
    setMaterialByteStoreForTests({
      deletePrefix: async () => {
        throw new Error('Unexpected deletePrefix in this byte-store fixture');
      },
      list: async () => {
        throw new Error('Unexpected list in this byte-store fixture');
      },
      put: async () => undefined,
      get: async (key) => {
        throw new Error(`no object ${key}`);
      },
      delete: async () => undefined,
    });
    await reserve(h, 'src-pool', bytes, '');
    const assetId = await allocateOwnerMaterialBytes(h.provider, ACCOUNT, bytes, 'application/pdf');
    await publishOwnerMaterialUpload(h.provider, ACCOUNT, 'src-pool', {
      assetId,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
    });

    await ensure(h, 'src-pool');
    expect(await drain(h, h.deps({ readSource: undefined }))).toBe(1);

    expect((await stateOf(h, 'src-pool')).status).toBe('done');
    expect(h.documentExtract).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('still extracts a source from before the pool by its object key', async () => {
    const h = await boot();
    const bytes = Buffer.from('%PDF-legacy');
    const objects = new Map([['objects/src-legacy', bytes]]);
    setMaterialByteStoreForTests({
      deletePrefix: async () => {
        throw new Error('Unexpected deletePrefix in this byte-store fixture');
      },
      list: async () => {
        throw new Error('Unexpected list in this byte-store fixture');
      },
      put: async () => undefined,
      get: async (key) => {
        const value = objects.get(key);
        if (!value) throw new Error(`no object ${key}`);
        return value;
      },
      delete: async () => undefined,
    });
    await reserve(h, 'src-legacy', bytes, 'objects/src-legacy');
    await finalizeOwnerMaterial(h.pool as never, 'src-legacy', bytes.byteLength, digest(bytes));

    // A pre-pool source already queued on the owner parser retains that queue.
    await h.pool.query(
      'UPDATE owner_material SET extraction = \'{"status":"pending"}\' WHERE id = \'src-legacy\'',
    );
    await ensure(h, 'src-legacy');
    expect(await drain(h, h.deps({ readSource: undefined }))).toBe(1);

    expect((await stateOf(h, 'src-legacy')).status).toBe('done');
  }, 20_000);

  it('never hands an extractor a source from before the pool whose object no longer matches its digest', async () => {
    const h = await boot();
    const bytes = Buffer.from('%PDF-legacy');
    const objects = new Map([['objects/src-damaged', Buffer.from('%PDF-legacX')]]);
    setMaterialByteStoreForTests({
      deletePrefix: async () => {
        throw new Error('Unexpected deletePrefix in this byte-store fixture');
      },
      list: async () => {
        throw new Error('Unexpected list in this byte-store fixture');
      },
      put: async () => undefined,
      get: async (key) => {
        const value = objects.get(key);
        if (!value) throw new Error(`no object ${key}`);
        return value;
      },
      delete: async () => undefined,
    });
    await reserve(h, 'src-damaged', bytes, 'objects/src-damaged');
    await finalizeOwnerMaterial(h.pool as never, 'src-damaged', bytes.byteLength, digest(bytes));

    await ensure(h, 'src-damaged');
    await drain(h, h.deps({ readSource: undefined }));

    expect((await stateOf(h, 'src-damaged')).status).not.toBe('done');
    expect(h.documentExtract).not.toHaveBeenCalled();
  }, 20_000);

  it('refuses a publication after a claim moved the reservation, and the cleanup follows it', async () => {
    const h = await boot();
    const bytes = Buffer.from('%PDF-claimed-mid-upload');
    await registerOwnerMaterial(
      h.pool as unknown as ConnectableQueryable,
      {
        id: 'src-mid-claim',
        ownerId: ANON,
        kind: 'source',
        mime: 'application/pdf',
        bytes: bytes.byteLength,
        originalName: 'mid.pdf',
        ossKey: '',
        extraction: { status: 'idle' },
      },
      { maxCount: 100, maxTotalBytes: 1_000_000 },
    );
    const assetId = await allocateOwnerMaterialBytes(h.provider, ANON, bytes, 'application/pdf');

    // The claim lands between the allocation and the publication: it moves
    // the reservation and re-keys the pending entry to the account.
    await claimOwner(ANON, ACCOUNT, { provider: h.provider });

    const refused = await publishOwnerMaterialUpload(h.provider, ANON, 'src-mid-claim', {
      assetId,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
    }).catch((error: unknown) => error);
    expect(isOwnerRetiredError(refused)).toBe(true);
    const roots = await h.pool.query(
      `SELECT 1 FROM asset_root_refs WHERE root_kind = 'material' AND root_id = $1`,
      ['src-mid-claim'],
    );
    expect(roots.rows).toEqual([]);

    // The route's cleanup runs under the request's (retired) owner and
    // follows the claim to the account, where the reservation now is.
    await abandonOwnerMaterial(h.provider, ANON, 'src-mid-claim');
    const left = await h.pool.query('SELECT 1 FROM owner_material WHERE id = $1', [
      'src-mid-claim',
    ]);
    expect(left.rows).toEqual([]);
    // The unpublished entry is the account's now, pending, left to expire.
    const entry = await h.pool.query<{ principal: string; committed_at: unknown }>(
      'SELECT principal, committed_at FROM asset_entries WHERE id = $1',
      [assetId],
    );
    expect(entry.rows).toEqual([
      { principal: assetPrincipalForOwner(ACCOUNT).key, committed_at: null },
    ]);
  });

  it('reads a pool source for the account after a claim moved it', async () => {
    const h = await boot();
    const bytes = Buffer.from('%PDF-claimed-after-upload');
    await registerOwnerMaterial(
      h.pool as unknown as ConnectableQueryable,
      {
        id: 'src-claimed',
        ownerId: ANON,
        kind: 'source',
        mime: 'application/pdf',
        bytes: bytes.byteLength,
        originalName: 'claimed.pdf',
        ossKey: '',
        extraction: { status: 'idle' },
      },
      { maxCount: 100, maxTotalBytes: 1_000_000 },
    );
    const assetId = await allocateOwnerMaterialBytes(h.provider, ANON, bytes, 'application/pdf');
    await publishOwnerMaterialUpload(h.provider, ANON, 'src-claimed', {
      assetId,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
    });

    await claimOwner(ANON, ACCOUNT, { provider: h.provider });

    // A reader holding the owner from before the claim (an extraction claimed
    // earlier keeps it) still reads the source.
    expect(
      await readOwnerMaterialBytes({
        id: 'src-claimed',
        ownerId: ANON,
        assetId,
        ossKey: '',
        sha256: digest(bytes),
      }),
    ).toEqual(bytes);
  });
});
