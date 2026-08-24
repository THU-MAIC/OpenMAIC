/**
 * Extraction derivation cache (RFC #1153 part 1).
 *
 * Extraction is treated as a pure derivation of (source bytes, extractor,
 * extractor version). After a successful document/media extraction the
 * structured artifact is stored in the asset pool as its own
 * `application/json` asset — inline image data stripped, each image's pool
 * asset id recorded in its place — and a single KV record per
 * (content digest, extractor identity, caller-supplied endpoint fingerprint)
 * indexes it: lineage and cache index in one entry. Re-importing the same
 * bytes (same or another course) then hits the cache instead of re-running the
 * paid extraction, provided the digest, the extractor id, the extractor
 * version AND the config fingerprint all match — a version bump is a miss that
 * re-derives, and so is a caller-supplied endpoint change (the residual
 * staleness that stays ACCEPTED is documented at `extractionCacheKey`).
 *
 * Both halves are strictly best-effort from the caller's point of view:
 *
 * - A lookup that fails for any reason (no record, unresolvable artifact or
 *   image asset, unreadable bytes, a KV/pool transport error) degrades to a
 *   cache miss, so the real extraction always runs. A hit is logged so the
 *   cache is observable.
 * - A write that fails at any step is logged and abandoned WITHOUT failing
 *   the caller's extraction, and every asset allocated in the partial attempt
 *   is released. The KV record is written LAST, only once every asset it
 *   names exists, so a partial attempt never leaves a record pointing at
 *   assets that failed to ingest.
 */
import type { AssetMeta } from '@openmaic/dsl';
import { BrowserKVStore, HttpKVStore, HttpKVStoreError, type KVStore } from '@openmaic/storage';

import type { FetchExtractionResponseOptions } from '@/lib/document/extract-source';
import { fetchExtractionResponse } from '@/lib/document/extract-source';
import {
  getDocumentExtractorProvider,
  selectDocumentExtractorProvider,
} from '@/lib/document/extractors/registry';
import {
  getMediaExtractorProvider,
  selectMediaExtractorProvider,
} from '@/lib/document/extractors/media-registry';
import { SUPPORTED_MEDIA_MIME_TYPES } from '@/lib/document/mime';
import type { MediaExtractorProviderId } from '@/lib/document/types';
import { createLogger } from '@/lib/logger';
import { putAsset, removeAsset } from '@/lib/media/asset-pool';
import type { AssetPoolStore } from '@/lib/media/asset-pool-config';
import { withAssetUrl } from '@/lib/media/use-asset-url';
import {
  getPersistenceRequestHeaders,
  isBrowserPersistenceEnabled,
} from '@/lib/persistence/bootstrap';
import type { ParsedPdfContent } from '@/lib/types/pdf';

const log = createLogger('ExtractionCache');

/** Key-prefix of every derivation record; bump the `v2` on a record-shape change. */
export const EXTRACTION_CACHE_KEY_PREFIX = 'derived-extraction:v2';

/**
 * KV scope the derivation records live under. `account` is the right scope
 * for both backends: browser-backed it is local like everything else, and
 * server-backed it syncs across devices — where the artifact assets also live
 * (in the server-backed pool), so another device hits the same cache instead
 * of re-paying for extraction.
 */
export const EXTRACTION_CACHE_KV_SCOPE = 'account' as const;

/** One extracted image's pool asset plus its lineage metadata. */
export interface DerivedExtractionImage {
  /** Image id as the extraction produced it (e.g. `img_1`). */
  id: string;
  /** Pool asset id of the image bytes. */
  assetId: string;
  /** Page number in the source document, when the extractor reports one. */
  pageNumber?: number;
  description?: string;
  width?: number;
  height?: number;
  mimeType?: string;
}

/**
 * One derivation record = lineage + cache index, stored as a single KV entry
 * per (content digest, extractor identity).
 *
 * Constraint for the future KV server backend (upstream #1000 part B): the KV
 * and asset namespaces must be scoped per principal (the learner key), and a
 * record must only reference assets its own principal wrote — otherwise a
 * shared namespace turns one caller's write into another's trusted extraction.
 */
export interface DerivationRecord {
  /** Source-document pool asset id whose extraction produced this derivation. */
  sourceDocAssetId?: string;
  extractorId: string;
  extractorVersion: string;
  /**
   * Extractor identities the lookup may legitimately use for this record
   * besides `extractorId`. Set when the extractor that ACTUALLY ran differed
   * from the one the lookup expected (e.g. self-host MinerU fell back to MinerU
   * Cloud): the same record value is then stored under the expected key too, as
   * an alias naming the same artifact/image assets (RFC #1153 part 1, K1).
   */
  aliases?: Array<{ extractorId: string; extractorVersion: string }>;
  /** Pool asset id of the stored artifact JSON (inline image data stripped). */
  artifactAssetId: string;
  images: DerivedExtractionImage[];
  createdAt: string;
}

