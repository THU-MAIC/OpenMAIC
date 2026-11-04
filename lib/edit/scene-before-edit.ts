/**
 * Scenes as they stood before their first unsaved edit, kept until the sync next
 * compares what it read (`lib/edit/scene-echo.ts`). Separate from that module so the
 * stage store, imported everywhere, does not carry the sanitizer into every bundle.
 */

import type { Scene } from '@/lib/types/stage';

const KEPT_PER_SCENE = 8;

const pendingByStage = new Map<string, Map<string, Scene[]>>();

export function noteSceneBeforeEdit(stageId: string, scene: Scene): void {
  let stage = pendingByStage.get(stageId);
  if (!stage) {
    stage = new Map();
    pendingByStage.set(stageId, stage);
  }
  const kept = stage.get(scene.id) ?? [];
  kept.push(scene);
  if (kept.length > KEPT_PER_SCENE) kept.shift();
  stage.set(scene.id, kept);
}

/** Hand over what was noted for this course since the last call. */
export function takeScenesBeforeEdit(stageId: string): Scene[] {
  const stage = pendingByStage.get(stageId);
  if (!stage) return [];
  pendingByStage.delete(stageId);
  return [...stage.values()].flat();
}
