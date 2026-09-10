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
 * and leave one of them referenced by nothing. So a course adopts once at a
 * time, and a second caller is told there is nothing for it to do.
 */
const runsByStage = new Map<string, Promise<NarrationAdoptionOutcome>>();

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
 * Whether this row can be shown to hold the narration of this action.
 *
 * A row that names a course names the only course it may be adopted into. A
 * legacy row predates that column -- and legacy rows are exactly the population
 * this feature exists for -- so it is admitted on the other evidence the row
 * carries: the text that was synthesized. No text, no adoption; a row that
 * cannot be tied to the action is indistinguishable from another course's.
 */
function rowBelongsToAction(
  row: AudioFileRecord,
  stageId: string,
  action: DerivedNarration,
): boolean {
  if (row.stageId !== undefined) return row.stageId === stageId;
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
  if (running) return running;
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
