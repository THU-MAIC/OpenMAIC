/**
 * The material library manifest (RFC #1153 part 2).
 *
 * A per-principal, KV-backed (`account` scope) manifest of the source
 * documents a user has imported. Entries are minted at upload time, keyed by
 * the SHA-256 content digest of the bytes: re-importing the same bytes
 * refreshes the SAME entry (`addedAt` bumped, `assetId` advanced to the newest
 * allocation) instead of minting a duplicate. Removing a selected material
 * before generation never removes the library entry — the library is durable
 * memory of what the user imported; the pool-entry release stays as-is.
 *
 * The two agent-facing atomic tools of RFC design §4 live here and are kept
 * pure and JSON-serializable in/out so a later agent-tool wrapper is trivial:
 *
 * - `listMaterials()` — metadata only, newest first.
 * - `readMaterial(assetId)` — bytes through the existing pool seams.
 *
 * Lineage is NOT duplicated into this manifest. A source entry points at the
 * part-1 derivation records that were produced from its bytes by their key
 * parts — content digest (already the entry key) × domain × extractor@version
 * (`derivations`) — so the extracted images and their lineage stay owned by
 * the derivation records and are reachable from the entry without copying
 * asset ids into two places.
 *
 * Degradation is the part-1 pattern: the KV store is browser-backed by
 * default and server-backed under the same persistence bootstrap flag, and
 * every read/write is defensive against an unavailable backend. A KV failure
 * answers an empty list (with one warn per disable episode) and never throws
 * to the caller; `readMaterial` needs no KV at all and only depends on the
 * pool. This is a client-reachable module: it must never import server-only
 * code (the import-graph guard in
 * `tests/document/material-library-manifest.test.ts` enforces that).
 */
import { BrowserKVStore, HttpKVStore, HttpKVStoreError, type KVStore } from '@openmaic/storage';

import { createLogger } from '@/lib/logger';
import type { AssetPoolStore } from '@/lib/media/asset-pool-config';
import { withAssetUrl } from '@/lib/media/use-asset-url';
import {
  getPersistenceRequestHeaders,
  isBrowserPersistenceEnabled,
} from '@/lib/persistence/bootstrap';

const log = createLogger('MaterialLibrary');

/** Key-prefix of every library entry; bump the `v1` on a record-shape change. */
export const MATERIAL_LIBRARY_KEY_PREFIX = 'material-library:v1';

/** KV scope the manifest lives under: `account`, like the extraction cache. */
export const MATERIAL_LIBRARY_KV_SCOPE = 'account' as const;

/**
 * One derivation pointer: the key parts of a part-1 derivation record
 * (digest × domain × extractor@version) that were produced from this entry's
 * bytes. The record's full cache key is
 * `extractionCacheKey(contentDigest, extractorId, extractorVersion,
 * configFingerprint, domain)`; the config-fingerprint half is per-run
 * deployment config, so the agent resolves it with `computeConfigFingerprint`
 * from `lib/document/extraction-cache.ts` (managed providers share the stable
 * `'managed'` bucket).
 */
export interface MaterialDerivationRef {
  /** Which extraction path produced the derivation (`doc` vs `media`). */
  domain: 'doc' | 'media';
  extractorId: string;
  extractorVersion: string;
}

/**
 * One library entry = the reviewable contract of RFC #1153 part 2.
 *
 * Keyed by `contentDigest` (same bytes re-imported = same entry). `assetId`
 * names the NEWEST allocation of those bytes, so a durable reference an agent
 * hands downstream stays resolvable even after the upload-time pool entry was
 * released; `addedAt` is the newest import instant. `derivations` are pointers
 * to the part-1 derivation records, appended once the extraction identity is
 * known — never a copy of their lineage.
 */
export interface MaterialLibraryEntry {
  /** Pool asset id of the newest allocation of these bytes. */
  assetId: string;
  /** SHA-256 of the bytes (lowercase hex); the entry key. */
  contentDigest: string;
  /** Display name of the imported file (the newest import's name). */
  name: string;
  /** Canonical MIME type of the imported file, when known. */
  mimeType?: string;
  /** Byte length of the imported file. */
  size: number;
  /** ISO-8601 instant of the newest import. */
  addedAt: string;
  /** Pointers to part-1 derivation records by their key parts. */
  derivations?: MaterialDerivationRef[];
}