/**
 * The exact cache key: content identity (stable across uploads of the same
 * bytes) × extractor identity (id and version, so a version bump is a miss) ×
 * config fingerprint (see `computeConfigFingerprint`), so a caller-supplied
 * endpoint change misses instead of serving the old engine's output.
 *
 * Residual staleness that stays ACCEPTED: an engine upgraded in place behind
 * the same endpoint, or an account change on the same endpoint — the extractor
 * `version` field is the governance lever for in-repo providers, and part 2's
 * material library brings manual eviction (RFC #1153 part 2).
 */
export function extractionCacheKey(
  contentDigest: string,
  extractorId: string,
  extractorVersion: string,
  configFingerprint: string,
): string {
  return `${EXTRACTION_CACHE_KEY_PREFIX}:${contentDigest}:${extractorId}@${extractorVersion}:cfg-${configFingerprint}`;
}

/**
 * The config half of the cache key: `sha256(baseUrl ?? 'managed')` truncated
 * to 8 hex chars. Providers whose output depends on a caller-supplied endpoint
 * fingerprint that endpoint, so pointing it at a different engine misses;
 * in-repo providers (unpdf, plain-text) and managed/endpoint-less providers
 * share the constant `'managed'` bucket and keep stable keys.
 */
export async function computeConfigFingerprint(baseUrl?: string): Promise<string> {
  const input = baseUrl ?? 'managed';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8);
}

/**
 * SHA-256 of the file bytes as a lowercase hex string (Web Crypto). Two
 * uploads of the same bytes produce the same digest; different bytes differ.
 */
export async function computeContentDigest(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The extractor identity the cache is keyed under. */
export interface ExpectedExtractor {
  extractorId: string;
  extractorVersion: string;
}

/**
 * Resolve the extractor identity the extraction is expected to run under, for
 * the cache lookup that happens BEFORE the extract API is called.
 *
 * Mirrors the extract route's own selection: a requested provider that cannot
 * handle the MIME is dropped and the registry auto-selects a compatible one.
 * Returns `null` when no extractor can be resolved (an unsupported MIME), in
 * which case the caller skips the cache entirely. If the route ultimately
 * auto-selects a different provider (e.g. self-hosted MinerU falling back to
 * MinerU Cloud), the lookup misses conservatively — correctness is preserved
 * and only the optimization is lost.
 */
export function resolveExpectedExtractor(
  mimeType: string,
  requestedProviderId?: string,
): ExpectedExtractor | null {
  try {
    const normalizedMimeType = mimeType.toLowerCase();
    if (SUPPORTED_MEDIA_MIME_TYPES.includes(normalizedMimeType)) {
      const requested = requestedProviderId
        ? getMediaExtractorProvider(requestedProviderId as MediaExtractorProviderId)
        : undefined;
      const provider =
        requested && requested.supportedMimeTypes.includes(normalizedMimeType)
          ? requested
          : selectMediaExtractorProvider({
              mimeType: normalizedMimeType,
              requiredCapabilities: { transcript: true },
            });
      return { extractorId: provider.id, extractorVersion: provider.version };
    }
    const requested = requestedProviderId
      ? getDocumentExtractorProvider(requestedProviderId)
      : undefined;
    const provider =
      requested && requested.supportedMimeTypes.includes(normalizedMimeType)
        ? requested
        : selectDocumentExtractorProvider({
            mimeType: normalizedMimeType,
            requiredCapabilities: { text: true },
          });
    return { extractorId: provider.id, extractorVersion: provider.version };
  } catch {
    return null;
  }
}

/** The declared version of a provider, from whichever registry holds it. */
export function extractorVersionFor(providerId: string): string | undefined {
  return (
    getDocumentExtractorProvider(providerId)?.version ??
    getMediaExtractorProvider(providerId as MediaExtractorProviderId)?.version
  );
}

// ─── KV wiring ────────────────────────────────────────────────────────────────

let cacheKv: KVStore | undefined;

/**
 * The browser-wide KV store for the extraction cache. Wired exactly like the
 * asset pool: browser-backed by default, and server-backed under the same
 * persistence bootstrap flag (`NEXT_PUBLIC_PERSISTENCE=1`), where the account
 * scope is served by the persistence API and the device scope stays on a
 * local store. Every cache operation is defensive against this store
 * failing, so an unavailable backend only costs the optimization, never the
 * user's extraction.
 */
export function getExtractionCacheKV(): KVStore {
  return (cacheKv ??= resolveConfiguredExtractionCacheKV());
}

function resolveConfiguredExtractionCacheKV(): KVStore {
  if (isBrowserPersistenceEnabled()) {
    return new HttpKVStore({
      baseUrl: '/api/persistence',
      headers: () => getPersistenceRequestHeaders(),
      deviceStore: new BrowserKVStore(),
    });
  }
  if (typeof window === 'undefined') {
    throw new Error('The extraction cache KV store requires browser storage.');
  }
  return new BrowserKVStore();
}

// ─── Session-wide degradation (RFC #1153 part 1, K5) ─────────────────────────

/**
 * Whether the cache is disabled for the rest of the session. Set once when the
 * KV backend answers with a route-level failure (the KV route itself is gone,
 * as with `NEXT_PUBLIC_PERSISTENCE=1` today): from then on every lookup is a
 * miss and every write is skipped WITHOUT ingesting assets, so the degradation
 * is quiet (one warn total) and cheap (no putAsset-then-removeAsset churn per
 * extraction). Transient failures (network blips) keep the per-op behavior.
 */
let cacheDisabledForSession = false;

/**
 * A route-level KV failure: an HTTP 404 that is NOT the store's legitimate
 * "key not found" miss (which `HttpKVStore.get` maps to `null`). Such a 404
 * means the KV route itself is unreachable, so no per-key retry can help.
 */
function isRouteLevelKVError(error: unknown): boolean {
  return (
    error instanceof HttpKVStoreError && error.status === 404 && error.code !== 'KEY_NOT_FOUND'
  );
}

/** Disable the cache for the session, logging exactly ONE warn (the first). */
function disableCacheForSession(error: unknown): void {
  if (cacheDisabledForSession) return;
  cacheDisabledForSession = true;
  log.warn(
    'The extraction cache KV route is unreachable; disabling the extraction cache for this session:',
    error,
  );
}

/** Test-only: clear the session-wide disable flag between tests. */
export function resetExtractionCacheForTests(): void {
  cacheDisabledForSession = false;
}

/** Best-effort release of every asset a partial attempt allocated, logging rejected outcomes. */
async function releaseAllocatedAssets(
  allocated: readonly string[],
  remove: (assetId: string) => Promise<void>,
  context: string,
): Promise<void> {
  const outcomes = await Promise.allSettled(allocated.map((assetId) => remove(assetId)));
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    if (outcome.status === 'rejected') {
      log.warn(
        `Failed to release extraction-cache asset "${allocated[index]}" (${context}):`,
        outcome.reason,
      );
    }
  }
}

