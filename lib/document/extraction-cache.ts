/**
 * Extraction derivation cache (RFC #1153 part 1).
 *
 * Extraction is treated as a pure derivation of (source bytes, derivation
 * domain, extractor, extractor version, caller-supplied endpoint). After a
 * successful document/media extraction the structured artifact is stored in
 * the asset pool as its own `application/json` asset — inline image data
 * stripped, each image's pool asset id recorded in its place — and a single KV
 * record per (content digest, domain, extractor identity, caller-supplied
 * endpoint fingerprint) indexes it: lineage and cache index in one entry.
 * Re-importing the same bytes (same or another course) then hits the cache
 * instead of re-running the paid extraction, provided the digest, the domain,
 * the extractor id, the extractor version AND the config fingerprint all
 * match — a version bump is a miss that re-derives, and so is a caller-supplied
 * endpoint change (the residual staleness that stays ACCEPTED is documented at
 * `extractionCacheKey`).
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
import {
  DEFAULT_INGEST_AWAIT_TIMEOUT_MS,
  fetchExtractionResponse,
} from '@/lib/document/extract-source';
import {
  getDocumentExtractorManifestEntry,
  getMediaExtractorManifestEntry,
  selectDocumentExtractorManifestEntry,
  selectMediaExtractorManifestEntry,
} from '@/lib/document/extractors/manifest';
import { SUPPORTED_MEDIA_MIME_TYPES } from '@/lib/document/mime';
import { createLogger } from '@/lib/logger';
import { putAsset, removeAsset } from '@/lib/media/asset-pool';
import type { AssetPoolStore } from '@/lib/media/asset-pool-config';
import { assetRefExists, withAssetUrl } from '@/lib/media/use-asset-url';
import {
  getPersistenceRequestHeaders,
  isBrowserPersistenceEnabled,
} from '@/lib/persistence/bootstrap';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { mapWithConcurrency } from '@/lib/utils/concurrency';

const log = createLogger('ExtractionCache');

/**
 * Concurrency bound for the asset-id existence probes (review P3/O3): a hit's
 * per-image probes are identity reads (HEAD / registry lookup) that can run in
 * parallel, so they are dispatched in batches of this size instead of one
 * sequential round-trip per image.
 */
const ASSET_PROBE_CONCURRENCY = 8;

/**
 * Aggregate budget for the WHOLE probe phase of one hit, reused from the
 * ingest drain (`DEFAULT_INGEST_AWAIT_TIMEOUT_MS`). Each probe has its own
 * per-probe deadline, but N sequential probes would still cost N × deadline
 * on a stalled pool; this budget caps the phase, and an exhausted budget
 * degrades the hit to a miss (the real extraction runs) with one warn —
 * consistent with the degrade-to-miss contract.
 */
const ASSET_PROBE_BUDGET_MS = DEFAULT_INGEST_AWAIT_TIMEOUT_MS;

/** Key-prefix of every derivation record; bump the `v3` on a record-shape change. */
export const EXTRACTION_CACHE_KEY_PREFIX = 'derived-extraction:v3';

/**
 * Which extraction path a derivation record belongs to. `alidocmind` exists in
 * both the document and the media extractor registries at the same version, so
 * the content identity alone cannot tell the two derivations apart: the same
 * bytes extracted as a document and as media are different derivations and
 * must not share a cache key (RFC #1153 part 1, L6). The domain is threaded
 * from the call site — the page knows which path a source takes.
 */
export type ExtractionCacheDomain = 'doc' | 'media';

/**
 * How long an ALIAS-only validation of a derivation record stays trusted.
 *
 * A record hit under its own PRIMARY identity is permanent (exact match). A
 * hit that validates ONLY via the `aliases` list is honored only while the
 * record is younger than this: after it, the alias hit is treated as a miss,
 * the real extraction runs, and the fresh write records the CURRENT actual
 * identity as primary — so a deployment reconfigured server-side converges
 * within the TTL (RFC #1153 part 1, L1).
 */
export const ALIAS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
 * bytes) × derivation domain (document vs media — L6) × extractor identity
 * (id and version, so a version bump is a miss) × config fingerprint (see
 * `computeConfigFingerprint`), so a caller-supplied endpoint change misses
 * instead of serving the old engine's output.
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
  domain: ExtractionCacheDomain,
): string {
  return `${EXTRACTION_CACHE_KEY_PREFIX}:${contentDigest}:${domain}:${extractorId}@${extractorVersion}:cfg-${configFingerprint}`;
}

