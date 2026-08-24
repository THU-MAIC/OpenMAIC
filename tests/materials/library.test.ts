import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { KVScope } from '@openmaic/storage';

import {
  listMaterials,
  MATERIAL_LIBRARY_KV_SCOPE,
  materialLibraryKey,
  readMaterial,
  recordMaterialDerivation,
  resetMaterialLibraryForTests,
  setMaterialLibraryKVForTests,
  upsertMaterialLibraryEntry,
  type MaterialLibraryEntry,
} from '@/lib/materials/library';
import type { AssetPoolStore } from '@/lib/media/asset-pool-config';

/** A minimal in-memory KVStore with the same JSON round-trip semantics. */
class FakeKV {
  private readonly entries = new Map<string, string>();

  private fullKey(key: string, scope: KVScope | undefined): string {
    return `${scope ?? MATERIAL_LIBRARY_KV_SCOPE}:${key}`;
  }

  async get<T>(key: string, scope?: KVScope): Promise<T | null> {
    const raw = this.entries.get(this.fullKey(key, scope));
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async set<T>(key: string, value: T, scope?: KVScope): Promise<void> {
    this.entries.set(this.fullKey(key, scope), JSON.stringify(value));
  }

  async remove(key: string, scope?: KVScope): Promise<void> {
    this.entries.delete(this.fullKey(key, scope));
  }

  async keys(prefix = '', scope?: KVScope): Promise<string[]> {
    const fullPrefix = this.fullKey('', scope);
    return [...this.entries.keys()]
      .filter((key) => key.startsWith(fullPrefix))
      .map((key) => key.slice(fullPrefix.length))
      .filter((key) => key.startsWith(prefix));
  }

  storedKeys(): string[] {
    return [...this.entries.keys()];
  }
}

function makePool(): AssetPoolStore & { blobs: Map<string, Blob> } {
  const blobs = new Map<string, Blob>();
  let next = 0;
  const pool: AssetPoolStore = {
    put: async (data: Blob) => {
      const id = `ast_test_${next}`;
      next += 1;
      blobs.set(id, data);
      return id;
    },
    resolve: async (ref: string) => (blobs.has(ref) ? `test://${ref}` : null),
    invalidate: async () => undefined,
    remove: async (ref: string) => {
      blobs.delete(ref);
    },
    replace: async () => undefined,
    release: async () => undefined,
    close: async () => undefined,
  };
  return Object.assign(pool, { blobs });
}

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function entry(over: Partial<MaterialLibraryEntry>): MaterialLibraryEntry {
  return {
    assetId: 'ast_lib_1',
    contentDigest: DIGEST_A,
    name: 'safety-checklist.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    addedAt: '2025-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('material library — upsert by digest', () => {
  let kv: FakeKV;

  beforeEach(() => {
    kv = new FakeKV();
    setMaterialLibraryKVForTests(kv);
  });

  afterEach(() => {
    resetMaterialLibraryForTests();
  });

  it('mints one entry keyed by contentDigest', async () => {
    await upsertMaterialLibraryEntry({
      assetId: 'ast_lib_1',
      contentDigest: DIGEST_A,
      name: 'safety-checklist.pdf',
      mimeType: 'application/pdf',
      size: 2048,
    });

    const stored = await kv.get<MaterialLibraryEntry>(
      materialLibraryKey(DIGEST_A),
      MATERIAL_LIBRARY_KV_SCOPE,
    );
    expect(stored).toMatchObject({
      assetId: 'ast_lib_1',
      contentDigest: DIGEST_A,
      name: 'safety-checklist.pdf',
      mimeType: 'application/pdf',
      size: 2048,
    });
    expect(typeof stored?.addedAt).toBe('string');
    expect(kv.storedKeys()).toHaveLength(1);
  });

  it('re-importing the same bytes refreshes the SAME entry (no duplicate)', async () => {
    await upsertMaterialLibraryEntry({
      assetId: 'ast_lib_1',
      contentDigest: DIGEST_A,
      name: 'safety-checklist.pdf',
      size: 2048,
    });
    const first = await kv.get<MaterialLibraryEntry>(
      materialLibraryKey(DIGEST_A),
      MATERIAL_LIBRARY_KV_SCOPE,
    );
    // Simulate the second import resolving a moment later with a new
    // allocation and an updated display name.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await upsertMaterialLibraryEntry({
      assetId: 'ast_lib_2',
      contentDigest: DIGEST_A,
      name: 'safety-checklist-copy.pdf',
      size: 2048,
    });

    const refreshed = await kv.get<MaterialLibraryEntry>(
      materialLibraryKey(DIGEST_A),
      MATERIAL_LIBRARY_KV_SCOPE,
    );
    expect(refreshed?.assetId).toBe('ast_lib_2');
    expect(refreshed?.name).toBe('safety-checklist-copy.pdf');
    // Same entry: one key, `addedAt` advanced.
    expect(kv.storedKeys()).toHaveLength(1);
    expect(new Date(refreshed!.addedAt).getTime()).toBeGreaterThan(
      new Date(first!.addedAt).getTime(),
    );
  });

  it('preserves recorded derivation pointers across a same-digest refresh', async () => {
    await upsertMaterialLibraryEntry({
      assetId: 'ast_lib_1',
      contentDigest: DIGEST_A,
      name: 'safety-checklist.pdf',
      size: 2048,
    });
    await recordMaterialDerivation(DIGEST_A, {
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
    });
    await upsertMaterialLibraryEntry({
      assetId: 'ast_lib_2',
      contentDigest: DIGEST_A,
      name: 'safety-checklist-copy.pdf',
      size: 2048,
    });

    const refreshed = await kv.get<MaterialLibraryEntry>(
      materialLibraryKey(DIGEST_A),
      MATERIAL_LIBRARY_KV_SCOPE,
    );
    expect(refreshed?.derivations).toEqual([
      { domain: 'doc', extractorId: 'mineru', extractorVersion: '1' },
    ]);
  });
});

describe('material library — listMaterials', () => {
  let kv: FakeKV;

  beforeEach(() => {
    kv = new FakeKV();
    setMaterialLibraryKVForTests(kv);
  });

  afterEach(() => {
    resetMaterialLibraryForTests();
  });

  it('lists every entry, newest first by addedAt', async () => {
    await upsertMaterialLibraryEntry({
      assetId: 'ast_old',
      contentDigest: DIGEST_A,
      name: 'old.pdf',
      size: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await upsertMaterialLibraryEntry({
      assetId: 'ast_new',
      contentDigest: DIGEST_B,
      name: 'new.pdf',
      size: 20,
    });

    const listed = await listMaterials();
    expect(listed.map((e) => e.name)).toEqual(['new.pdf', 'old.pdf']);
    expect(listed[0]?.assetId).toBe('ast_new');
    expect(listed[1]?.assetId).toBe('ast_old');
  });

  it('skips malformed entries instead of failing the list', async () => {
    await upsertMaterialLibraryEntry({
      assetId: 'ast_good',
      contentDigest: DIGEST_A,
      name: 'good.pdf',
      size: 10,
    });
    await kv.set(
      materialLibraryKey(DIGEST_B),
      { assetId: 'ast_bad', contentDigest: DIGEST_B }, // missing name/size/addedAt
      MATERIAL_LIBRARY_KV_SCOPE,
    );

    const listed = await listMaterials();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('good.pdf');
  });
});

describe('material library — readMaterial via the pool seam', () => {
  let kv: FakeKV;

  beforeEach(() => {
    kv = new FakeKV();
    setMaterialLibraryKVForTests(kv);
  });

  afterEach(() => {
    resetMaterialLibraryForTests();
  });

  it('returns the asset bytes as a data URL through the pool', async () => {
    const pool = makePool();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const assetId = await pool.put(new Blob([bytes], { type: 'image/png' }));
    // Serve the fake pool's `test://<assetId>` URLs, like the extraction-cache
    // tests do.
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const id = String(input).replace(/^test:\/\//, '');
      const blob = pool.blobs.get(id);
      return blob ? new Response(blob, { status: 200 }) : new Response('missing', { status: 404 });
    }) as typeof fetch;

    const result = await readMaterial(assetId, pool, fetchImpl);
    expect(result?.assetId).toBe(assetId);
    expect(result?.mimeType).toBe('image/png');
    expect(result?.size).toBe(4);
    expect(result?.dataUrl).toBe(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
  });

  it('returns null for an unresolvable asset id, never throws', async () => {
    const pool = makePool();
    await expect(readMaterial('ast_does_not_exist', pool)).resolves.toBeNull();
  });
});

describe('material library — KV-unavailable degradation', () => {
  afterEach(() => {
    resetMaterialLibraryForTests();
  });

  it('lists an EMPTY library when the KV store is unavailable, without throwing', async () => {
    setMaterialLibraryKVForTests({
      get: async () => {
        throw new Error('kv down');
      },
      set: async () => undefined,
      remove: async () => undefined,
      keys: async () => {
        throw new Error('kv down');
      },
    });

    await expect(listMaterials()).resolves.toEqual([]);
  });

  it('upsert and derivation recording never throw on a failing KV', async () => {
    setMaterialLibraryKVForTests({
      get: async () => {
        throw new Error('kv down');
      },
      set: async () => {
        throw new Error('kv down');
      },
      remove: async () => undefined,
      keys: async () => [],
    });

    await expect(
      upsertMaterialLibraryEntry({
        assetId: 'ast_lib_1',
        contentDigest: DIGEST_A,
        name: 'x.pdf',
        size: 1,
      }),
    ).resolves.toBeUndefined();
    await expect(
      recordMaterialDerivation(DIGEST_A, {
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
      }),
    ).resolves.toBeUndefined();
  });

  it('records derivation pointers and deduplicates identical identities', async () => {
    const kv = new FakeKV();
    setMaterialLibraryKVForTests(kv);
    await upsertMaterialLibraryEntry({
      assetId: 'ast_lib_1',
      contentDigest: DIGEST_A,
      name: 'safety-checklist.pdf',
      size: 2048,
    });

    await recordMaterialDerivation(DIGEST_A, {
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
    });
    await recordMaterialDerivation(DIGEST_A, {
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
    });
    await recordMaterialDerivation(DIGEST_A, {
      domain: 'media',
      extractorId: 'alidocmind',
      extractorVersion: '1',
    });

    const stored = await kv.get<MaterialLibraryEntry>(
      materialLibraryKey(DIGEST_A),
      MATERIAL_LIBRARY_KV_SCOPE,
    );
    expect(stored?.derivations).toEqual([
      { domain: 'doc', extractorId: 'mineru', extractorVersion: '1' },
      { domain: 'media', extractorId: 'alidocmind', extractorVersion: '1' },
    ]);
  });

  it('skips the derivation pointer when no library entry exists for the digest', async () => {
    const kv = new FakeKV();
    setMaterialLibraryKVForTests(kv);
    await recordMaterialDerivation(DIGEST_A, {
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
    });
    expect(kv.storedKeys()).toHaveLength(0);
  });

  it('entry shape contract is the reviewable document', () => {
    const sample = entry({});
    expect(Object.keys(sample).sort()).toEqual(
      ['addedAt', 'assetId', 'contentDigest', 'mimeType', 'name', 'size'].sort(),
    );
  });
});