/** The exact KV key for one entry. */
export function materialLibraryKey(contentDigest: string): string {
  return `${MATERIAL_LIBRARY_KEY_PREFIX}:${contentDigest}`;
}

// ─── KV wiring (browser-backed default, HTTP-backed under persistence) ───────

let libraryKv: KVStore | undefined;

/**
 * The browser-wide KV store for the material library, wired exactly like the
 * extraction cache and the asset pool: browser-backed by default, and
 * server-backed under the same persistence bootstrap flag
 * (`NEXT_PUBLIC_PERSISTENCE=1`), where the account scope is served by the
 * persistence API and the device scope stays on a local store. Every library
 * operation is defensive against this store failing, so an unavailable
 * backend only costs the manifest, never the user's upload or generation.
 */
export function getMaterialLibraryKV(): KVStore {
  return (libraryKv ??= resolveConfiguredMaterialLibraryKV());
}

function resolveConfiguredMaterialLibraryKV(): KVStore {
  if (isBrowserPersistenceEnabled()) {
    return new HttpKVStore({
      baseUrl: '/api/persistence',
      headers: () => getPersistenceRequestHeaders(),
      deviceStore: new BrowserKVStore(),
    });
  }
  if (typeof window === 'undefined') {
    throw new Error('The material library KV store requires browser storage.');
  }
  return new BrowserKVStore();
}

/** Test-only: clear the module singleton between tests. */
export function resetMaterialLibraryForTests(): void {
  libraryKv = undefined;
  libraryDisabledUntilEpochMs = 0;
}

/**
 * Test-only: replace the module KV store. Pass `null` to restore lazy
 * resolution through the configured backend. The agent-facing read/write
 * tools take no store arguments (they stay pure JSON in/out), so this is the
 * injection point tests use to drive a fake KV.
 */
export function setMaterialLibraryKVForTests(kv: KVStore | null): void {
  libraryKv = kv ?? undefined;
}

// ─── Bounded degradation (part-1 pattern) ────────────────────────────────────

/**
 * How long a route-level KV failure disables the library. The disable is
 * timestamped, NOT permanent: a transient route-level 404 (a deploy window, a
 * proxy 404 during rollout) must not kill the manifest for the tab lifetime,
 * so the library re-probes the KV route once the window expires.
 */
const LIBRARY_DISABLE_TTL_MS = 10 * 60 * 1000;

/**
 * Module-level (tab-wide) library disable, expressed as the epoch-ms instant
 * the disable window ends; `0` means not disabled. Set once when the KV
 * backend answers with a route-level failure (the KV route itself is gone, as
 * with `NEXT_PUBLIC_PERSISTENCE=1` today): until the window expires every
 * read answers an empty list and every write is skipped, so the degradation
 * is quiet (one warn per disable episode) and cheap. After expiry a fresh
 * route-level failure starts a new episode with its own single warn.
 * Transient failures (network blips) keep the per-op behavior.
 */
let libraryDisabledUntilEpochMs = 0;

/** Whether the library is inside a disable window right now. */
function isLibraryDisabled(): boolean {
  return libraryDisabledUntilEpochMs > Date.now();
}

/** A route-level KV failure: an HTTP 404 that is NOT the store's key-miss. */
function isRouteLevelKVError(error: unknown): boolean {
  return (
    error instanceof HttpKVStoreError && error.status === 404 && error.code !== 'KEY_NOT_FOUND'
  );
}

/** Disable the library for one window, logging exactly ONE warn per episode. */
function disableLibraryForWindow(error: unknown): void {
  if (isLibraryDisabled()) return;
  libraryDisabledUntilEpochMs = Date.now() + LIBRARY_DISABLE_TTL_MS;
  log.warn(
    `The material library KV route is unreachable; disabling the library manifest for the next ${Math.round(
      LIBRARY_DISABLE_TTL_MS / 60000,
    )} minutes:`,
    error,
  );
}

// ─── Entry validation ─────────────────────────────────────────────────────────

