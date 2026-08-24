import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

interface FakePoolHarness {
  pool: AssetPoolStore;
  blobs: Map<string, Blob>;
  put: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

/** A fake pool whose `put` mints a NEW id per allocation (like the real store). */
function makePool(): FakePoolHarness {
  const blobs = new Map<string, Blob>();
  let next = 0;
  const put = vi.fn(async (data: Blob): Promise<string> => {
    const id = `ast_lib_${next}`;
    next += 1;
    blobs.set(id, data);
    return id;
  });
  const remove = vi.fn(async (ref: string): Promise<void> => {
    blobs.delete(ref);
  });
  const pool: AssetPoolStore = {
    put: put as AssetPoolStore['put'],
    resolve: async (ref: string) => (blobs.has(ref) ? `test://${ref}` : null),
    invalidate: async () => undefined,
    remove: remove as AssetPoolStore['remove'],
    replace: async () => undefined,
    release: async () => undefined,
    close: async () => undefined,
  };
  return { pool, blobs, put, remove };
}

/** A fetch implementation serving the fake pool's `test://<assetId>` URLs. */
function makeFetch(harness: Pick<FakePoolHarness, 'blobs'>): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const id = String(input).replace(/^test:\/\//, '');
    const blob = harness.blobs.get(id);
    return blob ? new Response(blob, { status: 200 }) : new Response('missing', { status: 404 });
  }) as typeof fetch;
}

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

/** The imported file bytes the library allocates its OWN pool entry from. */
const FILE_BYTES = () => new Blob(['library-owned bytes'], { type: 'application/pdf' });

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

