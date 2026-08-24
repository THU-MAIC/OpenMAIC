import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AssetMeta, BinaryBlob } from '@openmaic/dsl';
import { HttpKVStoreError, type KVStore, type KVScope } from '@openmaic/storage';

import {
  ALIAS_MAX_AGE_MS,
  computeConfigFingerprint,
  computeContentDigest,
  createExtractionDeduplicator,
  EXTRACTION_CACHE_KV_SCOPE,
  extractionCacheKey,
  fetchExtractionWithCache,
  lookupCachedExtraction,
  resetExtractionCacheForTests,
  resolveExpectedExtractor,
  writeExtractionCache,
  type DerivationRecord,
  type ExtractionCacheDomain,
  type InRunExtractionKey,
} from '@/lib/document/extraction-cache';
import type { ExtractSourceFetchers } from '@/lib/document/extract-source';
import { setMaterialLibraryKVForTests } from '@/lib/materials/library';
import type { AssetPoolStore } from '@/lib/media/asset-pool-config';
import type { ParsedPdfContent } from '@/lib/types/pdf';

const PNG_1 = 'data:image/png;base64,AQID';
const PNG_2 = 'data:image/png;base64,BAUG';

/** Config fingerprint for providers without a caller-supplied endpoint (stable bucket). */
let MANAGED_FP: string;

beforeAll(async () => {
  MANAGED_FP = await computeConfigFingerprint();
  // A working library KV for the best-effort derivation-pointer recording that
  // `fetchExtractionWithCache` now performs: with the browser store unavailable
  // in node, the library would otherwise warn per call and pollute the
  // console.warn-count assertions in the K5 suite below. Installed for the
  // whole file (entries accumulate harmlessly; no test reads the library).
  setMaterialLibraryKVForTests(new FakeKV());
});

/** The full cache key for the stable (no baseUrl) config bucket, as callers use it. */
function managedKey(
  digest: string,
  extractorId: string,
  extractorVersion: string,
  domain: ExtractionCacheDomain = 'doc',
): string {
  return extractionCacheKey(digest, extractorId, extractorVersion, MANAGED_FP, domain);
}

/** A document-extraction result in the exact shape the route returns today. */
function fixtureResult(): ParsedPdfContent {
  return {
    text: '# Safety Checklist\n\nInspect the device before calibration.',
    images: [PNG_1, PNG_2],
    metadata: {
      pageCount: 2,
      parser: 'mineru',
      fileName: 'safety-checklist.pdf',
      fileSize: 2048,
      mimeType: 'application/pdf',
      imageMapping: { img_1: PNG_1, img_2: PNG_2 },
      pdfImages: [
        {
          id: 'img_1',
          src: PNG_1,
          pageNumber: 1,
          description: 'Device overview',
          width: 640,
          height: 480,
        },
        { id: 'img_2', src: PNG_2, pageNumber: 3, description: 'Second diagram' },
      ],
      taskId: 'mineru-task-1',
    },
    tables: [{ page: 1, data: [['Tool', 'State']], caption: 'Inspection table' }],
  };
}

/** A document-extraction result with `count` images, for probe-batching tests. */
function manyImageResult(count: number): ParsedPdfContent {
  const imageSrcs = Array.from({ length: count }, (_, index) => {
    const dataUrl = `data:image/png;base64,${Buffer.from(`img-${index + 1}`).toString('base64')}`;
    return dataUrl;
  });
  return {
    text: '# Many images',
    images: imageSrcs,
    metadata: {
      pageCount: count,
      parser: 'mineru',
      fileName: 'many-images.pdf',
      fileSize: 4096,
      mimeType: 'application/pdf',
      imageMapping: Object.fromEntries(imageSrcs.map((src, index) => [`img_${index + 1}`, src])),
      pdfImages: imageSrcs.map((src, index) => ({
        id: `img_${index + 1}`,
        src,
        pageNumber: index + 1,
      })),
      taskId: 'mineru-task-many',
    },
    tables: [],
  };
}

/** A minimal in-memory KVStore with the same JSON round-trip semantics. */
class FakeKV implements KVStore {
  private readonly entries = new Map<string, string>();

  private fullKey(key: string, scope?: KVScope): string {
    return `${scope ?? EXTRACTION_CACHE_KV_SCOPE}:${key}`;
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

  /** Every stored full key, for asserting that no record was written. */
  storedKeys(): string[] {
    return [...this.entries.keys()];
  }
}

interface FakePoolHarness {
  pool: AssetPoolStore;
  blobs: Map<string, Blob>;
  put: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
}

function makePool(): FakePoolHarness {
  const blobs = new Map<string, Blob>();
  let next = 0;
  const put = vi.fn(async (data: BinaryBlob, meta?: AssetMeta): Promise<string> => {
    const id = `ast_test_${next}`;
    next += 1;
    blobs.set(id, data as Blob);
    void meta;
    return id;
  });
  const resolve = vi.fn(async (ref: string): Promise<string | null> => {
    return blobs.has(ref) ? `test://${ref}` : null;
  });
  const remove = vi.fn(async (ref: string): Promise<void> => {
    blobs.delete(ref);
  });
  const exists = vi.fn(async (ref: string): Promise<boolean> => blobs.has(ref));
  const pool: AssetPoolStore = {
    put: put as AssetPoolStore['put'],
    resolve: resolve as AssetPoolStore['resolve'],
    invalidate: vi.fn(async () => undefined),
    remove: remove as AssetPoolStore['remove'],
    replace: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    exists: exists as AssetPoolStore['exists'],
    close: vi.fn(async () => undefined),
  };
  return { pool, blobs, put, resolve, remove, exists };
}

/** A fetch implementation serving the fake pool's `test://<assetId>` URLs. */
function makeFetch(harness: Pick<FakePoolHarness, 'blobs'>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    void init;
    const id = String(input).replace(/^test:\/\//, '');
    const blob = harness.blobs.get(id);
    if (!blob) return new Response(null, { status: 404 });
    return new Response(await blob.arrayBuffer(), {
      status: 200,
      headers: { 'content-type': blob.type || 'application/octet-stream' },
    });
  }) as typeof fetch;
}

function fetchersThatThrow(): {
  fetchers: ExtractSourceFetchers;
  spies: { assetId: ReturnType<typeof vi.fn>; bytes: ReturnType<typeof vi.fn> };
} {
  const assetId = vi.fn(async () => {
    throw new Error('the extract API must not be called on a cache hit');
  });
  const bytes = vi.fn(async () => {
    throw new Error('the extract API must not be called on a cache hit');
  });
  return {
    fetchers: { submitAssetIdForm: assetId, submitByteForm: bytes },
    spies: { assetId, bytes },
  };
}

const DIGEST = 'a'.repeat(64);

describe('computeContentDigest', () => {
  it('is stable across File instances with the same bytes', async () => {
    const bytes = new TextEncoder().encode('same document bytes');
    const first = new File([bytes], 'a.pdf', { type: 'application/pdf' });
    const second = new File([bytes], 'b.pdf', { type: 'application/pdf' });

    const [digestA, digestB] = await Promise.all([
      computeContentDigest(first),
      computeContentDigest(second),
    ]);

    expect(digestA).toBe(digestB);
    expect(digestA).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when the bytes differ', async () => {
    const digestA = await computeContentDigest(new File(['one'], 'a.txt'));
    const digestB = await computeContentDigest(new File(['two'], 'b.txt'));

    expect(digestA).not.toBe(digestB);
  });
});