function isValidLibraryEntry(value: unknown): value is MaterialLibraryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<MaterialLibraryEntry>;
  const derivationsValid =
    entry.derivations === undefined ||
    (Array.isArray(entry.derivations) &&
      entry.derivations.every(
        (ref) =>
          typeof ref === 'object' &&
          ref !== null &&
          (ref.domain === 'doc' || ref.domain === 'media') &&
          typeof ref.extractorId === 'string' &&
          typeof ref.extractorVersion === 'string',
      ));
  return (
    typeof entry.assetId === 'string' &&
    typeof entry.contentDigest === 'string' &&
    typeof entry.name === 'string' &&
    (entry.mimeType === undefined || typeof entry.mimeType === 'string') &&
    typeof entry.size === 'number' &&
    typeof entry.addedAt === 'string' &&
    derivationsValid
  );
}

// ─── Write points ────────────────────────────────────────────────────────────

export interface UpsertMaterialLibraryEntryInput {
  /** Pool asset id of the newest allocation of these bytes. */
  assetId: string;
  /** SHA-256 of the bytes; the entry key. */
  contentDigest: string;
  /** Display name of the imported file. */
  name: string;
  /** Canonical MIME type of the imported file, when known. */
  mimeType?: string;
  /** Byte length of the imported file. */
  size: number;
}

/**
 * Upsert one library entry keyed by `contentDigest` (the upload-time write
 * point, RFC #1153 part 2 section A). Same bytes re-imported = same entry:
 * `addedAt` is refreshed to now and `assetId` advanced to the newest
 * allocation; the entry's derivation pointers are preserved across the
 * refresh. Best-effort by contract: a KV failure is logged and never fails
 * the caller's upload (a route-level KV failure disables the manifest for a
 * bounded window, mirroring part 1's cache degradation).
 */
export async function upsertMaterialLibraryEntry(
  input: UpsertMaterialLibraryEntryInput,
): Promise<void> {
  if (isLibraryDisabled()) return;
  let kv: KVStore;
  try {
    kv = getMaterialLibraryKV();
  } catch (error) {
    log.warn('The material library KV store is unavailable; skipping the library write:', error);
    return;
  }

  const key = materialLibraryKey(input.contentDigest);
  try {
    const existing = await kv.get<MaterialLibraryEntry>(key, MATERIAL_LIBRARY_KV_SCOPE);
    const entry: MaterialLibraryEntry = {
      assetId: input.assetId,
      contentDigest: input.contentDigest,
      name: input.name,
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      size: input.size,
      addedAt: new Date().toISOString(),
      // Preserve the derivation pointers across a same-digest re-import.
      ...(existing && isValidLibraryEntry(existing) && existing.derivations
        ? { derivations: existing.derivations }
        : {}),
    };
    await kv.set(key, entry, MATERIAL_LIBRARY_KV_SCOPE);
  } catch (error) {
    if (isRouteLevelKVError(error)) {
      disableLibraryForWindow(error);
    } else {
      log.warn(
        `Failed to upsert the material library entry for "${input.name}"; the upload is unaffected:`,
        error,
      );
    }
  }
}

/**
 * Append a derivation pointer (domain × extractor@version) to the entry for
 * these bytes. Called from the extraction-cache composition once the
 * extraction identity is known (hit or miss), so the entry names the
 * derivation records an agent can consult for derived images and lineage. A
 * duplicate identity is a no-op; a missing entry is skipped with a warn; a KV
 * failure is logged and ignored (best-effort, like every library write).
 */