describe('material library — upsert by digest with a library-owned allocation', () => {
  let kv: FakeKV;
  let harness: FakePoolHarness;

  beforeEach(() => {
    kv = new FakeKV();
    harness = makePool();
    setMaterialLibraryKVForTests(kv);
  });

  afterEach(() => {
    resetMaterialLibraryForTests();
  });

  it('mints one entry keyed by contentDigest, pointing at the LIBRARY-owned allocation', async () => {
    await upsertMaterialLibraryEntry(
      {
        file: FILE_BYTES(),
        contentDigest: DIGEST_A,
        name: 'safety-checklist.pdf',
        mimeType: 'application/pdf',
        size: 2048,
      },
      harness.pool,
    );

    const stored = await kv.get<MaterialLibraryEntry>(
      materialLibraryKey(DIGEST_A),
      MATERIAL_LIBRARY_KV_SCOPE,
    );
    expect(stored).toMatchObject({
      contentDigest: DIGEST_A,
      name: 'safety-checklist.pdf',
      mimeType: 'application/pdf',
      size: 2048,
    });
    // The entry names the library's OWN allocation (a fresh pool id), and the
    // bytes it names actually exist in the pool.
    expect(stored?.assetId).toBe('ast_lib_0');
    expect(harness.blobs.has(stored!.assetId)).toBe(true);
    expect(typeof stored?.addedAt).toBe('string');
    expect(kv.storedKeys()).toHaveLength(1);
  });

  it('re-importing the same bytes refreshes the SAME entry and releases the previous library allocation AFTER the swap', async () => {
    await upsertMaterialLibraryEntry(
      {
        file: FILE_BYTES(),
        contentDigest: DIGEST_A,
        name: 'safety-checklist.pdf',
        size: 2048,
      },
      harness.pool,
    );
    const first = await kv.get<MaterialLibraryEntry>(
      materialLibraryKey(DIGEST_A),
      MATERIAL_LIBRARY_KV_SCOPE,
    );
    // Simulate the second import resolving a moment later with a new
    // allocation and an updated display name.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await upsertMaterialLibraryEntry(
      {
        file: FILE_BYTES(),
        contentDigest: DIGEST_A,
        name: 'safety-checklist-copy.pdf',
        size: 2048,
      },
      harness.pool,
    );

    const refreshed = await kv.get<MaterialLibraryEntry>(
      materialLibraryKey(DIGEST_A),
      MATERIAL_LIBRARY_KV_SCOPE,
    );
    expect(refreshed?.assetId).toBe('ast_lib_1');
    expect(refreshed?.name).toBe('safety-checklist-copy.pdf');
    // Same entry: one key, `addedAt` advanced.
    expect(kv.storedKeys()).toHaveLength(1);
    expect(new Date(refreshed!.addedAt).getTime()).toBeGreaterThan(
      new Date(first!.addedAt).getTime(),
    );
    // The swap released the PREVIOUS library-owned allocation — after the
    // entry already pointed at the new one — and the new one is alive.
    expect(harness.remove).toHaveBeenCalledWith(first!.assetId);
    expect(harness.blobs.has(first!.assetId)).toBe(false);
    expect(harness.blobs.has(refreshed!.assetId)).toBe(true);
  });

  it('a failed library putAsset skips the upsert with the KV untouched (upload unaffected)', async () => {
    harness.put.mockRejectedValueOnce(new Error('pool put failed'));

    await expect(
      upsertMaterialLibraryEntry(
        {
          file: FILE_BYTES(),
          contentDigest: DIGEST_A,
          name: 'safety-checklist.pdf',
          size: 2048,
        },
        harness.pool,
      ),
    ).resolves.toBeUndefined();
    expect(kv.storedKeys()).toHaveLength(0);
  });

  it('releases the fresh library-owned allocation when kv.set rejects (one warn, P3)', async () => {
    vi.spyOn(kv, 'set').mockRejectedValueOnce(new Error('kv set failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      upsertMaterialLibraryEntry(
        {
          file: FILE_BYTES(),
          contentDigest: DIGEST_A,
          name: 'safety-checklist.pdf',
          size: 2048,
        },
        harness.pool,
      ),
    ).resolves.toBeUndefined();

    // The fresh library-owned allocation was released — a failed write must
    // not orphan it (review P3) — and the entry was never written.
    expect(harness.remove).toHaveBeenCalledWith('ast_lib_0');
    expect(harness.blobs.has('ast_lib_0')).toBe(false);
    expect(kv.storedKeys()).toHaveLength(0);
    // The failure surfaced as exactly ONE warn (which logs the release).
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('releases the fresh library-owned allocation when kv.get rejects (one warn, P3)', async () => {
    vi.spyOn(kv, 'get').mockRejectedValueOnce(new Error('kv get failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      upsertMaterialLibraryEntry(
        {
          file: FILE_BYTES(),
          contentDigest: DIGEST_A,
          name: 'safety-checklist.pdf',
          size: 2048,
        },
        harness.pool,
      ),
    ).resolves.toBeUndefined();

    expect(harness.remove).toHaveBeenCalledWith('ast_lib_0');
    expect(harness.blobs.has('ast_lib_0')).toBe(false);
    expect(kv.storedKeys()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps the fresh allocation when a rejecting kv.set actually committed server-side (ambiguous commit, no release, info)', async () => {
    // An HTTP KV PUT the server commits whose response is lost (proxy/gateway
    // timeout, connection reset) rejects kv.set — the entry IS written. The
    // ambiguous-commit re-read must detect it and NOT release the id the
    // committed entry now names (releasing it would leave a dangling entry
    // that breaks readMaterial).
    const realSet = kv.set.bind(kv);
    vi.spyOn(kv, 'set').mockImplementation(async (key, value, scope) => {
      await realSet(key, value, scope);
      throw new Error('kv set response lost');
    });
    // `log.info` emits through console.log.
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      upsertMaterialLibraryEntry(
        {
          file: FILE_BYTES(),
          contentDigest: DIGEST_A,
          name: 'safety-checklist.pdf',
          size: 2048,
        },
        harness.pool,
      ),
    ).resolves.toBeUndefined();

    // The entry committed and names the fresh allocation, which was KEPT.
    const stored = await kv.get<MaterialLibraryEntry>(
      materialLibraryKey(DIGEST_A),
      MATERIAL_LIBRARY_KV_SCOPE,
    );
    expect(stored?.assetId).toBe('ast_lib_0');
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.blobs.has('ast_lib_0')).toBe(true);
    expect(kv.storedKeys()).toHaveLength(1);
    // The keep decision is logged as info (the write actually landed).
    expect(log.mock.calls.some((c) => String(c[0]).includes('actually committed'))).toBe(true);
    warn.mockRestore();
    log.mockRestore();
  });

  it('skips the release when the post-failure re-read ALSO fails (leak-over-dangling, one warn)', async () => {
    // The upsert's pre-write get succeeds, the set rejects without committing,
    // and the ambiguous-commit re-read fails too. The release must be SKIPPED
    // (leak-over-dangling): a leaked pool entry is recoverable by re-import,
    // while releasing an id a committed entry might name would create a
    // dangling entry that breaks readMaterial.
    const realGet = kv.get.bind(kv);
    let getCalls = 0;
    vi.spyOn(kv, 'get').mockImplementation((async (key: string, scope?: KVScope) => {
      getCalls += 1;
      if (getCalls === 2) throw new Error('kv get failed on re-read');
      return realGet(key, scope);
    }) as typeof kv.get);
    vi.spyOn(kv, 'set').mockRejectedValueOnce(new Error('kv set failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      upsertMaterialLibraryEntry(
        {
          file: FILE_BYTES(),
          contentDigest: DIGEST_A,
          name: 'safety-checklist.pdf',
          size: 2048,
        },
        harness.pool,
      ),
    ).resolves.toBeUndefined();

    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.blobs.has('ast_lib_0')).toBe(true);
    expect(kv.storedKeys()).toHaveLength(0);
    // ONE warn names the leak-over-dangling decision.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('leak-over-dangling');
    warn.mockRestore();
  });

  it('preserves recorded derivation pointers across a same-digest refresh', async () => {
    await upsertMaterialLibraryEntry(
      {
        file: FILE_BYTES(),
        contentDigest: DIGEST_A,
        name: 'safety-checklist.pdf',
        size: 2048,
      },
      harness.pool,
    );
    await recordMaterialDerivation(DIGEST_A, {
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
    });
    await upsertMaterialLibraryEntry(
      {
        file: FILE_BYTES(),
        contentDigest: DIGEST_A,
        name: 'safety-checklist-copy.pdf',
        size: 2048,
      },
      harness.pool,
    );

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
  let harness: FakePoolHarness;

  beforeEach(() => {
    kv = new FakeKV();
    harness = makePool();
    setMaterialLibraryKVForTests(kv);
  });

  afterEach(() => {
    resetMaterialLibraryForTests();
  });

  it('lists every entry, newest first by addedAt', async () => {
    await upsertMaterialLibraryEntry(
      { file: FILE_BYTES(), contentDigest: DIGEST_A, name: 'old.pdf', size: 10 },
      harness.pool,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await upsertMaterialLibraryEntry(
      { file: FILE_BYTES(), contentDigest: DIGEST_B, name: 'new.pdf', size: 20 },
      harness.pool,
    );

    const listed = await listMaterials();
    expect(listed.map((e) => e.name)).toEqual(['new.pdf', 'old.pdf']);
    // Each entry names its own library-owned allocation, alive in the pool.
    expect(listed[0]?.assetId).toBe('ast_lib_1');
    expect(listed[1]?.assetId).toBe('ast_lib_0');
    expect(harness.blobs.has(listed[0]!.assetId)).toBe(true);
    expect(harness.blobs.has(listed[1]!.assetId)).toBe(true);
  });

  it('skips malformed entries instead of failing the list', async () => {
    await upsertMaterialLibraryEntry(
      { file: FILE_BYTES(), contentDigest: DIGEST_A, name: 'good.pdf', size: 10 },
      harness.pool,
    );
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

describe('material library — durability: the library owns its reference (RFC §5 root model)', () => {
  let kv: FakeKV;

  beforeEach(() => {
    kv = new FakeKV();
    setMaterialLibraryKVForTests(kv);
  });

  afterEach(() => {
    resetMaterialLibraryForTests();
  });

  it('readMaterial still resolves AFTER the selection entry is removed (removal never touches the library allocation)', async () => {
    const harness = makePool();
    // The selection's upload-time pool entry (part 0): a DIFFERENT allocation
    // of the same bytes, released by removeCourseMaterial.
    const selectionAssetId = await harness.pool.put(FILE_BYTES());

    await upsertMaterialLibraryEntry(
      {
        file: FILE_BYTES(),
        contentDigest: DIGEST_A,
        name: 'safety-checklist.pdf',
        size: 2048,
      },
      harness.pool,
    );
    const stored = await kv.get<MaterialLibraryEntry>(
      materialLibraryKey(DIGEST_A),
      MATERIAL_LIBRARY_KV_SCOPE,
    );
    expect(stored?.assetId).not.toBe(selectionAssetId);

    // The selection lifecycle releases ONLY the selection's entry.
    await harness.pool.remove(selectionAssetId);
    expect(harness.blobs.has(selectionAssetId)).toBe(false);
    expect(harness.blobs.has(stored!.assetId)).toBe(true);

    // The library's reference stays resolvable — the docstring's durability
    // claim is now true.
    const result = await readMaterial(stored!.assetId, harness.pool, makeFetch(harness));
    expect(result?.assetId).toBe(stored!.assetId);
    expect(result?.size).toBe((FILE_BYTES() as Blob).size);
  });

  it('re-import swap: the previous library allocation is released, the entry names the live one', async () => {
    const harness = makePool();
    await upsertMaterialLibraryEntry(
      {
        file: FILE_BYTES(),
        contentDigest: DIGEST_A,
        name: 'safety-checklist.pdf',
        size: 2048,
      },
      harness.pool,
    );
    await upsertMaterialLibraryEntry(
      {
        file: FILE_BYTES(),
        contentDigest: DIGEST_A,
        name: 'safety-checklist-copy.pdf',
        size: 2048,
      },
      harness.pool,
    );

    const stored = await kv.get<MaterialLibraryEntry>(
      materialLibraryKey(DIGEST_A),
      MATERIAL_LIBRARY_KV_SCOPE,
    );
    expect(stored?.assetId).toBe('ast_lib_1');
    // The superseded allocation is gone; the entry's allocation is live.
    expect(harness.blobs.has('ast_lib_0')).toBe(false);
    expect(harness.blobs.has(stored!.assetId)).toBe(true);
    const result = await readMaterial(stored!.assetId, harness.pool, makeFetch(harness));
    expect(result?.assetId).toBe(stored!.assetId);
    // The released id no longer resolves.
    await expect(readMaterial('ast_lib_0', harness.pool, makeFetch(harness))).resolves.toBeNull();
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
    const assetId = await pool.pool.put(new Blob([bytes], { type: 'image/png' }));

    const result = await readMaterial(assetId, pool.pool, makeFetch(pool));
    expect(result?.assetId).toBe(assetId);
    expect(result?.mimeType).toBe('image/png');
    expect(result?.size).toBe(4);
    expect(result?.dataUrl).toBe(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
  });

  it('returns null for an unresolvable asset id, never throws', async () => {
    const pool = makePool();
    await expect(readMaterial('ast_does_not_exist', pool.pool)).resolves.toBeNull();
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

  it('upsert and derivation recording never throw on a failing KV (the library allocation is still attempted)', async () => {
    const harness = makePool();
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
      upsertMaterialLibraryEntry(
        {
          file: FILE_BYTES(),
          contentDigest: DIGEST_A,
          name: 'x.pdf',
          size: 1,
        },
        harness.pool,
      ),
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
    const harness = makePool();
    setMaterialLibraryKVForTests(kv);
    await upsertMaterialLibraryEntry(
      {
        file: FILE_BYTES(),
        contentDigest: DIGEST_A,
        name: 'safety-checklist.pdf',
        size: 2048,
      },
      harness.pool,
    );

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
