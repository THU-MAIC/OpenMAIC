/**
 * Give a freshly built scene the allocated ids its media already has.
 *
 * Media generation runs alongside content generation, so an image is routinely
 * stored before the slide that asked for it exists. The write-back had nothing
 * to rewrite at that moment and parked the allocation; this is where it is
 * applied — on the scene object, before the scene is added to the store and
 * therefore before its first save. The document consequently never records the
 * placeholder, which is what makes one complete generation pass converge
 * instead of leaving work for the next owner load.
 *
 * The scene is mutated in place. Callers own the object at this point (it has
 * just been built by the generator and has not been handed to the store yet),
 * and rebuilding it would lose the identity the store's own migration relies
 * on.
 */
import { isServerBackedMediaPersistence } from '@/lib/persistence/media-persistence';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import type { Scene, Stage } from '@/lib/types/stage';

import {
  rewriteSceneMediaReference,
  rewriteStageMediaReference,
  sceneMediaPlaceholders,
  stageMediaPlaceholders,
  type GeneratedMediaReferenceRewrite,
} from './generated-media-references';
import {
  allocatedMediaReference,
  pendingMediaAllocation,
  takePendingMediaAllocations,
} from './pending-media-allocations';

/** Whether any placeholder this scene carries has bytes waiting for it. */
export function sceneHasPendingMediaAllocation(scene: Scene): boolean {
  const stageId = scene.stageId;
  if (!stageId) return false;
  for (const ref of sceneMediaPlaceholders(scene)) {
    if (pendingMediaAllocation(stageId, ref)) return true;
  }
  return false;
}

export function reconcileSceneMediaAllocations(scene: Scene): void {
  if (!isServerBackedMediaPersistence()) return;
  applyPendingMediaAllocationsToScene(scene);
}

/**
 * Drain every allocation this scene's placeholders claim, rewriting the scene
 * in place. Returns whether anything changed.
 *
 * Unguarded by the persistence mode on purpose: callers that already know they
 * are server-backed (the write-back funnel) must not pay for the check twice,
 * and the registry is empty in browser-only mode anyway.
 */
export function applyPendingMediaAllocationsToScene(scene: Scene): boolean {
  const stageId = scene.stageId;
  if (!stageId) return false;

  const placeholders = sceneMediaPlaceholders(scene);
  if (placeholders.size === 0) return false;

  let changed = false;
  for (const allocation of takePendingMediaAllocations(stageId, placeholders)) {
    const rewrite = {
      placeholderRef: allocation.placeholderRef,
      assetId: allocation.assetId,
      ...(allocation.posterAssetId ? { posterAssetId: allocation.posterAssetId } : {}),
    };
    if (!rewriteSceneMediaReference(scene, rewrite)) continue;
    changed = true;
    // The task was held under the placeholder while the allocation waited.
    // Re-key it now that the document names the allocated id, so the renderer
    // resolves the same way it does for media whose slot already existed.
    useMediaGenerationStore
      .getState()
      .rekeyDone(
        allocation.placeholderRef,
        allocation.assetId,
        allocation.objectUrl ?? '',
        allocation.posterObjectUrl,
        allocation.posterAssetId,
      );
  }
  return changed;
}

/**
 * The persistence write boundary's last look at a snapshot before it is stored.
 *
 * Every route into durable storage — a queued autosave whose snapshot was taken
 * before a rewrite landed, an editor-history entry replayed by an undo or a
 * later `applyOp`, the departing save a course switch flushes — carries content
 * captured at some earlier moment. Any of them can still hold a placeholder
 * this session has already allocated for, and writing it would undo a
 * successful write-back with no corrective flush left to follow. Point fixes at
 * each producer would leave the next producer to rediscover the same bug, so
 * the check lives here, where every producer must pass.
 *
 * The lookup is the session's allocation record, not the parked queue: a
 * placeholder whose rewrite landed long ago is exactly the case this catches.
 * Nothing is mutated in place; only the scenes and the stage that actually
 * change are rebuilt, so an unchanged snapshot writes through untouched.
 */
export function applyKnownMediaAllocations(
  stageId: string,
  stage: Stage | null | undefined,
  scenes: readonly Scene[],
): { stage: Stage | null | undefined; scenes: readonly Scene[] } | null {
  if (!isServerBackedMediaPersistence()) return null;

  const rewritesFor = (refs: Iterable<string>): GeneratedMediaReferenceRewrite[] => {
    const rewrites: GeneratedMediaReferenceRewrite[] = [];
    for (const ref of refs) {
      const allocation = allocatedMediaReference(stageId, ref);
      if (!allocation) continue;
      rewrites.push({
        placeholderRef: allocation.placeholderRef,
        assetId: allocation.assetId,
        ...(allocation.posterAssetId ? { posterAssetId: allocation.posterAssetId } : {}),
      });
    }
    return rewrites;
  };

  let changed = false;
  const nextScenes = scenes.map((scene) => {
    const rewrites = rewritesFor(sceneMediaPlaceholders(scene));
    if (rewrites.length === 0) return scene;
    const next = structuredClone(scene);
    let sceneChanged = false;
    for (const rewrite of rewrites) {
      if (rewriteSceneMediaReference(next, rewrite)) sceneChanged = true;
    }
    if (!sceneChanged) return scene;
    changed = true;
    return next;
  });

  let nextStage = stage;
  const stageRewrites = rewritesFor(stageMediaPlaceholders(stage));
  if (stageRewrites.length > 0 && stage) {
    const candidate = structuredClone(stage);
    let stageChanged = false;
    for (const rewrite of stageRewrites) {
      if (rewriteStageMediaReference(candidate, rewrite)) stageChanged = true;
    }
    if (stageChanged) {
      nextStage = candidate;
      changed = true;
    }
  }

  return changed ? { stage: nextStage, scenes: nextScenes } : null;
}
