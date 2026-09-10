import { db, mediaFileKey, type MediaFileRecord } from '@/lib/utils/database';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { withAssetUrl } from './use-asset-url';
import { lookupMediaTask } from './media-task-resolution';
import {
  MISSING_ASSET_LEASE,
  isConcreteMediaAddress,
  renderableMediaUrl,
  resolveMediaRef,
  type MediaTaskState,
} from './resolve-media-ref';

/**
 * Pool-first byte resolution for export paths, with the fallback chain every
 * export surface shares.
 *
 * A same-id replacement commits the new bytes to the pool first; if the
 * compatibility write then fails, the task records
 * `MEDIA_COMPATIBILITY_STORE_LAGGED` and the document deliberately keeps the
 * same reference. Rendering resolves the pool, so every export must too --
 * otherwise it ships media the classroom no longer shows. The chain, in order:
 *
 * 1. The asset pool. An opaque ref's current bytes win whenever the pool
 *    resolves them.
 * 2. The Dexie compatibility row, optionally with its CDN URL (`ossKey`) as a
 *    byte source when the local blob is empty -- a live-mode classroom whose
 *    local blobs were LRU-evicted under storage pressure still exports a
 *    self-contained archive.
 * 3. The URL the media-resolution state machine resolves from the task, for
 *    generated media whose bytes never reached either store.
 *
 * The three historical callers (classroom ZIP, PPTX, video) differ in which
 * levels they run, how strictly they validate fetched bytes, and whether they
 * gate acceptance on the media-resolution state machine. Those differences
 * are load-bearing, so they are explicit options below rather than collapsed
 * into one policy. Returns `null` when no level yields bytes; never throws.
 */

/** How strictly a fetched byte source is validated before it is accepted. */
export interface StoredBytesFetchPolicy {
  /** Reject a non-OK response instead of shipping the error body as bytes. */
  readonly requireOk: boolean;
  /** Reject an empty (0-byte) blob instead of shipping it. */
  readonly requireNonEmpty: boolean;
}

export interface ResolveStoredBytesOptions {
  /** Stage scope for the task lookup and the internal compatibility-row read. */
  readonly stageId?: string;
  /**
   * Pre-loaded compatibility row. Its compound id authoritatively names the
   * document ref, so a supplied row re-derives the ref every level resolves
   * for. Rows carrying an `error` still name the ref but never supply bytes.
   */
  readonly record?: MediaFileRecord;
  /**
   * Read the compatibility row from Dexie by compound key when no `record`
   * was supplied. A failed read is treated as a missing row. Requires
   * `stageId`: the row is keyed by `stageId:ref`, so with no stage this level
   * is skipped entirely -- the same gate the pre-refactor callers applied.
   */
  readonly loadCompatRow?: boolean;
  /**
   * Allow the row's CDN URL (`ossKey`) as a byte source when its local blob is
   * empty. Applies to the compatibility level only, so it is inert unless a
   * `record` was supplied or `loadCompatRow` found one.
   */
  readonly compatRowCdnFallback?: boolean;
  /**
   * Final level: fetch the URL the media-resolution state machine resolves
   * from the ref's task, so generated media still exports when neither the
   * pool nor the compatibility row holds its bytes. Independent of
   * `resolutionGating` -- the task is looked up for this level whether or not
   * the earlier levels are gated.
   */
  readonly taskUrlFallback?: boolean;
  /**
   * Gate every level through the media-resolution state machine, keyed by the
   * ref's current task: an in-flight regeneration then suppresses stale pool
   * and compatibility bytes, so the export cannot ship media the classroom no
   * longer shows. Off for callers that resolve the pool unconditionally.
   */
  readonly resolutionGating?: boolean;
  /** Validation applied to every fetched byte source. */
  readonly fetchPolicy: StoredBytesFetchPolicy;
}

/** The document ref a compatibility row's compound id (`stageId:ref`) names. */
export function mediaRefFromRecordId(recordId: string): string {
  return recordId.includes(':') ? recordId.split(':').slice(1).join(':') : recordId;
}

