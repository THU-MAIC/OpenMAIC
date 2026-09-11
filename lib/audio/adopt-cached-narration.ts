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
 * At most ONE rescan is queued at a time, and it belongs to every caller waiting
 * for it. A chain would be pointless — the first rescan converts whatever is
 * left, and every later one would find an allocated id on every action — so
 * what coalescing buys is precisely a bounded queue: N callers no longer build
 * N sequential runs, and the rescan starts with a signal that is aborted only
 * once every caller sharing it has left, so a surface that closes cannot stop
 * work another surface is still waiting for.
 *
 * What it does NOT buy, and this is worth stating because it looks like it
 * should: it is no protection against a stalled upload. The queued rescan is
 * chained off the run in flight, so a `putAsset` that never settles leaves the
 * rescan unstarted and every waiting caller pending, exactly as a chain would.
 * That is the same uncancellable tail the media pass has, recorded as a known
 * limitation rather than solved here.
 */
const runsByStage = new Map<string, Promise<unknown>>();

/** A rescan that has not started yet, and the callers waiting for it. */
interface QueuedAdoption {
  /** One entry per caller sharing this rescan. `undefined` means "never leaves". */
  readonly signals: (AbortSignal | undefined)[];
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
  // need, so this caller joins it rather than queueing another.
  const waiting = queuedByStage.get(stageId);
  if (waiting) {
    waiting.signals.push(abortSignal);
    return waiting.outcome;
  }

  const queued: QueuedAdoption = {
    signals: [abortSignal],
    outcome: running
      .catch(() => undefined)
      .then(() => {
        queuedByStage.delete(stageId);
        const shared = whileAnyCallerStays(queued.signals);
        return startAdoptionRun(stageId, shared.signal).finally(shared.release);
      }),
  };
  queuedByStage.set(stageId, queued);
  return queued.outcome;
}

/**
 * One signal for a run several callers share, aborted only once they have all
 * left.
 *
 * Taking the newest caller's signal was tried and is a quieter version of the
 * defect the queue exists to prevent: the caller that arrived last is not
 * necessarily the caller that is still there, so a surface that opens a course
 * and closes it again would stop a rescan the surface still showing that course
 * is waiting for -- and that surface is latched, so it would not ask again.
 *
 * A caller that passed no signal never leaves, which makes the composite
 * uncancellable; that is the correct reading of "someone is still here".
 */
