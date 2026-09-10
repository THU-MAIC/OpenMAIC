'use client';

/**
 * Convert a course's pre-allocation narration to stored assets, for free.
 *
 * A course narrated before this application stored media server-side holds a
 * derived key on every speech action -- `tts_s<order>_<action>` -- and the
 * bytes for it only in this browser's local audio table. The document outlives
 * the browser now, so those references are a promise the course cannot keep:
 * the author's next device, and every visitor, reads an id nothing can resolve.
 *
 * The bytes are already paid for, so the author's own browser converts them
 * rather than re-synthesizing: allocate the clip in the pool, write the
 * allocated id back into the speech action, and mirror the row locally under
 * its new id. No provider is called, and a course converges on the first load
 * by an owner who still has the cache.
 *
 * What this deliberately does NOT do:
 *
 * - It does not adopt a row that belongs to another course. The derived key
 *   contains no stage id and `audioFiles` is keyed by id alone, so two courses
 *   can mint the same key -- a PPTX import numbers its scenes and actions
 *   deterministically, which makes the first slide of every imported deck
 *   `tts_s1_speech-scene-p1`. Locally that only means one course plays
 *   another's clip in one browser; adopting it would write that clip into the
 *   shared document permanently, for every device and every visitor. So the
 *   row's own `stageId` must not name a different course, and a legacy row
 *   from before that column existed is admitted only when its recorded text
 *   matches the action being converted.
 * - It does not run for a visitor. Ownership is the same gate every other
 *   spending or writing path uses, and it fails closed.
 * - It does not run in browser-only mode, where a derived key is a complete
 *   address and the document and the audio share one lifetime.
 * - It does not synthesize anything. A speech action whose bytes are not here,
 *   or whose only candidate row cannot be shown to belong to it, is left
 *   exactly as it is, still carrying its derived id. That narration is lost,
 *   and paying a provider to replace it is a decision for the author, not a
 *   side effect of opening a course.
 */
import { putAsset } from '@/lib/media/asset-pool';
import { mayGenerateForStage } from '@/lib/classroom/generation-permission';
import {
  clearAssetStorageFull,
  isAssetStorageFull,
  markAssetStorageFull,
} from '@/lib/media/asset-storage-full';
import { isStorageFullFailure } from '@/lib/media/media-failure';
import { createLogger } from '@/lib/logger';
import { mayNameAPoolAsset } from '@/lib/media/media-placeholder';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';
import { isServerBackedMediaPersistence } from '@/lib/persistence/media-persistence';
import { db, type AudioFileRecord } from '@/lib/utils/database';

import { persistNarrationReference } from './persist-narration-reference';

const log = createLogger('NarrationAdoption');

/**
 * The adoption running for a course, if one is.
 *
 * A run is a loop of uncancellable uploads: aborting it stops the loop between
 * clips, but the upload already in flight still finishes and still writes back,
 * because abandoning it would orphan the asset it just paid for. A second run
 * started while that tail is settling — a surface that re-enters the course, or
 * two surfaces mounted at once — could hand the same clip a second allocation
 * and leave one of them referenced by nothing. So a course adopts one run at a
 * time.
 *
 * A later caller QUEUES behind the tail rather than being handed it. Handing it
 * over was tried and is the same bug from the other side: the run a re-entry
 * inherits is bound to the signal that was just aborted, so it stops at its
 * next clip and the caller — which has a live signal and a course open — is
 * told the work is done. Waiting and then scanning again costs a lookup on a
 * course that has nothing left, and finishes the clips the abort cut off on one
 * that does.
 *
 * At most ONE rescan is queued at a time. A chain of them would be pointless —
 * the first rescan converts whatever is left, and every later one finds an
 * allocated id on every action — and it would turn a single stalled upload,
 * which the loop is deliberately unable to cancel, into a course that never
 * adopts again for the rest of the session. Callers that arrive while a rescan
 * is waiting share it, and it starts with the most recent caller's signal,
 * because that is the one whose course is actually open.
 */
