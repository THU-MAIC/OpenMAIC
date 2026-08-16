/**
 * Legacy asset-reference converter (#1007 part 2, step c).
 *
 * Pre-conversion documents reference generated media through context-relative
 * handles whose bytes live outside any storage abstraction: `gen_img_*` /
 * `gen_vid_*` slide placeholders (bytes in the Dexie `mediaFiles` table, keyed
 * `${stageId}:${ref}`), TTS-derived `audioId`s (bytes in Dexie `audioFiles`),
 * and server-classroom speech actions carrying a raw `audioUrl` beside the
 * `audioId`. This module rewrites a loaded document to the 0.2.0 reference
 * model: every legacy handle whose bytes are available is ingested into the
 * asset pool and replaced by the allocated asset id.
 *
 * Conversion rules, per reference:
 *
 * - Slide placeholder with a usable `mediaFiles` row (no error, non-empty
 *   blob): ingest the row's bytes, rewrite the reference. One logical ref
 *   allocates ONE asset no matter how many slots (or the video manifest) name
 *   it -- the row they shared was already one byte store.
 * - Speech `audioId` with an `audioFiles` row: ingest, rewrite, and mirror the
 *   row under the new id (Dexie stays a deliberate compatibility copy until
 *   Part 3 converges exporters onto the pool). A co-present `audioUrl`
 *   collapses into the same single asset: the pair names one narration, and
 *   the URL is dropped once the id is confirmed resolvable.
 * - Co-present pair whose `audioId` is dangling (no pool entry, no Dexie row):
 *   the URL is the only live handle, so it is fetched and ingested; the
 *   `audioId` becomes the allocated id and the URL is dropped. An
 *   allocation-shaped `audioId` carrying a co-present URL is probed before
 *   the URL is dropped: an imported or cross-browser document can name an id
 *   this pool never minted, and the co-present URL is then the live handle.
 * - An `audioUrl` that no longer resolves (a definitive HTTP refusal):
 *   converts to NO asset and an emptied reference -- a dead URL is never
 *   carried into the new format.
 * - Bytes unavailable (missing/failed Dexie row, transient fetch failure):
 *   the legacy references are kept UNTOUCHED rather than lost silently; the
 *   document converts on a later open once the bytes are back.
 *
 * Idempotent: a converted document holds pool-backed allocated ids, no
 * placeholders, and no `audioUrl`, so re-running is a no-op.
 *
 * The pure DSL migration ladder (`0.1.0 -> 0.2.0`) deliberately does none of
 * this: it cannot read local bytes or probe URLs. It covers only documents
 * this converter never reached.
 */

import type { AssetMeta, Slide } from '@openmaic/dsl';
import { createLogger } from '@/lib/logger';
import type { AppDocument } from '@/lib/document-store/persistence-types';
import type { Action, SpeechAction } from '@/lib/types/action';
import type { AppScene, Stage } from '@/lib/types/stage';
import { makeScene } from '@/lib/types/stage';
import type { AudioFileRecord, MediaFileRecord } from '@/lib/utils/database';
import { fetchMediaUrl } from './fetch-media-url';
import { isGeneratedMediaPlaceholder } from './media-ref';
import { slideMediaReferenceSlots } from './slide-media-slots';

const log = createLogger('LegacyAssetConversion');

/**
 * The removed-from-contract field as stored documents and server classroom
 * payloads still carry it. Only this converter (and the pure ladder, for
 * documents it never reaches) may still read it; every other consumer was
 * switched to the converted shape in the same delivery unit.
 */
type LegacySpeechAction = SpeechAction & { audioUrl?: string };
export type { LegacySpeechAction };

/**
 * Outcome of reaching for the bytes behind a legacy `audioUrl`. The fetch is
 * also the reachability probe: one GET answers both. `dead` is a definitive
 * refusal (HTTP 4xx -- the server asserts the bytes are gone); anything
 * transient (network error, 5xx, timeout) is `unavailable`, so a flaky
 * connection never empties a reference that a later open could still convert.
 */
export type LegacyUrlFetch =
  | { readonly kind: 'ok'; readonly blob: Blob }
  | { readonly kind: 'dead' }
  | { readonly kind: 'unavailable' };