describe('extractionCacheKey', () => {
  it('includes the content digest, the domain, the extractor id and version, and the config fingerprint', () => {
    const key = managedKey(DIGEST, 'mineru', '1');

    expect(key).toBe(`derived-extraction:v3:${DIGEST}:doc:mineru@1:cfg-${MANAGED_FP}`);
    expect(key).toContain(DIGEST);
    expect(key).toContain(':doc:');
    expect(key).toContain('mineru');
    expect(key).toContain('@1');
    expect(key).toContain(`:cfg-${MANAGED_FP}`);
  });

  it('separates the document and media derivations of the same bytes (L6)', () => {
    // `alidocmind` lives in both registries at version '1': a document and a
    // media derivation of the same bytes must not share a key.
    const doc = managedKey(DIGEST, 'alidocmind', '1', 'doc');
    const media = managedKey(DIGEST, 'alidocmind', '1', 'media');

    expect(doc).not.toBe(media);
    expect(doc).toContain(':doc:');
    expect(media).toContain(':media:');
  });

  it('produces a different key when the extractor version bumps', () => {
    const v1 = managedKey(DIGEST, 'mineru', '1');
    const v2 = managedKey(DIGEST, 'mineru', '2');

    expect(v1).not.toBe(v2);
  });

  it('produces a different key for a different extractor', () => {
    expect(managedKey(DIGEST, 'unpdf', '1')).not.toBe(managedKey(DIGEST, 'mineru', '1'));
  });

  it('fingerprints a caller-supplied endpoint so a baseUrl change misses (K2)', async () => {
    const atA = extractionCacheKey(
      DIGEST,
      'mineru',
      '1',
      await computeConfigFingerprint('https://a.example'),
      'doc',
    );
    const atB = extractionCacheKey(
      DIGEST,
      'mineru',
      '1',
      await computeConfigFingerprint('https://b.example'),
      'doc',
    );

    expect(atA).not.toBe(atB);
  });

  it('keeps the key stable for the managed/default bucket across calls (K2)', async () => {
    const withUndefined = extractionCacheKey(
      DIGEST,
      'unpdf',
      '1',
      await computeConfigFingerprint(undefined),
      'doc',
    );
    const withExplicit = extractionCacheKey(DIGEST, 'unpdf', '1', MANAGED_FP, 'doc');

    expect(withUndefined).toBe(withExplicit);
    expect(withUndefined).toContain(`:cfg-${MANAGED_FP}`);
  });
});

describe('computeConfigFingerprint', () => {
  it('normalizes trivially-equal spellings of one endpoint into one fingerprint (L2)', async () => {
    const variants = ['https://Host/', 'https://host', 'https://host:443'];
    const fingerprints = await Promise.all(variants.map((url) => computeConfigFingerprint(url)));

    expect(fingerprints[0]).toBe(fingerprints[1]);
    expect(fingerprints[1]).toBe(fingerprints[2]);
  });

  it('keeps different paths on the same endpoint as different fingerprints (L2)', async () => {
    const atA = await computeConfigFingerprint('https://host/a');
    const atB = await computeConfigFingerprint('https://host/b');

    expect(atA).not.toBe(atB);
  });

  it('strips a non-default port only when it is the scheme default (L2)', async () => {
    const nonDefault = await computeConfigFingerprint('https://host:8080');
    const bare = await computeConfigFingerprint('https://host');

    expect(nonDefault).not.toBe(bare);
  });

  it('hashes an unparseable baseUrl verbatim (L2)', async () => {
    const raw = 'not a url';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const expected = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    )
      .join('')
      .slice(0, 8);

    expect(await computeConfigFingerprint(raw)).toBe(expected);
  });
});

describe('resolveExpectedExtractor', () => {
  it('auto-selects the first compatible document extractor when none is requested', () => {
    expect(resolveExpectedExtractor('application/pdf')).toEqual({
      extractorId: 'unpdf',
      extractorVersion: '1',
    });
  });

  it('honors a requested extractor that supports the MIME', () => {
    expect(resolveExpectedExtractor('application/pdf', 'mineru')).toEqual({
      extractorId: 'mineru',
      extractorVersion: '1',
    });
  });

  it('drops a requested extractor that cannot handle the MIME and auto-selects', () => {
    expect(resolveExpectedExtractor('application/pdf', 'plain-text')).toEqual({
      extractorId: 'unpdf',
      extractorVersion: '1',
    });
  });

  it('resolves the media extractor for audio/video MIMEs', () => {
    expect(resolveExpectedExtractor('video/mp4')).toEqual({
      extractorId: 'alidocmind',
      extractorVersion: '1',
    });
    expect(resolveExpectedExtractor('audio/mpeg', 'alidocmind')).toEqual({
      extractorId: 'alidocmind',
      extractorVersion: '1',
    });
  });

  it('returns null for an unsupported MIME', () => {
    expect(resolveExpectedExtractor('application/x-unknown')).toBeNull();
  });
});

