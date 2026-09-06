'use client';

/**
 * Write an allocated asset id back into the document that asked for the media.
 *
 * Under server-backed persistence the document outlives the browser, so a
 * generation placeholder left in place is a permanent instruction to every
 * later reader to generate the same media again. This is the single write-back
 * funnel: it goes through the same document store the rest of the app writes
 * through, inside `mutateDocument`, which re-reads the current document under
 * the per-stage document lock.
 *
 * What that lock buys, exactly: the Web Locks API serializes this rewrite
 * against other writers **in this browser**, so a save running in another tab
 * of the same profile cannot interleave with the read-modify-write. It says
 * nothing about other browsers or devices, which is precisely the world a
 * shared document lives in. Against a concurrent editor elsewhere the write is
 * last-write-wins over the whole scene, because `putScene` sends the scene
 * object and the store has no conditional write to send it under. Reload-then-
 * write narrows the window to the round trip; closing it needs a compare-and-
 * swap the document contract does not have yet.
 *
 * The live stage store is updated with the same rewrite and the rewritten units
 * are marked dirty. Marking matters: an autosave round captures its snapshot
 * synchronously and writes that snapshot, so a round already in flight when the
 * rewrite lands will write the placeholder back over the allocated id. Marking
 * the same units dirty again after the rewrite leaves a corrective flush queued
 * behind it, and re-saving a scene that already holds the id is idempotent — a
 * lost write-back is not.
 *
 * An allocation this funnel cannot place is parked, never dropped, and never
 * silently reclaimed: the id may already be referenced by a write whose
 * response was lost, and the bytes are paid for either way. The one case that
 * reclaims is the one where nothing could possibly hold the id — no store write
 * was ever issued and no live scene took it.
 */
import { mutateDocument } from '@/lib/document-store';
import { createLogger } from '@/lib/logger';
import { markStagePersistenceDirty, useStageStore } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';
import type { PendingChange } from '@/lib/utils/stage-storage';

import {
  rewriteSceneMediaReference,
  rewriteStageMediaReference,
  sceneCarriesMediaReference,
  stageCarriesMediaReference,
  type GeneratedMediaReferenceRewrite,
} from './generated-media-references';
import {
  recordMediaAllocation,
  recordPendingMediaAllocation,
  type PendingMediaAllocation,
} from './pending-media-allocations';
import {
  applyPendingMediaAllocationsToScene,
  sceneHasPendingMediaAllocation,
} from './reconcile-scene-media';

const log = createLogger('MediaReferenceWriteBack');

/**
 * `written` — at least one slot now holds the allocated id.
 * `held` — no surface of this course references the placeholder yet, so the
 * allocation is parked under it until the slide that wants it is committed.
 *
 * Either way the allocation is recorded for the course's session, so a snapshot
 * captured before this call cannot write the placeholder back later.
 */
export type MediaReferenceWriteBackResult = 'written' | 'held';

/**
 * A write-back that could not complete.
 *
 * `allocationRetained` is the caller's whole decision: `true` means the ids may
 * already be referenced by the document, or are parked for a later attempt, and
 * deleting them would destroy media something points at. Only `false` — no
 * store write was ever issued and nothing took the ids — permits reclamation.
 */
export class MediaReferenceWriteBackError extends Error {
  override readonly name = 'MediaReferenceWriteBackError';