export interface LegacyAssetConversionDeps {
  /** Ingest bytes into the asset pool; resolves to the allocated asset id. */
  putAsset(blob: Blob, meta: AssetMeta): Promise<string>;
  /** Whether the pool already holds an entry for a ref (an allocated id). */
  assetRefExists(ref: string): Promise<boolean>;
  /** Legacy generated-media row for a `${stageId}:${ref}` placeholder. */
  getMediaRecord(stageId: string, ref: string): Promise<MediaFileRecord | undefined>;
  /** Legacy TTS row for an `audioId`. */
  getAudioRecord(audioId: string): Promise<AudioFileRecord | undefined>;
  /**
   * Write the post-conversion Dexie compatibility copy of a media row, keyed
   * by the ref the document now names. Without it the export/import
   * round-trip breaks: collectMediaFiles derives ZIP references from row
   * keys, so a converted document would point at media the export only knows
   * by the old placeholder. Same double-write discipline as the audio path.
   */
  putMediaRecord(stageId: string, ref: string, record: MediaFileRecord): Promise<void>;
  /** Write the post-conversion Dexie compatibility copy of an audio row. */
  putAudioRecord(record: AudioFileRecord): Promise<void>;
  /**
   * The compatibility row a previous (possibly partial) conversion mirrored
   * for this legacy pair, if any. This is what makes a retry idempotent:
   * without it, a conversion that failed after allocating would allocate a
   * fresh twin on every retry. When BOTH origin keys are supplied the row
   * must match BOTH: actions sharing an id across different urls are distinct
   * logical references, and reusing the first pair's allocation for the
   * second would stamp one narration's bytes onto the other. Single-key
   * lookups (id-only, URL-only) still match on the one supplied key.
   */
  getMirroredAudioRecord(
    stageId: string,
    keys: { audioId?: string; audioUrl?: string },
  ): Promise<AudioFileRecord | undefined>;
  /**
   * Remove an allocation nothing references anymore -- the compensation when
   * a compatibility write fails after the allocation succeeded, so a failed
   * conversion does not strand entries (and their quota) in the pool.
   */
  removeAsset(ref: string): Promise<void>;
  /** Fetch (and thereby probe) a legacy `audioUrl`. */
  fetchLegacyUrl(url: string): Promise<LegacyUrlFetch>;
}

/** Run each job through at most `limit` workers, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  // The first rejection stops the pool from scheduling new work, and the
  // pool is joined before the error propagates: a caller degrading to the
  // unconverted document never leaves siblings still committing effects.
  let failed = false;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failed) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}

/**
 * Thrown when the caller's liveness check fails mid-conversion. Callers that
 * degrade to the unconverted document (the classroom fetch path) treat this
 * like any converter failure; the document load path never passes a check.
 * Carries the fresh allocations made before the abort, so a caller that
 * discards the result can roll them back instead of stranding them.
 */
export class LegacyConversionAbortedError extends Error {
  override readonly name = 'LegacyConversionAbortedError';
  constructor(readonly allocatedIds: readonly string[]) {
    super('legacy asset conversion aborted');
  }
}

export interface LegacyAssetConversionReport {
  /** References rewritten to a freshly allocated asset id. */
  converted: number;
  /** References emptied because their only handle no longer resolves. */
  emptied: number;
  /** Legacy references left untouched because their bytes are unavailable. */
  kept: number;
}

export interface LegacyAssetConversionResult {
  document: AppDocument;
  /** False when nothing was rewritten -- the input is returned by identity. */
  changed: boolean;
  report: LegacyAssetConversionReport;
  /**
   * Ids this pass freshly allocated (reused mirrors are not listed). A caller
   * that ends up rejecting the converted document -- a superseded classroom
   * load -- rolls these back, so a discarded payload leaves no pool entries.
   */
  allocatedIds: string[];
}

/**
 * Locate a legacy media row by exact key first, then by a retained
 * `placeholderRef`. Rows re-keyed to an allocated id keep the original gen_*
 * reference in that field for reload reconciliation, and a document not yet
 * converted still names the placeholder -- the exact key alone would miss
 * bytes that are right there.
 */
export async function findLegacyMediaRecord(
  db: {
    mediaFiles: {
      get(key: string): Promise<MediaFileRecord | undefined>;
      where(field: 'stageId'): {
        equals(stageId: string): {
          and(pred: (row: MediaFileRecord) => boolean): {
            first(): Promise<MediaFileRecord | undefined>;
          };
        };
      };
    };
  },
  mediaFileKey: (stageId: string, ref: string) => string,
  stageId: string,
  ref: string,
  assetRefExists: (ref: string) => Promise<boolean>,
): Promise<MediaFileRecord | undefined> {
  const exact = await db.mediaFiles.get(mediaFileKey(stageId, ref));
  const mirror = await db.mediaFiles
    .where('stageId')
    .equals(stageId)
    .and((row) => row.placeholderRef === ref && row.id !== mediaFileKey(stageId, ref))
    .first();
  // A pool-backed mirror wins over the exact row: it is the retry's recovery
  // handle, and preferring the exact row would allocate a twin of it.
  if (mirror) {
    const keyedRef = mirror.id.startsWith(`${stageId}:`)
      ? mirror.id.slice(stageId.length + 1)
      : undefined;
    if (keyedRef && (await assetRefExists(keyedRef))) return mirror;
  }
  return exact ?? mirror;
}

/**
 * Undo a discarded conversion's side effects: the pool entries, and the
 * Dexie compatibility rows keyed by them (audio by the allocated id, media
 * by the stage-scoped compound key). Idempotent and best-effort.
 */