function whileAnyCallerStays(signals: readonly (AbortSignal | undefined)[]): {
  readonly signal: AbortSignal | undefined;
  readonly release: () => void;
} {
  if (signals.some((candidate) => candidate === undefined)) {
    return { signal: undefined, release: () => undefined };
  }
  const callers = signals as readonly AbortSignal[];
  const composite = new AbortController();
  const abortOnceEveryoneHasLeft = (): void => {
    if (callers.every((caller) => caller.aborted)) composite.abort();
  };
  for (const caller of callers) caller.addEventListener('abort', abortOnceEveryoneHasLeft);
  // The last caller may already have left before the run got its turn.
  abortOnceEveryoneHasLeft();
  return {
    signal: composite.signal,
    // Listeners on a course's own controllers outlive the run otherwise, and a
    // long workbench session opens many courses.
    release: () => {
      for (const caller of callers) caller.removeEventListener('abort', abortOnceEveryoneHasLeft);
    },
  };
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

  // No marker is read here, and none is written. The store checks each write
  // against the headroom it has left, so "refused for want of room" is a fact
  // about one blob; adoption pays no provider for a refusal, so it needs no
  // deck-wide memory of one either. It attempts, every load, every clip it
  // holds that an earlier refusal in the same run has not already answered for,
  // and lets the ones that do not fit wait for a bigger ceiling.
  //
  // Sharing the media pass's marker was tried across several rounds and the
  // coupling is what kept failing: the flag means "do not spend money here",
  // which is a claim adoption is in no position to make. One clip larger than
  // current headroom was enough to stand a course's whole image pass down
  // indefinitely -- on a store that had just accepted adoption's other clips.
  // The marker is now written only by the paths whose refusal cost a provider
  // call.
  //
  // What keeps a load bounded is not memory of an earlier load but the store's
  // own arithmetic, applied within this one. The rule is
  // `used + addedBytes > quotaBytes`, and `used` only grows while a run is
  // uploading, so a clip of size s refused for want of room implies every clip
  // of size >= s is refused for the rest of this run. That is an implication,
  // not a guess about the deployment: it needs no flag, no key and nothing
  // carried across loads.
  //
  // So the run remembers the smallest size it has been refused, and skips
  // anything at least that large without uploading it. A smaller clip is still
  // attempted, because it may fit.
  //
  // The exact cost, since an approximation here is what the previous version of
  // this comment got wrong: on a deck the store refuses entirely, one upload
  // per successive size minimum IN DOCUMENT ORDER. That is one for a deck whose
  // clips grow, about ln N for an arbitrary one, and N for a deck whose clips
  // only shrink -- a long opener followed by terser lines is exactly that
  // shape. The bound resets per run and a refused clip stays outstanding, so
  // every fully-refused load costs the same; no load is cheaper than the first.
  // On a deck the store has room for it costs nothing, because nothing is
  // refused.
  //
  // Making that one upload for ANY ordering needs a fact only the store has:
  // its remaining headroom. The 507 already carries a `details` channel that
  // the client surfaces and the server leaves empty, so putting the headroom
  // there would let this skip everything above it after a single refusal. That
  // is a cross-package change and a follow-up, not something to fake here.
  //
  // The implication itself is exact, not merely conservative. Quota is charged
  // at the blob's full length with no discount for a duplicate, the sum it is
  // checked against joins entries to blobs -- so the byte collector, which only
  // removes blobs no entry names, cannot lower it -- and the check takes a
  // per-principal lock before summing, so it never reads an uncommitted or
  // rolled-back row. Replace and delete are refused to every browser. Nothing a
  // run can do makes room appear inside it.
  let smallestRefusedForRoom = Number.POSITIVE_INFINITY;

  let adopted = 0;
  let unbacked = 0;
  for (const action of actions) {
    // A course left mid-loop must not have the rest of its deck allocated
    // against it, or its document lock taken for them.
    if (abortSignal?.aborted || !onThisCourse()) break;
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
    // Already known not to fit: something no larger than this was refused
    // earlier in this same run, and the store has only filled up since.
    if (row.blob.size >= smallestRefusedForRoom) {
      unbacked += 1;
      continue;
    }
    // Re-checked after the read and before anything is spent.
    if (abortSignal?.aborted || !onThisCourse()) break;

    let assetId: string;
    try {
      // Bytes first, exactly as the media path does it: a document may never
      // name narration that was not stored.
      assetId = await putAsset(
        row.blob,
        {
          contentType: row.blob.type || `audio/${row.format}`,
          ...(row.duration === undefined ? {} : { durationSeconds: row.duration }),
        },
        // A write that goes through retires this course's "no room" note, at
        // the seam rather than here. Together with generated narration this is
        // the only path that can establish that for a course whose media needs
        // nothing, and it is worth naming what it costs: a few hundred bytes of
        // narration fit in headroom an image does not, so retiring the note can
        // let the next pass pay a provider for an image that is refused again.
        // Bounded at one such generation, because that pass re-marks and
        // adoption converts everything that fits in a single load, and the
        // alternative is a course whose media never generates again.
        { stageId },
      );
    } catch (error) {
      // One clip's storage failure costs that clip and nothing else. The action
      // keeps its derived id, the deck carries on, and a later load tries
      // again -- which is how a course converges the moment the ceiling moves,
      // with nothing to click and nothing to remember.
      log.warn(`Could not store cached narration ${action.derivedRef}:`, error);
      unbacked += 1;
      // A refusal for room, and only that, lowers the bar for the rest of this
      // run. Any other failure -- a dropped connection, a 500 -- says nothing
      // about how much room there is, so it must not stop the next clip being
      // attempted.
      if (isStorageFullFailure(storageErrorCode(error))) {
        smallestRefusedForRoom = Math.min(smallestRefusedForRoom, row.blob.size);
      }
      continue;
    }
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
