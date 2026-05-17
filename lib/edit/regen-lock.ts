/**
 * AI regeneration lock predicate — the reverse direction of #564's
 * auto-exit. `isCurrentSceneEditable` blocks ENTERING edit mode on a
 * generating scene; this predicate is the check regenerate-this-scene
 * call sites perform before STARTING generation, so a scene that is
 * currently being edited cannot have its content silently replaced.
 *
 * Pure function — caller pulls `mode` + `currentSceneId` from the stage
 * store and provides the candidate sceneId. Pessimistic semantics
 * (refuse, do not queue) match the v0 design; callers surface the
 * refusal however makes sense locally (toast, retry-later button, etc.)
 *
 * Wiring (slide-surface PR / future regen entry points):
 *   - `useSceneGenerator.retrySingleOutline` calls this before kicking
 *     off content generation; if locked, returns early.
 *   - Any future "regenerate a successful scene" feature does the same.
 *   - Current `retrySingleOutline` only operates on failed outlines and
 *     so cannot structurally hit this guard, but the pattern is in
 *     place for the moment a successful-scene regen ships.
 */

import type { StageMode } from '@/lib/types/stage';

export interface SceneEditLockState {
  readonly sceneId: string;
  readonly mode: StageMode;
  readonly currentSceneId: string | null;
}

export function isSceneEditLocked(state: SceneEditLockState): boolean {
  return state.mode === 'edit' && state.currentSceneId === state.sceneId;
}