export async function rollbackConvertedAllocations(
  stageId: string,
  allocatedIds: readonly string[],
): Promise<void> {
  if (allocatedIds.length === 0) return;
  const [{ removeAsset }, { db }] = await Promise.all([
    import('./asset-pool'),
    import('@/lib/utils/database'),
  ]);
  for (const id of allocatedIds) {
    await removeAsset(id).catch(() => undefined);
    await db.audioFiles.delete(id).catch(() => undefined);
    await db.mediaFiles.delete(`${stageId}:${id}`).catch(() => undefined);
  }
}

/**
 * Whether a reference is the server classroom media transport: a
 * `/api/classroom-media/...` URL, relative or absolute. Server generation
 * rewrites placeholders to these before the document reaches a client, and
 * the bytes behind them are exactly what conversion must ingest.
 */
export function isClassroomMediaUrl(ref: string | undefined): ref is string {
  if (!ref) return false;
  try {
    return new URL(ref, 'http://local.invalid').pathname.startsWith('/api/classroom-media/');
  } catch {
    return false;
  }
}

/**
 * Whether a document still carries server classroom media transport URLs
 * anywhere the converter rewrites -- including speech actions' `audioUrl`,
 * whose bytes the converter ingests regardless of URL shape. Used to recognize
 * a payload whose conversion is incomplete -- or a persisted document that
 * predates conversion -- so the server-fallback load path never applies or
 * persists a deployment-specific address.
 */
export function containsClassroomMediaUrls(document: AppDocument): boolean {
  const slideContainsTransport = (slide: SlideLike): boolean =>
    [...slideMediaReferenceSlots(slide)].some((slot) => isClassroomMediaUrl(slot.read()));

  if (document.stage.whiteboard?.some(slideContainsTransport)) return true;
  if (Object.keys(document.stage.videoManifest ?? {}).some(isClassroomMediaUrl)) return true;
  return document.scenes.some(
    (scene) =>
      (scene.content.type === 'slide' && slideContainsTransport(scene.content.canvas)) ||
      scene.whiteboards?.some(slideContainsTransport) === true ||
      // A speech action that still carries an audioUrl after conversion means
      // audio conversion did not complete; the URL is a transport handle the
      // converter rewrites, so it must not pass the completeness guard.
      scene.actions?.some(
        (action) => action.type === 'speech' && Boolean((action as LegacySpeechAction).audioUrl),
      ) === true,
  );
}

