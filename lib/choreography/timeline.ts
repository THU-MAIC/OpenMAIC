/**
 * `resolveActionTimeline` — the index-domain → time-domain expansion.
 *
 * Playback drives actions by a `(sceneIndex, actionIndex)` cursor; a faithful
 * video exporter needs the same sequence laid out on a wall-clock. This pure
 * function formalizes the semantics the app's `PlaybackEngine.processNext`
 * switch expresses as control flow:
 *
 * - **Blocking** actions (speech, whiteboard, widget, video, discussion) hold
 *   the cursor until they complete — the next action starts after them.
 * - **Fire-and-forget** actions (spotlight, laser) do not block: playback
 *   continues immediately, and the effect persists visually for
 *   {@link EFFECT_AUTO_CLEAR_MS} before auto-clearing.
 *
 * The blocking/non-blocking partition is read from the DSL's
 * {@link FIRE_AND_FORGET_ACTIONS} rather than hardcoded here, so the two stay
 * in lockstep. Durations come from the shared {@link timing} spec.
 *
 * Pure, no runtime dependencies beyond `@openmaic/dsl`.
 */
import type {
  Action,
  SceneCore,
  SpeechAction,
  PlayVideoAction,
  WbDrawCodeAction,
  WbClearAction,
} from '@openmaic/dsl';
import { FIRE_AND_FORGET_ACTIONS } from '@openmaic/dsl';
import { EMPTY_SCENE_DWELL } from './cursor';
import {
  EFFECT_AUTO_CLEAR_MS,
  DISCUSSION_TRIGGER_DELAY_MS,
  MAX_VIDEO_WAIT_MS,
  WB_OPEN_MS,
  WB_DRAW_MS,
  WB_EDIT_MS,
  WB_DELETE_MS,
  WB_CLOSE_MS,
  WIDGET_MS,
  wbDrawCodeMs,
  wbClearMs,
  estimateSpeechDurationMs,
} from './timing';

const FIRE_AND_FORGET = new Set<string>(FIRE_AND_FORGET_ACTIONS);

export interface ResolveTimelineOptions {
  /** Playback speed multiplier applied to the no-audio speech estimate. Default 1. */
  playbackSpeed?: number;
  /**
   * Real narration duration (ms) for a speech action when pre-generated audio
   * exists. Return `null`/`undefined` to fall back to the deterministic
   * {@link estimateSpeechDurationMs}. The exporter, which knows each clip's
   * stored audio duration (issue #861), supplies this.
   */
  getAudioDurationMs?: (action: SpeechAction) => number | null | undefined;
  /**
   * Real video duration (ms) for a play_video action. Return `null`/`undefined`
   * when unknown (treated as 0, i.e. no dwell). Capped at {@link MAX_VIDEO_WAIT_MS}.
   */
  getVideoDurationMs?: (action: PlayVideoAction) => number | null | undefined;
  /**
   * Live whiteboard element count when a wb_clear runs (the clear animation
   * scales with it). Defaults to 0 (the animation floor) when not supplied; the
   * exporter, which replays whiteboard state, can provide the true count.
   */
  getClearElementCount?: (action: WbClearAction) => number;
}

export interface TimelineSegment {
  action: Action;
  sceneId: string;
  sceneIndex: number;
  actionIndex: number;
  /** Wall-clock start (ms) relative to the start of playback. */
  startMs: number;
  /** How long the action is visually present (ms). */
  durationMs: number;
  /**
   * How much the playback cursor advances (ms) before the next action starts.
   * Equal to `durationMs` for blocking actions, `0` for fire-and-forget.
   */
  advancesCursorMs: number;
  /** Whether the action blocks the cursor (false only for fire-and-forget). */
  blocking: boolean;
}

/** Line count of a code block, matching the app's `code.split('\n')` typing anim. */
function codeLineCount(code: string): number {
  return code.split('\n').length;
}

/**
 * The visual duration (ms) of a single action — how long it is present on
 * screen. For blocking actions this is also how long the cursor waits.
 */
function actionDurationMs(action: Action, opts: ResolveTimelineOptions): number {
  switch (action.type) {
    case 'speech': {
      const audio = opts.getAudioDurationMs?.(action);
      if (audio != null) return audio;
      return estimateSpeechDurationMs(action.text, { speed: opts.playbackSpeed ?? 1 });
    }
    case 'spotlight':
    case 'laser':
      return EFFECT_AUTO_CLEAR_MS;
    case 'discussion':
      // Deterministic dwell before the ProactiveCard shows. The subsequent
      // interactive wait (user answers/skips) is not part of the deterministic
      // timeline and is out of scope here.
      return DISCUSSION_TRIGGER_DELAY_MS;
    case 'play_video': {
      const video = opts.getVideoDurationMs?.(action) ?? 0;
      return Math.min(video, MAX_VIDEO_WAIT_MS);
    }
    case 'wb_open':
      return WB_OPEN_MS;
    case 'wb_draw_text':
    case 'wb_draw_shape':
    case 'wb_draw_chart':
    case 'wb_draw_latex':
    case 'wb_draw_table':
    case 'wb_draw_line':
      return WB_DRAW_MS;
    case 'wb_draw_code':
      return wbDrawCodeMs(codeLineCount((action as WbDrawCodeAction).code));
    case 'wb_edit_code':
      return WB_EDIT_MS;
    case 'wb_clear':
      return wbClearMs(opts.getClearElementCount?.(action as WbClearAction) ?? 0);
    case 'wb_delete':
      return WB_DELETE_MS;
    case 'wb_close':
      return WB_CLOSE_MS;
    case 'widget_highlight':
    case 'widget_setState':
    case 'widget_annotation':
    case 'widget_reveal':
      return WIDGET_MS;
    default:
      return 0;
  }
}

/**
 * Expand a scene list into an ordered wall-clock timeline. Scenes and their
 * actions are visited in order; a scene with no actions yields one
 * {@link EMPTY_SCENE_DWELL} beat (a blank speech clip's dwell) so it still
 * shows, mirroring {@link resolvePlaybackCursor}.
 *
 * @returns segments in play order, each stamped with `startMs`, its visual
 *          `durationMs`, and how far it `advancesCursorMs`.
 *
 * Typed against {@link SceneCore} (only `id` + `actions` are read), so an
 * app-widened `Scene` (extra content kinds) is accepted without casting.
 */
export function resolveActionTimeline(
  scenes: SceneCore[],
  opts: ResolveTimelineOptions = {},
): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let clockMs = 0;

  const push = (action: Action, sceneId: string, sceneIndex: number, actionIndex: number) => {
    const durationMs = actionDurationMs(action, opts);
    const blocking = !FIRE_AND_FORGET.has(action.type);
    const advancesCursorMs = blocking ? durationMs : 0;
    segments.push({
      action,
      sceneId,
      sceneIndex,
      actionIndex,
      startMs: clockMs,
      durationMs,
      advancesCursorMs,
      blocking,
    });
    clockMs += advancesCursorMs;
  };

  scenes.forEach((scene, sceneIndex) => {
    const actions = scene.actions ?? [];
    if (actions.length === 0) {
      // Empty scene → one synthetic dwell beat, exactly as the cursor yields.
      push(EMPTY_SCENE_DWELL, scene.id, sceneIndex, 0);
      return;
    }
    actions.forEach((action, actionIndex) => {
      push(action, scene.id, sceneIndex, actionIndex);
    });
  });

  return segments;
}
