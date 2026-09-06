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
import type { Scene } from '@/lib/types/stage';

import { rewriteSceneMediaReference, sceneMediaPlaceholders } from './generated-media-references';
import { pendingMediaAllocation, takePendingMediaAllocations } from './pending-media-allocations';

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