describe('writeExtractionCache', () => {
  it('writes one derivation record per (digest, extractor) with full lineage', async () => {
    const kv = new FakeKV();
    const harness = makePool();

    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: fixtureResult(),
    });

    const key = managedKey(DIGEST, 'mineru', '1');
    const record = await kv.get<{
      sourceDocAssetId?: string;
      extractorId: string;
      extractorVersion: string;
      artifactAssetId: string;
      images: Array<{
        id: string;
        assetId: string;
        pageNumber?: number;
        description?: string;
        width?: number;
        height?: number;
        mimeType?: string;
      }>;
      createdAt: string;
    }>(key, EXTRACTION_CACHE_KV_SCOPE);

    expect(record).not.toBeNull();
    expect(record?.sourceDocAssetId).toBe('ast_source_doc');
    expect(record?.extractorId).toBe('mineru');
    expect(record?.extractorVersion).toBe('1');
    expect(record?.artifactAssetId).toMatch(/^ast_test_\d+$/);
    expect(typeof record?.createdAt).toBe('string');
    // Lineage: page numbers and descriptions carried through per image.
    expect(record?.images).toEqual([
      {
        id: 'img_1',
        assetId: 'ast_test_0',
        pageNumber: 1,
        description: 'Device overview',
        width: 640,
        height: 480,
        mimeType: 'image/png',
      },
      {
        id: 'img_2',
        assetId: 'ast_test_1',
        pageNumber: 3,
        description: 'Second diagram',
        mimeType: 'image/png',
      },
    ]);

    // The artifact asset holds the result JSON with inline image data stripped
    // and each image's pool asset id in its place.
    const artifactBlob = harness.blobs.get(record!.artifactAssetId);
    expect(artifactBlob).toBeDefined();
    const artifact = JSON.parse(await artifactBlob!.text()) as {
      images: string[];
      metadata: {
        imageMapping: Record<string, string>;
        pdfImages: Array<{ id: string; assetId: string; pageNumber: number }>;
      };
    };
    expect(artifact.images).toEqual(['ast_test_0', 'ast_test_1']);
    expect(artifact.metadata.imageMapping).toEqual({ img_1: 'ast_test_0', img_2: 'ast_test_1' });
    expect(artifact.metadata.pdfImages).toEqual([
      {
        id: 'img_1',
        assetId: 'ast_test_0',
        pageNumber: 1,
        description: 'Device overview',
        width: 640,
        height: 480,
      },
      { id: 'img_2', assetId: 'ast_test_1', pageNumber: 3, description: 'Second diagram' },
    ]);
    expect(JSON.stringify(artifact)).not.toContain('data:image/');
  });

  it('resolves to the derived images (extraction id → pool asset id) on success', async () => {
    const kv = new FakeKV();
    const harness = makePool();

    const derived = await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: fixtureResult(),
    });

    // A server-backed caller awaits the write to learn the image asset ids
    // without materializing image bytes (RFC #1153 part 2 B).
    expect(derived.map((image) => image.id)).toEqual(['img_1', 'img_2']);
    expect(derived.map((image) => image.assetId)).toEqual(['ast_test_0', 'ast_test_1']);
  });

  it('returns the ADOPTED record images when a same-key race supersedes the attempt (K3)', async () => {
    const kv = new FakeKV();
    const harness = makePool();

    const first = await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      result: fixtureResult(),
    });
    // A second write for the same key ingests its own assets, then adopts the
    // existing record and releases them — the caller must receive the LIVE
    // ids, not the released ones.
    const second = await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      result: fixtureResult(),
    });

    expect(second).toEqual(first);
    expect(second.map((image) => image.assetId)).toEqual(['ast_test_0', 'ast_test_1']);
  });

  it('resolves to an empty array when the write is skipped (route-level KV failure window)', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    resetExtractionCacheForTests();
    // Force the route-level disable window so the write is skipped pre-ingest.
    const routeFailure = new HttpKVStoreError(404, 'ROUTE_GONE', 'route gone');
    // The window is module-internal; simulate by a failing kv.get path that is
    // treated as route-level — see the K5 suite below for the real mechanism.
    const failingKv: KVStore = {
      get: async () => {
        throw routeFailure;
      },
      set: async () => undefined,
      remove: async () => undefined,
      keys: async () => [],
    };
    // First write: the route-level failure disables the cache for a window.
    await writeExtractionCache({
      kv: failingKv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      result: fixtureResult(),
    });
    const skipped = await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      result: fixtureResult(),
    });
    expect(skipped).toEqual([]);
    expect(harness.blobs.size).toBe(0);
    resetExtractionCacheForTests();
  });

  it('releases every allocated asset and writes no record when an image ingest fails', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    // First image ingests, the second fails: the partial attempt must release
    // the first image's asset and must not leave a KV record behind.
    harness.put
      .mockResolvedValueOnce('ast_test_0')
      .mockRejectedValueOnce(new Error('pool put failed'));

    await expect(
      writeExtractionCache({
        kv,
        pool: harness.pool,
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        sourceDocAssetId: 'ast_source_doc',
        result: fixtureResult(),
      }),
    ).resolves.toEqual([]);

    expect(kv.storedKeys()).toEqual([]);
    expect(harness.remove).toHaveBeenCalledWith('ast_test_0');
    expect(harness.blobs.has('ast_test_0')).toBe(false);
  });

  it('releases images and writes no record when the KV record write fails', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const failingKv = new FakeKV();
    vi.spyOn(failingKv, 'set').mockRejectedValueOnce(new Error('kv unavailable'));

    await writeExtractionCache({
      kv: failingKv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: fixtureResult(),
    });

    expect(failingKv.storedKeys()).toEqual([]);
    // Both images and the artifact were allocated before the KV write; all
    // three are released.
    expect(harness.remove).toHaveBeenCalledWith('ast_test_0');
    expect(harness.remove).toHaveBeenCalledWith('ast_test_1');
    expect(harness.remove).toHaveBeenCalledWith('ast_test_2');
    expect(harness.blobs.size).toBe(0);
    expect(kv.storedKeys()).toEqual([]);
  });

  it('adopts an existing record and releases its own allocations on a same-key race (cross-tab, K3)', async () => {
    const kv = new FakeKV();
    const first = makePool();
    await writeExtractionCache({
      kv,
      pool: first.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: fixtureResult(),
    });
    const key = managedKey(DIGEST, 'mineru', '1');
    const original = await kv.get<DerivationRecord>(key, EXTRACTION_CACHE_KV_SCOPE);
    expect(original).not.toBeNull();

    // A second writer (fresh pool, fresh asset ids) races the same key.
    const second = makePool();
    await writeExtractionCache({
      kv,
      pool: second.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      result: fixtureResult(),
    });

    // The existing record was adopted unchanged, and the loser's allocations
    // were all released — no orphaned assets accumulate.
    const after = await kv.get<DerivationRecord>(key, EXTRACTION_CACHE_KV_SCOPE);
    expect(after?.artifactAssetId).toBe(original!.artifactAssetId);
    expect(second.blobs.size).toBe(0);
    expect(second.remove).toHaveBeenCalledTimes(3);
    expect(kv.storedKeys()).toHaveLength(1);
  });

  it('writes an alias record for an existing record when racing a same-key write (K1 × K3)', async () => {
    const kv = new FakeKV();
    // Winner: actual mineru-cloud run with no alias expected.
    const first = makePool();
    await writeExtractionCache({
      kv,
      pool: first.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru-cloud',
      extractorVersion: '1',
      result: fixtureResult(),
    });
    const winner = await kv.get<DerivationRecord>(
      managedKey(DIGEST, 'mineru-cloud', '1'),
      EXTRACTION_CACHE_KV_SCOPE,
    );
    expect(winner).not.toBeNull();

    // Loser: same actual extractor, but a mineru lookup expected it — it must
    // write the alias for the EXISTING record (declaring the expected alias)
    // and release its own allocations.
    const loser = makePool();
    await writeExtractionCache({
      kv,
      pool: loser.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru-cloud',
      extractorVersion: '1',
      aliasExtractor: { extractorId: 'mineru', extractorVersion: '1' },
      result: fixtureResult(),
    });

    const aliasRecord = await kv.get<DerivationRecord>(
      managedKey(DIGEST, 'mineru', '1'),
      EXTRACTION_CACHE_KV_SCOPE,
    );
    expect(aliasRecord?.artifactAssetId).toBe(winner!.artifactAssetId);
    expect(aliasRecord?.aliases).toEqual([{ extractorId: 'mineru', extractorVersion: '1' }]);
    expect(loser.blobs.size).toBe(0);
  });

  it('logs rejected outcomes when releasing assets after a failed cache write (K6)', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    // Second image ingest fails; the catch path releases the first image, whose
    // removal rejects — that rejection must be logged, never swallowed.
    harness.put
      .mockResolvedValueOnce('ast_test_0')
      .mockRejectedValueOnce(new Error('second image put failed'));
    harness.remove.mockImplementation(async (id: string) => {
      if (id === 'ast_test_0') throw new Error('pool remove failed');
      harness.blobs.delete(id);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      result: fixtureResult(),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to release'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ast_test_0'));
    warn.mockRestore();
  });

  it('stores the same record value under both the actual key and the alias key (K1)', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru-cloud',
      extractorVersion: '1',
      aliasExtractor: { extractorId: 'mineru', extractorVersion: '1' },
      result: fixtureResult(),
    });

    const actualKey = managedKey(DIGEST, 'mineru-cloud', '1');
    const aliasKey = managedKey(DIGEST, 'mineru', '1');
    const actualRecord = await kv.get<DerivationRecord>(actualKey, EXTRACTION_CACHE_KV_SCOPE);
    const aliasRecord = await kv.get<DerivationRecord>(aliasKey, EXTRACTION_CACHE_KV_SCOPE);
    expect(actualRecord).not.toBeNull();
    expect(aliasRecord).not.toBeNull();
    // Same value under both keys, and the record declares the alias identity so
    // a lookup under the expected key validates.
    expect(JSON.stringify(aliasRecord)).toBe(JSON.stringify(actualRecord));
    expect(aliasRecord?.aliases).toEqual([{ extractorId: 'mineru', extractorVersion: '1' }]);
    // Both entries reference the SAME artifact/image assets.
    expect(aliasRecord?.artifactAssetId).toBe(actualRecord?.artifactAssetId);
  });

  it('abandons the write and releases its allocations when the config-fingerprint computation throws (M1)', async () => {
    const digestSpy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockRejectedValueOnce(new Error('Web Crypto unavailable'));
    const kv = new FakeKV();
    const harness = makePool();
    try {
      await writeExtractionCache({
        kv,
        pool: harness.pool,
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        result: fixtureResult(),
      });

      // Best-effort: the write resolves (it never rejects the detached promise
      // into the warn path), releases every asset it allocated before the key
      // step, and writes no record.
      expect(kv.storedKeys()).toEqual([]);
      expect(harness.remove).toHaveBeenCalledWith('ast_test_0');
      expect(harness.remove).toHaveBeenCalledWith('ast_test_1');
      expect(harness.remove).toHaveBeenCalledWith('ast_test_2');
      expect(harness.blobs.size).toBe(0);
    } finally {
      digestSpy.mockRestore();
    }
  });

  it('supersedes an expired alias record without releasing the superseded record assets (M1)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const kv = new FakeKV();
      const harness = makePool();
      // Phase 1: MinerU Cloud ran for a mineru request — the alias record under
      // the mineru key is a COPY of the actual-primary record (same assets).
      await writeExtractionCache({
        kv,
        pool: harness.pool,
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru-cloud',
        extractorVersion: '1',
        aliasExtractor: { extractorId: 'mineru', extractorVersion: '1' },
        result: fixtureResult(),
      });
      const aliasKey = managedKey(DIGEST, 'mineru', '1');
      const superseded = await kv.get<DerivationRecord>(aliasKey, EXTRACTION_CACHE_KV_SCOPE);
      expect(superseded).not.toBeNull();
      const supersededAssetIds = [
        superseded!.artifactAssetId,
        ...superseded!.images.map((image) => image.assetId),
      ];

      // Phase 2: past the alias TTL, the same expected key is re-written by the
      // CURRENT actual identity — the expired alias record is superseded.
      vi.advanceTimersByTime(ALIAS_MAX_AGE_MS + 1);
      await writeExtractionCache({
        kv,
        pool: harness.pool,
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        result: fixtureResult(),
      });

      const after = await kv.get<DerivationRecord>(aliasKey, EXTRACTION_CACHE_KV_SCOPE);
      expect(after?.extractorId).toBe('mineru');
      expect(after?.aliases).toBeUndefined();
      expect(after?.artifactAssetId).not.toBe(superseded!.artifactAssetId);
      // The superseded alias record is a copy of the actual-primary record: its
      // assets stay referenced under the actual-identity key (which the
      // supersede must not touch), so no release calls may happen for them —
      // and none happened at all (the fresh write kept its own allocations).
      for (const assetId of supersededAssetIds) {
        expect(harness.blobs.has(assetId)).toBe(true);
      }
      expect(harness.remove).not.toHaveBeenCalled();
      const actualPrimary = await kv.get<DerivationRecord>(
        managedKey(DIGEST, 'mineru-cloud', '1'),
        EXTRACTION_CACHE_KV_SCOPE,
      );
      expect(actualPrimary?.artifactAssetId).toBe(superseded!.artifactAssetId);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('lookupCachedExtraction', () => {
  it('rebuilds exactly the parse result a real extraction produces on a hit', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const original = fixtureResult();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: original,
    });

    const rebuilt = await lookupCachedExtraction({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
    });

    expect(rebuilt).not.toBeNull();
    expect(rebuilt).toEqual(original);
    expect(rebuilt?.metadata?.pdfImages?.[0]).toMatchObject({
      id: 'img_1',
      src: PNG_1,
      pageNumber: 1,
      description: 'Device overview',
      width: 640,
      height: 480,
    });
  });

  it('rebuilds by asset id in asset-id mode WITHOUT materializing image bytes (RFC #1153 part 2 C)', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const original = fixtureResult();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: original,
    });
    const record = await kv.get<DerivationRecord>(
      managedKey(DIGEST, 'mineru', '1'),
      EXTRACTION_CACHE_KV_SCOPE,
    );
    expect(record?.images.map((image) => image.assetId)).toEqual(['ast_test_0', 'ast_test_1']);

    const rebuilt = await lookupCachedExtraction({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
      imageMappingMode: 'asset-id',
    });

    expect(rebuilt).not.toBeNull();
    // The image BYTES were NOT fetched: only the artifact asset was resolved
    // from the pool (data-url mode resolves artifact + every image); each
    // image asset was probed for EXISTENCE through the pool's identity seam
    // (no byte fetch).
    expect(harness.resolve).toHaveBeenCalledTimes(1);
    expect(harness.resolve).toHaveBeenCalledWith(record!.artifactAssetId);
    expect(harness.exists).toHaveBeenCalledTimes(2);
    expect(harness.exists).toHaveBeenCalledWith('ast_test_0');
    expect(harness.exists).toHaveBeenCalledWith('ast_test_1');
    // metadata.imageMapping maps img_N → the allocated asset id, and
    // pdfImages carry the id on `assetId` with src left empty.
    expect(rebuilt?.metadata?.imageMapping).toEqual({ img_1: 'ast_test_0', img_2: 'ast_test_1' });
    expect(rebuilt?.metadata?.pdfImages?.[0]).toMatchObject({
      id: 'img_1',
      src: '',
      assetId: 'ast_test_0',
      description: 'Device overview',
    });
    expect(rebuilt?.metadata?.pdfImages?.[1]).toMatchObject({
      id: 'img_2',
      src: '',
      assetId: 'ast_test_1',
    });
    expect(rebuilt?.images).toEqual([]);
    // The text half is rebuilt exactly as a real extraction returns it.
    expect(rebuilt?.text).toBe(original.text);
  });

  it('reports a MISS in asset-id mode when an image asset was reclaimed (reclaim = miss, N6)', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: fixtureResult(),
    });
    // Simulate a partially-reclaimed cache: one image asset's bytes are gone.
    harness.blobs.delete('ast_test_1');

    const rebuilt = await lookupCachedExtraction({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
      imageMappingMode: 'asset-id',
    });

    // A dangling id is a miss, exactly like data-url mode — the real
    // extraction re-derives instead of serving text with a silently missing
    // image. The existence probe is an identity read, never a byte fetch.
    expect(rebuilt).toBeNull();
    expect(harness.exists).toHaveBeenCalledWith('ast_test_1');
    expect(harness.resolve).toHaveBeenCalledTimes(1); // artifact only
  });

  it('probes every image existence with bounded concurrency on a many-image hit (O3)', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const count = 24;
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: manyImageResult(count),
    });
    // Track the probe concurrency: how many exists calls are in flight at once.
    let inFlight = 0;
    let maxInFlight = 0;
    harness.exists.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return true;
    });

    const rebuilt = await lookupCachedExtraction({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
      imageMappingMode: 'asset-id',
    });

    expect(rebuilt).not.toBeNull();
    // The happy path consults EVERY image asset — no probe is skipped.
    expect(harness.exists).toHaveBeenCalledTimes(count);
    // ... and the batch bound held: never more than 8 probes in flight.
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it('degrades a probe phase that outlives the aggregate budget to a miss, not a hang (O3)', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: fixtureResult(),
    });
    // One image's existence probe never settles — a stalled persistence
    // endpoint holding the HEAD open. Without an aggregate budget this would
    // hold the hit path forever; with it, the phase degrades to a miss. The
    // production default is the 15 s ingest-drain constant; the test injects
    // a tiny budget so the degrade is observable without waiting 15 s.
    harness.exists.mockImplementation(async (ref: string) => {
      if (ref === 'ast_test_1') return new Promise<boolean>(() => undefined);
      return true;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const rebuilt = await lookupCachedExtraction({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
      imageMappingMode: 'asset-id',
      assetProbeBudgetMs: 50,
    });

    // The hit resolved to a miss after the budget — it did not wait on the
    // hanging probe — with exactly ONE warn naming the budget.
    expect(rebuilt).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('aggregate budget');
    warn.mockRestore();
  });

  it('reports a miss when no record exists', async () => {
    const kv = new FakeKV();
    const harness = makePool();

    await expect(
      lookupCachedExtraction({
        kv,
        pool: harness.pool,
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        fetchImpl: makeFetch(harness),
      }),
    ).resolves.toBeNull();
  });

  it('reports a miss when the extractor version does not match the record', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '2',
      sourceDocAssetId: 'ast_source_doc',
      result: fixtureResult(),
    });
    // The key is pinned to v2, so a v1 lookup misses — the version bump is a
    // miss by construction.
    await expect(
      lookupCachedExtraction({
        kv,
        pool: harness.pool,
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        fetchImpl: makeFetch(harness),
      }),
    ).resolves.toBeNull();
  });

  it('reports a miss when the artifact asset is missing', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: fixtureResult(),
    });
    // Simulate a partially reclaimed cache: the artifact bytes are gone.
    const record = await kv.get<{ artifactAssetId: string }>(managedKey(DIGEST, 'mineru', '1'));
    harness.blobs.delete(record!.artifactAssetId);

    await expect(
      lookupCachedExtraction({
        kv,
        pool: harness.pool,
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        fetchImpl: makeFetch(harness),
      }),
    ).resolves.toBeNull();
  });

  it('reports a miss when an image asset is missing', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: fixtureResult(),
    });
    harness.blobs.delete('ast_test_1');

    await expect(
      lookupCachedExtraction({
        kv,
        pool: harness.pool,
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        fetchImpl: makeFetch(harness),
      }),
    ).resolves.toBeNull();
  });

  it('round-trips an images-only result (no pdfImages) into the page fallback shape', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const imagesOnly: ParsedPdfContent = {
      text: 'Plain text',
      images: [PNG_1],
      metadata: {
        pageCount: 1,
        parser: 'unpdf',
        fileName: 'legacy.pdf',
        fileSize: 512,
        mimeType: 'application/pdf',
      },
    };
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'unpdf',
      extractorVersion: '1',
      result: imagesOnly,
    });

    const rebuilt = await lookupCachedExtraction({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'unpdf',
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
    });

    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.text).toBe('Plain text');
    expect(rebuilt?.images).toEqual([PNG_1]);
    expect(rebuilt?.metadata?.pdfImages).toEqual([{ id: 'img_1', src: PNG_1, pageNumber: 1 }]);
    expect(rebuilt?.metadata?.imageMapping).toEqual({ img_1: PNG_1 });
  });

  it('round-trips a media-shaped result (no images) verbatim', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const media: ParsedPdfContent = {
      text: '## Transcript\n\n[00:01] Hello world',
      images: [],
      metadata: {
        pageCount: 0,
        parser: 'alidocmind',
        fileName: 'lecture.mp4',
        fileSize: 2048,
        mimeType: 'video/mp4',
      },
    };
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'alidocmind',
      extractorVersion: '1',
      result: media,
    });

    const rebuilt = await lookupCachedExtraction({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'alidocmind',
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
    });

    expect(rebuilt).toEqual(media);
    // No images were ingested for a media artifact.
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it("rebuilds a zero-image document hit with the route's empty image shape (K4)", async () => {
    const kv = new FakeKV();
    const harness = makePool();
    // The route's wire shape for a zero-image document: imageMapping/pdfImages
    // are PRESENT and empty, alongside the route's fileName/fileSize/mimeType.
    const zeroImage: ParsedPdfContent = {
      text: '# Notes\n\nPlain text only.',
      images: [],
      metadata: {
        pageCount: 1,
        parser: 'plain-text',
        fileName: 'notes.md',
        fileSize: 42,
        mimeType: 'text/markdown',
        imageMapping: {},
        pdfImages: [],
      },
    };
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'plain-text',
      extractorVersion: '1',
      result: zeroImage,
    });

    const rebuilt = await lookupCachedExtraction({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'plain-text',
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
    });

    expect(rebuilt).not.toBeNull();
    // Field-for-field equal to the route response shape, empty image keys
    // included.
    expect(rebuilt).toEqual(zeroImage);
    expect(rebuilt?.metadata?.imageMapping).toEqual({});
    expect(rebuilt?.metadata?.pdfImages).toEqual([]);
  });

  it('hits via the alias key when the record declares the requested identity as an alias (K1)', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const original = fixtureResult();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru-cloud',
      extractorVersion: '1',
      aliasExtractor: { extractorId: 'mineru', extractorVersion: '1' },
      result: original,
    });

    const rebuilt = await lookupCachedExtraction({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
    });

    expect(rebuilt).not.toBeNull();
    expect(rebuilt).toEqual(original);
  });

  it('treats a record whose image list disagrees with the artifact as a miss (K6)', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      result: fixtureResult(),
    });
    // Corrupt the record the way a truncated/tampered KV value would: one image
    // entry dropped while the artifact still names both asset ids.
    const key = managedKey(DIGEST, 'mineru', '1');
    const record = await kv.get<DerivationRecord>(key, EXTRACTION_CACHE_KV_SCOPE);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await kv.set(key, { ...record!, images: [record!.images[0]!] }, EXTRACTION_CACHE_KV_SCOPE);

    await expect(
      lookupCachedExtraction({
        kv,
        pool: harness.pool,
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        fetchImpl: makeFetch(harness),
      }),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('do not match'));
    warn.mockRestore();
  });

  it('degrades to a miss when the config-fingerprint computation throws (M1)', async () => {
    const digestSpy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockRejectedValueOnce(new Error('Web Crypto unavailable'));
    const kv = new FakeKV();
    const harness = makePool();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // The fingerprint is computed BEFORE any KV traffic: a failure there must
      // resolve to a miss, never reject the caller's extraction.
      await expect(
        lookupCachedExtraction({
          kv,
          pool: harness.pool,
          contentDigest: DIGEST,
          domain: 'doc',
          extractorId: 'mineru',
          extractorVersion: '1',
          fetchImpl: makeFetch(harness),
        }),
      ).resolves.toBeNull();
      // The failure happened at the digest seam, before the store was touched.
      expect(kv.storedKeys()).toEqual([]);
      // The degrade is observable: one warn naming the miss and the cause.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Extraction cache lookup failed; running the real extraction'),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Web Crypto unavailable'));
    } finally {
      digestSpy.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('alias trust window (L1)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hits a fresh alias, misses an alias older than the TTL, and keeps primary hits permanent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const kv = new FakeKV();
    const harness = makePool();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru-cloud',
      extractorVersion: '1',
      aliasExtractor: { extractorId: 'mineru', extractorVersion: '1' },
      result: fixtureResult(),
    });
    const lookupOptions = (extractorId: string) => ({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc' as const,
      extractorId,
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
    });

    // A fresh alias hit is honored…
    expect(await lookupCachedExtraction(lookupOptions('mineru'))).not.toBeNull();
    // …and the primary hit is permanent from the start.
    expect(await lookupCachedExtraction(lookupOptions('mineru-cloud'))).not.toBeNull();

    // Past the TTL the alias is NO longer trusted — the lookup degrades to a
    // miss so the real extraction re-runs under the current identity.
    vi.advanceTimersByTime(ALIAS_MAX_AGE_MS + 1);
    expect(await lookupCachedExtraction(lookupOptions('mineru'))).toBeNull();
    // The PRIMARY hit stays permanent regardless of age.
    expect(await lookupCachedExtraction(lookupOptions('mineru-cloud'))).not.toBeNull();
  });

  it('converges after expiry: the fresh write records the current actual identity as primary (L1)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const kv = new FakeKV();
    const harness = makePool();
    // Phase 1: MinerU Cloud ran for a mineru request — cloud is the actual
    // primary, mineru is the alias, both under the constant 'managed' bucket.
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru-cloud',
      extractorVersion: '1',
      aliasExtractor: { extractorId: 'mineru', extractorVersion: '1' },
      result: fixtureResult(),
    });
    vi.advanceTimersByTime(ALIAS_MAX_AGE_MS + 1);

    // Phase 2: the deployment configures server-managed self-host mineru; the
    // route now reports parser `mineru`. The expired alias is a miss, the real
    // extraction runs, and the fresh write records mineru as PRIMARY.
    const selfHostResult: ParsedPdfContent = {
      ...fixtureResult(),
      metadata: { ...fixtureResult().metadata!, parser: 'mineru' },
    };
    const assetIdForm = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, data: selfHostResult }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const makeOptions = (): Parameters<typeof fetchExtractionWithCache>[0] => ({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm: assetIdForm, submitByteForm: assetIdForm },
      logWarning: vi.fn(),
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      kv,
      pool: harness.pool,
      fetchImpl: makeFetch(harness),
      parseFailedMessage: 'parse failed',
    });

    const first = await fetchExtractionWithCache(makeOptions());
    expect(first.cacheHit).toBe(false);
    await first.cacheWrite;

    // The record under the expected key is now the self-host PRIMARY (the
    // write superseded the expired alias record instead of adopting it).
    const record = await kv.get<DerivationRecord>(
      managedKey(DIGEST, 'mineru', '1'),
      EXTRACTION_CACHE_KV_SCOPE,
    );
    expect(record?.extractorId).toBe('mineru');
    expect(record?.aliases).toBeUndefined();

    // The next lookup under the same expected key HITS the new primary — no
    // second extraction.
    const second = await fetchExtractionWithCache(makeOptions());
    expect(second.cacheHit).toBe(true);
    expect(second.data).toEqual(selfHostResult);
    expect(assetIdForm).toHaveBeenCalledTimes(1);
  });

  it('treats an alias record whose createdAt is "garbage" as stale (miss); the primary identity stays a hit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const kv = new FakeKV();
    const harness = makePool();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru-cloud',
      extractorVersion: '1',
      aliasExtractor: { extractorId: 'mineru', extractorVersion: '1' },
      result: fixtureResult(),
    });
    // Corrupt the ALIAS record's creation time: an unparseable `createdAt`
    // yields a NaN age, which callers must treat as STALE — an alias without a
    // trustworthy creation time must never be honored.
    const aliasKey = managedKey(DIGEST, 'mineru', '1');
    const aliasRecord = await kv.get<DerivationRecord>(aliasKey, EXTRACTION_CACHE_KV_SCOPE);
    expect(aliasRecord).not.toBeNull();
    await kv.set(aliasKey, { ...aliasRecord!, createdAt: 'garbage' }, EXTRACTION_CACHE_KV_SCOPE);
    const lookupOptions = (extractorId: string) => ({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc' as const,
      extractorId,
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
    });

    // The alias is stale → miss, so the real extraction re-runs…
    expect(await lookupCachedExtraction(lookupOptions('mineru'))).toBeNull();
    // …and the primary identity is unaffected by its own record's alias copy.
    expect(await lookupCachedExtraction(lookupOptions('mineru-cloud'))).not.toBeNull();
  });

  it('treats an alias record with no createdAt (undefined) as stale (miss); the primary identity stays a hit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const kv = new FakeKV();
    const harness = makePool();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru-cloud',
      extractorVersion: '1',
      aliasExtractor: { extractorId: 'mineru', extractorVersion: '1' },
      result: fixtureResult(),
    });
    // Store the alias record WITHOUT a createdAt: `undefined` does not survive
    // the KV JSON round-trip, which is exactly the shape a record with
    // `createdAt: undefined` takes on disk. A missing creation time is a NaN
    // age → stale, so the alias must miss.
    const aliasKey = managedKey(DIGEST, 'mineru', '1');
    const aliasRecord = await kv.get<DerivationRecord>(aliasKey, EXTRACTION_CACHE_KV_SCOPE);
    expect(aliasRecord).not.toBeNull();
    await kv.set(
      aliasKey,
      { ...aliasRecord!, createdAt: undefined as unknown as string },
      EXTRACTION_CACHE_KV_SCOPE,
    );
    const lookupOptions = (extractorId: string) => ({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc' as const,
      extractorId,
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
    });

    expect(await lookupCachedExtraction(lookupOptions('mineru'))).toBeNull();
    expect(await lookupCachedExtraction(lookupOptions('mineru-cloud'))).not.toBeNull();
  });

  it('pins the documented residual: a future-dated alias createdAt stays a hit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const kv = new FakeKV();
    const harness = makePool();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru-cloud',
      extractorVersion: '1',
      aliasExtractor: { extractorId: 'mineru', extractorVersion: '1' },
      result: fixtureResult(),
    });
    // A future-dated `createdAt` yields a NEGATIVE age → the alias is treated
    // as fresh and stays a hit. Pinned as the documented residual (review
    // round 3, L1): such a record is already inside the accepted shared-
    // principal envelope, since whoever planted it could equally plant a
    // permanent primary record.
    const aliasKey = managedKey(DIGEST, 'mineru', '1');
    const aliasRecord = await kv.get<DerivationRecord>(aliasKey, EXTRACTION_CACHE_KV_SCOPE);
    expect(aliasRecord).not.toBeNull();
    await kv.set(
      aliasKey,
      { ...aliasRecord!, createdAt: '2099-01-01T00:00:00Z' },
      EXTRACTION_CACHE_KV_SCOPE,
    );
    const lookupOptions = (extractorId: string) => ({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc' as const,
      extractorId,
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
    });

    expect(await lookupCachedExtraction(lookupOptions('mineru'))).not.toBeNull();
  });
});

