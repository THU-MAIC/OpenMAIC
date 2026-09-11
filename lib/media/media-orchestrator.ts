/**
 * Media Generation Orchestrator
 *
 * Dispatches media generation API calls for all mediaGenerations across outlines.
 * Runs entirely on the frontend — calls /api/generate/image and /api/generate/video,
 * fetches result blobs and updates the Zustand store.
 *
 * Where the bytes land, and what the document ends up pointing at, depends on
 * how durable the document is:
 *
 * - Browser-only: bytes go to the local `mediaFiles` table and the document
 *   keeps its `gen_img_*` / `gen_vid_*` placeholder. Document and media share
 *   one lifetime, so the placeholder is a complete address.
 * - Server-backed: the document outlives this browser, so the bytes go to the
 *   asset pool first and the id the pool allocated is written back into the
 *   document. Only then is the task done. The local table becomes a cache for
 *   this tab, never the source of truth, and "already generated?" is answered
 *   by the document instead of by that cache.
 */

import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { useStageStore } from '@/lib/store/stage';
import { mayGenerateForStage } from '@/lib/classroom/generation-permission';
import { db, mediaFileKey, type MediaFileRecord } from '@/lib/utils/database';
import type { SceneOutline } from '@/lib/types/generation';
import type { MediaGenerationRequest } from '@/lib/media/types';
import { putAsset } from '@/lib/media/asset-pool';
import {
  ASSET_QUOTA_EXCEEDED,
  isRetryableMediaFailure,
  isStorageFullFailure,
} from '@/lib/media/media-failure';
import {
  indexGeneratedMediaReferences,
  isGeneratedMediaSatisfied,
  type GeneratedMediaDocumentIndex,
} from '@/lib/media/generated-media-references';
import {
  MediaReferenceWriteBackError,
  persistGeneratedMediaReference,
  placePendingMediaAllocations,
  type MediaReferenceWriteBackResult,
} from '@/lib/media/persist-media-reference';
import {
  forgetMediaAllocation,
  pendingMediaAllocation,
  takePendingMediaAllocations,
  type PendingMediaAllocation,
} from '@/lib/media/pending-media-allocations';
import { isAssetStorageFull, markAssetStorageFull } from '@/lib/media/asset-storage-full';
import { fetchProxiedMediaUrl } from '@/lib/media/proxy-media-cache';
import { isServerBackedMediaPersistence } from '@/lib/persistence/media-persistence';
import { createLogger } from '@/lib/logger';

const log = createLogger('MediaOrchestrator');

/**
 * The pass currently running for a stage, if one is.
 *
 * Media passes for one course are serial, and that is the whole concurrency
 * model: there is no per-element bookkeeping, because there is nothing for it
 * to arbitrate. A replacement pass aborts its predecessor and then waits for it
 * to settle, so by the time it looks at the document nothing is in flight —
 * a commit that had already started has finished (its bytes are stored and its
 * reference written, so the new pass sees a resolved slide and skips it), and
 * an element the aborted pass never reached is still a placeholder and gets
 * collected like any other.
 *
 * Three rounds of per-element claims taught the lesson this replaces: every
 * refinement of "who owns this element right now" created a new way to strand
 * one. Waiting has no such states.
 *
 * The wait is unbounded, and deliberately so. A commit is uncancellable — the
 * asset client takes no signal and a document write cannot be half-undone — so
 * a stalled upload holds this course's media queue until it settles or the page
 * is reloaded. Abandoning the wait on a deadline was tried and reverted: it
 * turns an element whose commit is still alive into a retryable one, and a
 * Retry then runs a second commit for the same placeholder against the first —
 * two provider calls, two allocations, and a placeholder-keyed record that the
 * loser can erase from under the winner. That is precisely the overlap this
 * design exists to remove, so the queue waits.
 */
const passesByStage = new Map<string, Promise<void>>();

/** Wait for the stage's current pass to settle, whatever it settles as. */
async function awaitCurrentPass(stageId: string): Promise<void> {
  const current = passesByStage.get(stageId);
  if (current) await current.catch(() => undefined);
}

/** @internal Test-only: forget any pass a spec left un-settled. */
export function resetMediaPassesForTests(): void {
  passesByStage.clear();
}

/** Error with a structured errorCode from the API */
class MediaApiError extends Error {
  errorCode?: string;
  constructor(message: string, errorCode?: string) {
    super(message);
    this.errorCode = errorCode;
  }
}

/**
 * A store refusal that still holds the bytes it refused.
 *
 * The bytes are the whole point. They were either just paid for at a provider,
 * or they are the only copy a pre-server-backed course has of its own media --
 * and the failure record written for this element goes to the very row that
 * copy lives in. Carrying them out of the commit is what lets that record keep
 * them, and what lets a later Retry re-attempt the upload instead of the
 * generation.
 */
class MediaStorageRefusalError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly code: string,
    readonly refused: RefusedMediaBytes,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'MediaStorageRefusalError';
  }
}

/** Generated bytes an upload refused, kept so nothing has to be bought twice. */
interface RefusedMediaBytes {
  readonly blob: Blob;
  readonly mimeType: string;
  readonly poster?: Blob;
  readonly posterMimeType?: string;
}

/**
 * The structured code a failure should be remembered by, if it has one.
 *
 * A code is what makes a failure permanent: it is written to the local table,
 * survives a reload as a `failed` task, and turns off the Retry affordance. So
 * it is reserved for refusals a retry cannot change — a provider's content
 * decision, a disabled generation setting, and a full asset store.
 *
 * The quota refusal reaches this browser as the asset client's error, whose
 * `code` is the one the storage contract puts in the response body. Matching
 * on the code rather than on the client's error class is deliberate: the class
 * is not always the one this bundle imported, while the code is the part of
 * the contract that crosses every boundary. Everything else stays retryable,
 * because everything else might work next time.
 */