// ─── Data URL helpers (environment-agnostic: no DOM FileReader) ───────────────

function dataUrlMimeType(src: string): string | undefined {
  const match = /^data:([^;,]*)/.exec(src);
  return match?.[1] || undefined;
}

/** Decode a base64 data URL into a Blob, or `null` when it is not one. */
function dataUrlToBlob(src: string): Blob | null {
  const match = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(src);
  if (!match || match[2] !== ';base64') return null;
  const mimeType = match[1] || 'application/octet-stream';
  try {
    const binary = atob(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ─── Artifact JSON shape ──────────────────────────────────────────────────────

/** An image inside the stored artifact: the inline data URL replaced by its pool asset id. */
interface StoredPdfImage {
  id: string;
  assetId: string;
  pageNumber: number;
  description?: string;
  width?: number;
  height?: number;
}

/**
 * The artifact as stored in the pool: the parse result the page consumes,
 * with every inline data URL stripped and the image's pool asset id recorded
 * in its place (the bytes are recoverable from the pool; storing base64 twice
 * is waste). Media artifacts carry no image bytes at all — the transcript and
 * keyframe descriptions are text inside `text` — so they are stored verbatim.
 */
interface StoredExtractionArtifact {
  text: string;
  /** Pool asset ids in the same order as the original data-URL array. */
  images: string[];
  tables?: ParsedPdfContent['tables'];
  formulas?: ParsedPdfContent['formulas'];
  layout?: ParsedPdfContent['layout'];
  metadata: {
    fileName?: string;
    fileSize?: number;
    pageCount?: number;
    parser?: string;
    processingTime?: number;
    taskId?: string;
    imageMapping?: Record<string, string>;
    pdfImages?: StoredPdfImage[];
    [key: string]: unknown;
  };
}

/** Copy a record minus the named keys (the stored artifact's metadata shape). */
function omitKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): StoredExtractionArtifact['metadata'] {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(key)) continue;
    out[key] = value;
  }
  return out as StoredExtractionArtifact['metadata'];
}

// ─── Cache write ──────────────────────────────────────────────────────────────

export interface ExtractionCacheWriteOptions {
  kv: KVStore;
  /**
   * Pool to ingest into. Omitted in production, where the browser-wide pool
   * is used through the `putAsset` / `removeAsset` seams; injectable so tests
   * can drive a fake pool.
   */
  pool?: AssetPoolStore;
  /** Content identity of the source bytes (the cache key's stable half). */
  contentDigest: string;
  /** The extractor identity that ACTUALLY ran (route-reported, when known). */
  extractorId: string;
  extractorVersion: string;
  /** Caller-supplied endpoint the provider ran against; fingerprints the key. */
  baseUrl?: string;
  /**
   * When the extractor that ACTUALLY ran differs from the one the lookup used,
   * also store the SAME record value under this expected identity — an alias
   * naming the same artifact/image assets, so the next lookup under the
   * expected key hits (RFC #1153 part 1, K1).
   */
  aliasExtractor?: { extractorId: string; extractorVersion: string };
  /** Source-document pool asset id, for lineage. */
  sourceDocAssetId?: string;
  /** The parse result the page consumes, exactly as a real extraction returns. */
  result: ParsedPdfContent;
}