describe('fetchExtractionWithCache', () => {
  it('returns the cached result and never calls the extract API on a hit', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const original = fixtureResult();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: original,
    });
    const { fetchers, spies } = fetchersThatThrow();

    const outcome = await fetchExtractionWithCache({
      serverBacked: true,
      hasAssetId: true,
      fetchers,
      logWarning: vi.fn(),
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      kv,
      pool: harness.pool,
      fetchImpl: makeFetch(harness),
      parseFailedMessage: 'parse failed',
    });

    expect(outcome.cacheHit).toBe(true);
    expect(outcome.data).toEqual(original);
    expect(spies.assetId).not.toHaveBeenCalled();
    expect(spies.bytes).not.toHaveBeenCalled();
  });

  it('feeds an asset-id imageMapping on a server-backed hit (RFC #1153 part 2 C)', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: fixtureResult(),
    });
    const { fetchers, spies } = fetchersThatThrow();

    const outcome = await fetchExtractionWithCache({
      serverBacked: true,
      hasAssetId: true,
      fetchers,
      logWarning: vi.fn(),
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      kv,
      pool: harness.pool,
      fetchImpl: makeFetch(harness),
      imageMappingMode: 'asset-id',
      parseFailedMessage: 'parse failed',
    });

    expect(outcome.cacheHit).toBe(true);
    // The cache hit names images by their pool asset ids directly — no image
    // bytes were materialized client-side — so generation can be fed by id.
    expect(outcome.data.metadata?.imageMapping).toEqual({
      img_1: 'ast_test_0',
      img_2: 'ast_test_1',
    });
    expect(outcome.data.metadata?.pdfImages?.[0]?.assetId).toBe('ast_test_0');
    expect(outcome.data.images).toEqual([]);
    expect(spies.assetId).not.toHaveBeenCalled();
    expect(spies.bytes).not.toHaveBeenCalled();
  });

  it('runs the real extraction on a miss and caches the result', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const assetIdForm = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, data: fixtureResult() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const byteForm = vi.fn(async () => {
      throw new Error('byte form must not be used');
    });

    const outcome = await fetchExtractionWithCache({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm: assetIdForm, submitByteForm: byteForm },
      logWarning: vi.fn(),
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      kv,
      pool: harness.pool,
      fetchImpl: makeFetch(harness),
      parseFailedMessage: 'parse failed',
    });

    expect(outcome.cacheHit).toBe(false);
    expect(outcome.data).toEqual(fixtureResult());
    expect(assetIdForm).toHaveBeenCalledTimes(1);
    expect(byteForm).not.toHaveBeenCalled();
    // The write is fire-and-forget (L5): the result returned before it
    // finished, so await the detached write before asserting on it.
    await outcome.cacheWrite;
    // The successful extraction was cached best-effort.
    await expect(
      kv.get(managedKey(DIGEST, 'mineru', '1'), EXTRACTION_CACHE_KV_SCOPE),
    ).resolves.not.toBeNull();
  });

  it('resolves the cacheWrite to the derived image asset ids on a miss (RFC #1153 part 2 B)', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const assetIdForm = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, data: fixtureResult() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const byteForm = vi.fn(async () => {
      throw new Error('byte form must not be used');
    });

    const outcome = await fetchExtractionWithCache({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm: assetIdForm, submitByteForm: byteForm },
      logWarning: vi.fn(),
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      kv,
      pool: harness.pool,
      fetchImpl: makeFetch(harness),
      imageMappingMode: 'asset-id',
      parseFailedMessage: 'parse failed',
    });

    // A server-backed caller awaits the detached write to learn the image
    // asset ids (extraction id → pool asset id) without materializing bytes.
    const derived = await outcome.cacheWrite;
    expect(derived).toEqual([
      expect.objectContaining({ id: 'img_1', assetId: 'ast_test_0' }),
      expect.objectContaining({ id: 'img_2', assetId: 'ast_test_1' }),
    ]);
  });

  it('writes both keys when the actual extractor differs from the expected one, and hits via the expected key on re-import (K1)', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const base = fixtureResult();
    const cloudResult: ParsedPdfContent = {
      ...base,
      metadata: { ...base.metadata!, parser: 'mineru-cloud' },
    };
    const assetIdForm = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, data: cloudResult }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const byteForm = vi.fn(async () => {
      throw new Error('byte form must not be used');
    });
    const options: Parameters<typeof fetchExtractionWithCache>[0] = {
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm: assetIdForm, submitByteForm: byteForm },
      logWarning: vi.fn(),
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      kv,
      pool: harness.pool,
      fetchImpl: makeFetch(harness),
      parseFailedMessage: 'parse failed',
    };

    // First import: mineru requested, mineru-cloud ran. Both keys are written
    // (await the detached fire-and-forget write so the records exist below).
    const first = await fetchExtractionWithCache(options);
    expect(first.cacheHit).toBe(false);
    await first.cacheWrite;

    const actualRecord = await kv.get<DerivationRecord>(
      managedKey(DIGEST, 'mineru-cloud', '1'),
      EXTRACTION_CACHE_KV_SCOPE,
    );
    const aliasRecord = await kv.get<DerivationRecord>(
      managedKey(DIGEST, 'mineru', '1'),
      EXTRACTION_CACHE_KV_SCOPE,
    );
    expect(actualRecord).not.toBeNull();
    expect(aliasRecord).not.toBeNull();
    // Same value under both keys (the alias names the same artifact/assets),
    // and the record declares the expected identity as an alias.
    expect(JSON.stringify(aliasRecord)).toBe(JSON.stringify(actualRecord));
    expect(aliasRecord?.aliases).toEqual([{ extractorId: 'mineru', extractorVersion: '1' }]);

    // Second import under the expected key hits — no second extraction.
    const second = await fetchExtractionWithCache(options);
    expect(second.cacheHit).toBe(true);
    expect(second.data).toEqual(cloudResult);
    expect(assetIdForm).toHaveBeenCalledTimes(1);
  });

  it('writes a single entry when the actual extractor matches the expected one (K1 symmetric)', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const assetIdForm = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, data: fixtureResult() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const outcome = await fetchExtractionWithCache({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm: assetIdForm, submitByteForm: assetIdForm },
      logWarning: vi.fn(),
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      kv,
      pool: harness.pool,
      fetchImpl: makeFetch(harness),
      parseFailedMessage: 'parse failed',
    });
    await outcome.cacheWrite;

    expect(kv.storedKeys()).toHaveLength(1);
    expect(kv.storedKeys()[0]).toContain(':mineru@1:');
  });

  it('still returns the extraction result when the cache write fails', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    harness.put.mockRejectedValue(new Error('pool put failed'));
    const assetIdForm = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, data: fixtureResult() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const outcome = await fetchExtractionWithCache({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm: assetIdForm, submitByteForm: assetIdForm },
      logWarning: vi.fn(),
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      kv,
      pool: harness.pool,
      fetchImpl: makeFetch(harness),
      parseFailedMessage: 'parse failed',
    });

    expect(outcome.cacheHit).toBe(false);
    expect(outcome.data).toEqual(fixtureResult());
    // The write fails internally but never fails the result; awaiting the
    // detached write is deterministic because `writeExtractionCache` catches
    // its own failures.
    await outcome.cacheWrite;
    expect(kv.storedKeys()).toEqual([]);
  });

  it('throws the route error string for a non-ok response', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const assetIdForm = vi.fn(async () => {
      return new Response(
        JSON.stringify({ success: false, errorCode: 'PARSE_FAILED', error: 'boom' }),
        {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    await expect(
      fetchExtractionWithCache({
        serverBacked: true,
        hasAssetId: true,
        fetchers: { submitAssetIdForm: assetIdForm, submitByteForm: assetIdForm },
        logWarning: vi.fn(),
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        kv,
        pool: harness.pool,
        parseFailedMessage: 'parse failed',
      }),
    ).rejects.toThrow('boom');
  });

  it('throws the localized fallback for a success without parse data', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const assetIdForm = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(
      fetchExtractionWithCache({
        serverBacked: true,
        hasAssetId: true,
        fetchers: { submitAssetIdForm: assetIdForm, submitByteForm: assetIdForm },
        logWarning: vi.fn(),
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        kv,
        pool: harness.pool,
        parseFailedMessage: 'parse failed',
      }),
    ).rejects.toThrow('parse failed');
  });

  it('throws the localized fallback for a non-JSON error body (proxy error page), not a SyntaxError', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const assetIdForm = vi.fn(async () => {
      return new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      });
    });

    await expect(
      fetchExtractionWithCache({
        serverBacked: true,
        hasAssetId: true,
        fetchers: { submitAssetIdForm: assetIdForm, submitByteForm: assetIdForm },
        logWarning: vi.fn(),
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        kv,
        pool: harness.pool,
        parseFailedMessage: 'parse failed',
      }),
    ).rejects.toThrow('parse failed');
  });

  it('throws the localized fallback for a non-JSON success body, not a SyntaxError', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const assetIdForm = vi.fn(async () => {
      return new Response('not json at all', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    });

    await expect(
      fetchExtractionWithCache({
        serverBacked: true,
        hasAssetId: true,
        fetchers: { submitAssetIdForm: assetIdForm, submitByteForm: assetIdForm },
        logWarning: vi.fn(),
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        kv,
        pool: harness.pool,
        parseFailedMessage: 'parse failed',
      }),
    ).rejects.toThrow('parse failed');
  });

  it('runs the real extraction without caching when no KV store is available', async () => {
    // No `kv` (and no injectable singleton in the Node test environment): the
    // KV resolution fails, which must disable caching only — the extraction
    // still runs and its result still returns.
    const harness = makePool();
    const assetIdForm = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, data: fixtureResult() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const outcome = await fetchExtractionWithCache({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm: assetIdForm, submitByteForm: assetIdForm },
      logWarning: vi.fn(),
      contentDigest: DIGEST,
      domain: 'doc',
      extractorId: 'mineru',
      extractorVersion: '1',
      pool: harness.pool,
      parseFailedMessage: 'parse failed',
    });

    expect(outcome.cacheHit).toBe(false);
    expect(outcome.data).toEqual(fixtureResult());
    expect(assetIdForm).toHaveBeenCalledTimes(1);
  });

  it('runs the real extraction when the config-fingerprint computation throws (M1)', async () => {
    // The lookup's fingerprint computation throws (first digest call), so the
    // lookup degrades to a miss and the real extraction runs. The write's own
    // fingerprint call (second digest call) succeeds, so the successful result
    // is cached — the fingerprint failure cost only the optimization, never
    // the user's extraction.
    const digestSpy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockRejectedValueOnce(new Error('Web Crypto unavailable'));
    const kv = new FakeKV();
    const harness = makePool();
    const assetIdForm = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, data: fixtureResult() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      const outcome = await fetchExtractionWithCache({
        serverBacked: true,
        hasAssetId: true,
        fetchers: { submitAssetIdForm: assetIdForm, submitByteForm: assetIdForm },
        logWarning: vi.fn(),
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        kv,
        pool: harness.pool,
        fetchImpl: makeFetch(harness),
        parseFailedMessage: 'parse failed',
      });

      expect(outcome.cacheHit).toBe(false);
      expect(outcome.data).toEqual(fixtureResult());
      expect(assetIdForm).toHaveBeenCalledTimes(1);
      await outcome.cacheWrite;
      // The write's own fingerprint (second digest call) succeeded: the
      // derivation was cached, proving the lookup failure did not propagate.
      await expect(
        kv.get(managedKey(DIGEST, 'mineru', '1'), EXTRACTION_CACHE_KV_SCOPE),
      ).resolves.not.toBeNull();
    } finally {
      digestSpy.mockRestore();
    }
  });
});