const runsByStage = new Map<string, Promise<unknown>>();

/** A rescan that has not started yet, and the signal it will start with. */
interface QueuedAdoption {
  signal: AbortSignal | undefined;
  readonly outcome: Promise<NarrationAdoptionOutcome>;
}

const queuedByStage = new Map<string, QueuedAdoption>();

export interface NarrationAdoptionOutcome {
  /** Speech actions whose bytes were stored and whose reference was rewritten. */
  readonly adopted: number;
  /**
   * Derived references left alone: no bytes here, bytes that belong to another
   * course, or a write this browser could no longer make.
   */
  readonly unbacked: number;
}

/** A derived reference and the text of the action that carries it. */
interface DerivedNarration {
  readonly derivedRef: string;
  readonly text: string;
}

/** Every derived narration reference the open course still carries. */
function derivedNarrationRefs(
  scenes: readonly { actions?: readonly unknown[] }[],
): DerivedNarration[] {
  const found = new Map<string, DerivedNarration>();
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (typeof action !== 'object' || action === null) continue;
      const candidate = action as { type?: unknown; audioId?: unknown; text?: unknown };
      if (candidate.type !== 'speech') continue;
      const audioId = candidate.audioId;
      if (typeof audioId !== 'string' || audioId === '') continue;
      // An allocated id needs nothing, and a concrete address -- a hosted URL
      // or a classroom-media path -- is not a local key at all; treating one as
      // a derived reference would put a pool id built from unrelated bytes over
      // a working address.
      if (mayNameAPoolAsset(audioId) || isConcreteMediaAddress(audioId)) continue;
      if (found.has(audioId)) continue;
      found.set(audioId, {
        derivedRef: audioId,
        text: typeof candidate.text === 'string' ? candidate.text : '',
      });
    }
  }
  return [...found.values()];
}

/**
 * The action id inside a derived narration key.
 *
 * The key is `tts_s<sceneOrder>_<actionId>`, with a `tts_request_s…` variant.
 * Everything after the scene order is the action's own id.
 */
const DERIVED_KEY_ACTION_ID = /^tts_(?:request_)?s-?\d+_(.+)$/;

/**
 * An action id the generator would not mint twice.
 *
 * A generated speech action is `action_` plus a nanoid, so two courses do not
 * produce the same one and a derived key built from it names exactly one clip.
 * Every other shape has to be treated as reproducible -- an import mints its
 * actions from the slide's position (`speech-scene-p<n>`), which makes the
 * first slide of every imported deck carry the same key.
 *
 * This is a statement about what the generator produces, not an invariant the
 * parser enforces: the action parser accepts an `action_id` supplied by the
 * model and only falls back to a nanoid, so a model that echoed the same id
 * into two courses at the same scene order would make a key this predicate
 * calls unique. Nothing in the prompts asks for that field and no other
 * producer of speech actions supplies one, so it is a narrow residual -- and
 * it is one the alternative shares, because the rule it replaced (require the
 * row's recorded text to match) offers no protection in the likeliest
 * collision either: the same deck imported twice has identical notes. The
 * alternative's actual cost is much larger, since it refuses every real
 * pre-allocation course. Closing this properly belongs in the parser, by
 * minting the id unconditionally for speech, not here.
 */
const UNIQUE_ACTION_ID = /^action_[A-Za-z0-9_-]{8,}$/;

/** The contract code an upload failure declares, if it declares one. */
function storageErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function derivedKeyIsUnique(derivedRef: string): boolean {
  const actionId = DERIVED_KEY_ACTION_ID.exec(derivedRef)?.[1];
  return actionId !== undefined && UNIQUE_ACTION_ID.test(actionId);
}