  constructor(
    override readonly cause: unknown,
    readonly allocationRetained: boolean,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

function rewriteOf(allocation: PendingMediaAllocation): GeneratedMediaReferenceRewrite {
  return {
    placeholderRef: allocation.placeholderRef,
    assetId: allocation.assetId,
    ...(allocation.posterAssetId ? { posterAssetId: allocation.posterAssetId } : {}),
  };
}

/** Clone a scene deeply enough that a rewrite cannot mutate store state. */
function cloneScene(scene: Scene): Scene {
  return structuredClone(scene);
}

function applyToLiveStage(stageId: string, rewrite: GeneratedMediaReferenceRewrite): boolean {
  const state = useStageStore.getState();
  if (state.stage?.id !== stageId) return false;

  const dirty: PendingChange[] = [];
  const scenes = state.scenes.map((scene) => {
    if (!sceneCarriesMediaReference(scene, rewrite.placeholderRef)) return scene;
    const next = cloneScene(scene);
    if (!rewriteSceneMediaReference(next, rewrite)) return scene;
    dirty.push({ kind: 'scene', sceneId: next.id });
    return next;
  });

  let stage = state.stage;
  if (stageCarriesMediaReference(stage, rewrite.placeholderRef)) {
    const nextStage = structuredClone(stage);
    if (rewriteStageMediaReference(nextStage, rewrite)) {
      stage = nextStage;
      dirty.push({ kind: 'stage' });
    }
  }

  if (dirty.length === 0) return false;
  // Order matters: the store must already hold the rewrite when the mark
  // schedules the next flush, so the snapshot that flush captures carries it.
  useStageStore.setState({ scenes, stage });
  markStagePersistenceDirty(dirty);
  return true;
}

/**
 * Hand every parked allocation to the open course's scene that now wants it.
 *
 * A scene can be committed while a write-back's round trip is in flight; its
 * own reconciliation ran against a registry that did not yet hold the entry, so
 * the entry would otherwise sit there for a scene that will never be added
 * again — and, worse, answer the skip test as "already handled". This is the
 * second look that keeps that from happening; it is also what makes a parked
 * allocation converge on a later generation pass rather than only at commit.
 */
export function placePendingMediaAllocations(stageId: string): boolean {
  const state = useStageStore.getState();
  if (state.stage?.id !== stageId) return false;

  const dirty: PendingChange[] = [];
  const scenes = state.scenes.map((scene) => {
    if (!sceneHasPendingMediaAllocation(scene)) return scene;
    const next = cloneScene(scene);
    if (!applyPendingMediaAllocationsToScene(next)) return scene;
    dirty.push({ kind: 'scene', sceneId: next.id });
    return next;
  });

  if (dirty.length === 0) return false;
  useStageStore.setState({ scenes });
  markStagePersistenceDirty(dirty);
  return true;
}

/**
 * Point the document at stored bytes.
 *
 * Throws {@link MediaReferenceWriteBackError} if the document store refuses the
 * write. The allocation is placed or parked before the throw whenever the ids
 * could be referenced; the caller reclaims only when `allocationRetained` is
 * false.
 */
export async function persistGeneratedMediaReference(
  allocation: PendingMediaAllocation,
): Promise<MediaReferenceWriteBackResult> {
  const { stageId } = allocation;
  const rewrite = rewriteOf(allocation);
  // Recorded before the attempt, and kept whatever the attempt does with it.
  // Every later snapshot that still carries this placeholder — a queued save,
  // an editor-history entry, a departing-course flush — is rewritten from this
  // record at the persistence write boundary.
  recordMediaAllocation(allocation);
  let documentMatched = false;
  // Set immediately BEFORE handing a write to the store, never after it
  // resolves: a rejected request does not prove the server did not apply it,
  // so an attempted write is enough to make the ids possibly-referenced.
  let writeIssued = false;

  try {
    await mutateDocument(stageId, async (document, store) => {
      if (!document) return;
      const now = Date.now();
      for (const scene of document.scenes) {
        if (!rewriteSceneMediaReference(scene, rewrite)) continue;
        writeIssued = true;
        await store.putScene(stageId, { ...scene, updatedAt: now });
        documentMatched = true;
      }
      if (rewriteStageMediaReference(document.stage, rewrite)) {
        writeIssued = true;
        await store.putStage(stageId, { ...document.stage, updatedAt: now });
        documentMatched = true;
      }
    });
  } catch (error) {
    // Whatever the document did or did not receive, the live store must not be
    // left behind it: the next ordinary flush writes the live snapshot, and a
    // snapshot still holding the placeholder would undo the half that landed.
    const placedLive = applyToLiveStage(stageId, rewrite);
    if (!placedLive && writeIssued) recordPendingMediaAllocation(allocation);
    throw new MediaReferenceWriteBackError(error, placedLive || writeIssued);
  }

  // No await may be introduced between this live check and the park below. The
  // two are one decision: a scene committed between them would reconcile
  // against a registry that does not hold the entry yet, and the entry it then
  // finds nothing to give would sit there answering the skip test forever. That
  // gap is exactly the defect this ordering exists to remove.
  const liveMatched = applyToLiveStage(stageId, rewrite);
  if (!documentMatched && !liveMatched) {
    recordPendingMediaAllocation(allocation);
    log.info(
      `No slot of stage ${stageId} references ${allocation.placeholderRef} yet; holding the allocation until its scene arrives.`,
    );
    return 'held';
  }
  return 'written';
}