/**
 * Best-effort cache write: ingest images → store artifact → write KV record,
 * in that order. Any failure logs and abandons the write WITHOUT failing the
 * caller's extraction, and releases every asset allocated in the partial
 * attempt. The KV record is deliberately written last, so a partial attempt
 * never leaves a record pointing at assets that failed to ingest. A route-level
 * KV failure disables the cache for the rest of the session (K5) — subsequent
 * writes are skipped BEFORE any asset is ingested, so a dead KV route costs no
 * putAsset-then-removeAsset churn.
 */
export async function writeExtractionCache(options: ExtractionCacheWriteOptions): Promise<void> {
  // K5: the KV route is unreachable for this session; skip the write entirely
  // BEFORE ingesting anything, so a dead backend costs no pool churn.
  if (cacheDisabledForSession) return;

  const allocated: string[] = [];
  // Production ingests through the browser-wide pool seams; tests inject a
  // fake pool. Injected or not, both surfaces share the same store.
  const put = (data: Blob, meta?: AssetMeta): Promise<string> =>
    options.pool ? options.pool.put(data, meta) : putAsset(data, meta);
  const remove = (assetId: string): Promise<void> =>
    options.pool ? options.pool.remove(assetId) : removeAsset(assetId);
  try {
    // 1. Ingest every extracted image as its own pool asset, recording the
    //    lineage metadata (source page, description, dimensions) next to it.
    const images: DerivedExtractionImage[] = [];
    for (const image of extractImagesFromResult(options.result)) {
      const blob = dataUrlToBlob(image.src);
      if (!blob) {
        throw new Error(
          `Extraction image "${image.id}" is not a base64 data URL; abandoning the cache write.`,
        );
      }
      const assetId = await put(blob, image.mimeType ? { contentType: image.mimeType } : undefined);
      allocated.push(assetId);
      images.push({
        id: image.id,
        assetId,
        ...(image.pageNumber !== undefined ? { pageNumber: image.pageNumber } : {}),
        ...(image.description !== undefined ? { description: image.description } : {}),
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {}),
        ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
      });
    }

    // 2. Store the artifact JSON as its own pool asset, inline data stripped.
    const artifact = stripInlineImages(options.result, images);
    const artifactAssetId = await put(
      new Blob([JSON.stringify(artifact)], { type: 'application/json' }),
      { contentType: 'application/json' },
    );
    allocated.push(artifactAssetId);

    // 3. Write the KV record LAST, only once every asset it names exists.
    //
    // Derivation records and derived assets are cache-owned: removing a course
    // material releases only its own source-doc entry (removeCourseMaterial)
    // and never cascades into this cache. Eviction and management of derived
    // entries belong to the material library milestone (RFC #1153 part 2).
    const configFingerprint = await computeConfigFingerprint(options.baseUrl);
    const key = extractionCacheKey(
      options.contentDigest,
      options.extractorId,
      options.extractorVersion,
      configFingerprint,
    );
    const aliasIdentity = options.aliasExtractor ? [{ ...options.aliasExtractor }] : undefined;
    const aliasKey = options.aliasExtractor
      ? extractionCacheKey(
          options.contentDigest,
          options.aliasExtractor.extractorId,
          options.aliasExtractor.extractorVersion,
          configFingerprint,
        )
      : undefined;

    // K3 (cross-tab): another tab may have written this derivation while this
    // attempt allocated its assets. Re-read the key before writing; a valid
    // record already present means this attempt is the loser — release every
    // asset IT allocated and adopt the existing record. The get→set race window
    // that remains is milliseconds; if it fires, the loser's assets orphan —
    // accepted: eviction is part 2's material library, and the orphan is
    // indistinguishable from any other never-referenced pool asset until then.
    const existing = await options.kv.get<DerivationRecord>(key, EXTRACTION_CACHE_KV_SCOPE);
    if (existing && isValidDerivationRecord(existing)) {
      if (aliasKey && aliasIdentity) {
        await writeAliasRecord(options.kv, aliasKey, aliasIdentity[0], existing);
      }
      await releaseAllocatedAssets(allocated, remove, 'superseded by an existing record');
      log.info(
        `Extraction cache write for ${key} abandoned: an existing derivation record was adopted; ` +
          `${allocated.length} asset(s) allocated by this attempt were released.`,
      );
      return;
    }

    const record: DerivationRecord = {
      ...(options.sourceDocAssetId !== undefined
        ? { sourceDocAssetId: options.sourceDocAssetId }
        : {}),
      extractorId: options.extractorId,
      extractorVersion: options.extractorVersion,
      ...(aliasIdentity ? { aliases: aliasIdentity } : {}),
      artifactAssetId,
      images,
      createdAt: new Date().toISOString(),
    };
    await options.kv.set(key, record, EXTRACTION_CACHE_KV_SCOPE);
    // K1: the expected key is an alias naming the same artifact/image assets,
    // so the next lookup under it hits. Best-effort and isolated on purpose:
    // the primary record already references these assets, so an alias-write
    // failure must NOT release them (that would orphan the primary record).
    if (aliasKey && aliasIdentity) {
      await writeAliasRecord(options.kv, aliasKey, aliasIdentity[0], record);
    }
  } catch (error) {
    if (isRouteLevelKVError(error)) {
      // The KV route itself is gone (K5): disable caching for the session and
      // log one warn; future writes are skipped before any ingest.
      disableCacheForSession(error);
    } else {
      log.error(
        'Failed to cache the extraction derivation; the extraction result is still returned:',
        error,
      );
    }
    // Release every asset allocated in this partial attempt so the pool does
    // not accumulate orphans. The KV record was only written last, so nothing
    // references the released ids.
    await releaseAllocatedAssets(allocated, remove, 'a failed cache write');
  }
}

