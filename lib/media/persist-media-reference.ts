'use client';

/**
 * Write an allocated asset id back into the document that asked for the media.
 *
 * Under server-backed persistence the document outlives the browser, so a
 * generation placeholder left in place is a permanent instruction to every
 * later reader to generate the same media again. This is the single write-back
 * funnel: it goes through the same document store the rest of the app writes
 * through, inside `mutateDocument`, which re-reads the current document under
 * the per-stage document lock. The rewrite is therefore applied to whatever
 * the document holds now, never to a snapshot captured before generation
 * started — the HTTP document store has no compare-and-swap, so reload-then-
 * write is what keeps a concurrent edit from being clobbered.
 *
 * The live stage store is updated with the same rewrite afterwards, without
 * marking anything dirty. That is cache coherence, not a second save path: it
 * stops a later ordinary flush of the open course from writing the placeholder
 * back over the id that was just persisted, and it lets a scene that has been
 * generated but not yet written carry the allocated id into its first save.
 */
import { mutateDocument } from '@/lib/document-store';
import { createLogger } from '@/lib/logger';
import { useStageStore } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';

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
 * is nothing to point at the stored bytes. The caller keeps the placeholder.
 */
export type MediaReferenceWriteBackResult = 'written' | 'unmatched';

/** Clone a scene deeply enough that the rewrite cannot mutate store state. */
function cloneScene(scene: Scene): Scene {
  return structuredClone(scene);
}

function applyToLiveStage(stageId: string, rewrite: GeneratedMediaReferenceRewrite): boolean {
  const state = useStageStore.getState();
  if (state.stage?.id !== stageId) return false;

  let changed = false;
  const scenes = state.scenes.map((scene) => {
    if (!sceneCarriesMediaReference(scene, rewrite.placeholderRef)) return scene;
    const next = cloneScene(scene);
    if (!rewriteSceneMediaReference(next, rewrite)) return scene;
    changed = true;
    return next;
  });

  let stage = state.stage;
  if (stageCarriesMediaReference(stage, rewrite.placeholderRef)) {
    const nextStage = structuredClone(stage);
    if (rewriteStageMediaReference(nextStage, rewrite)) {
      stage = nextStage;
      changed = true;
    }
  }

  if (changed) useStageStore.setState({ scenes, stage });
  return changed;
}

/**
 * Point the document at stored bytes. Throws if the document store refuses the
 * write; the caller must then leave the placeholder in place.
 */
export async function persistGeneratedMediaReference(
  stageId: string,
  rewrite: GeneratedMediaReferenceRewrite,
): Promise<MediaReferenceWriteBackResult> {
  let documentMatched = false;

  await mutateDocument(stageId, async (document, store) => {
    if (!document) return;
    const now = Date.now();
    for (const scene of document.scenes) {
      if (!rewriteSceneMediaReference(scene, rewrite)) continue;
      documentMatched = true;
      await store.putScene(stageId, { ...scene, updatedAt: now });
    }
    if (rewriteStageMediaReference(document.stage, rewrite)) {
      documentMatched = true;
      await store.putStage(stageId, { ...document.stage, updatedAt: now });
    }
  });

  const liveMatched = applyToLiveStage(stageId, rewrite);
  if (!documentMatched && !liveMatched) {
    log.warn(
      `No slot of stage ${stageId} references ${rewrite.placeholderRef}; the allocated asset is left unreferenced.`,
    );
    return 'unmatched';
  }
  return 'written';
}