/**
 * Whether this row can be shown to hold the narration of this action.
 *
 * A row that names a course names the only course it may be adopted into.
 *
 * A row that names none predates the column -- and that is not an edge case,
 * it is the entire population this feature exists for. `stageId` and `text`
 * were added to these rows by the same change that moved narration onto
 * allocated ids, so a row still carrying a derived key has neither. A rule
 * that required the text therefore refused every real pre-allocation course
 * while admitting only fixtures built from post-allocation rows.
 *
 * What the row cannot tell us, the key can. A derived key collides only when
 * two courses share both a scene order and an action id, and action ids are
 * reproducible only when something other than the generator minted them --
 * an import, which numbers them by slide position. So a key whose action id is
 * a generated one names exactly one clip and is adopted on that basis; a key
 * whose action id could have been minted twice is adopted only when the row
 * does carry text and that text matches the action being converted.
 *
 * That last case is deliberately strict, and it is worth naming what it does
 * not cover: two imports of the *same* deck produce identical notes, so
 * matching text proves nothing there. Refusing such a row costs one course its
 * cached narration; adopting the wrong one writes another course's audio into
 * a shared document permanently.
 */
function rowBelongsToAction(
  row: AudioFileRecord,
  stageId: string,
  action: DerivedNarration,
): boolean {
  if (row.stageId !== undefined) return row.stageId === stageId;
  if (derivedKeyIsUnique(action.derivedRef)) return true;
  const recorded = row.text?.trim();
  return recorded !== undefined && recorded !== '' && recorded === action.text.trim();
}

/**
 * Adopt this browser's cached narration for the open course.
 *
 * Safe to call on every load: a course whose narration is already allocated
 * finds nothing to do and touches neither the pool nor the document.
 *
 * The signal is the course's own. Allocation is uncancellable once started and
 * its write-back cannot be half-undone, so the loop stops between clips rather
 * than mid-clip -- and every write re-checks that this browser still has the
 * course open, because a `mutateDocument` on a departed course takes its lock
 * and, with the live store moved on, produces an allocation nothing references.
 */