/**
 * Best-effort K1 alias write: store the record under the alias (expected) key.
 * Ensures the record declares the alias identity so a lookup under the alias
 * validates; a failure is logged and does NOT release assets — the primary
 * record already references them.
 */
async function writeAliasRecord(
  kv: KVStore,
  aliasKey: string,
  aliasIdentity: { extractorId: string; extractorVersion: string },
  record: DerivationRecord,
): Promise<void> {
  try {
    const aliases = record.aliases ?? [];
    const alreadyDeclared = aliases.some(
      (alias) =>
        alias.extractorId === aliasIdentity.extractorId &&
        alias.extractorVersion === aliasIdentity.extractorVersion,
    );
    const aliasRecord = alreadyDeclared
      ? record
      : { ...record, aliases: [...aliases, aliasIdentity] };
    await kv.set(aliasKey, aliasRecord, EXTRACTION_CACHE_KV_SCOPE);
  } catch (error) {
    log.warn(`Failed to write the extraction-cache alias record under "${aliasKey}":`, error);
  }
}

/** The images a parse result carries, in the page's own consumption order. */
interface ResultImage {
  id: string;
  src: string;
  pageNumber?: number;
  description?: string;
  width?: number;
  height?: number;
  mimeType?: string;
}

function extractImagesFromResult(result: ParsedPdfContent): ResultImage[] {
  const pdfImages = result.metadata?.pdfImages;
  if (pdfImages && pdfImages.length > 0) {
    return pdfImages.map((image) => ({
      id: image.id,
      src: image.src,
      pageNumber: image.pageNumber,
      description: image.description,
      width: image.width,
      height: image.height,
      mimeType: dataUrlMimeType(image.src),
    }));
  }
  return (result.images ?? []).map((src, index) => ({
    id: `img_${index + 1}`,
    src,
    pageNumber: 1,
    mimeType: dataUrlMimeType(src),
  }));
}

function stripInlineImages(
  result: ParsedPdfContent,
  images: DerivedExtractionImage[],
): StoredExtractionArtifact {
  const sourceMetadata = result.metadata ?? { pageCount: 0 };
  const metadata = omitKeys(sourceMetadata, ['imageMapping', 'pdfImages']);
  metadata.pageCount = sourceMetadata.pageCount ?? 0;
  // Shape parity with the route (RFC #1153 part 1, K4): a DOCUMENT result
  // always carries imageMapping/pdfImages — `{}` / `[]` when it has no images —
  // so the keys are preserved on the stored artifact when the source carried
  // them (or when images exist). Media results never carry the keys and stay
  // verbatim, exactly like the route's media shape.
  const carriesImageShape =
    images.length > 0 || 'imageMapping' in sourceMetadata || 'pdfImages' in sourceMetadata;
  if (carriesImageShape) {
    metadata.imageMapping = Object.fromEntries(images.map((image) => [image.id, image.assetId]));
    metadata.pdfImages = images.map((image) => ({
      id: image.id,
      assetId: image.assetId,
      pageNumber: image.pageNumber ?? 1,
      ...(image.description !== undefined ? { description: image.description } : {}),
      ...(image.width !== undefined ? { width: image.width } : {}),
      ...(image.height !== undefined ? { height: image.height } : {}),
    }));
  }
  return {
    text: result.text,
    images: images.map((image) => image.assetId),
    ...(result.tables !== undefined ? { tables: result.tables } : {}),
    ...(result.formulas !== undefined ? { formulas: result.formulas } : {}),
    ...(result.layout !== undefined ? { layout: result.layout } : {}),
    metadata,
  };
}

// ─── Cache lookup ─────────────────────────────────────────────────────────────