export async function resolveStoredBytes(
  ref: string,
  options: ResolveStoredBytesOptions,
): Promise<Blob | null> {
  const { stageId, fetchPolicy } = options;
  const effectiveRef = options.record ? mediaRefFromRecordId(options.record.id) : ref;
  // Two independent concerns need the task: gating (which suppresses stale
  // bytes) and the final URL fallback (which resolves the task's own address).
  // Only the gating levels read it conditionally -- deriving it from
  // `resolutionGating` alone would leave `taskUrlFallback` inert without it,
  // which is not what the option promises and not what the pre-refactor
  // callers did (their task lookup was unconditional).
  const task =
    options.resolutionGating || options.taskUrlFallback
      ? effectiveMediaTask(effectiveRef, stageId)
      : undefined;
  const gate = options.resolutionGating ? task : undefined;
  // A SUPPLIED row's `error` verdict is taken here, before the pool is
  // awaited, because that is where the pre-refactor caller took it: the row is
  // a live object, so deciding after the await would let an `error` set (or
  // cleared) while the pool lookup is pending change the answer. A row this
  // function loads itself is judged when it is read, after the pool miss --
  // also as before, since that read did not exist until then.
  const suppliedRow = options.record && !options.record.error ? options.record : undefined;

  const pooled = await pooledBytes(effectiveRef, gate, options);
  if (pooled) return pooled;

  const record = options.record
    ? suppliedRow
    : options.loadCompatRow && stageId
      ? await db.mediaFiles.get(mediaFileKey(stageId, effectiveRef)).catch(() => undefined)
      : undefined;
  // `suppliedRow` already carries the pre-await verdict, so it is NOT
  // re-examined here -- re-reading `error` off the live object is exactly the
  // late decision this snapshot exists to avoid. A row loaded above is judged
  // now, when it was read.
  const usableRow = options.record ? suppliedRow : record && !record.error ? record : undefined;
  if (usableRow) {
    const stored = await compatRowBytes(usableRow, options);
    if (stored) {
      // Gating off means `gate` is undefined and the resolved lease always
      // yields a URL, so this one check covers both caller shapes.
      const state = resolveMediaRef(effectiveRef, gate, {
        status: 'resolved',
        url: 'dexie:media',
      });
      if (state.kind === 'url') return stored;
    }
  }

  if (options.taskUrlFallback) {
    const state = resolveMediaRef(effectiveRef, task, MISSING_ASSET_LEASE);
    const resolved = renderableMediaUrl(state);
    return resolved ? fetchBytes(resolved, fetchPolicy) : null;
  }
  return null;
}

/**
 * The pool level: a same-id replacement lands here first, so it answers
 * before any stored row. Concrete addresses are network sources, not pool
 * refs, and resolve to `null` immediately. Pool access failure is not fatal --
 * the compatibility row remains the fallback.
 */
async function pooledBytes(
  ref: string,
  task: MediaTaskState | undefined,
  options: ResolveStoredBytesOptions,
): Promise<Blob | null> {
  if (isConcreteMediaAddress(ref)) return null;
  try {
    return await withAssetUrl(ref, async (url) => {
      if (!url) return null;
      if (!options.resolutionGating) return fetchBytes(url, options.fetchPolicy);
      const state = resolveMediaRef(ref, task, { status: 'resolved', url });
      const resolved = renderableMediaUrl(state);
      return resolved ? fetchBytes(resolved, options.fetchPolicy) : null;
    });
  } catch {
    return null;
  }
}

/** The compatibility-row level: local blob first, then the CDN URL when enabled. */
async function compatRowBytes(
  record: MediaFileRecord,
  options: ResolveStoredBytesOptions,
): Promise<Blob | null> {
  // The blob is declared required, but the guard is the reason this function
  // honors the module's "never throws" contract for a row that lost it.
  if (record.blob && record.blob.size > 0) return record.blob;
  if (!options.compatRowCdnFallback || !record.ossKey) return null;
  return fetchBytes(record.ossKey, options.fetchPolicy);
}

async function fetchBytes(url: string, policy: StoredBytesFetchPolicy): Promise<Blob | null> {
  try {
    const response = await fetch(url);
    if (policy.requireOk && !response.ok) return null;
    const blob = await response.blob();
    return policy.requireNonEmpty && blob.size === 0 ? null : blob;
  } catch {
    return null;
  }
}

/**
 * The task governing a ref: keyed directly, or by the placeholder ref a
 * completed allocation kept. A task from another stage never counts.
 */
function effectiveMediaTask(ref: string, stageId: string | undefined): MediaTaskState | undefined {
  const tasks = useMediaGenerationStore.getState().tasks;
  return lookupMediaTask(tasks, ref, stageId);
}
