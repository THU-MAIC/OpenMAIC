import type { SceneType } from '@/lib/types/stage';

/**
 * The narration timeline (ActionsBar) is decoupled from the canvas editor
 * surface. It applies wherever a spoken script makes sense: scene types with a
 * registered editor surface (slide/quiz), PLUS view-only-canvas scenes that
 * still carry narration (interactive/pbl). Mirrors how the AI edit panel
 * (agentEnabled) is decoupled from the canvas surface in EditChromeRoot.
 */
const NARRATION_ONLY_TYPES: ReadonlySet<SceneType> = new Set(['interactive', 'pbl']);

export function supportsNarrationTimeline(
  sceneType: SceneType,
  hasRegisteredSurface: boolean,
): boolean {
  return hasRegisteredSurface || NARRATION_ONLY_TYPES.has(sceneType);
}