export interface ExtractionCacheLookupOptions {
  kv: KVStore;
  /**
   * Pool to resolve asset bytes from. Omitted in production, where URL
   * resolution goes through the shared `withAssetUrl` lease seam (the
   * browser-wide pool); injectable so tests can drive a fake pool.
   */
  pool?: AssetPoolStore;
  contentDigest: string;
  extractorId: string;
  extractorVersion: string;
  /** Caller-supplied endpoint the provider is expected to run against; fingerprints the key. */
  baseUrl?: string;
  /** Fetch implementation; defaults to the global one. Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Look up a cached extraction derivation and, on a hit, rebuild exactly the
 * parse result the page consumes (images back to data URLs).
 *
 * Returns `null` on ANY inconsistency — no record, a record whose extractor
 * identity disagrees (and is not a recorded alias), an artifact or image asset
 * that does not resolve, bytes that cannot be read, a record whose image list
 * disagrees with the stored artifact's own image asset ids, or a KV/pool
 * transport failure — so the caller treats it as a miss and runs the real
 * extraction. A hit is logged so it is observable.
 */
export async function lookupCachedExtraction(
  options: ExtractionCacheLookupOptions,
): Promise<ParsedPdfContent | null> {
  // K5: a route-level KV failure disabled the cache for this session; every
  // lookup is a miss without touching the store (one warn was already logged).
  if (cacheDisabledForSession) return null;
  const key = extractionCacheKey(
    options.contentDigest,
    options.extractorId,
    options.extractorVersion,
    await computeConfigFingerprint(options.baseUrl),
  );
  try {
    const record = await options.kv.get<DerivationRecord>(key, EXTRACTION_CACHE_KV_SCOPE);
    if (!record || !isValidDerivationRecord(record)) return null;
    // The key already pins the extractor identity; a record that disagrees is
    // an inconsistency and must be treated as a miss, never trusted — unless
    // the record explicitly declares the requested identity as an alias (K1:
    // a self-host MinerU request that actually ran on MinerU Cloud stores the
    // same record under the expected key, declaring itself an alias for it).
    const matchesRequestedIdentity =
      record.extractorId === options.extractorId &&
      record.extractorVersion === options.extractorVersion;
    const aliasedRequestedIdentity = (record.aliases ?? []).some(
      (alias) =>
        alias.extractorId === options.extractorId &&
        alias.extractorVersion === options.extractorVersion,
    );
    if (!matchesRequestedIdentity && !aliasedRequestedIdentity) {
      log.warn(
        `Extraction cache miss for ${key}: recorded extractor ${record.extractorId}@` +
          `${record.extractorVersion} does not match the requested identity and is not a ` +
          `recorded alias for it.`,
      );
      return null;
    }
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    // Bytes are read under the shared URL lease so the pinned blob snapshot is
    // released once the read completes (asset URL ownership boundary).
    const artifact = await withAssetUrl(
      record.artifactAssetId,
      async (url) => {
        if (!url) {
          log.warn(
            `Extraction cache miss for ${key}: artifact asset ${record.artifactAssetId} does not resolve.`,
          );
          return null;
        }
        return fetchStoredArtifact(url, fetchImpl);
      },
      options.pool,
    );
    if (!artifact) {
      log.warn(`Extraction cache miss for ${key}: artifact bytes could not be read.`);
      return null;
    }
    // K6 (integrity): the record's image list must match the stored artifact's
    // own image asset ids. The record is the cache index, the artifact is the
    // payload; on ANY inconsistency the spec mandates a miss, so a truncated or
    // tampered record never yields a hit with silently shorter images.
    if (!artifactImagesMatchRecord(artifact, record)) {
      log.warn(
        `Extraction cache miss for ${key}: the record's image assets do not match the ` +
          `stored artifact's own image list.`,
      );
      return null;
    }
    // Every image asset must resolve and be readable; a record naming a
    // partially-reclaimed cache is a miss, and the real extraction re-derives.
    const dataUrls: string[] = [];
    for (const image of record.images) {
      const dataUrl = await withAssetUrl(
        image.assetId,
        async (url) => {
          if (!url) {
            log.warn(
              `Extraction cache miss for ${key}: image asset ${image.assetId} does not resolve.`,
            );
            return null;
          }
          return fetchBytesAsDataUrl(url, image.mimeType, fetchImpl);
        },
        options.pool,
      );
      if (!dataUrl) {
        log.warn(
          `Extraction cache miss for ${key}: image bytes for ${image.assetId} could not be read.`,
        );
        return null;
      }
      dataUrls.push(dataUrl);
    }
    const result = rebuildResult(artifact, record, dataUrls);
    log.info(
      `Extraction cache hit for ${key}: rebuilt ${record.images.length} image(s) from the pool.`,
    );
    return result;
  } catch (error) {
    // A KV or pool failure must never fail the user's extraction: degrade to a
    // miss and let the real extraction run. A route-level KV failure (the KV
    // route itself is gone) disables the cache for the session (K5).
    if (isRouteLevelKVError(error)) {
      disableCacheForSession(error);
    } else {
      log.warn(`Extraction cache lookup failed for ${key}; running the real extraction:`, error);
    }
    return null;
  }
}

/** Whether the record's image asset ids equal the stored artifact's own list, in order. */
function artifactImagesMatchRecord(
  artifact: StoredExtractionArtifact,
  record: DerivationRecord,
): boolean {
  const recordedAssetIds = record.images.map((image) => image.assetId);
  return (
    artifact.images.length === recordedAssetIds.length &&
    artifact.images.every((assetId, index) => assetId === recordedAssetIds[index])
  );
}

function isValidDerivationRecord(value: unknown): value is DerivationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<DerivationRecord>;
  const aliasesValid =
    record.aliases === undefined ||
    (Array.isArray(record.aliases) &&
      record.aliases.every(
        (alias) =>
          typeof alias === 'object' &&
          alias !== null &&
          typeof alias.extractorId === 'string' &&
          typeof alias.extractorVersion === 'string',
      ));
  return (
    typeof record.extractorId === 'string' &&
    typeof record.extractorVersion === 'string' &&
    typeof record.artifactAssetId === 'string' &&
    Array.isArray(record.images) &&
    record.images.every(
      (image) =>
        typeof image === 'object' &&
        image !== null &&
        typeof image.id === 'string' &&
        typeof image.assetId === 'string',
    ) &&
    aliasesValid
  );
}

