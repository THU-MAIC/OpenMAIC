import { describe, expect, it, vi } from 'vitest';

import type { AssetMeta, BinaryBlob } from '@openmaic/dsl';
import type { KVStore, KVScope } from '@openmaic/storage';

import {
  computeContentDigest,
  EXTRACTION_CACHE_KV_SCOPE,
  extractionCacheKey,
  fetchExtractionWithCache,
  lookupCachedExtraction,
  resolveExpectedExtractor,
  writeExtractionCache,
} from '@/lib/document/extraction-cache';
import type { ExtractSourceFetchers } from '@/lib/document/extract-source';
import type { AssetPoolStore } from '@/lib/media/asset-pool-config';
import type { ParsedPdfContent } from '@/lib/types/pdf';

const PNG_1 = 'data:image/png;base64,AQID';
const PNG_2 = 'data:image/png;base64,BAUG';

/** A document-extraction result in the exact shape the route returns today. */
function fixtureResult(): ParsedPdfContent {
  return {
    text: '# Safety Checklist\n\nInspect the device before calibration.',
    images: [PNG_1, PNG_2],
    metadata: {
      pageCount: 2,
      parser: 'mineru',
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
  const pool: AssetPoolStore = {
    put: put as AssetPoolStore['put'],
    resolve: resolve as AssetPoolStore['resolve'],
    invalidate: vi.fn(async () => undefined),
    remove: remove as AssetPoolStore['remove'],
    replace: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return { pool, blobs, put, resolve, remove };
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
  it('includes the content digest and the extractor id and version', () => {
    const key = extractionCacheKey(DIGEST, 'mineru', '1');

    expect(key).toBe(`derived-extraction:v1:${DIGEST}:mineru@1`);
    expect(key).toContain(DIGEST);
    expect(key).toContain('mineru');
    expect(key).toContain('@1');
  });

  it('produces a different key when the extractor version bumps', () => {
    const v1 = extractionCacheKey(DIGEST, 'mineru', '1');
    const v2 = extractionCacheKey(DIGEST, 'mineru', '2');

    expect(v1).not.toBe(v2);
  });

  it('produces a different key for a different extractor', () => {
    expect(extractionCacheKey(DIGEST, 'unpdf', '1')).not.toBe(
      extractionCacheKey(DIGEST, 'mineru', '1'),
    );
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
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: fixtureResult(),
    });

    const key = extractionCacheKey(DIGEST, 'mineru', '1');
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
        extractorId: 'mineru',
        extractorVersion: '1',
        sourceDocAssetId: 'ast_source_doc',
        result: fixtureResult(),
      }),
    ).resolves.toBeUndefined();

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
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: original,
    });

    const rebuilt = await lookupCachedExtraction({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
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

  it('reports a miss when no record exists', async () => {
    const kv = new FakeKV();
    const harness = makePool();

    await expect(
      lookupCachedExtraction({
        kv,
        pool: harness.pool,
        contentDigest: DIGEST,
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
      extractorId: 'mineru',
      extractorVersion: '1',
      sourceDocAssetId: 'ast_source_doc',
      result: fixtureResult(),
    });
    // Simulate a partially reclaimed cache: the artifact bytes are gone.
    const record = await kv.get<{ artifactAssetId: string }>(
      extractionCacheKey(DIGEST, 'mineru', '1'),
    );
    harness.blobs.delete(record!.artifactAssetId);

    await expect(
      lookupCachedExtraction({
        kv,
        pool: harness.pool,
        contentDigest: DIGEST,
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
      metadata: { pageCount: 1, parser: 'unpdf' },
    };
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      extractorId: 'unpdf',
      extractorVersion: '1',
      result: imagesOnly,
    });

    const rebuilt = await lookupCachedExtraction({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      extractorId: 'unpdf',
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
    });

    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.text).toBe('Plain text');
    expect(rebuilt?.images).toEqual([PNG_1]);
    expect(rebuilt?.metadata?.pdfImages).toEqual([{ id: 'img_1', src: PNG_1, pageNumber: 1 }]);
  });

  it('round-trips a media-shaped result (no images) verbatim', async () => {
    const kv = new FakeKV();
    const harness = makePool();
    const media: ParsedPdfContent = {
      text: '## Transcript\n\n[00:01] Hello world',
      images: [],
      metadata: { pageCount: 0, parser: 'alidocmind' },
    };
    await writeExtractionCache({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      extractorId: 'alidocmind',
      extractorVersion: '1',
      result: media,
    });

    const rebuilt = await lookupCachedExtraction({
      kv,
      pool: harness.pool,
      contentDigest: DIGEST,
      extractorId: 'alidocmind',
      extractorVersion: '1',
      fetchImpl: makeFetch(harness),
    });

    expect(rebuilt).toEqual(media);
    // No images were ingested for a media artifact.
    expect(harness.remove).not.toHaveBeenCalled();
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
    // The successful extraction was cached best-effort.
    await expect(
      kv.get(extractionCacheKey(DIGEST, 'mineru', '1'), EXTRACTION_CACHE_KV_SCOPE),
    ).resolves.not.toBeNull();
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
      extractorId: 'mineru',
      extractorVersion: '1',
      pool: harness.pool,
      parseFailedMessage: 'parse failed',
    });

    expect(outcome.cacheHit).toBe(false);
    expect(outcome.data).toEqual(fixtureResult());
    expect(assetIdForm).toHaveBeenCalledTimes(1);
  });
});