export async function recordMaterialDerivation(
  contentDigest: string,
  ref: MaterialDerivationRef,
): Promise<void> {
  if (isLibraryDisabled()) return;
  let kv: KVStore;
  try {
    kv = getMaterialLibraryKV();
  } catch (error) {
    log.warn(
      'The material library KV store is unavailable; skipping the derivation record:',
      error,
    );
    return;
  }

  const key = materialLibraryKey(contentDigest);
  try {
    const existing = await kv.get<MaterialLibraryEntry>(key, MATERIAL_LIBRARY_KV_SCOPE);
    if (!existing || !isValidLibraryEntry(existing)) {
      // No upload-time entry exists for these bytes (a legacy session, or the
      // upload-time library write never settled). The pointer is best-effort —
      // there is nothing to point at, and this is a normal condition, not an
      // anomaly worth a warn.
      log.debug(
        `No material library entry exists for digest ${contentDigest}; skipping the derivation pointer.`,
      );
      return;
    }
    const derivations = existing.derivations ?? [];
    const alreadyRecorded = derivations.some(
      (item) =>
        item.domain === ref.domain &&
        item.extractorId === ref.extractorId &&
        item.extractorVersion === ref.extractorVersion,
    );
    if (alreadyRecorded) return;
    await kv.set(
      key,
      { ...existing, derivations: [...derivations, { ...ref }] },
      MATERIAL_LIBRARY_KV_SCOPE,
    );
  } catch (error) {
    if (isRouteLevelKVError(error)) {
      disableLibraryForWindow(error);
    } else {
      log.warn(`Failed to record the material derivation pointer for ${contentDigest}:`, error);
    }
  }
}

// ─── Read API (the agent-facing atomic tools) ────────────────────────────────

/**
 * List the material library, metadata only, newest first (`addedAt` desc).
 * Any KV failure (an unavailable store, a route-level 404, unreadable
 * entries) degrades to an EMPTY list with one warn per disable episode — an
 * agent that cannot reach the manifest gets an honest "nothing known" instead
 * of an error it cannot act on.
 */
export async function listMaterials(): Promise<MaterialLibraryEntry[]> {
  if (isLibraryDisabled()) return [];
  let kv: KVStore;
  try {
    kv = getMaterialLibraryKV();
  } catch (error) {
    log.warn('The material library KV store is unavailable; listing an empty library:', error);
    return [];
  }

  try {
    const keys = await kv.keys(MATERIAL_LIBRARY_KEY_PREFIX + ':', MATERIAL_LIBRARY_KV_SCOPE);
    const entries = (
      await Promise.all(
        keys.map((key) => kv.get<MaterialLibraryEntry>(key, MATERIAL_LIBRARY_KV_SCOPE)),
      )
    ).filter((entry): entry is MaterialLibraryEntry => isValidLibraryEntry(entry));
    return entries.sort(
      (left, right) => new Date(right.addedAt).getTime() - new Date(left.addedAt).getTime(),
    );
  } catch (error) {
    if (isRouteLevelKVError(error)) {
      disableLibraryForWindow(error);
    } else {
      log.warn('Failed to list the material library; returning an empty list:', error);
    }
    return [];
  }
}

/** The bytes of one library asset, JSON-serializable for an agent-tool wrapper. */
export interface MaterialReadResult {
  assetId: string;
  /** The asset bytes as a base64 data URL (the existing pool transport). */
  dataUrl: string;
  mimeType?: string;
  size?: number;
}

/**
 * Read a material's bytes by its allocated asset id, through the existing
 * pool seam (`withAssetUrl`, the same lease the renderer uses). Returns
 * `null` when the asset does not resolve or its bytes cannot be read — never
 * throws. KV is not involved: an asset id resolves in the pool directly, so
 * `readMaterial` works even while the manifest itself is unreachable.
 *
 * The optional `pool` / `fetchImpl` are the test injection points; production
 * omits them and `withAssetUrl` resolves the browser-wide pool itself (the
 * shared owner module owns that access — see the asset-url-boundary guard),
 * so the agent-facing signature stays `readMaterial(assetId)`.
 */
export async function readMaterial(
  assetId: string,
  pool?: AssetPoolStore,
  fetchImpl: typeof fetch = fetch,
): Promise<MaterialReadResult | null> {
  try {
    return await withAssetUrl(
      assetId,
      async (url) => {
        if (!url) return null;
        try {
          const response = await fetchImpl(url);
          if (!response.ok) return null;
          const blob = await response.blob();
          if (blob.size === 0) return null;
          return {
            assetId,
            dataUrl: await blobToDataUrl(blob),
            ...(blob.type ? { mimeType: blob.type } : {}),
            size: blob.size,
          };
        } catch {
          return null;
        }
      },
      pool,
    );
  } catch {
    return null;
  }
}

/** Encode a Blob as a base64 data URL without a DOM FileReader (environment-agnostic). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
  });
}