async function fetchStoredArtifact(
  url: string,
  fetchImpl: typeof fetch,
): Promise<StoredExtractionArtifact | null> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const parsed = (await response.json()) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const artifact = parsed as StoredExtractionArtifact;
    if (typeof artifact.text !== 'string' || !Array.isArray(artifact.images)) return null;
    return artifact;
  } catch {
    return null;
  }
}

async function fetchBytesAsDataUrl(
  url: string,
  mimeType: string | undefined,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mime = mimeType || 'application/octet-stream';
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  } catch {
    return null;
  }
}

/** Rebuild the exact parse-result shape a real extraction returns. */
function rebuildResult(
  artifact: StoredExtractionArtifact,
  record: DerivationRecord,
  dataUrls: readonly string[],
): ParsedPdfContent {
  const metadata = {
    pageCount: artifact.metadata.pageCount ?? 0,
    ...omitKeys(artifact.metadata, ['imageMapping', 'pdfImages']),
  } as NonNullable<ParsedPdfContent['metadata']>;
  // Shape parity with the route (RFC #1153 part 1, K4): a document hit always
  // carries imageMapping/pdfImages — `{}` / `[]` when the document has none —
  // exactly like the route's document response. Media artifacts never carry the
  // keys (the route's media shape omits them), so they stay absent.
  const carriesImageShape = 'imageMapping' in artifact.metadata || 'pdfImages' in artifact.metadata;
  if (record.images.length > 0 || carriesImageShape) {
    metadata.imageMapping =
      record.images.length > 0
        ? Object.fromEntries(record.images.map((image, index) => [image.id, dataUrls[index]!]))
        : {};
    metadata.pdfImages =
      record.images.length > 0
        ? record.images.map((image, index) => ({
            id: image.id,
            src: dataUrls[index]!,
            pageNumber: image.pageNumber ?? 1,
            ...(image.description !== undefined ? { description: image.description } : {}),
            ...(image.width !== undefined ? { width: image.width } : {}),
            ...(image.height !== undefined ? { height: image.height } : {}),
          }))
        : [];
  }
  return {
    text: artifact.text,
    images: [...dataUrls],
    ...(artifact.tables !== undefined ? { tables: artifact.tables } : {}),
    ...(artifact.formulas !== undefined ? { formulas: artifact.formulas } : {}),
    ...(artifact.layout !== undefined ? { layout: artifact.layout } : {}),
    metadata,
  };
}

// ─── Composition with the extract API ─────────────────────────────────────────

export interface ExtractionFetchWithCacheOptions extends FetchExtractionResponseOptions {
  /** Content identity of the source bytes; absent for legacy sessions (no cache). */
  contentDigest?: string;
  /** Extractor identity the extraction is expected to run under; see `resolveExpectedExtractor`. */
  extractorId?: string;
  extractorVersion?: string;
  /** Caller-supplied provider endpoint; fingerprints the cache key (K2). */
  baseUrl?: string;
  /** Source-document pool asset id, recorded for lineage on the cache write. */
  sourceDocAssetId?: string;
  /**
   * KV store for derivation records. Omitted in production, where the
   * browser-wide store is resolved lazily (and a resolution failure disables
   * caching without failing the extraction); injectable so tests can drive a
   * fake KV.
   */
  kv?: KVStore;
  /**
   * Pool to ingest/resolve through. Omitted in production (the browser-wide
   * pool via the `putAsset` / `withAssetUrl` seams); injectable for tests.
   */
  pool?: AssetPoolStore;
  /** Fetch implementation for reading cached bytes; defaults to the global one. */
  fetchImpl?: typeof fetch;
  /** Localized fallback for a response that carries no usable parse data. */
  parseFailedMessage: string;
}

export interface ExtractionFetchWithCacheResult {
  /** The parse result the page consumes (cache-rebuilt or freshly extracted). */
  data: ParsedPdfContent;
  /** Whether this result was rebuilt from the derivation cache (no network extraction). */
  cacheHit: boolean;
}

