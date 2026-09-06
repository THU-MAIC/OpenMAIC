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
 * The live stage store is updated with the same rewrite afterwards and the
 * rewritten units are marked dirty. Marking matters: an autosave round captures
 * its snapshot synchronously and writes that snapshot, so a round already in
 * flight when the rewrite lands will write the placeholder back over the
 * allocated id. Marking the same units dirty again after the rewrite leaves a
 * corrective flush queued behind it, and re-saving a scene that already holds
 * the id is idempotent — a lost write-back is not.
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

const log = createLogger('MediaReferenceWriteBack');

/**
 * `written` — at least one slot now holds the allocated id.
 * `unmatched` — no surface of this course references the placeholder, so there
 * is nothing to point at the stored bytes. The caller keeps the placeholder
 * and holds the allocation until a slot for it exists.
 */
export type MediaReferenceWriteBackResult = 'written' | 'unmatched';

/**
 * A write-back that could not complete, carrying whether any part of it reached
 * the document.
 *
 * The caller reclaims the allocation only when nothing did: an id that is
 * already named by a persisted scene must outlive the failure, or the document
 * would point at bytes that were deleted.
 */
export class MediaReferenceWriteBackError extends Error {
  override readonly name = 'MediaReferenceWriteBackError';

  constructor(
    override readonly cause: unknown,
    readonly documentWritten: boolean,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Clone a scene deeply enough that the rewrite cannot mutate store state. */
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
 * Point the document at stored bytes.
 *
 * Throws {@link MediaReferenceWriteBackError} if the document store refuses the
 * write; the caller must then leave the placeholder in place and, when nothing
 * reached the document, reclaim the allocation.
 */
export async function persistGeneratedMediaReference(
  stageId: string,
  rewrite: GeneratedMediaReferenceRewrite,
): Promise<MediaReferenceWriteBackResult> {
  let documentMatched = false;

  try {
    await mutateDocument(stageId, async (document, store) => {
      if (!document) return;
      const now = Date.now();
      for (const scene of document.scenes) {
        if (!rewriteSceneMediaReference(scene, rewrite)) continue;
        await store.putScene(stageId, { ...scene, updatedAt: now });
        documentMatched = true;
      }
      if (rewriteStageMediaReference(document.stage, rewrite)) {
        await store.putStage(stageId, { ...document.stage, updatedAt: now });
        documentMatched = true;
      }
    });
  } catch (error) {
    throw new MediaReferenceWriteBackError(error, documentMatched);
  }

  const liveMatched = applyToLiveStage(stageId, rewrite);
  if (!documentMatched && !liveMatched) {
    log.info(
      `No slot of stage ${stageId} references ${rewrite.placeholderRef} yet; holding the allocation until its scene arrives.`,
    );
    return 'unmatched';
  }
  return 'written';
}