/** The default production wiring: Dexie legacy tables plus the app asset pool. */
async function defaultDeps(): Promise<LegacyAssetConversionDeps> {
  const [{ db, mediaFileKey }, { putAsset, removeAsset }, { assetRefExists }] = await Promise.all([
    import('@/lib/utils/database'),
    import('./asset-pool'),
    import('./use-asset-url'),
  ]);
  return {
    putAsset: (blob, meta) => putAsset(blob, meta),
    assetRefExists: (ref) => assetRefExists(ref),
    getMediaRecord: (stageId, ref) =>
      findLegacyMediaRecord(db, mediaFileKey, stageId, ref, assetRefExists),
    getAudioRecord: (audioId) => db.audioFiles.get(audioId),
    putMediaRecord: (stageId, ref, record) =>
      db.mediaFiles
        .put({ ...record, id: mediaFileKey(stageId, ref), stageId })
        .then(() => undefined),
    putAudioRecord: (record) => db.audioFiles.put(record).then(() => undefined),
    getMirroredAudioRecord: (stageId, keys) =>
      db.audioFiles
        .filter((row) => {
          if (row.stageId !== stageId) return false;
          const idMatches = keys.audioId === undefined || row.originAudioId === keys.audioId;
          const urlMatches = keys.audioUrl === undefined || row.originAudioUrl === keys.audioUrl;
          return idMatches && urlMatches;
        })
        .first(),
    removeAsset: (ref) => removeAsset(ref),
    fetchLegacyUrl: async (url) => {
      try {
        // Cross-origin URLs go through the same-origin media proxy: a plain
        // fetch is CORS-blocked exactly where an <audio> element would still
        // play, and the proxy carries the SSRF guard and its response limit.
        // Bounded either way: conversion runs on the document load path, and
        // one stalled URL must not hold the document lock indefinitely.
        const response = await fetchMediaUrl(url, 15_000);
        if (response.ok) return { kind: 'ok', blob: await response.blob() };
        // Only definitive absence empties the reference. A 408 or 429 is
        // transient by definition, a 401 or 403 may clear on a credential
        // refresh, and any of them would make the deletion permanent for a
        // temporary condition.
        return {
          kind: response.status === 404 || response.status === 410 ? 'dead' : 'unavailable',
        };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}

function mediaMeta(record: MediaFileRecord, blob: Blob): AssetMeta {
  let params: unknown;
  try {
    params = JSON.parse(record.params || '{}');
  } catch {
    params = {};
  }
  return {
    contentType: blob.type || record.mimeType,
    mediaType: record.type,
    prompt: record.prompt,
    params,
    origin: 'legacy-mediaFiles',
  };
}

function audioFormat(blob: Blob, record: AudioFileRecord | undefined, fallback = 'mp3'): string {
  if (record?.format) return record.format;
  const subtype = blob.type.split('/')[1];
  return subtype || fallback;
}

function audioMeta(
  blob: Blob,
  record: AudioFileRecord | undefined,
  action: LegacySpeechAction,
): AssetMeta {
  const voice = action.voice ?? record?.voice;
  return {
    contentType: blob.type || `audio/${audioFormat(blob, record)}`,
    mediaType: 'audio',
    text: action.text,
    ...(voice ? { voice } : {}),
    ...(record?.duration !== undefined ? { duration: record.duration } : {}),
    origin: record ? 'legacy-audioFiles' : 'legacy-audioUrl',
  };
}

type SlideLike = Pick<Slide, 'background' | 'elements'>;

/**
 * Total wall-clock budget for legacy URL probes in one conversion pass. Each
 * probe is individually capped; this caps the aggregate, so a document full
 * of stalled URLs cannot hold the load path for (count / concurrency) times
 * the per-probe timeout.
 */
const URL_PROBE_BUDGET_MS = 60_000;

/**
 * Convert every legacy media reference in a loaded document to an allocated
 * asset id. The input document is never mutated; the side effects are pool
 * ingests and Dexie compatibility mirror writes.
 *
 * Crash-safety ordering mirrors the generation write paths: pool bytes first,
 * the Dexie compatibility copy second, and the in-memory document rewrite
 * last, so a failure mid-conversion never leaves the persisted document
 * pointing at bytes that were never stored.
 */

export async function convertDocumentAssetRefs(
  document: AppDocument,
  deps?: LegacyAssetConversionDeps,
  shouldContinue?: () => boolean,
  ledger?: string[],
): Promise<LegacyAssetConversionResult> {
  const resolvedDeps = deps ?? (await defaultDeps());
  const stageId = document.stage.id;
  // The URL probes are the only network-bound work here, and each is already
  // individually capped, but a document full of stalled URLs would still
  // multiply that cap by the clip count. One shared budget bounds the whole
  // pass; what is left converts on a later open. Every probe -- including the
  // ossKey recovery fetches -- routes through it, or several stalled CDN
  // fetches could exceed the advertised aggregate conversion budget.
  const urlProbeBudgetEndsAt = Date.now() + URL_PROBE_BUDGET_MS;
  const withinUrlProbeBudget = (): boolean => Date.now() <= urlProbeBudgetEndsAt;
  /**
   * Ids this pass freshly allocated. A caller may share the array to own the
   * rollback itself: any failure path -- liveness abort or an ordinary worker
   * error -- then still compensates what the pass committed.
   */
  const allocatedIds = ledger ?? [];
  // Liveness probe for callers whose own work can be superseded mid-flight
  // (a classroom load): a stale conversion must stop producing side effects
  // as soon as its result is known to be unwanted, not after the last fetch.
  const assertContinuing = (): void => {
    if (shouldContinue && !shouldContinue()) throw new LegacyConversionAbortedError(allocatedIds);
  };
  // One allocation per logical legacy ref, shared across every slot, manifest
  // key, and speech action that names it -- they already shared one byte
  // store. The map holds the in-flight promise, not just the settled value:
  // slides convert concurrently, and caching only completed allocations would
  // let two slides naming one ref each allocate their own asset.
  const allocationByRef = new Map<string, Promise<string | null>>();
  /**
   * Outcome of reaching for the bytes behind a legacy URL-backed reference,
   * shared by the speech pairs and the classroom media transport URLs.
   * `dead` is a definitive refusal (the fetch answered 404/410); `unavailable`
   * is anything transient, which keeps the reference for a later open.
   */
  type UrlOutcome =
    | { readonly kind: 'allocated'; readonly assetId: string }
    | { readonly kind: 'dead' }
    | { readonly kind: 'unavailable' };
  /** Outcome of the URL-backed speech path, cached per dangling (id, url) pair. */
  const urlOutcomeByRef = new Map<string, Promise<UrlOutcome>>();
  /** Outcome of the classroom-media URL path, cached per URL. */
  const mediaUrlOutcomeByRef = new Map<string, Promise<UrlOutcome>>();
  const report: LegacyAssetConversionReport = { converted: 0, emptied: 0, kept: 0 };
  let changed = false;

  /** Allocate (once) for a placeholder with local or CDN bytes; null when unusable. */
  const allocateMediaRef = (ref: string): Promise<string | null> => {
    const inFlight = allocationByRef.get(ref);
    if (inFlight) return inFlight;
    const pending = (async (): Promise<string | null> => {
      const record = await resolvedDeps.getMediaRecord(stageId, ref);
      // A zero-length local blob with an ossKey is an evicted row: the CDN
      // copy is the live byte source, and export already treats it that way.
      let source: Blob | undefined;
      const usable = !!record && !record.error && !!record.blob && record.blob.size > 0;
      if (usable) {
        source = record.blob.type
          ? record.blob
          : new Blob([record.blob], { type: record.mimeType });
      } else if (record && record.ossKey && withinUrlProbeBudget()) {
        const fetched = await resolvedDeps.fetchLegacyUrl(record.ossKey);
        // Zero-byte responses are not usable bytes: the row stays retryable
        // instead of allocating an empty asset.
        if (fetched.kind === 'ok' && fetched.blob.size > 0) {
          source = fetched.blob.type
            ? fetched.blob
            : new Blob([fetched.blob], { type: record.mimeType });
        }
      }
      if (!record || !source) {
        report.kept += 1;
        return null;
      }
      // A previous conversion -- or the recovery write path -- may already
      // have keyed this row to an allocated id. Reuse it rather than
      // allocating a twin entry for the same bytes.
      const keyedRef = record.id.startsWith(`${stageId}:`)
        ? record.id.slice(stageId.length + 1)
        : undefined;
      if (keyedRef && keyedRef !== ref && (await existsOnce(keyedRef))) {
        report.converted += 1;
        return keyedRef;
      }
      const assetId = await resolvedDeps.putAsset(source, mediaMeta(record, source));
      allocatedIds.push(assetId);
      try {
        // Liveness is rechecked at the commit boundary: an abort between the
        // allocation and its mirror compensates the allocation, exactly like
        // a mirror-write failure.
        assertContinuing();
        // Mirror the row under the allocated id, like the audio path and the
        // generation write path: collectMediaFiles derives export references
        // from row keys, so without the copy an exported manifest would name
        // media the ZIP only knows by the old placeholder. The original ref
        // stays on placeholderRef for reload reconciliation.
        await resolvedDeps.putMediaRecord(stageId, assetId, {
          ...record,
          placeholderRef: record.placeholderRef ?? ref,
        });
      } catch (error) {
        // Do not strand an allocation nothing references.
        await resolvedDeps.removeAsset(assetId).catch(() => undefined);
        throw error;
      }
      report.converted += 1;
      return assetId;
    })();
    allocationByRef.set(ref, pending);
    return pending;
  };

  /**
   * Allocate (once) for a server classroom media transport URL. The outcome
   * is three-state: allocated bytes rewrite the slot, a definitive 404/410
   * removes the dead reference (a dead URL is never carried into the new
   * format), and a transient failure keeps it for a later open.
   */
  const allocateUrlMediaRef = (url: string): Promise<UrlOutcome> => {
    const inFlight = mediaUrlOutcomeByRef.get(url);
    if (inFlight) return inFlight;
    const pending = (async (): Promise<UrlOutcome> => {
      if (!withinUrlProbeBudget()) return { kind: 'unavailable' };
      const fetched = await resolvedDeps.fetchLegacyUrl(url);
      if (fetched.kind !== 'ok') {
        return fetched.kind === 'dead' ? { kind: 'dead' } : { kind: 'unavailable' };
      }
      // Zero-byte responses are not usable bytes: keep the reference and
      // retry on a later open rather than allocating an empty asset.
      if (fetched.blob.size === 0) return { kind: 'unavailable' };
      const isVideo = /\.(mp4|webm|mov)(\?|#|$)/i.test(url);
      const assetId = await resolvedDeps.putAsset(fetched.blob, {
        contentType: fetched.blob.type || undefined,
        mediaType: isVideo ? 'video' : 'image',
        origin: 'classroom-media-url',
      });
      allocatedIds.push(assetId);
      try {
        assertContinuing();
        // Mirror like the placeholder path, so export and stage deletion see
        // the same rows they see for any converted media.
        await resolvedDeps.putMediaRecord(stageId, assetId, {
          id: `${stageId}:${assetId}`,
          stageId,
          type: isVideo ? 'video' : 'image',
          blob: fetched.blob,
          mimeType: fetched.blob.type || (isVideo ? 'video/mp4' : 'image/png'),
          size: fetched.blob.size,
          prompt: '',
          params: '{}',
          createdAt: Date.now(),
          placeholderRef: url,
        });
      } catch (error) {
        await resolvedDeps.removeAsset(assetId).catch(() => undefined);
        throw error;
      }
      report.converted += 1;
      return { kind: 'allocated', assetId };
    })();
    mediaUrlOutcomeByRef.set(url, pending);
    return pending;
  };

  const convertSlide = async <T extends SlideLike>(slide: T): Promise<T> => {
    assertContinuing();
    const slots = [...slideMediaReferenceSlots(slide)];
    const rewrites: Array<{ index: number; assetId: string }> = [];
    const removals: number[] = [];
    for (let index = 0; index < slots.length; index += 1) {
      const ref = slots[index].read();
      if (isGeneratedMediaPlaceholder(ref)) {
        const assetId = await allocateMediaRef(ref);
        if (assetId) rewrites.push({ index, assetId });
      } else if (isClassroomMediaUrl(ref)) {
        // Server classrooms ship media as transport URLs; ingest their bytes
        // rather than persisting a deployment-specific address. A confirmed
        // dead URL is emptied (removed), never preserved or allocated.
        const outcome = await allocateUrlMediaRef(ref);
        if (outcome.kind === 'allocated') {
          rewrites.push({ index, assetId: outcome.assetId });
        } else if (outcome.kind === 'dead') {
          removals.push(index);
          report.emptied += 1;
        } else {
          report.kept += 1;
        }
      }
    }
    if (rewrites.length === 0 && removals.length === 0) return slide;
    // Rewrite on a clone so the caller's document is never mutated. Slot
    // iteration order is deterministic, so the clone's slots align by index.
    const clone = structuredClone(slide);
    const cloneSlots = [...slideMediaReferenceSlots(clone)];
    for (const { index, assetId } of rewrites) cloneSlots[index].write(assetId);
    // Emptied slots remove the dead reference entirely: an empty src cannot
    // trip the classroom-transport completeness guard.
    for (const index of removals) cloneSlots[index].write(undefined);
    changed = true;
    return clone;
  };

  // Existence answers are memoized within the pass, so a probe costs one
  // request per unique id per pass, never per action. A probe only happens
  // when a recovery handle is at stake: an allocation-shaped id with no
  // co-present URL is trusted without one (nothing droppable is lost if the
  // trust is wrong -- the read was a miss either way), while a co-present URL
  // is dropped only after the probe confirms the id resolves, because an
  // imported or cross-browser document can name an id this pool never minted
  // and the URL is then the only live handle.
  const existsMemo = new Map<string, Promise<boolean>>();
  const existsOnce = (ref: string): Promise<boolean> => {
    const pending = existsMemo.get(ref);
    if (pending) return pending;
    const probe = resolvedDeps.assetRefExists(ref);
    existsMemo.set(ref, probe);
    return probe;
  };
  const hasAllocatedShape = (ref: string): boolean => ref.startsWith('ast_');

  const convertSpeechAction = async (action: Action): Promise<Action> => {
    assertContinuing();
    if (action.type !== 'speech') return action;
    const speech = action as LegacySpeechAction;
    const audioId = speech.audioId || undefined;
    const audioUrl = speech.audioUrl || undefined;
    if (!audioId && !audioUrl) return action;

    // Pool-backed means the id resolves in the current pool. For an
    // allocation-shaped id with nothing beside it, the shape alone suffices
    // (see above); any other id -- or an id whose drop would take a live URL
    // with it -- is confirmed by the memoized per-pass probe. An id the pool
    // does not hold is not treated as converted, and the co-present URL falls
    // through to the dangling branch below as the live handle.
    const poolBacked =
      audioId !== undefined &&
      (hasAllocatedShape(audioId) && audioUrl === undefined ? true : await existsOnce(audioId));
    if (audioId && poolBacked) {
      // Already converted (pool-backed). Only a stale co-present URL remains
      // to drop; the id was confirmed resolvable above, so the URL is safe to
      // discard.
      if (!audioUrl) return action;
      const next: LegacySpeechAction = { ...speech };
      delete next.audioUrl;
      changed = true;
      return next;
    }

    const record = audioId ? await resolvedDeps.getAudioRecord(audioId) : undefined;
    const recordHasBytes = !!record && record.blob.size > 0;
    // An evicted row (empty blob, live ossKey) still has its bytes on the CDN;
    // export already treats ossKey as the live source, and conversion does too.
    if (audioId && record && (recordHasBytes || record.ossKey)) {
      // The id's own row is the byte source for this reference. Two actions
      // sharing an id but carrying different urls are different logical
      // references -- the exact rule the dangling branch already enforces --
      // so the recovery mirror lookup and the in-pass cache both key on the
      // (id, url) pair when a URL is present: a mirror written for (id,
      // URL-A) must never be reused for (id, URL-B), whose narration it does
      // not hold.
      const pairKey = audioUrl === undefined ? audioId : `${audioId}\u0000${audioUrl}`;
      const pendingAudio =
        allocationByRef.get(pairKey) ??
        (async (): Promise<string | null> => {
          // A previous partially committed conversion may already have
          // mirrored this exact pair; reuse its allocation instead of
          // orphaning a twin entry on every retry. When both origin keys
          // are present the lookup must match BOTH: an id-only match could
          // be a mirror written for a different url, and reusing it would
          // stamp that pair's bytes onto this one.
          const mirrored = await resolvedDeps.getMirroredAudioRecord(
            stageId,
            audioUrl === undefined ? { audioId } : { audioId, audioUrl },
          );
          if (mirrored && (await existsOnce(mirrored.id))) {
            report.converted += 1;
            return mirrored.id;
          }
          let source: Blob | undefined = recordHasBytes ? record.blob : undefined;
          if (!source && record.ossKey && withinUrlProbeBudget()) {
            const fetched = await resolvedDeps.fetchLegacyUrl(record.ossKey);
            // Zero-byte responses are not usable bytes: keep the row retryable.
            if (fetched.kind === 'ok' && fetched.blob.size > 0) source = fetched.blob;
          }
          if (!source) return null;
          const allocated = await resolvedDeps.putAsset(source, audioMeta(source, record, speech));
          allocatedIds.push(allocated);
          try {
            // Liveness is rechecked at the commit boundary, like the media path.
            assertContinuing();
            // Dexie stays a deliberate compatibility double-write until Part
            // 3 converges exporters and import/export onto the pool; mirror
            // the row under the allocated id, keyed like the generation
            // write path, with the legacy id -- and the url, when the action
            // carries one -- retained for retry recovery. Recording both
            // keys is what lets a later retry of THIS pair reuse the
            // allocation while a different url on the same id still misses
            // it.
            await resolvedDeps.putAudioRecord({
              ...record,
              id: allocated,
              stageId,
              originAudioId: audioId,
              ...(audioUrl ? { originAudioUrl: audioUrl } : {}),
            });
          } catch (error) {
            // Do not strand an allocation nothing references.
            await resolvedDeps.removeAsset(allocated).catch(() => undefined);
            throw error;
          }
          report.converted += 1;
          return allocated;
        })();
      allocationByRef.set(pairKey, pendingAudio);
      const assetId = await pendingAudio;
      if (!assetId) {
        report.kept += 1;
        return action;
      }
      const next: LegacySpeechAction = { ...speech, audioId: assetId };
      // The id now resolves, and the allocation IS this pair's: either the
      // recovery mirror matched both origin keys, or the bytes came from
      // this row (its blob or its ossKey). Only then is the co-present URL
      // dropped -- never when a mirror for a different url was reused.
      delete next.audioUrl;
      changed = true;
      return next;
    }

    if (audioUrl) {
      // The audioId is dangling (or absent): the URL is the only live handle.
      // Actions sharing one pair (id AND url) also share this allocation,
      // cached like the local-byte paths -- otherwise each would fetch
      // identical bytes and receive its own twin entry. The pair, not the id
      // alone, is the cache key: two actions sharing an id but carrying
      // different urls are different logical references, and keying on the id
      // would reuse the first fetch's outcome for the second url -- assigning
      // the wrong bytes or propagating a dead outcome to a live URL.
      const urlKey = `${audioId ?? ''}\u0000${audioUrl}`;
      const pendingUrl =
        urlOutcomeByRef.get(urlKey) ??
        (async (): Promise<UrlOutcome> => {
          // A previous partially committed conversion may already have
          // fetched this URL and mirrored it; reuse its allocation instead of
          // fetching and allocating again on every retry.
          const mirrored = await resolvedDeps.getMirroredAudioRecord(stageId, {
            audioId,
            audioUrl,
          });
          if (mirrored && (await existsOnce(mirrored.id))) {
            report.converted += 1;
            return { kind: 'allocated', assetId: mirrored.id };
          }
          if (!withinUrlProbeBudget()) {
            // The document cannot wait for every stalled URL; the rest of
            // this pass converts on a later open.
            return { kind: 'unavailable' };
          }
          const fetched = await resolvedDeps.fetchLegacyUrl(audioUrl);
          // Zero-byte responses are not usable bytes: the pair stays
          // retryable and the URL remains the live fallback, never an
          // allocated empty asset.
          if (fetched.kind === 'ok' && fetched.blob.size > 0) {
            const assetId = await resolvedDeps.putAsset(
              fetched.blob,
              audioMeta(fetched.blob, undefined, speech),
            );
            allocatedIds.push(assetId);
            try {
              // Liveness is rechecked at the commit boundary, like the media path.
              assertContinuing();
              await resolvedDeps.putAudioRecord({
                id: assetId,
                stageId,
                blob: fetched.blob,
                format: audioFormat(fetched.blob, undefined),
                text: speech.text,
                voice: speech.voice,
                createdAt: Date.now(),
                // Both origin keys are recoverable handles for the next
                // retry; a URL-only action has no legacy id to key on.
                ...(audioId ? { originAudioId: audioId } : {}),
                originAudioUrl: audioUrl,
              });
            } catch (error) {
              // Do not strand an allocation nothing references.
              await resolvedDeps.removeAsset(assetId).catch(() => undefined);
              throw error;
            }
            report.converted += 1;
            return { kind: 'allocated', assetId };
          }
          return fetched.kind === 'dead' ? { kind: 'dead' } : { kind: 'unavailable' };
        })();
      urlOutcomeByRef.set(urlKey, pendingUrl);
      const outcome = await pendingUrl;
      if (outcome.kind === 'allocated') {
        const next: LegacySpeechAction = { ...speech, audioId: outcome.assetId };
        delete next.audioUrl;
        changed = true;
        return next;
      }
      if (outcome.kind === 'dead') {
        // A URL that no longer resolves converts to NO asset and an emptied
        // reference: a dead URL is never carried into the new format.
        const next: LegacySpeechAction = { ...speech };
        delete next.audioId;
        delete next.audioUrl;
        changed = true;
        report.emptied += 1;
        return next;
      }
      // Transient fetch failure: keep both legacy handles and retry on a
      // later open rather than losing the reference silently.
    }
    report.kept += 1;
    return action;
  };

  const stage = document.stage;
  let whiteboard = stage.whiteboard;
  if (whiteboard) {
    const converted = await Promise.all(whiteboard.map((slide) => convertSlide(slide)));
    if (converted.some((slide, index) => slide !== whiteboard![index])) {
      whiteboard = converted;
    }
  }

  const scenes: AppScene[] = [];
  for (const scene of document.scenes) {
    let nextScene = scene;
    if (scene.content.type === 'slide') {
      const canvas = await convertSlide(scene.content.canvas);
      if (canvas !== scene.content.canvas) {
        // Rebuild through makeScene so the discriminated union stays bound:
        // a plain spread cannot prove the canvas lands on the slide member.
        const { type: _type, content: _content, ...core } = nextScene;
        void _type;
        void _content;
        nextScene = makeScene(core, { ...scene.content, canvas });
      }
    }
    if (scene.whiteboards) {
      const converted = await Promise.all(scene.whiteboards.map((slide) => convertSlide(slide)));
      if (converted.some((slide, index) => slide !== scene.whiteboards![index])) {
        nextScene = { ...nextScene, whiteboards: converted };
      }
    }
    scenes.push(nextScene);
  }

  // Speech actions across ALL scenes through one bounded pool: converting
  // per scene would multiply the per-fetch timeout by the scene count when a
  // legacy endpoint stalls. The promise caches make concurrent conversion of
  // shared references safe.
  const speechJobs: Array<{ sceneIndex: number; actionIndex: number; action: Action }> = [];
  document.scenes.forEach((scene, sceneIndex) => {
    scene.actions?.forEach((action, actionIndex) => {
      if (action.type === 'speech') speechJobs.push({ sceneIndex, actionIndex, action });
    });
  });
  const convertedSpeech = await mapWithConcurrency(speechJobs, 4, (job) =>
    convertSpeechAction(job.action),
  );
  for (const [index, job] of speechJobs.entries()) {
    const converted = convertedSpeech[index];
    if (converted === job.action) continue;
    const scene = scenes[job.sceneIndex];
    const actions = (scene.actions ?? document.scenes[job.sceneIndex].actions)?.map((action, i) =>
      i === job.actionIndex ? converted : action,
    );
    scenes[job.sceneIndex] = { ...scene, actions };
  }

  // The video manifest is keyed by the same media refs; re-key placeholder
  // entries whose bytes were (or can still be) ingested, drop entries whose
  // transport URL is confirmed dead, and keep transiently unavailable ones
  // under the legacy key for a later open.
  let videoManifest = stage.videoManifest;
  if (videoManifest) {
    let manifestChanged = false;
    const nextManifest: typeof videoManifest = {};
    for (const [key, entry] of Object.entries(videoManifest)) {
      if (isGeneratedMediaPlaceholder(key)) {
        const assetId = await allocateMediaRef(key);
        if (assetId) {
          nextManifest[assetId] = entry;
          manifestChanged = true;
          continue;
        }
      } else if (isClassroomMediaUrl(key)) {
        const outcome = await allocateUrlMediaRef(key);
        if (outcome.kind === 'allocated') {
          nextManifest[outcome.assetId] = entry;
          manifestChanged = true;
          continue;
        }
        if (outcome.kind === 'dead') {
          report.emptied += 1;
          manifestChanged = true;
          continue;
        }
        report.kept += 1;
      }
      nextManifest[key] = entry;
    }
    if (manifestChanged) {
      videoManifest = nextManifest;
      changed = true;
    }
  }

  if (!changed) return { document, changed: false, report, allocatedIds };

  const nextStage: Stage =
    whiteboard !== stage.whiteboard || videoManifest !== stage.videoManifest
      ? {
          ...stage,
          ...(whiteboard !== stage.whiteboard ? { whiteboard } : {}),
          ...(videoManifest !== stage.videoManifest ? { videoManifest } : {}),
        }
      : stage;

  log.info(
    `Converted legacy asset refs for ${stageId}: ${report.converted} converted, ` +
      `${report.emptied} emptied (dead URL), ${report.kept} kept (bytes unavailable)`,
  );
  return {
    document: { ...document, stage: nextStage, scenes },
    changed: true,
    report,
    allocatedIds,
  };
}