describe('createExtractionDeduplicator', () => {
  it('shares ONE extraction across same-digest, same-extractor sources (K3)', async () => {
    const deduplicator = createExtractionDeduplicator();
    const extraction = vi.fn(async () => fixtureResult());
    const key: InRunExtractionKey = {
      contentDigest: DIGEST,
      domain: 'doc',
      configFingerprint: MANAGED_FP,
      extractorId: 'mineru',
      extractorVersion: '1',
    };

    const [first, second] = await Promise.all([
      deduplicator.run(key, extraction),
      deduplicator.run(key, extraction),
    ]);

    expect(extraction).toHaveBeenCalledTimes(1);
    expect(first).toEqual(fixtureResult());
    expect(second).toEqual(fixtureResult());
  });

  it('does not share extractions across different expected extractors (K3)', async () => {
    const deduplicator = createExtractionDeduplicator();
    const mineru = vi.fn(async () => fixtureResult());
    const unpdf = vi.fn(async () => fixtureResult());

    await Promise.all([
      deduplicator.run(
        {
          contentDigest: DIGEST,
          domain: 'doc',
          configFingerprint: MANAGED_FP,
          extractorId: 'mineru',
          extractorVersion: '1',
        },
        mineru,
      ),
      deduplicator.run(
        {
          contentDigest: DIGEST,
          domain: 'doc',
          configFingerprint: MANAGED_FP,
          extractorId: 'unpdf',
          extractorVersion: '1',
        },
        unpdf,
      ),
    ]);

    expect(mineru).toHaveBeenCalledTimes(1);
    expect(unpdf).toHaveBeenCalledTimes(1);
  });

  it('does not share extractions across different config fingerprints (L3)', async () => {
    const deduplicator = createExtractionDeduplicator();
    const extraction = vi.fn(async () => fixtureResult());
    const fpA = await computeConfigFingerprint('https://a.example');
    const fpB = await computeConfigFingerprint('https://b.example');

    // Same digest + same extractor, but different per-source endpoints: the
    // dedupe identity is the cache identity, so these are two derivations.
    await Promise.all([
      deduplicator.run(
        {
          contentDigest: DIGEST,
          domain: 'doc',
          extractorId: 'mineru',
          extractorVersion: '1',
          configFingerprint: fpA,
        },
        extraction,
      ),
      deduplicator.run(
        {
          contentDigest: DIGEST,
          domain: 'doc',
          extractorId: 'mineru',
          extractorVersion: '1',
          configFingerprint: fpB,
        },
        extraction,
      ),
    ]);

    expect(extraction).toHaveBeenCalledTimes(2);
  });

  it('does not share extractions across document and media domains (L6)', async () => {
    const deduplicator = createExtractionDeduplicator();
    const extraction = vi.fn(async () => fixtureResult());

    await Promise.all([
      deduplicator.run(
        {
          contentDigest: DIGEST,
          domain: 'doc',
          extractorId: 'alidocmind',
          extractorVersion: '1',
          configFingerprint: MANAGED_FP,
        },
        extraction,
      ),
      deduplicator.run(
        {
          contentDigest: DIGEST,
          domain: 'media',
          extractorId: 'alidocmind',
          extractorVersion: '1',
          configFingerprint: MANAGED_FP,
        },
        extraction,
      ),
    ]);

    expect(extraction).toHaveBeenCalledTimes(2);
  });

  it('clears the memo on a rejected extraction so a later retry re-invokes (L3)', async () => {
    const deduplicator = createExtractionDeduplicator();
    const key = {
      contentDigest: DIGEST,
      domain: 'doc' as const,
      extractorId: 'mineru',
      extractorVersion: '1',
      configFingerprint: MANAGED_FP,
    };
    const extraction = vi
      .fn()
      .mockRejectedValueOnce(new Error('first attempt failed'))
      .mockResolvedValueOnce(fixtureResult());

    await expect(deduplicator.run(key, extraction)).rejects.toThrow('first attempt failed');
    // The memo entry was dropped on rejection: the same key re-invokes instead
    // of re-receiving the stale rejection.
    await expect(deduplicator.run(key, extraction)).resolves.toEqual(fixtureResult());
    expect(extraction).toHaveBeenCalledTimes(2);
  });
});