/**
 * The generation-preview extraction flow: cache lookup first, then the real
 * extraction, then a best-effort cache write.
 *
 * On a cache hit the rebuilt parse result is returned and the extract API is
 * never called — `fetchers` are untouched. On a miss the wrapped
 * `fetchExtractionResponse` runs (asset-id form with the byte fallback, per
 * part 0) and the successful result is cached under the extractor that
 * ACTUALLY ran. Errors surface exactly as the page's current flow raises
 * them: a non-ok response throws its `error` string (or the localized
 * fallback), and a success without parse data throws the localized fallback.
 */
export async function fetchExtractionWithCache(
  options: ExtractionFetchWithCacheOptions,
): Promise<ExtractionFetchWithCacheResult> {
  // Resolve the KV store once, defensively: an unavailable store (privacy
  // mode, server persistence offline) disables caching entirely — the user's
  // extraction must never fail because the cache could not be reached.
  let kv: KVStore | null = options.kv ?? null;
  if (kv === null) {
    try {
      kv = getExtractionCacheKV();
    } catch (error) {
      log.warn(
        'The extraction cache KV store is unavailable; running the real extraction without caching:',
        error,
      );
    }
  }

  // 1. Client-side cache lookup, before the extract API. On a hit the rebuilt
  //    parse result skips the paid extraction entirely. (When the session's KV
  //    route failed, `lookupCachedExtraction` answers a miss without touching
  //    the store — K5.)
  if (kv && options.contentDigest && options.extractorId && options.extractorVersion) {
    const cached = await lookupCachedExtraction({
      kv,
      pool: options.pool,
      contentDigest: options.contentDigest,
      extractorId: options.extractorId,
      extractorVersion: options.extractorVersion,
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
    });
    if (cached) return { data: cached, cacheHit: true };
  }

  // 2. Real extraction (asset-id JSON form with the legacy byte fallback).
  const response = await fetchExtractionResponse(options);
  if (!response.ok) {
    const errorData = (await response.json()) as { error?: unknown } | null;
    throw new Error(
      typeof errorData?.error === 'string' ? errorData.error : options.parseFailedMessage,
    );
  }
  const parsed = (await response.json()) as { success?: unknown; data?: unknown };
  if (!parsed.success || !parsed.data) {
    throw new Error(options.parseFailedMessage);
  }
  const data = parsed.data as ParsedPdfContent;

  // 3. Best-effort cache write. The key uses the extractor that ACTUALLY ran
  //    (reported as `parser` in the result metadata) plus its declared
  //    version, so a version bump is a cache miss that re-derives. When the
  //    actual key differs from the expected key the lookup used (e.g. a
  //    self-host MinerU request that the route fell back to MinerU Cloud on),
  //    the SAME record is also stored under the expected key as an alias, so
  //    the next lookup under the expected key hits (K1). A failed write is
  //    logged and abandoned without failing this extraction; a route-level KV
  //    failure disables the cache for the session (K5).
  if (kv && options.contentDigest && options.extractorId && options.extractorVersion) {
    const actualExtractorId = data.metadata?.parser || options.extractorId;
    const actualExtractorVersion =
      extractorVersionFor(actualExtractorId) || options.extractorVersion;
    const aliasExtractor =
      actualExtractorId !== options.extractorId ||
      actualExtractorVersion !== options.extractorVersion
        ? { extractorId: options.extractorId, extractorVersion: options.extractorVersion }
        : undefined;
    await writeExtractionCache({
      kv,
      pool: options.pool,
      contentDigest: options.contentDigest,
      extractorId: actualExtractorId,
      extractorVersion: actualExtractorVersion,
      baseUrl: options.baseUrl,
      ...(aliasExtractor ? { aliasExtractor } : {}),
      sourceDocAssetId: options.sourceDocAssetId,
      result: data,
    });
  }
  return { data, cacheHit: false };
}

// ─── In-run extraction dedupe (RFC #1153 part 1, K3) ──────────────────────────

/** The identity two sources share when their extractions are interchangeable. */
export interface InRunExtractionKey {
  contentDigest: string;
  extractorId: string;
  extractorVersion: string;
}

/**
 * Per-run memoizer so sources with the SAME content digest AND the SAME
 * expected extractor identity share ONE extraction: within one generation run
 * the first same-digest source pays for the extraction and every other one
 * awaits the same in-flight promise, so two same-byte files never both pay.
 * Different digest or extractor identity → separate extractions (two bytes
 * that are equal under different extractors are legitimately different
 * derivations). A per-run instance is created once per generation run; the
 * memoized promises live exactly as long as the run.
 */
export function createExtractionDeduplicator(): {
  run: (
    key: InRunExtractionKey,
    extraction: () => Promise<ParsedPdfContent>,
  ) => Promise<ParsedPdfContent>;
} {
  const inflight = new Map<string, Promise<ParsedPdfContent>>();
  return {
    run(key, extraction) {
      const memoKey = `${key.contentDigest}|${key.extractorId}@${key.extractorVersion}`;
      const existing = inflight.get(memoKey);
      if (existing) return existing;
      const promise = extraction();
      inflight.set(memoKey, promise);
      return promise;
    },
  };
}