/**
 * The config half of the cache key: `sha256(normalizedBaseUrl ?? 'managed')`
 * truncated to 8 hex chars. The endpoint is normalized first — scheme and host
 * lowercased, default ports (443 for https, 80 for http) stripped, trailing
 * slashes stripped from the path — so trivially-equal spellings of the same
 * endpoint (`https://host`, `https://Host/`, `https://host:443`) share one
 * bucket instead of fragmenting the cache forever (RFC #1153 part 1, L2); a
 * string that does not parse as a URL is hashed verbatim. Providers whose
 * output depends on a caller-supplied endpoint fingerprint that endpoint, so
 * pointing it at a different engine misses; in-repo providers (unpdf,
 * plain-text) and managed/endpoint-less providers share the constant
 * `'managed'` bucket and keep stable keys.
 */
export async function computeConfigFingerprint(baseUrl?: string): Promise<string> {
  const input = normalizeEndpointForFingerprint(baseUrl ?? 'managed');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8);
}

/**
 * Normalize a caller-supplied endpoint for fingerprinting: lowercase the scheme
 * and host, strip the scheme's default port, strip trailing slashes from the
 * path, and keep the rest (port, query, hash) as written. An unparseable
 * string is returned verbatim.
 */
function normalizeEndpointForFingerprint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  const scheme = url.protocol.toLowerCase();
  const defaultPort = scheme === 'https:' ? '443' : scheme === 'http:' ? '80' : undefined;
  const port = defaultPort !== undefined && url.port === defaultPort ? '' : url.port;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `${scheme}//${url.hostname.toLowerCase()}${port ? `:${port}` : ''}${path}${url.search}${url.hash}`;
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
 *
 * Resolved against the browser-safe extractor MANIFEST (not the registry): the
 * client pages must compute the expected identity without importing the
 * provider implementations, and the manifest is pinned equal to the registries
 * by `tests/document/extractor-registry.test.ts`.
 */
export function resolveExpectedExtractor(
  mimeType: string,
  requestedProviderId?: string,
): ExpectedExtractor | null {
  try {
    const normalizedMimeType = mimeType.toLowerCase();
    if (SUPPORTED_MEDIA_MIME_TYPES.includes(normalizedMimeType)) {
      const requested = requestedProviderId
        ? getMediaExtractorManifestEntry(requestedProviderId)
        : undefined;
      const provider =
        requested && requested.supportedMimeTypes.includes(normalizedMimeType)
          ? requested
          : selectMediaExtractorManifestEntry({
              mimeType: normalizedMimeType,
              requiredCapabilities: { transcript: true },
            });
      return { extractorId: provider.id, extractorVersion: provider.version };
    }
    const requested = requestedProviderId
      ? getDocumentExtractorManifestEntry(requestedProviderId)
      : undefined;
    const provider =
      requested && requested.supportedMimeTypes.includes(normalizedMimeType)
        ? requested
        : selectDocumentExtractorManifestEntry({
            mimeType: normalizedMimeType,
            requiredCapabilities: { text: true },
          });
    return { extractorId: provider.id, extractorVersion: provider.version };
  } catch {
    return null;
  }
}