export async function adoptCachedNarration(
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<NarrationAdoptionOutcome> {
  const running = runsByStage.get(stageId);
  if (!running) return startAdoptionRun(stageId, abortSignal);

  // A rescan is already waiting for that run. One is all any number of callers
  // need, so they share it -- and it takes this caller's signal, which is more
  // recent than the one it was created with.
  const waiting = queuedByStage.get(stageId);
  if (waiting) {
    waiting.signal = abortSignal;
    return waiting.outcome;
  }

  const queued: QueuedAdoption = {
    signal: abortSignal,
    outcome: running
      .catch(() => undefined)
      .then(() => {
        queuedByStage.delete(stageId);
        return startAdoptionRun(stageId, queued.signal);
      }),
  };
  queuedByStage.set(stageId, queued);
  return queued.outcome;
}

/** Run adoption now, and hold the course's slot for exactly as long as it runs. */
async function startAdoptionRun(
  stageId: string,
  abortSignal: AbortSignal | undefined,
): Promise<NarrationAdoptionOutcome> {
  const run = adoptCachedNarrationRun(stageId, abortSignal);
  runsByStage.set(stageId, run);
  try {
    return await run;
  } finally {
    if (runsByStage.get(stageId) === run) runsByStage.delete(stageId);
  }
}

async function adoptCachedNarrationRun(
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<NarrationAdoptionOutcome> {
  const idle: NarrationAdoptionOutcome = { adopted: 0, unbacked: 0 };
  if (!isServerBackedMediaPersistence()) return idle;
  // Fail-closed: 'owner' is the only answer that may write.
  if (!mayGenerateForStage(stageId)) return idle;

  const { useStageStore } = await import('@/lib/store/stage');
  const onThisCourse = (): boolean => useStageStore.getState().stage?.id === stageId;
  if (!onThisCourse()) return idle;

  const actions = derivedNarrationRefs(useStageStore.getState().scenes);
  if (actions.length === 0) return idle;

  // The store had no room the last time this browser wrote to it, so this load
  // spends ONE upload finding out whether that is still true instead of the
  // whole deck. A thirty-clip course would otherwise issue thirty refused
  // uploads per load against a ceiling that is deployment-wide anyway.
  //
  // A probe rather than a stand-down, deliberately. Adoption has no affordance
  // of its own: no button, no message, no task row. A course it stood down on
  // could only be released by a media Retry, and a course whose media needs
  // nothing -- a narration-only deck, or one whose slides are already
  // satisfied -- has none to click, so the marker became permanent and the
  // narration was lost for good. Adoption also spends no provider money, so
  // the entire cost of probing a store that is still full is one refused
  // upload; the entire cost of not probing was an unrecoverable course.
  let probing = await isAssetStorageFull(stageId);
  if (probing) {
    log.info(`Asset storage was full for ${stageId}; probing with a single clip.`);
  }

  let adopted = 0;
  let unbacked = 0;
  for (const action of actions) {
    if (abortSignal?.aborted) break;
    // The derived id IS the local key: that is what made it usable before
    // allocation existed.
    const row = await db.audioFiles.get(action.derivedRef).catch(() => undefined);
    if (!row?.blob || row.blob.size === 0) {
      unbacked += 1;
      continue;
    }
    if (!rowBelongsToAction(row, stageId, action)) {
      log.info(`Cached narration for ${action.derivedRef} belongs elsewhere; leaving it alone.`);
      unbacked += 1;
      continue;
    }
    // Re-checked after the read and before anything is spent: a course left in
    // the meantime must not have its remaining clips allocated against it.
    if (abortSignal?.aborted || !onThisCourse()) break;

    let assetId: string;
    try {
      // Bytes first, exactly as the media path does it: a document may never
      // name narration that was not stored.
      assetId = await putAsset(row.blob, {
        contentType: row.blob.type || `audio/${row.format}`,
        ...(row.duration === undefined ? {} : { durationSeconds: row.duration }),
      });
    } catch (error) {
      // One clip's storage failure costs that clip. The action keeps its
      // derived id and is adopted on a later load.
      log.warn(`Could not store cached narration ${action.derivedRef}:`, error);
      unbacked += 1;
      // Unless there is no room at all, in which case every clip after this one
      // would be refused at the same point. Remembered per course, exactly as
      // the media pass remembers it, so the next load probes with one clip
      // instead of repeating the whole deck.
      if (isStorageFullFailure(storageErrorCode(error))) {
        await markAssetStorageFull(stageId);
        unbacked = actions.length - adopted;
        break;
      }
      // A probe is one upload, whatever it answers. Nothing here disproves the
      // marker, so the rest of the deck waits for the next load exactly as it
      // would have on a refusal.
      if (probing) {
        unbacked = actions.length - adopted;
        break;
      }
      continue;
    }
    // The store took a write, so whatever was full is not full any more --
    // including for the media pass, which has no other way to learn it.
    await clearAssetStorageFull(stageId);
    probing = false;

    // The allocation is uncancellable, so it may finish after the course was
    // left. Its write-back is not: a document this browser no longer has open
    // would take a lock for a rewrite the live store cannot mirror.
    if (!onThisCourse()) {
      unbacked += 1;
      break;
    }

    const placed = await persistNarrationReference(stageId, action.derivedRef, assetId).catch(
      (error: unknown) => {
        log.warn(`Could not write back narration ${action.derivedRef}:`, error);
        return false;
      },
    );
    if (!placed) {
      unbacked += 1;
      continue;
    }

    // Local mirror under the new id, stage-scoped so it cannot be mistaken for
    // another course's the way the derived row could be. The document already
    // points at the pool, so a failed cache write costs a re-download.
    await db.audioFiles
      .put({ ...row, id: assetId, stageId, originAudioId: action.derivedRef })
      .catch((error: unknown) => {
        log.warn(`Local narration cache mirror failed for ${assetId}:`, error);
      });
    adopted += 1;
  }

  if (adopted > 0) {
    log.info(`Adopted ${adopted} cached narration clip(s) for ${stageId}; no provider call.`);
  }
  return { adopted, unbacked };
}
