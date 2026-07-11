import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

/**
 * Resolve a scene's generation outline by stable identity (`outlineId`) rather
 * than by the mutable `order`.
 *
 * Pro-mode insert / reorder / delete rebalances `scene.order` while the
 * persisted `outlines` array keeps the original generation plan, so matching an
 * outline by `order` attaches **another slide's** outline (wrong title / type /
 * key points) to the scene being edited once the deck has been reordered.
 * Matching by the stamped `outlineId` is reorder-stable.
 *
 * Scenes built before `outlineId` existed, or freshly inserted scenes that have
 * no originating outline, fall back to an outline derived from the scene itself
 * — never another slide's outline.
 */
export function resolveSceneOutline(scene: Scene, outlines: SceneOutline[]): SceneOutline {
  const matched = scene.outlineId ? outlines.find((o) => o.id === scene.outlineId) : undefined;
  return (
    matched ?? {
      id: scene.id,
      type: scene.type,
      title: scene.title,
      description: '',
      keyPoints: [],
      order: scene.order,
    }
  );
}