function mediaFailureCode(error: unknown): string | undefined {
  if (error instanceof MediaApiError) return error.errorCode;
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return code === ASSET_QUOTA_EXCEEDED ? ASSET_QUOTA_EXCEEDED : undefined;
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('Aborted', 'AbortError');
  return Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

/**
 * Launch media generation for all mediaGenerations declared in outlines.
 * Runs in parallel with content/action generation — does not block.
 */
export async function generateMediaForOutlines(
  outlines: SceneOutline[],
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (!isServerBackedMediaPersistence()) {
    return collectAndGenerate(outlines, stageId, abortSignal, false);
  }
  // Serial per stage. The caller aborts the previous pass before starting this
  // one; waiting for that pass to actually settle is what makes the handoff
  // safe without tracking individual elements. A commit already under way is
  // uncancellable — `putAsset` and the write-back run to completion — so
  // waiting is also what stops the replacement from paying for it twice.
  const pass = awaitCurrentPass(stageId).then(() =>
    collectAndGenerate(outlines, stageId, abortSignal, true),
  );
  passesByStage.set(stageId, pass);
  try {
    await pass;
  } finally {
    if (passesByStage.get(stageId) === pass) passesByStage.delete(stageId);
  }
}

async function collectAndGenerate(
  outlines: SceneOutline[],
  stageId: string,
  abortSignal: AbortSignal | undefined,
  serverBacked: boolean,
): Promise<void> {
  // Everything below this point may be running long after the caller queued it:
  // a server-backed pass waits for its predecessor, and a predecessor's
  // uncancellable tail can outlast the user's stay on the course. So the pass
  // re-earns its right to touch anything, twice.
  //
  // First, the signal. `enqueueTasks` writes into a table that is keyed by
  // element id alone, and placeholder ids are not unique across courses, so an
  // aborted pass that enqueued anyway would seed the ARRIVING course's table
  // with tasks carrying the departing course's stage id — and a Retry routes by
  // that id, into the wrong document.
  //
  // Second, the document. `documentSkipIndex` can only answer while the live
  // store is on this stage; when it cannot, the pass has no way to tell what is
  // already generated. Falling through to the task table would be a silent
  // demotion from "the document is the authority" to "this browser's table is",
  // on exactly the path where the table has just been cleared — so every
  // element the predecessor committed would be generated again. Not deciding is
  // the only safe answer, and a pass that cannot decide simply ends.
  let documentIndex: GeneratedMediaDocumentIndex | undefined;
  if (serverBacked) {
    if (abortSignal?.aborted) return;
    documentIndex = documentSkipIndex(stageId);
    if (!documentIndex) {
      log.info(`Media pass for ${stageId} stood down: the course is no longer open here.`);
      return;
    }
    // Before deciding anything: hand every parked allocation to the slide that
    // now wants it. A held allocation whose scene has since arrived must become
    // a rewrite, not an answer to the skip test — otherwise the placeholder it
    // was waiting to replace would be treated as handled and never replaced.
    placePendingMediaAllocations(stageId);
    // The drain may have resolved slides, so ask the document again.
    documentIndex = documentSkipIndex(stageId);
    if (!documentIndex) return;
  }

  const settings = useSettingsStore.getState();
  const store = useMediaGenerationStore.getState();
  // Under server-backed persistence the document, not this browser's task
  // table, decides what still needs generating: the table is per-browser, so
  // reading it is exactly how every new browser re-ran (and re-billed) an
  // already-generated course.

  // Collect all media requests
  const allRequests: MediaGenerationRequest[] = [];
  for (const outline of outlines) {
    if (!outline.mediaGenerations) continue;
    for (const mg of outline.mediaGenerations) {
      // Filter by enabled flags
      if (mg.type === 'image' && !settings.imageGenerationEnabled) continue;
      if (mg.type === 'video' && !settings.videoGenerationEnabled) continue;
      const existing = store.getTask(mg.elementId);
      if (documentIndex) {
        // The document is the authority. A permanently failed task (content
        // policy, generation disabled) is still honoured: it is a refusal to
        // call the provider again, never a claim that media exists.
        if (isGeneratedMediaSatisfied(documentIndex, outline.order, mg.elementId)) continue;
        // Stored, waiting for its slide to exist. The drain above already gave
        // away every allocation whose slide has arrived, so what is left here
        // genuinely has nowhere to go yet; asking the provider again would pay
        // twice for bytes this session already holds.
        if (pendingMediaAllocation(stageId, mg.elementId)) continue;
        // A permanently failed task (content policy, generation disabled) is a
        // refusal to call the provider again, never a claim that media exists.
        if (existing?.status === 'failed') continue;
        // `generating` is the one status that means "something is working on
        // this right now". Passes are serial, so it can only be a single-element
        // retry running alongside this pass; letting the pass take it too would
        // pay for the element twice. `pending` is deliberately NOT skipped: it
        // means a pass once intended to reach this element, and an abandoned
        // pass leaves that intent behind with nobody acting on it — reading it
        // as answered is what stranded elements in earlier designs.
        if (existing?.status === 'generating') continue;
      } else {
        // Skip already completed or permanently failed (restored from DB)
        if (existing?.status === 'done' || existing?.status === 'failed') continue;
      }
      allRequests.push(mg);
    }
  }

  if (allRequests.length === 0) return;

  // Enqueue all as pending
  useMediaGenerationStore.getState().enqueueTasks(stageId, allRequests);

  // The store had no room the last time this browser tried. That is a property
  // of the deployment, not of any slide, so it is remembered once per course:
  // without it, every reload would call a provider for the next placeholder and
  // be refused at exactly the same point. The elements are shown the condition
  // they are waiting on, each with its Retry; the first upload that succeeds
  // clears the marker and the next pass runs normally.
  if (serverBacked && (await isAssetStorageFull(stageId))) {
    log.info(`Asset storage was full for ${stageId}; standing down without generating.`);
    markStorageFull(allRequests);
    return;
  }

  // One read of the stage's media table for the whole pass, built on the first
  // element that needs it.
  const scan = createCachedMediaScan();

  // Process requests serially — image/video APIs have limited concurrency
  for (const [index, req] of allRequests.entries()) {
    if (abortSignal?.aborted) break;
    const attempt = await generateSingleMedia(req, stageId, abortSignal, undefined, scan);
    if (!attempt.storageFull) continue;
    // The store checks each write against the headroom it has left, so a
    // refusal is evidence about one blob and only weak evidence about the next.
    // The pass stops the deck anyway, and that is a judgement about cost rather
    // than about certainty: every element it attempts costs a provider call
    // before the store is asked, so continuing to pay for elements that will
    // probably be refused is the worse bet. A path whose refusals are free
    // makes the opposite call -- narration adoption attempts every clip it
    // holds, bounded only by what an earlier refusal in the same run already
    // implies. So the pass stops here and says why. The elements it never reached keep their
    // placeholders and are NOT recorded as failures — nothing was attempted
    // for them, so a later load may still generate them once — but they show
    // the same "storage is full" state as the one that was refused, because
    // that is the condition they are waiting on.
    log.warn(`Asset storage is full; stopping the media pass for ${stageId}.`);
    await markAssetStorageFull(stageId);
    markStorageFull(allRequests.slice(index + 1));
    break;
  }
}

/**
 * Show a set of unattempted elements the condition they are waiting on.
 *
 * In memory only, and deliberately: nothing was attempted for them, so a
 * persisted record would be a record of something that never happened — and
 * once the ceiling is raised, an element with no record is one ordinary
 * generation rather than a permanently refused one. What stops the next pass
 * from spending on them is the per-course marker, not a record per element.
 */
function markStorageFull(requests: readonly MediaGenerationRequest[]): void {
  const store = useMediaGenerationStore.getState();
  for (const request of requests) {
    store.markFailed(
      request.elementId,
      `Asset storage is full; the ${request.type} was not generated`,
      ASSET_QUOTA_EXCEEDED,
    );
  }
}

/**
 * Retry a single failed media task.
 */
export async function retryMediaTask(
  elementId: string,
  _target?: { readonly elementId: string; readonly sceneId?: string; readonly slideId?: string },
): Promise<void> {
  const store = useMediaGenerationStore.getState();
  const task = store.getTask(elementId);
  if (!task || task.status !== 'failed') return;

  // A refusal of the content or the configuration is not retryable, and the
  // affordance that calls this is already hidden for one. Refusing here too
  // keeps the render condition and the action precondition the same rule
  // rather than two that can drift.
  if (!isRetryableMediaFailure(task)) return;

  // The affordance that calls this is already hidden when generation is not
  // permitted; refusing here too is what makes the render condition and the
  // action precondition the same rule rather than two that can drift.
  if (!mayGenerateForStage(task.stageId)) return;

  // Check if the corresponding generation type is still enabled in global settings
  const settings = useSettingsStore.getState();
  if (task.type === 'image' && !settings.imageGenerationEnabled) {
    store.markFailed(elementId, 'Generation disabled', 'GENERATION_DISABLED');
    return;
  }
  if (task.type === 'video' && !settings.videoGenerationEnabled) {
    store.markFailed(elementId, 'Generation disabled', 'GENERATION_DISABLED');
    return;
  }

  // Bytes that reached the pool but whose reference never reached the document.
  //
  // A write-back that fails with the allocation retained parks it, and nothing
  // is written to the local media table, because that write only happens after
  // a successful write-back. So the bytes are in the pool, the document still
  // carries the placeholder, and this browser holds no cached copy -- a Retry
  // that went to the provider from here would pay for the media a second time
  // and allocate a second asset for bytes the pool already has, with the first
  // one left for server-side reclamation. The pass has refused that since it
  // learned to read the parked queue; this is the same gate on the affordance.
  const parked = pendingMediaAllocation(task.stageId, elementId);
  if (parked) {
    useMediaGenerationStore.getState().markPendingForRetry(elementId);
    let outcome: MediaReferenceWriteBackResult;
    try {
      outcome = await persistGeneratedMediaReference(parked);
    } catch (error) {
      // Still parked, still retryable, and still no provider call: the next
      // Retry -- or the next pass -- comes back through here.
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Write-back retry failed for ${elementId}:`, message);
      useMediaGenerationStore.getState().markFailed(elementId, message);
      return;
    }
    // The object URL is minted by the commit that parked this, so it is present
    // in practice; an allocation without one degrades to resolving the
    // allocated id through the asset lease, which is what a fresh browser does.
    const objectUrl = parked.objectUrl ?? '';
    if (outcome === 'held') {
      // The slide this belongs to still has not been built. The allocation
      // stays parked and the task stays keyed by the placeholder the document
      // carries, so the request reads as answered and nothing asks again.
      useMediaGenerationStore.getState().markDone(elementId, objectUrl, parked.posterObjectUrl);
      return;
    }
    // Placed. Taking the entry is what keeps a later rewrite of an
    // already-rewritten slot from looking possible; the non-draining record
    // stays, because a snapshot captured before this rewrite still has to be
    // corrected at the write boundary.
    takePendingMediaAllocations(task.stageId, [elementId]);
    useMediaGenerationStore
      .getState()
      .rekeyDone(
        elementId,
        parked.assetId,
        objectUrl,
        parked.posterObjectUrl,
        parked.posterAssetId,
      );
    return;
  }

  // Bytes this browser already holds for the element, whatever put them there:
  // a store that refused the upload and kept them, or a course generated before
  // this application stored media server-side. A retry adopts them for the same
  // reason a pass does -- they are paid for -- so it re-attempts the upload
  // rather than buying the media again. The condition is the bytes, not the
  // error code: an upload refused for room and then retried into a network
  // failure has lost its code but not its bytes, and asking a provider for them
  // a third time would be the second thing that costs money for nothing.
  //
  // Read BEFORE anything is removed, and the row is NOT removed first: it is
  // the only copy until an upload succeeds.
  const dbKey = mediaFileKey(task.stageId, elementId);
  const refused = isServerBackedMediaPersistence()
    ? await refusedMediaBytes(task.stageId, elementId, task.type)
    : undefined;
  if (!refused) {
    // Nothing to keep. Clearing the persisted failure is what lets a fresh
    // result be written under this key.
    await db.mediaFiles.delete(dbKey).catch(() => {});
  }

  // Re-read after the await: only a still-failed task may be retried, and the
  // check has to come BEFORE the state is destroyed. Marking first and refusing
  // afterwards is what turned a recoverable failure into a slide stuck at
  // `pending` with no affordance left to recover it.
  if (useMediaGenerationStore.getState().getTask(elementId)?.status !== 'failed') return;
  useMediaGenerationStore.getState().markPendingForRetry(elementId);
  const attempt = await generateSingleMedia(
    {
      type: task.type,
      prompt: task.prompt,
      elementId: task.elementId,
      aspectRatio: task.params.aspectRatio as MediaGenerationRequest['aspectRatio'],
      style: task.params.style,
    },
    task.stageId,
    undefined,
    refused,
  );

  if (attempt.storageFull) {
    // A deliberate Retry is always allowed to try, even on a store this browser
    // believes is full: the author may know something it does not, and the
    // ceiling is exactly the kind of thing an operator has just changed. But a
    // refusal is an answer, and the next pass must have it — otherwise the
    // deck's other elements each pay a provider to rediscover it.
    await markAssetStorageFull(task.stageId);
    return;
  }

  // The retry landed. Its bytes live under the allocated id now, so the row
  // kept under the placeholder is a stale duplicate carrying a failure that no
  // longer happened. Read from what the attempt reported, never from the task
  // table: a course switch clears that table, and reading "no failed task" as
  // "it worked" is how the only copy of the bytes gets deleted after a refusal.
  if (refused && attempt.committed) {
    await db.mediaFiles.delete(dbKey).catch(() => {});
  }
}

/**
 * The bytes kept for an element a full store refused.
 *
 * The row is the one the failure record was written around, so it carries the
 * error that was recorded alongside the media -- read it anyway, since here the
 * error is what identifies it.
 */
async function refusedMediaBytes(
  stageId: string,
  elementId: string,
  type: MediaGenerationRequest['type'],
): Promise<RefusedMediaBytes | undefined> {
  const row = await db.mediaFiles.get(mediaFileKey(stageId, elementId)).catch(() => undefined);
  if (!row?.blob || row.blob.size === 0) return undefined;
  const poster = row.poster && row.poster.size > 0 ? row.poster : undefined;
  return {
    blob: row.blob,
    mimeType: storedMediaType(row.blob, type === 'video' ? 'video/mp4' : 'image/png'),
    ...(poster ? { poster, posterMimeType: storedMediaType(poster, 'image/jpeg') } : {}),
  };
}

/** Build the renderer retry scope while classic retries remain placeholder-keyed. */
export function mediaRetryTarget(
  elementId: string,
  sceneId: string | undefined,
  sceneData: unknown,
): { elementId: string; sceneId?: string; slideId?: string } {
  const slideId =
    sceneData && typeof sceneData === 'object' && 'canvas' in sceneData
      ? (sceneData as { canvas?: { id?: string } }).canvas?.id
      : undefined;
  return { elementId, ...(sceneId ? { sceneId } : {}), ...(slideId ? { slideId } : {}) };
}

// ==================== Internal ====================

/**
 * The document's answer to "what still needs generating", or `undefined` when
 * this browser cannot read it — the live store has moved to another course.
 * Callers in server-backed mode must treat `undefined` as "cannot decide", not
 * as an invitation to consult the task table instead.
 */
function documentSkipIndex(stageId: string): GeneratedMediaDocumentIndex | undefined {
  const { stage, scenes, generationComplete } = useStageStore.getState();
  // Another course's scenes would answer for slides this stage does not own,
  // and a wrong "already generated" is a slide that never gets its media.
  if (stage?.id !== stageId) return undefined;
  return indexGeneratedMediaReferences({ stage, scenes, generationComplete });
}

/**
 * Commit generated bytes under server-backed persistence: pool first, then the
 * document, then the local cache, and only then the task.
 *
 * Order is the contract. A reference reaches the document only after `put`
 * returned an id, so the document can never name bytes that were not stored;
 * and a failure anywhere before the write-back leaves the placeholder in place
 * with the provider called exactly once, so the retry happens on the next
 * owner load rather than inside this run.
 */
async function commitPooledMedia(args: {
  req: MediaGenerationRequest;
  stageId: string;
  paramsJson: string;
  blob: Blob;
  mimeType: string;
  posterBlob?: Blob;
  posterMimeType?: string;
}): Promise<void> {
  const { req, stageId, paramsJson, blob, mimeType, posterBlob, posterMimeType } = args;

  let assetId: string;
  try {
    // The stage is handed to the seam, which is where a successful write
    // retires this course's "no room" note -- one place rather than one per
    // caller. A write-back that fails for its own reasons afterwards therefore
    // does not leave the course standing down.
    assetId = await putAsset(blob, { contentType: mimeType }, { stageId });
  } catch (error) {
    // A full store keeps its bytes. Everything else is an ordinary failure and
    // is retried from the provider, as it always was.
    if (!isStorageFullFailure(mediaFailureCode(error))) throw error;
    throw new MediaStorageRefusalError(error, ASSET_QUOTA_EXCEEDED, {
      blob,
      mimeType,
      ...(posterBlob ? { poster: posterBlob } : {}),
      ...(posterBlob && posterMimeType ? { posterMimeType } : {}),
    });
  }
  // A poster is decorative: it is written only into a slot that has none of its
  // own. Letting its upload fail the commit would discard a stored video and
  // send the retry to submit the most expensive job in the system a second
  // time, so a poster failure costs the poster and nothing else.
  let posterAssetId: string | undefined;
  if (posterBlob) {
    try {
      posterAssetId = await putAsset(
        posterBlob,
        { contentType: posterMimeType ?? posterBlob.type },
        { stageId },
      );
    } catch (error) {
      log.warn(`Poster allocation failed for ${req.elementId}; keeping the video:`, error);
    }
  }

  // Minted before the write-back, not after it, so the allocation the funnel
  // may park in the same turn as its decision is complete: an entry drained a
  // microtask later must carry the bytes this tab can already render.
  const objectUrl = URL.createObjectURL(blob);
  const posterObjectUrl = posterBlob ? URL.createObjectURL(posterBlob) : undefined;
  const allocation: PendingMediaAllocation = {
    stageId,
    placeholderRef: req.elementId,
    assetId,
    posterAssetId,
    objectUrl,
    posterObjectUrl,
  };

  let outcome: MediaReferenceWriteBackResult;
  try {
    outcome = await persistGeneratedMediaReference(allocation);
  } catch (error) {
    // The funnel places or parks the allocation whenever the ids could be
    // referenced, and says so. Reclaiming is for the one case where nothing can
    // possibly hold them — otherwise a lost response would take an asset the
    // persisted document already names.
    if (error instanceof MediaReferenceWriteBackError && error.allocationRetained) throw error;
    URL.revokeObjectURL(objectUrl);
    if (posterObjectUrl) URL.revokeObjectURL(posterObjectUrl);
    // Forgetting is all a browser does here. The record outlives the parked
    // queue, so leaving it behind would let a later save stamp an id whose
    // bytes nothing references — and the placeholder it replaced would be gone
    // with it, which reads as "already generated" and stops any retry.
    //
    // The bytes themselves are NOT deleted. Asset deletion is refused to every
    // browser, because the principal it scopes to is shared and would let any
    // caller destroy another author's media; an entry nothing references waits
    // for server-side reclamation instead.
    forgetMediaAllocation(stageId, req.elementId);
    throw error;
  }

  // Local cache for this tab only. The document already points at the pool, so
  // a failed cache write costs a re-download, never the media.
  await db.mediaFiles
    .put({
      id: mediaFileKey(stageId, assetId),
      stageId,
      type: req.type,
      blob,
      mimeType,
      size: blob.size,
      poster: posterBlob,
      placeholderRef: req.elementId,
      prompt: req.prompt,
      params: paramsJson,
      createdAt: Date.now(),
    })
    .catch((error: unknown) => {
      log.warn(`Local media cache write failed for ${assetId}:`, error);
    });

  if (outcome === 'held') {
    // The slide this media belongs to has not been built yet, which during a
    // first pass is the ordinary case rather than an edge one. The funnel holds
    // the allocation; the task stays keyed by the placeholder the document
    // still carries, so the request reads as answered and the provider is not
    // asked a second time.
    useMediaGenerationStore.getState().markDone(req.elementId, objectUrl, posterObjectUrl);
    return;
  }

  useMediaGenerationStore
    .getState()
    .rekeyDone(req.elementId, assetId, objectUrl, posterObjectUrl, posterAssetId);
}

/**
 * The locally cached bytes for a placeholder, under either key this
 * application has used for them.
 *
 * A course generated before server-backed storage has its row under the
 * placeholder itself (`${stageId}:gen_img_3`), because that was the only id
 * there was. A course generated after it has the same bytes under the
 * allocated id (`${stageId}:ast_…`), with the placeholder it replaced recorded
 * in `placeholderRef`. Both are "bytes this browser already paid for", and a
 * document that carries the placeholder again — a rollback, a restored backup,
 * an edit that reinstated an outline — must be able to adopt either. Looking
 * only under the placeholder key was enough for the first layout and silently
 * regenerated the second.
 *
 * A row that records only a hosted URL (`ossKey`) and no bytes is treated as
 * absent: that URL is the provider's address, not something a document may
 * hold. A row recording a permanent failure is absent too — it is a refusal,
 * not media.
 */
async function adoptableCachedMedia(
  stageId: string,
  placeholderRef: string,
  // A caller with no pass -- a single-element Retry -- gets a scan of its own,
  // which is one read for its one lookup: the same cost as before.
  scan: CachedMediaScan = createCachedMediaScan(),
): Promise<{ blob: Blob; poster?: Blob } | undefined> {
  const usable = (row: MediaFileRecord | undefined): { blob: Blob; poster?: Blob } | undefined => {
    if (!row || row.error || !row.blob || row.blob.size === 0) return undefined;
    return { blob: row.blob, ...(row.poster ? { poster: row.poster } : {}) };
  };

  const direct = usable(
    await db.mediaFiles.get(mediaFileKey(stageId, placeholderRef)).catch(() => undefined),
  );
  if (direct) return direct;

  for (const row of await scan.candidatesFor(stageId, placeholderRef)) {
    const adoptable = usable(row);
    if (adoptable) return adoptable;
  }
  return undefined;
}

/** A pass's view of the stage's cached media rows, indexed by placeholder. */
interface CachedMediaScan {
  candidatesFor(stageId: string, placeholderRef: string): Promise<readonly MediaFileRecord[]>;
}

/**
 * Read the stage's media table at most once, however many elements ask.
 *
 * `placeholderRef` is not indexed, so the fallback is a stage-scoped scan --
 * and the keyed lookup misses for every row the commit path writes, since those
 * are keyed by the allocated id. Doing that per element made a pass materialize
 * and sort the course's whole media table once per element, which is quadratic
 * in the deck on the author's hot path.
 *
 * One snapshot per pass is enough, and not merely cheaper: an element only ever
 * asks for its own placeholder, and every row a pass writes carries the
 * placeholder of the element that wrote it, so no lookup in a pass can need a
 * row that same pass produced. The scan is built on the first miss, so a pass
 * whose elements all hit the keyed lookup never reads the table at all. It is
 * scoped to one pass, which bounds how stale it can get if some other writer
 * adds a row mid-pass -- the cost of that being one element regenerated instead
 * of adopted, on the next pass rather than never.
 */
function createCachedMediaScan(): CachedMediaScan {
  let rows: Promise<Map<string, MediaFileRecord[]>> | undefined;
  return {
    async candidatesFor(stageId, placeholderRef) {
      return (rows ??= loadCachedMediaByPlaceholder(stageId)).then(
        (index) => index.get(placeholderRef) ?? [],
      );
    },
  };
}

async function loadCachedMediaByPlaceholder(
  stageId: string,
): Promise<Map<string, MediaFileRecord[]>> {
  const rows = await db.mediaFiles
    .where('stageId')
    .equals(stageId)
    .toArray()
    .catch(() => [] as MediaFileRecord[]);
  const index = new Map<string, MediaFileRecord[]>();
  for (const row of rows) {
    if (!row.placeholderRef) continue;
    const existing = index.get(row.placeholderRef);
    if (existing) existing.push(row);
    else index.set(row.placeholderRef, [row]);
  }
  // Newest first. A regenerated element forks to a fresh id and its
  // predecessor's row is retained, so several rows can name the same
  // placeholder; adopting whichever one the index happened to return first
  // would restore the superseded image.
  for (const candidates of index.values()) {
    candidates.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  }
  return index;
}

/**
 * Adopt bytes this browser already holds for a placeholder, without asking a
 * provider for them again.
 *
 * The local media table is keyed by `stageId:ref`, and a course from before
 * server-backed storage carries its generated bytes there under the very
 * placeholder its document still names. Committing them through the ordinary
 * path stores them in the pool and writes the allocated id back, so the course
 * converges on the author's next load at no cost — and a visitor, who has no
 * such table, simply sees the media once the author has been through.
 *
 * A row that records only a hosted URL (`ossKey`) and no bytes is treated as
 * absent: that URL is the provider's address, not something a document may
 * hold, and re-downloading it is not obviously cheaper or more reliable than
 * regenerating. Returns whether the element is finished.
 */
async function commitCachedMedia(
  req: MediaGenerationRequest,
  stageId: string,
  paramsJson: string,
  abortSignal?: AbortSignal,
  scan?: CachedMediaScan,
): Promise<boolean> {
  const cached = await adoptableCachedMedia(stageId, req.elementId, scan);
  const blob = cached?.blob;
  if (!cached || !blob || blob.size === 0) return false;
  // The read above is the only thing that has happened so far, and it is
  // cheap. Everything after it is not: a `put` cannot be cancelled and its
  // write-back cannot be half-undone, so a pass whose course has already been
  // left stops here rather than committing into a document nobody is looking
  // at.
  throwIfAborted(abortSignal);

  const poster = cached.poster && cached.poster.size > 0 ? cached.poster : undefined;
  log.info(`Adopting locally cached bytes for ${req.elementId}; no provider call.`);
  await commitPooledMedia({
    req,
    stageId,
    paramsJson,
    blob,
    mimeType: storedMediaType(blob, req.type === 'video' ? 'video/mp4' : 'image/png'),
    posterBlob: poster,
    ...(poster ? { posterMimeType: storedMediaType(poster, 'image/jpeg') } : {}),
  });
  return true;
}

/**
 * The content type to record for stored bytes.
 *
 * The generation routes declare no media type, so the only signal is whatever
 * the transfer reported. A generic or empty value carries no information and
 * must not become the asset's recorded type: the pool mints its object URL from
 * it, and `<video>` will not play a source it is told is an octet stream.
 */
function storedMediaType(blob: Blob, fallback: string): string {
  const declared = blob.type.trim();
  return declared && declared !== 'application/octet-stream' ? declared : fallback;
}

/** What one attempt at an element settled as. */
interface MediaAttemptOutcome {
  /** The store refused the write for want of room: the deck-wide condition. */
  readonly storageFull: boolean;
  /** Bytes reached the store and the element is finished. */
  readonly committed: boolean;
}

const ATTEMPT_FAILED: MediaAttemptOutcome = { storageFull: false, committed: false };
const ATTEMPT_COMMITTED: MediaAttemptOutcome = { storageFull: false, committed: true };

/**
 * Generate (or re-store) one element, and say what happened.
 *
 * Both halves of the answer are read by callers that must not infer them from
 * anywhere else. The pass stops the deck on `storageFull`; a retry deletes the
 * row that was holding the only copy of the bytes only on `committed`, because
 * the obvious substitute -- "the task is no longer failed" -- is a fact about a
 * table a course switch clears out from under it.
 *
 * `refusedBytes` short-circuits the provider entirely: it is what a Retry hands
 * back after a full store kept the bytes, so the retry re-attempts the upload
 * rather than buying the media a second time.
 */
async function generateSingleMedia(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
  refusedBytes?: RefusedMediaBytes,
  scan?: CachedMediaScan,
): Promise<MediaAttemptOutcome> {
  const store = useMediaGenerationStore.getState();
  store.markGenerating(req.elementId);

  try {
    const paramsJson = JSON.stringify({
      aspectRatio: req.aspectRatio,
      style: req.style,
    });

    const serverBacked = isServerBackedMediaPersistence();

    if (serverBacked && refusedBytes) {
      await commitPooledMedia({
        req,
        stageId,
        paramsJson,
        blob: refusedBytes.blob,
        mimeType: refusedBytes.mimeType,
        ...(refusedBytes.poster ? { posterBlob: refusedBytes.poster } : {}),
        ...(refusedBytes.posterMimeType ? { posterMimeType: refusedBytes.posterMimeType } : {}),
      });
      return ATTEMPT_COMMITTED;
    }

    // A course generated before this application stored media server-side holds
    // placeholders in its document and its bytes only in the author's local
    // tables. Those bytes are already paid for, so the author's first
    // server-backed load converts them instead of buying them again.
    if (serverBacked && (await commitCachedMedia(req, stageId, paramsJson, abortSignal, scan))) {
      return ATTEMPT_COMMITTED;
    }

    if (req.type === 'image') {
      const result = await callImageApi(req, stageId, abortSignal);

      if (serverBacked) {
        // A hosted URL is the provider's address, not a durable reference the
        // document may hold, so the bytes are fetched and put to the pool.
        throwIfAborted(abortSignal);
        const blob = await fetchAsBlob(result.ossUrl || result.url);
        throwIfAborted(abortSignal);
        await commitPooledMedia({
          req,
          stageId,
          paramsJson,
          blob,
          mimeType: storedMediaType(blob, 'image/png'),
        });
        return ATTEMPT_COMMITTED;
      }

      // CDN path: server already uploaded to OSS
      if (result.ossUrl) {
        throwIfAborted(abortSignal);
        await db.mediaFiles.put({
          id: mediaFileKey(stageId, req.elementId),
          stageId,
          type: 'image',
          blob: new Blob([]),
          mimeType: 'image/png',
          size: 0,
          ossKey: result.ossUrl,
          prompt: req.prompt,
          params: paramsJson,
          createdAt: Date.now(),
        });
        useMediaGenerationStore.getState().markDone(req.elementId, result.ossUrl);
        return ATTEMPT_COMMITTED;
      }

      // Fallback: fetch blob via proxy-media
      throwIfAborted(abortSignal);
      const blob = await fetchAsBlob(result.url);
      await db.mediaFiles.put({
        id: mediaFileKey(stageId, req.elementId),
        stageId,
        type: 'image',
        blob,
        mimeType: 'image/png',
        size: blob.size,
        prompt: req.prompt,
        params: paramsJson,
        createdAt: Date.now(),
      });
      const objectUrl = URL.createObjectURL(blob);
      useMediaGenerationStore.getState().markDone(req.elementId, objectUrl);
    } else {
      const result = await callVideoApi(req, abortSignal);

      if (serverBacked) {
        throwIfAborted(abortSignal);
        const blob = await fetchAsBlob(result.ossUrl || result.url);
        const posterSource = result.posterOssUrl || result.poster;
        const posterBlob = posterSource
          ? await fetchAsBlob(posterSource).catch(() => undefined)
          : undefined;
        throwIfAborted(abortSignal);
        await commitPooledMedia({
          req,
          stageId,
          paramsJson,
          blob,
          mimeType: storedMediaType(blob, 'video/mp4'),
          posterBlob,
          ...(posterBlob ? { posterMimeType: storedMediaType(posterBlob, 'image/jpeg') } : {}),
        });
        return ATTEMPT_COMMITTED;
      }

      // CDN path: server already uploaded to OSS
      if (result.ossUrl) {
        throwIfAborted(abortSignal);
        await db.mediaFiles.put({
          id: mediaFileKey(stageId, req.elementId),
          stageId,
          type: 'video',
          blob: new Blob([]),
          mimeType: 'video/mp4',
          size: 0,
          ossKey: result.ossUrl,
          posterOssKey: result.posterOssUrl,
          prompt: req.prompt,
          params: paramsJson,
          createdAt: Date.now(),
        });
        useMediaGenerationStore
          .getState()
          .markDone(req.elementId, result.ossUrl, result.posterOssUrl);
        return ATTEMPT_COMMITTED;
      }

      // Fallback: fetch blob via proxy-media
      throwIfAborted(abortSignal);
      const blob = await fetchAsBlob(result.url);
      const posterBlob = result.poster
        ? await fetchAsBlob(result.poster).catch(() => undefined)
        : undefined;
      await db.mediaFiles.put({
        id: mediaFileKey(stageId, req.elementId),
        stageId,
        type: 'video',
        blob,
        mimeType: 'video/mp4',
        size: blob.size,
        poster: posterBlob,
        prompt: req.prompt,
        params: paramsJson,
        createdAt: Date.now(),
      });
      const objectUrl = URL.createObjectURL(blob);
      const posterObjectUrl = posterBlob ? URL.createObjectURL(posterBlob) : undefined;
      useMediaGenerationStore.getState().markDone(req.elementId, objectUrl, posterObjectUrl);
    }
    return ATTEMPT_COMMITTED;
  } catch (err) {
    if (abortSignal?.aborted) {
      // A submitted video MaaS task keeps running to a billable terminal state
      // server-side even after this client stops polling. Mark either media
      // task retryable instead of leaving it stuck in `generating`; note that
      // retrying a video submits a second job rather than resuming the first.
      const abortedMessage =
        req.type === 'video'
          ? 'Video generation polling was aborted; retry to submit a new job'
          : 'Image generation was aborted; retry to submit a new request';
      useMediaGenerationStore.getState().markFailed(req.elementId, abortedMessage);
      return ATTEMPT_FAILED;
    }
    const message = err instanceof Error ? err.message : String(err);
    const errorCode = mediaFailureCode(err);
    log.error(`Failed ${req.elementId}:`, message);
    useMediaGenerationStore.getState().markFailed(req.elementId, message, errorCode);

    // Bytes a full store refused. They are kept, and the record below is
    // written around them rather than over them: for a course being converted
    // from local storage this row IS the only copy of its media, and for a
    // freshly generated element these are bytes already paid for. Either way a
    // Retry after the ceiling is raised re-attempts the upload and calls no
    // provider.
    // A retry that was handed bytes still holds them when it fails for some
    // other reason -- a dropped connection, a 500 -- and that failure must not
    // be the thing that finally throws them away.
    const refused =
      err instanceof MediaStorageRefusalError ? err.refused : (refusedBytes ?? undefined);

    // Persist the failure so it survives a page refresh: a restored task
    // carrying an error is a `failed` task, and a pass never re-runs one. A
    // failure with bytes to keep is recorded for that reason alone, so the row
    // that holds them survives too.
    if (errorCode || refused) {
      await db.mediaFiles
        .put({
          id: mediaFileKey(stageId, req.elementId),
          stageId,
          type: req.type,
          blob: refused?.blob ?? new Blob(),
          mimeType: refused?.mimeType ?? (req.type === 'image' ? 'image/png' : 'video/mp4'),
          size: refused?.blob.size ?? 0,
          ...(refused?.poster ? { poster: refused.poster } : {}),
          placeholderRef: req.elementId,
          prompt: req.prompt,
          params: JSON.stringify({ aspectRatio: req.aspectRatio, style: req.style }),
          error: message,
          errorCode,
          createdAt: Date.now(),
        })
        .catch(() => {}); // best-effort
    }
    return { storageFull: isStorageFullFailure(errorCode), committed: false };
  }
}

async function callImageApi(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<{ url: string; ossUrl?: string }> {
  const settings = useSettingsStore.getState();
  const providerConfig = settings.imageProvidersConfig?.[settings.imageProviderId];

  const response = await fetch('/api/generate/image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-image-provider': settings.imageProviderId || '',
      'x-image-model': settings.imageModelId || '',
      'x-api-key': providerConfig?.apiKey || '',
      'x-base-url': providerConfig?.baseUrl || '',
    },
    body: JSON.stringify({
      prompt: req.prompt,
      aspectRatio: req.aspectRatio,
      style: req.style,
      stageId,
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new MediaApiError(data.error || `Image API returned ${response.status}`, data.errorCode);
  }

  const data = await response.json();
  if (!data.success)
    throw new MediaApiError(data.error || 'Image generation failed', data.errorCode);

  // Result may have ossUrl (CDN direct), url, or base64
  const ossUrl = data.result?.ossUrl as string | undefined;
  const url =
    data.result?.url || (data.result?.base64 ? `data:image/png;base64,${data.result.base64}` : '');
  if (!ossUrl && !url) throw new Error('No image URL in response');
  return { url, ossUrl };
}

async function callVideoApi(
  req: MediaGenerationRequest,
  abortSignal?: AbortSignal,
): Promise<{
  url: string;
  poster?: string;
  ossUrl?: string;
  posterOssUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
}> {
  const settings = useSettingsStore.getState();
  const providerConfig = settings.videoProvidersConfig?.[settings.videoProviderId];

  const response = await fetch('/api/generate/video', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-video-provider': settings.videoProviderId || '',
      'x-video-model': settings.videoModelId || '',
      'x-api-key': providerConfig?.apiKey || '',
      'x-base-url': providerConfig?.baseUrl || '',
    },
    body: JSON.stringify({
      prompt: req.prompt,
      aspectRatio: req.aspectRatio,
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new MediaApiError(data.error || `Video API returned ${response.status}`, data.errorCode);
  }

  const data = await response.json();
  if (!data.success)
    throw new MediaApiError(data.error || 'Video generation failed', data.errorCode);

  const url = data.result?.url;
  if (!url) throw new Error('No video URL in response');
  return {
    url,
    poster: data.result?.poster,
    ossUrl: data.result?.ossUrl,
    posterOssUrl: data.result?.posterOssUrl,
    width: data.result?.width,
    height: data.result?.height,
    duration: data.result?.duration,
  };
}

async function fetchAsBlob(url: string): Promise<Blob> {
  // For data URLs, convert directly
  if (url.startsWith('data:')) {
    const res = await fetch(url);
    return res.blob();
  }
  // For remote URLs, proxy through our server to bypass CORS restrictions.
  // Routed through the shared proxy-media negative cache so a permanently
  // failed URL (4xx) is not re-fetched by retries or later generation passes.
  //
  // Deliberately unabortable. The provider call that produced this URL has
  // already been billed, so cancelling the download throws away work that is
  // paid for — and the shared proxy cache would record the cancellation as a
  // transient failure against the URL, which after three aborts blocks it for
  // every consumer in the session. Letting the download finish costs a few
  // seconds after a Stop; cancelling it costs the image.
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await fetchProxiedMediaUrl(url);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Proxy fetch failed: ${res.status}`);
    }
    return res.blob();
  }
  // Relative URLs (shouldn't happen, but handle gracefully)
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch blob: ${res.status}`);
  return res.blob();
}