/** The declared version of a provider, from whichever manifest entry holds it. */
export function extractorVersionFor(providerId: string): string | undefined {
  return (
    getDocumentExtractorManifestEntry(providerId)?.version ??
    getMediaExtractorManifestEntry(providerId)?.version
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

// ─── Bounded degradation (RFC #1153 part 1, K5) ──────────────────────────────

/**
 * How long a route-level KV failure disables the cache. The disable is
 * timestamped, NOT permanent: a transient route-level 404 (a deploy window, a
 * proxy 404 during rollout) must not kill caching for the tab lifetime, so the
 * cache re-probes the KV route once the window expires (RFC #1153 part 1, L4).
 */
const CACHE_DISABLE_TTL_MS = 10 * 60 * 1000;

/**
 * Module-level (tab-wide) cache disable, expressed as the epoch-ms instant the
 * disable window ends; `0` means not disabled. Set once when the KV backend
 * answers with a route-level failure (the KV route itself is gone, as with
 * `NEXT_PUBLIC_PERSISTENCE=1` today): until the window expires every lookup is
 * a miss and every write is skipped WITHOUT ingesting assets, so the
 * degradation is quiet (one warn per disable episode) and cheap (no
 * putAsset-then-removeAsset churn per extraction). The flag is shared across
 * every generation run and every learner in the tab; after expiry a fresh
 * route-level failure starts a new episode with its own single warn.
 * Transient failures (network blips) keep the per-op behavior.
 */
let cacheDisabledUntilEpochMs = 0;

/** Whether the cache is inside a disable window right now. */
function isCacheDisabled(): boolean {
  return cacheDisabledUntilEpochMs > Date.now();
}

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

/** Disable the cache for one window, logging exactly ONE warn per episode. */
function disableCacheForWindow(error: unknown): void {
  if (isCacheDisabled()) return;
  cacheDisabledUntilEpochMs = Date.now() + CACHE_DISABLE_TTL_MS;
  log.warn(
    `The extraction cache KV route is unreachable; disabling the extraction cache for the next ${Math.round(
      CACHE_DISABLE_TTL_MS / 60000,
    )} minutes:`,
    error,
  );
}

/** Test-only: clear the disable window between tests. */
export function resetExtractionCacheForTests(): void {
  cacheDisabledUntilEpochMs = 0;
}

// ─── Alias trust window (RFC #1153 part 1, L1) ───────────────────────────────

/**
 * Age of a derivation record in ms. A missing or unparseable `createdAt`
 * yields `NaN`, which callers must treat as STALE — a record without a
 * trustworthy creation time must never be honored via an alias.
 */
function recordAgeMs(record: { createdAt: string }): number {
  return Date.now() - new Date(record.createdAt).getTime();
}

/**
 * Whether an alias-only validation of this record is still trusted. ASYMMETRIC
 * TRUST, on purpose: a hit under the record's own PRIMARY identity is
 * permanent (exact match), but a hit that validates only via the `aliases`
 * list is honored only while the record is younger than `ALIAS_MAX_AGE_MS`.
 *
 * The asymmetry exists because the client cannot observe server-managed config
 * changes: a record written under actual `mineru-cloud@1` with alias
 * `mineru@1` keeps serving cloud output forever after the operator configures
 * server-managed self-host mineru — both phases fingerprint `'managed'`, so
 * the keys match and the client never sees the new config. Expiry is the
 * convergence mechanism: an expired alias hit degrades to a miss, the real
 * extraction runs under the CURRENT identity, and the fresh write records that
 * identity as primary — so a reconfigured deployment converges within the TTL,
 * and a stable fallback deployment re-pays at most daily.
 */
function aliasStillTrusted(record: { createdAt: string }): boolean {
  return recordAgeMs(record) <= ALIAS_MAX_AGE_MS;
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
  /** Which extraction path produced this result (`doc` vs `media` — L6). */
  domain: ExtractionCacheDomain;
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
 * KV failure disables the cache for a bounded window (K5/L4) — subsequent
 * writes are skipped BEFORE any asset is ingested, so a dead KV route costs no
 * putAsset-then-removeAsset churn.
 *
 * Resolves to the derived images (extraction id → pool asset id) when the
 * write settled: this attempt's own images on success, the ADOPTED existing
 * record's images when a same-key race superseded this attempt (K3), or an
 * empty array when the write was skipped or failed. A server-backed caller can
 * await the returned `cacheWrite` promise to learn the image asset ids without
 * materializing image bytes client-side (RFC #1153 part 2 B).
 */
export async function writeExtractionCache(
  options: ExtractionCacheWriteOptions,
): Promise<DerivedExtractionImage[]> {
  // K5: the KV route is unreachable (inside the disable window); skip the
  // write entirely BEFORE ingesting anything, so a dead backend costs no pool
  // churn.
  if (isCacheDisabled()) return [];

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
      options.domain,
    );
    const aliasIdentity = options.aliasExtractor ? [{ ...options.aliasExtractor }] : undefined;
    const aliasKey = options.aliasExtractor
      ? extractionCacheKey(
          options.contentDigest,
          options.aliasExtractor.extractorId,
          options.aliasExtractor.extractorVersion,
          configFingerprint,
          options.domain,
        )
      : undefined;

    // K3 (cross-tab): another tab may have written this derivation while this
    // attempt allocated its assets. Re-read the key before writing; a valid
    // record already present means this attempt is the loser — release every
    // asset IT allocated and adopt the existing record. The get→set race
    // window that remains is milliseconds; if it fires, the loser's assets
    // orphan — accepted: eviction is part 2's material library, and the orphan
    // is indistinguishable from any other never-referenced pool asset until
    // then.
    //
    // L1 exception: an existing record whose identity does NOT match the key's
    // pinned identity is an alias record, and one older than the alias TTL is
    // exactly the stale record the lookup just refused to serve — adopting it
    // would re-poison the cache forever. Supersede it with this fresh write so
    // a reconfigured deployment converges (a fresh alias is still adopted: the
    // K1 × K3 race writes the same value either way).
    const existing = await options.kv.get<DerivationRecord>(key, EXTRACTION_CACHE_KV_SCOPE);
    const existingIsExpiredAlias =
      existing !== null &&
      isValidDerivationRecord(existing) &&
      !(
        existing.extractorId === options.extractorId &&
        existing.extractorVersion === options.extractorVersion
      ) &&
      !aliasStillTrusted(existing);
    if (existing && isValidDerivationRecord(existing) && !existingIsExpiredAlias) {
      if (aliasKey && aliasIdentity) {
        await writeAliasRecord(options.kv, aliasKey, aliasIdentity[0], existing);
      }
      await releaseAllocatedAssets(allocated, remove, 'superseded by an existing record');
      log.info(
        `Extraction cache write for ${key} abandoned: an existing derivation record was adopted; ` +
          `${allocated.length} asset(s) allocated by this attempt were released.`,
      );
      // The adopted record's images are the LIVE asset ids a server-backed
      // caller should use — this attempt's own ids were just released.
      return existing.images;
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
    return images;
  } catch (error) {
    if (isRouteLevelKVError(error)) {
      // The KV route itself is gone (K5): disable caching for a bounded
      // window and log one warn; future writes are skipped before any ingest.
      disableCacheForWindow(error);
    } else {
      log.error(
        'Failed to cache the extraction derivation; the extraction result is still returned:',
        error,
      );
    }
    // Release every asset allocated in this partial attempt so the pool does
    // not accumulate orphans. The KV record was only written last, so nothing
    // references the released ids. No live ids remain to hand back.
    await releaseAllocatedAssets(allocated, remove, 'a failed cache write');
    return [];
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
  /** Which extraction path this lookup belongs to (`doc` vs `media` — L6). */
  domain: ExtractionCacheDomain;
  extractorId: string;
  extractorVersion: string;
  /** Caller-supplied endpoint the provider is expected to run against; fingerprints the key. */
  baseUrl?: string;
  /** Fetch implementation; defaults to the global one. Injectable for tests. */
  fetchImpl?: typeof fetch;
  /**
   * Aggregate budget for the asset-id existence probe phase (review P3/O3),
   * in milliseconds. Defaults to the 15 s ingest-drain constant; injectable
   * so tests can drive a tiny budget instead of waiting the full 15 s.
   */
  assetProbeBudgetMs?: number;
  /**
   * How the rebuilt result's `imageMapping` / `pdfImages` are expressed
   * (RFC #1153 part 2 section C). `'data-url'` (default) rebuilds image bytes
   * client-side exactly as a real extraction returns them. `'asset-id'` —
   * used by a server-backed deployment — rebuilds WITHOUT materializing image
   * bytes: `metadata.imageMapping` maps `img_N` → the image's pool asset id
   * and `metadata.pdfImages[].assetId` carries the same id, so a cache hit
   * feeds generation by id instead of shipping bytes to the client. In
   * `'asset-id'` mode the per-image BYTE reads are skipped (the bytes are
   * resolved server-side at prompt-assembly time), but each image asset is
   * still probed for EXISTENCE through the pool's identity seam — a record
   * naming a reclaimed image is a miss (reclaim = miss, the same invariant
   * data-url mode and part-1 K6 enforce), never a hit with dangling ids.
   */
  imageMappingMode?: 'data-url' | 'asset-id';
}

/**
 * Look up a cached extraction derivation and, on a hit, rebuild exactly the
 * parse result the page consumes (images back to data URLs — or, in
 * `'asset-id'` mode, images as their pool asset ids with no bytes
 * materialized, per RFC #1153 part 2 C).
 *
 * Returns `null` on ANY inconsistency — no record, a record whose extractor
 * identity disagrees (and is not a recorded alias), an artifact or image asset
 * that does not resolve, bytes that cannot be read, a record whose image list
 * disagrees with the stored artifact's own image asset ids, or a KV/pool
 * transport failure — so the caller treats it as a miss and runs the real
 * extraction. (In `'asset-id'` mode the per-image BYTE reads are skipped, so
 * a hit costs the artifact read, the record/artifact consistency check, and
 * a per-image EXISTENCE probe through the pool's identity seam — a record
 * naming a reclaimed image is a miss there too.)
 * A hit is logged so it is observable.
 */
export async function lookupCachedExtraction(
  options: ExtractionCacheLookupOptions,
): Promise<ParsedPdfContent | null> {
  // K5: a route-level KV failure disabled the cache (inside the disable
  // window); every lookup is a miss without touching the store (one warn was
  // already logged per episode).
  if (isCacheDisabled()) return null;
  // The key is built INSIDE the guarded region below: a config-fingerprint
  // computation failure (Web Crypto unavailable) is a lookup failure like any
  // other and must degrade to a miss — never reject the caller's extraction
  // (RFC #1153 part 1, M1). `undefined` until the key is built, so the catch
  // below can still name the key when the failure comes after it.
  let key: string | undefined;
  // Asset-id mode (part 2 C): the rebuilt result names pool asset ids instead
  // of image bytes, so the per-image byte reads below are skipped and the
  // record's asset ids flow straight into the result.
  const assetIdMode = options.imageMappingMode === 'asset-id';
  try {
    key = extractionCacheKey(
      options.contentDigest,
      options.extractorId,
      options.extractorVersion,
      await computeConfigFingerprint(options.baseUrl),
      options.domain,
    );
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
    // L1 (asymmetric trust): an exact (primary) match is permanent; a hit that
    // validates ONLY via the aliases list is honored only while the record is
    // younger than `ALIAS_MAX_AGE_MS` (see `aliasStillTrusted` for why). An
    // expired alias hit is a miss: the real extraction runs and the fresh
    // write records the CURRENT actual identity as primary, so a deployment
    // reconfigured server-side converges within the TTL.
    if (!matchesRequestedIdentity && !aliasStillTrusted(record)) {
      log.warn(
        `Extraction cache miss for ${key}: the recorded alias for ${options.extractorId}@` +
          `${options.extractorVersion} is older than ${ALIAS_MAX_AGE_MS}ms; re-running the ` +
          `extraction so the current actual identity becomes primary.`,
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
    // Every image asset must resolve and be readable in data-url mode; a
    // record naming a partially-reclaimed cache is a miss, and the real
    // extraction re-derives. In asset-id mode (RFC #1153 part 2 C) the image
    // BYTES are deliberately NOT materialized client-side — the generation
    // routes resolve the ids server-side at prompt-assembly time — but the
    // reclaim-is-miss invariant (part-1 K6) is mode-independent: each image
    // asset is still probed for EXISTENCE through the pool seam (an identity
    // read — HEAD / registry lookup — never a byte fetch), and a record
    // naming a reclaimed image is a miss, exactly like data-url mode. Only a
    // record whose image assets all still exist serves a hit.
    const imagePayloads: string[] = [];
    if (assetIdMode) {
      // O3: the probes run with bounded concurrency (batches of 8) AND an
      // aggregate budget. N sequential HEADs would cost N round-trips on every
      // hit (and N × per-probe deadline on a stalled pool); batching keeps the
      // healthy-path cost to ceil(N / 8) waves, and the budget caps the whole
      // phase — an exhausted budget degrades this hit to a miss with ONE warn
      // (the real extraction runs), so a stalled persistence endpoint cannot
      // hold the hit path for N × per-probe timeout.
      const assetProbeBudgetMs = options.assetProbeBudgetMs ?? ASSET_PROBE_BUDGET_MS;
      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      const probeOutcome = await Promise.race([
        mapWithConcurrency(record.images, ASSET_PROBE_CONCURRENCY, (image) =>
          assetRefExists(image.assetId, options.pool),
        ).then(
          (results) => ({ status: 'done' as const, results }),
          (error) => ({ status: 'error' as const, error }),
        ),
        new Promise<{ status: 'timeout' }>((resolve) => {
          budgetTimer = setTimeout(() => resolve({ status: 'timeout' }), assetProbeBudgetMs);
        }),
      ]);
      if (budgetTimer !== undefined) clearTimeout(budgetTimer);
      if (probeOutcome.status === 'timeout') {
        log.warn(
          `Extraction cache miss for ${key}: image asset existence probes exceeded the ` +
            `${assetProbeBudgetMs}ms aggregate budget; running the real extraction.`,
        );
        return null;
      }
      if (probeOutcome.status === 'error') {
        // A probe transport failure degrades through the outer catch below
        // (warn + miss), exactly like the other pool failures.
        throw probeOutcome.error;
      }
      for (let i = 0; i < record.images.length; i++) {
        if (!probeOutcome.results[i]) {
          log.warn(
            `Extraction cache miss for ${key}: image asset ${record.images[i]!.assetId} no longer exists (reclaim = miss).`,
          );
          return null;
        }
        imagePayloads.push(record.images[i]!.assetId);
      }
    } else {
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
        imagePayloads.push(dataUrl);
      }
    }
    const result = rebuildResult(artifact, record, imagePayloads, assetIdMode);
    log.info(
      `Extraction cache hit for ${key}: rebuilt ${record.images.length} image(s) ${
        assetIdMode ? 'by asset id' : 'from the pool'
      }.`,
    );
    return result;
  } catch (error) {
    // A KV or pool failure must never fail the user's extraction: degrade to a
    // miss and let the real extraction run. A route-level KV failure (the KV
    // route itself is gone) disables the cache for a bounded window (K5/L4).
    // The same net catches a config-fingerprint failure, which happens BEFORE
    // any KV traffic (M1): the lookup misses with a warn and the real
    // extraction runs.
    if (isRouteLevelKVError(error)) {
      disableCacheForWindow(error);
    } else {
      log.warn(
        `Extraction cache lookup failed${key !== undefined ? ` for ${key}` : ''}; running the real extraction:`,
        error,
      );
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

/**
 * Rebuild the exact parse-result shape a real extraction returns.
 *
 * In `assetIdMode` (RFC #1153 part 2 C) the payloads are pool asset ids, not
 * data URLs: `metadata.imageMapping` maps `img_N` → asset id, each
 * `metadata.pdfImages` entry carries the id on `assetId` (with `src` left
 * empty — no image bytes were materialized), and the top-level `images` list
 * is empty for the same reason. Browser-backed hits keep the data-URL shape
 * byte-for-byte.
 */
function rebuildResult(
  artifact: StoredExtractionArtifact,
  record: DerivationRecord,
  imagePayloads: readonly string[],
  assetIdMode = false,
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
        ? Object.fromEntries(record.images.map((image, index) => [image.id, imagePayloads[index]!]))
        : {};
    metadata.pdfImages =
      record.images.length > 0
        ? record.images.map((image, index) => ({
            id: image.id,
            src: assetIdMode ? '' : imagePayloads[index]!,
            pageNumber: image.pageNumber ?? 1,
            ...(assetIdMode && image.assetId ? { assetId: image.assetId } : {}),
            ...(image.description !== undefined ? { description: image.description } : {}),
            ...(image.width !== undefined ? { width: image.width } : {}),
            ...(image.height !== undefined ? { height: image.height } : {}),
          }))
        : [];
  }
  return {
    text: artifact.text,
    images: assetIdMode ? [] : [...imagePayloads],
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
  /** Which extraction path this source takes (`doc` vs `media` — L6). */
  domain?: ExtractionCacheDomain;
  /** Extractor identity the extraction is expected to run under; see `resolveExpectedExtractor`. */
  extractorId?: string;
  extractorVersion?: string;
  /** Caller-supplied provider endpoint; fingerprints the cache key (K2). */
  baseUrl?: string;
  /** Source-document pool asset id, recorded for lineage on the cache write. */
  sourceDocAssetId?: string;
  /**
   * How cache-rebuilt results express their images (`'data-url'` by default;
   * `'asset-id'` on a server-backed deployment — see
   * `ExtractionCacheLookupOptions.imageMappingMode`).
   */
  imageMappingMode?: 'data-url' | 'asset-id';
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
  /**
   * The best-effort cache write, detached from the caller's result (L5). The
   * extraction result is returned WITHOUT waiting for the write; awaiting this
   * promise is only for tests, observability, or — on a server-backed
   * deployment — learning the derived image asset ids without materializing
   * image bytes (RFC #1153 part 2 B): it resolves to the derived images
   * (extraction id → pool asset id), or an empty array when the write was
   * skipped or failed. A page teardown mid-write can abandon the write —
   * best-effort by contract.
   */
  cacheWrite?: Promise<DerivedExtractionImage[]>;
}

/**
 * The generation-preview extraction flow: cache lookup first, then the real
 * extraction, then a best-effort cache write.
 *
 * On a cache hit the rebuilt parse result is returned and the extract API is
 * never called — `fetchers` are untouched. On a miss the wrapped
 * `fetchExtractionResponse` runs (asset-id form with the byte fallback, per
 * part 0) and the successful result is cached under the extractor that
 * ACTUALLY ran. The cache write is FIRE-AND-FORGET: the result returns as soon
 * as the extraction does, and `writeExtractionCache` runs detached — a page
 * teardown mid-write can abandon the write (best-effort by contract), and the
 * write can never gate or fail the user's result. Errors surface exactly as
 * the page's current flow raises them: a non-ok response throws its `error`
 * string (or the localized fallback), and a success without parse data throws
 * the localized fallback.
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
      domain: options.domain ?? 'doc',
      extractorId: options.extractorId,
      extractorVersion: options.extractorVersion,
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      imageMappingMode: options.imageMappingMode,
    });
    if (cached) {
      // The derivation exists (this hit proves it); point the material library
      // entry at it by its key parts, best-effort.
      recordMaterialDerivationBestEffort(
        options.contentDigest,
        options.domain ?? 'doc',
        options.extractorId,
        options.extractorVersion,
      );
      return { data: cached, cacheHit: true };
    }
  }

  // 2. Real extraction (asset-id JSON form with the legacy byte fallback).
  // Both body reads are guarded: a response that is not JSON at all (a proxy
  // error page, a truncated body) must surface the localized fallback, not a
  // raw SyntaxError.
  const response = await fetchExtractionResponse(options);
  if (!response.ok) {
    const errorData = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(
      typeof errorData?.error === 'string' ? errorData.error : options.parseFailedMessage,
    );
  }
  const parsed = (await response.json().catch(() => null)) as {
    success?: unknown;
    data?: unknown;
  } | null;
  if (!parsed?.success || !parsed.data) {
    throw new Error(options.parseFailedMessage);
  }
  const data = parsed.data as ParsedPdfContent;

  // 3. Best-effort cache write, FIRE-AND-FORGET (L5): the result is returned
  //    without awaiting the write sequence, so a stalled pool/KV never gates
  //    the user's extraction. The key uses the extractor that ACTUALLY ran
  //    (reported as `parser` in the result metadata) plus its declared
  //    version, so a version bump is a cache miss that re-derives. When the
  //    actual key differs from the expected key the lookup used (e.g. a
  //    self-host MinerU request that the route fell back to MinerU Cloud on),
  //    the SAME record is also stored under the expected key as an alias, so
  //    the next lookup under the expected key hits (K1). A failed write is
  //    logged and abandoned without failing this extraction; a route-level KV
  //    failure disables the cache for a bounded window (K5/L4).
  if (kv && options.contentDigest && options.extractorId && options.extractorVersion) {
    const actualExtractorId = data.metadata?.parser || options.extractorId;
    const actualExtractorVersion =
      extractorVersionFor(actualExtractorId) || options.extractorVersion;
    const aliasExtractor =
      actualExtractorId !== options.extractorId ||
      actualExtractorVersion !== options.extractorVersion
        ? { extractorId: options.extractorId, extractorVersion: options.extractorVersion }
        : undefined;
    const cacheWrite = writeExtractionCache({
      kv,
      pool: options.pool,
      contentDigest: options.contentDigest,
      domain: options.domain ?? 'doc',
      extractorId: actualExtractorId,
      extractorVersion: actualExtractorVersion,
      baseUrl: options.baseUrl,
      ...(aliasExtractor ? { aliasExtractor } : {}),
      sourceDocAssetId: options.sourceDocAssetId,
      result: data,
    })
      .then((derivedImages) => {
        // The derivation record now exists; point the material library entry at
        // it by its key parts, best-effort. Runs detached like the write itself.
        if (options.contentDigest) {
          recordMaterialDerivationBestEffort(
            options.contentDigest,
            options.domain ?? 'doc',
            actualExtractorId,
            actualExtractorVersion,
          );
        }
        return derivedImages;
      })
      .catch((error) => {
        // Defensive: `writeExtractionCache` already logs its own failures; this
        // handler only guarantees the detached write can never surface as an
        // unhandled rejection in the page's flow, and hands back no live ids.
        log.error(
          'Failed to cache the extraction derivation; the extraction result is still returned:',
          error,
        );
        return [];
      });
    return { data, cacheHit: false, cacheWrite };
  }
  return { data, cacheHit: false };
}

/**
 * Best-effort material-library pointer: append the extraction identity
 * (domain × extractor@version) to the library entry for these bytes, so an
 * agent consulting the entry can find the derivation record (and through it
 * the derived image assets) by the key parts. Any failure is logged inside
 * the library module and never affects the extraction flow.
 */
function recordMaterialDerivationBestEffort(
  contentDigest: string,
  domain: ExtractionCacheDomain,
  extractorId: string,
  extractorVersion: string,
): void {
  if (!contentDigest || !extractorId || !extractorVersion) return;
  void import('@/lib/materials/library')
    .then(({ recordMaterialDerivation }) =>
      recordMaterialDerivation(contentDigest, { domain, extractorId, extractorVersion }),
    )
    .catch((error) => {
      log.warn('Failed to record the material library derivation pointer:', error);
    });
}

// ─── In-run extraction dedupe (RFC #1153 part 1, K3) ──────────────────────────

/**
 * The identity two sources share when their extractions are interchangeable.
 * This is exactly the cache key minus the key prefix: content digest × domain
 * × extractor identity × config fingerprint, so two sources that would land on
 * different cache entries (e.g. the same digest under a different per-source
 * baseUrl) never share one extraction (RFC #1153 part 1, L3).
 */
export interface InRunExtractionKey {
  contentDigest: string;
  /** Which extraction path this source takes (`doc` vs `media` — L6). */
  domain: ExtractionCacheDomain;
  extractorId: string;
  extractorVersion: string;
  /** Config fingerprint of the source's provider endpoint (`computeConfigFingerprint`). */
  configFingerprint: string;
}

/**
 * Per-run memoizer so sources whose extraction cache key is IDENTICAL share
 * ONE extraction: within one generation run the first such source pays for the
 * extraction and every other one awaits the same in-flight promise, so two
 * same-byte files never both pay. The memo key is the full cache key (digest +
 * domain + extractor identity + config fingerprint), so per-source config
 * differences never collapse two derivations into one shared extraction — the
 * dedupe identity is exactly the cache identity (L3). A rejected shared
 * promise is removed from the memo, so a later retry within the same run
 * re-invokes instead of re-receiving the stale rejection. A per-run instance
 * is created once per generation run; the memoized promises live exactly as
 * long as the run.
 *
 * Generic over the extraction's result type: the page memoizes the full
 * `fetchExtractionWithCache` outcome (data + best-effort cache write), so a
 * deduplicated second source still reaches the shared derivation's image
 * asset ids through the winner's `cacheWrite` (RFC #1153 part 2 B).
 */
export function createExtractionDeduplicator(): {
  run: <T>(key: InRunExtractionKey, extraction: () => Promise<T>) => Promise<T>;
} {
  const inflight = new Map<string, Promise<unknown>>();
  return {
    run: <T>(key: InRunExtractionKey, extraction: () => Promise<T>): Promise<T> => {
      const memoKey = extractionCacheKey(
        key.contentDigest,
        key.extractorId,
        key.extractorVersion,
        key.configFingerprint,
        key.domain,
      );
      const existing = inflight.get(memoKey);
      if (existing) return existing as Promise<T>;
      const promise = extraction();
      inflight.set(memoKey, promise);
      // L3: a rejected shared promise must not poison later retries in the
      // same run. Guarded so a settled handler can never remove a NEWER
      // promise that reused the same memo slot.
      promise.catch(() => {
        if (inflight.get(memoKey) === promise) {
          inflight.delete(memoKey);
        }
      });
      return promise;
    },
  };
}
