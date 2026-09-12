'use client';

/**
 * Write an allocated narration id back into the speech actions that hold a
 * derived one.
 *
 * The sibling of the generated-media write-back funnel, for the other family
 * of references a course carries, and it follows the same three rules for the
 * same reasons. The write goes through `mutateDocument`, so it re-reads the
 * current document under the per-stage lock rather than overwriting whatever a
 * concurrent editor wrote. The live stage store takes the same rewrite and its
 * scenes are marked dirty, so an autosave round that captured the derived id
 * before the rewrite leaves a corrective flush queued behind it. And the
 * rewrite is recorded, so the persistence write boundary can correct a snapshot
 * that no dirty mark reaches -- an editor-history entry replayed by undo being
 * the one that taught the media path this lesson.
 *
 * It is simpler than the media funnel in one way that matters: there is nothing
 * to park. A media placeholder can be committed before the slide that carries
 * it exists, so its allocation has to wait somewhere; a speech action being
 * converted is by definition already in the document being read.
 */
import { mutateDocument } from '@/lib/document-store';
import { markStagePersistenceDirty, useStageStore } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';
import type { PendingChange } from '@/lib/utils/stage-storage';

import { recordNarrationAllocation } from './narration-allocations';

/** Whether any speech action in this scene still holds `derivedRef`. */
export function sceneCarriesNarrationReference(scene: Scene, derivedRef: string): boolean {
  return (scene.actions ?? []).some(
    (action) => action.type === 'speech' && action.audioId === derivedRef,
  );
}

/**
 * Point every speech action holding `derivedRef` at `assetId`, in place.
 *
 * Returns whether anything changed. A derived id is shared by no two actions in
 * practice -- it is built from the scene order and the action id -- but the
 * rewrite is written as a sweep anyway, because a duplicated id must not leave
 * half the actions behind.
 */
export function rewriteSceneNarrationReference(
  scene: Scene,
  derivedRef: string,
  assetId: string,
): boolean {
  let changed = false;
  for (const action of scene.actions ?? []) {
    if (action.type !== 'speech' || action.audioId !== derivedRef) continue;
    action.audioId = assetId;
    changed = true;
  }
  return changed;
}

function applyToLiveStage(stageId: string, derivedRef: string, assetId: string): boolean {
  const state = useStageStore.getState();
  if (state.stage?.id !== stageId) return false;

  const dirty: PendingChange[] = [];
  const scenes = state.scenes.map((scene) => {
    // Cloned only once the scene is known to carry the reference. Adoption runs
    // over every clip of a course on the load path, so cloning every scene per
    // clip would be a deck-sized deep copy per line of narration.
    if (!sceneCarriesNarrationReference(scene, derivedRef)) return scene;
    const next = structuredClone(scene);
    if (!rewriteSceneNarrationReference(next, derivedRef, assetId)) return scene;
    dirty.push({ kind: 'scene', sceneId: next.id });
    return next;
  });

  if (dirty.length === 0) return false;
  // Order matters: the store must already hold the rewrite when the mark
  // schedules the next flush, so the snapshot that flush captures carries it.
  useStageStore.setState({ scenes });
  markStagePersistenceDirty(dirty);
  return true;
}

/**
 * Persist the rewrite, and report whether the reference is now -- or is queued
 * to become -- the allocated id.
 *
 * A document write that fails still leaves the live store rewritten: the bytes
 * are stored either way, and the next ordinary flush is what carries the id to
 * the server. Returning `false` means nothing anywhere took the rewrite, which
 * is the only case where the allocation bought nothing.
 */
export async function persistNarrationReference(
  stageId: string,
  derivedRef: string,
  assetId: string,
): Promise<boolean> {
  let documentMatched = false;
  // Recorded before the first write is issued, not after the round trip ends:
  // a save that flushes during that trip captures its snapshot from the live
  // store, and the write boundary can only correct it against a record that
  // already exists.
  recordNarrationAllocation(stageId, derivedRef, assetId);
  try {
    await mutateDocument(stageId, async (document, store) => {
      if (!document) return;
      const now = Date.now();
      for (const scene of document.scenes) {
        if (!rewriteSceneNarrationReference(scene, derivedRef, assetId)) continue;
        await store.putScene(stageId, { ...scene, updatedAt: now });
        documentMatched = true;
      }
    });
  } catch (error) {
    const placedLive = applyToLiveStage(stageId, derivedRef, assetId);
    if (!placedLive) throw error;
    return true;
  }

  const placedLive = applyToLiveStage(stageId, derivedRef, assetId);
  return documentMatched || placedLive;
}