describe('degradation on a route-level KV failure (K5)', () => {
  afterEach(() => {
    resetExtractionCacheForTests();
  });

  function makeOptions(
    kv: KVStore,
    harness: FakePoolHarness,
  ): {
    options: Parameters<typeof fetchExtractionWithCache>[0];
    assetIdForm: ReturnType<typeof vi.fn>;
  } {
    const assetIdForm = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, data: fixtureResult() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return {
      options: {
        serverBacked: true,
        hasAssetId: true,
        fetchers: { submitAssetIdForm: assetIdForm, submitByteForm: assetIdForm },
        logWarning: vi.fn(),
        contentDigest: DIGEST,
        domain: 'doc',
        extractorId: 'mineru',
        extractorVersion: '1',
        kv,
        pool: harness.pool,
        fetchImpl: makeFetch(harness),
        parseFailedMessage: 'parse failed',
      },
      assetIdForm,
    };
  }

  it('disables caching for a bounded window after the first route-level 404, without ingest churn (K5)', async () => {
    const kv = new FakeKV();
    // A 404 that is NOT the store's legitimate key-not-found miss: the KV route
    // itself is gone (as with NEXT_PUBLIC_PERSISTENCE=1 today).
    vi.spyOn(kv, 'get').mockRejectedValue(
      new HttpKVStoreError(404, 'HTTP_ERROR', 'kv route not found'),
    );
    const harness = makePool();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { options, assetIdForm } = makeOptions(kv, harness);

    // Source 1: the first route-level 404 disables the cache (ONE warn total).
    const first = await fetchExtractionWithCache(options);
    await first.cacheWrite;
    // Source 2: the disabled cache is skipped entirely — no lookup, no ingest,
    // no further warn.
    const second = await fetchExtractionWithCache(options);
    await second.cacheWrite;

    expect(assetIdForm).toHaveBeenCalledTimes(2);
    expect(kv.get).toHaveBeenCalledTimes(1);
    // No record was ever written (the write path was skipped entirely).
    expect(kv.storedKeys()).toEqual([]);
    // No putAsset-then-removeAsset churn per extraction on the write path.
    expect(harness.put).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
    // Exactly ONE warn for the disable episode, never one per source.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('re-probes the KV route once the disable window expires (L4)', async () => {
    vi.useFakeTimers();
    try {
      const kv = new FakeKV();
      const getSpy = vi
        .spyOn(kv, 'get')
        .mockRejectedValue(new HttpKVStoreError(404, 'HTTP_ERROR', 'kv route not found'));
      const harness = makePool();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { options } = makeOptions(kv, harness);

      // First probe: the route-level 404 disables the cache for one window.
      const first = await fetchExtractionWithCache(options);
      await first.cacheWrite;
      // Inside the window: no further lookup touches the store.
      const second = await fetchExtractionWithCache(options);
      await second.cacheWrite;
      expect(getSpy).toHaveBeenCalledTimes(1);

      // The window expires: the next operation probes the KV route again.
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      const third = await fetchExtractionWithCache(options);
      await third.cacheWrite;

      expect(getSpy).toHaveBeenCalledTimes(2);
      // A second disable episode logs its own single warn.
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables the cache for a route-level 404 on the WRITE side too (K5)', async () => {
    const kv = new FakeKV();
    // Lookup and the pre-write re-read succeed (a normal miss); the KV record
    // write itself answers a route-level 404 — the write side must disable the
    // cache exactly like the lookup side.
    vi.spyOn(kv, 'get').mockResolvedValue(null);
    const setSpy = vi
      .spyOn(kv, 'set')
      .mockRejectedValue(new HttpKVStoreError(404, 'HTTP_ERROR', 'kv route not found'));
    const harness = makePool();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { options, assetIdForm } = makeOptions(kv, harness);

    // Source 1: the write hits the route-level 404 and disables the cache.
    const first = await fetchExtractionWithCache(options);
    expect(first.cacheHit).toBe(false);
    await first.cacheWrite;
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // The disabled write released the assets it allocated before failing.
    expect(harness.remove).toHaveBeenCalled();

    // Source 2: the disabled cache is skipped entirely — no lookup, no write.
    const second = await fetchExtractionWithCache(options);
    await second.cacheWrite;
    expect(assetIdForm).toHaveBeenCalledTimes(2);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps per-op behavior for a transient (non-404) failure without disabling the cache (K5)', async () => {
    const kv = new FakeKV();
    vi.spyOn(kv, 'get').mockRejectedValue(new Error('network blip'));
    const harness = makePool();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { options } = makeOptions(kv, harness);

    const first = await fetchExtractionWithCache(options);
    await first.cacheWrite;
    const second = await fetchExtractionWithCache(options);
    await second.cacheWrite;

    // The cache is NOT disabled: each source still attempts the lookup (one
    // per-op warn per lookup) and the write path still runs (pre-write re-get
    // included) — transient errors keep the current per-op behavior.
    expect(kv.get).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(harness.put).toHaveBeenCalled();
    warn.mockRestore();
  });
});
