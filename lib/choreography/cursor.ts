/**
 * Playback cursor — resolve the current action from a `(sceneIndex, actionIndex)`
 * cursor over a scene list.
 *
 * Moved verbatim from the app's `lib/playback/engine-cursor.ts` so the app
 * runtime and the video exporter walk scenes identically. Pure — types come
 * from `@openmaic/dsl`, no runtime dependencies.
 */
import type { Action, SceneCore } from '@openmaic/dsl';

/**
 * Synthetic dwell beat yielded for a scene that carries no actions. It is an
 * empty-text speech, so the engine routes it through the same reading-timer
 * dwell a blank speech clip already uses — the slide shows for a short beat
 * instead of being skipped (which would make it vanish from playback). A scene
 * with `actions: []` thus behaves exactly like one carrying a single blank
 * speech clip.
 */
export const EMPTY_SCENE_DWELL: Action = {
  id: '__empty_scene_dwell__',
  type: 'speech',
  text: '',
} as Action;

export interface CursorResult {
  action: Action;
  sceneId: string;
  /** The (possibly advanced) scene cursor the engine should adopt. */
  sceneIndex: number;
  /** The (possibly advanced) action cursor the engine should adopt. */
  actionIndex: number;
}

/**
 * Resolve the current playback action from a `(sceneIndex, actionIndex)` cursor,
 * advancing past scenes whose actions are exhausted. A scene with no actions
 * yields one {@link EMPTY_SCENE_DWELL} beat (when its action cursor is still 0)
 * rather than being skipped. Returns `null` once every scene is consumed.
 *
 * Pure: it does not mutate inputs; the caller adopts the returned cursor. Typed
 * against {@link SceneCore} (only `id` + `actions` are read), so an app-widened
 * `Scene` (extra content kinds) is accepted without casting.
 */
export function resolvePlaybackCursor(
  scenes: SceneCore[],
  sceneIndex: number,
  actionIndex: number,
): CursorResult | null {
  let si = sceneIndex;
  let ai = actionIndex;
  while (si < scenes.length) {
    const actions = scenes[si].actions ?? [];
    if (actions.length === 0) {
      if (ai === 0) {
        return {
          action: EMPTY_SCENE_DWELL,
          sceneId: scenes[si].id,
          sceneIndex: si,
          actionIndex: ai,
        };
      }
      si++;
      ai = 0;
      continue;
    }
    if (ai < actions.length) {
      return { action: actions[ai], sceneId: scenes[si].id, sceneIndex: si, actionIndex: ai };
    }
    si++;
    ai = 0;
  }
  return null;
}
