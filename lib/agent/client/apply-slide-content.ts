'use client';

/**
 * Apply a scene patch to the stage store while keeping the OPEN slide edit
 * session in lockstep. Shared by both the `regenerate_scene` apply path and the
 * "restore previous" button — without reseeding the open session, the canvas
 * keeps rendering its stale `history.present` and the next edit clobbers the
 * applied change.
 */
import { useStageStore } from '@/lib/store/stage';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import type { ScenePatch, SlideContent } from '@/lib/types/stage';

/** Apply a scene patch to the stage store and keep the OPEN slide edit session
 *  in lockstep (else the canvas renders stale history and clobbers the change). */
export function applyScenePatchInSync(sceneId: string, patch: ScenePatch): void {
  useStageStore.getState().updateScene(sceneId, patch);
  const es = useSlideEditSession.getState();
  if (patch.content && es.sceneId === sceneId) {
    es.seed(sceneId, patch.content as SlideContent);
  }
}
