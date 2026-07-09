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
  WbDrawTextAction,
  WbDrawTableAction,
  WbEditCodeAction,
  DiscussionAction,
  WbClearAction,
} from '@openmaic/dsl';
import { FIRE_AND_FORGET_ACTIONS } from '@openmaic/dsl';
import { EMPTY_SCENE_DWELL } from './cursor';
import {
  EFFECT_AUTO_CLEAR_MS,
  DISCUSSION_TRIGGER_DELAY_MS,
  DISCUSSION_AUTO_SKIP_MS,
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

/**
 * Synthetic segment emitted when a whiteboard mutation runs while the board is
 * closed. The app's `ActionEngine.execute()` awaits `ensureWhiteboardOpen()`
 * (a `WB_OPEN_MS` open animation) before any `wb_*` action other than
 * `wb_open`/`wb_close`, so the exporter must lay down that same beat or every
 * later segment starts `WB_OPEN_MS` too early. Distinct id so consumers can
 * tell it apart from an authored `wb_open`.
 */
export const IMPLICIT_WB_OPEN: Action = {
  id: '__implicit_wb_open__',
  type: 'wb_open',
} as Action;

/** Whiteboard mutations that trigger an implicit auto-open when the board is closed. */
function isImplicitOpenTrigger(type: string): boolean {
  return type.startsWith('wb_') && type !== 'wb_open' && type !== 'wb_close';
}

export interface ResolveTimelineOptions {
  /** Playback speed multiplier applied to speech dwell (estimate and real audio alike). Default 1. */
  playbackSpeed?: number;
  /**
   * Real narration duration (ms) for a speech action when pre-generated audio
   * exists. Return `null`/`undefined` to fall back to the deterministic
   * {@link estimateSpeechDurationMs}. The exporter, which knows each clip's
   * stored audio duration (issue #861), supplies this. The returned length is
   * the clip's natural (1×) duration; the timeline divides it by `playbackSpeed`
   * to match the live `AudioPlayer.setPlaybackRate` path.
   */
  getAudioDurationMs?: (action: SpeechAction) => number | null | undefined;
  /**
   * Real video duration (ms) for a play_video action. Return `null`/`undefined`
   * when unknown — the {@link ResolveTimelineOptions.onUnresolvedVideoDuration}
   * policy then decides. A resolved value is capped at {@link MAX_VIDEO_WAIT_MS}.
   */
  getVideoDurationMs?: (action: PlayVideoAction) => number | null | undefined;
  /**
   * What to do when a `play_video` duration is unresolved (no `getVideoDurationMs`,
   * or it returned nullish). `play_video` blocks live playback until the video
   * ends, so a silent 0 would shift every later action early — hence the default
   * is `'throw'` (fail loudly). `'cap'` assumes the {@link MAX_VIDEO_WAIT_MS}
   * safety cap; `'zero'` opts back into no-dwell explicitly.
   */
  onUnresolvedVideoDuration?: 'throw' | 'cap' | 'zero';
  /**
   * Live whiteboard element count when a wb_clear runs (the clear animation
   * scales with it). Defaults to 0 when not supplied, which yields a 0ms dwell
   * (an empty clear is a no-op in the engine); the exporter, which replays
   * whiteboard state, can provide the true count.
   */
  getClearElementCount?: (action: WbClearAction) => number;
  /**
   * Whether a discussion action is skipped outright by the engine (already
   * consumed, or its `agentId` isn't in the selected set) — in which case it
   * contributes no dwell. Depends on runtime state the pure timeline can't see,
   * so the caller supplies it; defaults to "not skipped"
   * ({@link DISCUSSION_TRIGGER_DELAY_MS}).
   */
  isDiscussionSkipped?: (action: DiscussionAction) => boolean;
  /**
   * Whether a `wb_edit_code` action is a no-op the engine skips without delay
   * (target block missing / not a code element / stale line refs). Depends on
   * live whiteboard state, so the caller supplies it; defaults to a normal edit
   * ({@link WB_EDIT_MS}).
   */
  isEditCodeNoop?: (action: WbEditCodeAction) => boolean;
  /**
   * Whether the whiteboard is already open when the timeline starts. Defaults to
   * `false`, matching the engine's post-`resetPlaybackVisualState()` state, so
   * the first whiteboard mutation triggers an implicit {@link IMPLICIT_WB_OPEN}
   * beat.
   */
  whiteboardOpen?: boolean;
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
 * Resolve a `play_video` action's blocking duration. Live playback treats
 * `play_video` as blocking — it waits until the video ends or {@link MAX_VIDEO_WAIT_MS}
 * fires — so an unknown duration must NOT silently become a zero-length segment
 * (that would shift every later action early). When `getVideoDurationMs` returns
 * a value it's capped at the wait limit; when it's missing/unresolved the
 * {@link ResolveTimelineOptions.onUnresolvedVideoDuration} policy decides:
 * `'throw'` (default — fail loudly), `'cap'` (assume the max wait), or `'zero'`
 * (opt in to the old no-dwell behavior explicitly).
 */
function resolveVideoDurationMs(action: PlayVideoAction, opts: ResolveTimelineOptions): number {
  const resolved = opts.getVideoDurationMs?.(action);
  if (resolved != null) return Math.min(resolved, MAX_VIDEO_WAIT_MS);

  switch (opts.onUnresolvedVideoDuration ?? 'throw') {
    case 'zero':
      return 0;
    case 'cap':
      return MAX_VIDEO_WAIT_MS;
    case 'throw':
    default:
      throw new Error(
        `resolveActionTimeline: play_video "${action.elementId}" has no resolved duration. ` +
          `play_video is blocking, so a missing duration would silently shift later actions ` +
          `early. Supply getVideoDurationMs, or set onUnresolvedVideoDuration to 'cap' or 'zero'.`,
      );
  }
}

/**
 * The visual duration (ms) of a single action — how long it is present on
 * screen. For blocking actions this is also how long the cursor waits.
 */
function actionDurationMs(action: Action, opts: ResolveTimelineOptions): number {
  switch (action.type) {
    case 'speech': {
      const speed = opts.playbackSpeed ?? 1;
      // The live path plays pre-generated audio at `AudioPlayer.setPlaybackRate(speed)`,
      // so a stored clip's wall-clock dwell is its length divided by speed — the
      // same scaling the no-audio estimate applies. Keeping the two paths in
      // lockstep is what stops non-1× exports from drifting.
      const audio = opts.getAudioDurationMs?.(action);
      if (audio != null) return audio / speed;
      return estimateSpeechDurationMs(action.text, { speed });
    }
    case 'spotlight':
    case 'laser':
      return EFFECT_AUTO_CLEAR_MS;
    case 'discussion': {
      // A discussion the engine skips outright — already consumed, or its agent
      // isn't selected — contributes no dwell (`processNext` recurses with no
      // timer). That skip depends on runtime state (consumed set / selected
      // agents), so the caller signals it via `isDiscussionSkipped`.
      if (opts.isDiscussionSkipped?.(action as DiscussionAction)) return 0;
      // Otherwise: the trigger delay before the ProactiveCard shows, then — in
      // unattended playback/export — the card's own auto-skip countdown before
      // playback continues. (An attended viewer joining/skipping the card early
      // is interactive and out of scope; this models the deterministic
      // no-interaction dwell.)
      return DISCUSSION_TRIGGER_DELAY_MS + DISCUSSION_AUTO_SKIP_MS;
    }
    case 'play_video':
      return resolveVideoDurationMs(action as PlayVideoAction, opts);
    case 'wb_open':
      return WB_OPEN_MS;
    case 'wb_draw_text': {
      // The engine no-ops (no delay) when there's nothing to draw:
      // `executeWbDrawText` returns early on empty content.
      const content = (action as WbDrawTextAction).content ?? '';
      return content ? WB_DRAW_MS : 0;
    }
    case 'wb_draw_table': {
      // `executeWbDrawTable` returns early (no delay) when the table has no rows
      // or no columns.
      const data = (action as WbDrawTableAction).data;
      const rows = data?.length ?? 0;
      const cols = rows > 0 ? (data[0]?.length ?? 0) : 0;
      return rows === 0 || cols === 0 ? 0 : WB_DRAW_MS;
    }
    case 'wb_draw_shape':
    case 'wb_draw_chart':
    case 'wb_draw_latex':
    case 'wb_draw_line':
      return WB_DRAW_MS;
    case 'wb_draw_code':
      return wbDrawCodeMs(codeLineCount((action as WbDrawCodeAction).code));
    case 'wb_edit_code':
      // `executeWbEditCode` returns before its delay when the edit can't apply
      // (missing/non-code target, or stale lineId/lineIds). That depends on live
      // whiteboard state the pure timeline can't see, so the caller signals a
      // no-op via `isEditCodeNoop`; otherwise it's the normal edit animation.
      return opts.isEditCodeNoop?.(action as WbEditCodeAction) ? 0 : WB_EDIT_MS;
    case 'wb_clear': {
      // The engine early-returns with no delay when the board is already empty
      // (`executeWbClear`: elementCount === 0 → return), so an empty clear has a
      // 0ms dwell, not the `wbClearMs(0)` animation floor.
      const count = opts.getClearElementCount?.(action as WbClearAction) ?? 0;
      return count === 0 ? 0 : wbClearMs(count);
    }
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
 * Whiteboard auto-open is modeled: a `wb_*` mutation (draw/edit/clear/delete)
 * that runs while the board is closed is preceded by a synthetic
 * {@link IMPLICIT_WB_OPEN} beat ({@link WB_OPEN_MS}), exactly as the engine's
 * `ensureWhiteboardOpen` does. The open state carries across scenes and is
 * toggled by `wb_open` / `wb_close`; seed it via {@link ResolveTimelineOptions.whiteboardOpen}.
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
  // Mirrors the engine's whiteboard-open flag: false after
  // resetPlaybackVisualState(), flipped by wb_open / wb_close, and read to
  // decide whether a wb_* mutation must first pay the implicit open animation.
  let whiteboardOpen = opts.whiteboardOpen ?? false;

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

  const pushWithWhiteboard = (
    action: Action,
    sceneId: string,
    sceneIndex: number,
    actionIndex: number,
  ) => {
    // A wb_* mutation on a closed board is auto-preceded by an open animation
    // (engine: `execute` awaits `ensureWhiteboardOpen`). Emit that beat first so
    // later segments don't start WB_OPEN_MS early.
    if (!whiteboardOpen && isImplicitOpenTrigger(action.type)) {
      push(IMPLICIT_WB_OPEN, sceneId, sceneIndex, actionIndex);
      whiteboardOpen = true;
    }
    push(action, sceneId, sceneIndex, actionIndex);
    if (action.type === 'wb_open') whiteboardOpen = true;
    else if (action.type === 'wb_close') whiteboardOpen = false;
  };

  scenes.forEach((scene, sceneIndex) => {
    const actions = scene.actions ?? [];
    if (actions.length === 0) {
      // Empty scene → one synthetic dwell beat, exactly as the cursor yields.
      push(EMPTY_SCENE_DWELL, scene.id, sceneIndex, 0);
      return;
    }
    actions.forEach((action, actionIndex) => {
      pushWithWhiteboard(action, scene.id, sceneIndex, actionIndex);
    });
  });

  clampFireAndForgetLifetimes(segments, clockMs);

  return segments;
}

/**
 * Correct the visual `durationMs` of fire-and-forget effects (spotlight/laser)
 * in place. Their nominal lifetime is {@link EFFECT_AUTO_CLEAR_MS}, but the
 * engine cuts it short — and occasionally extends it:
 *
 * - **Scene boundary / completion.** The app plays one `PlaybackEngine` per
 *   scene: switching scenes tears the engine down (`stop()` → `clearEffects()`)
 *   and each scene ends via the completion path (`getCurrentAction()` returns
 *   null → `clearEffects()`). Either way effects never outlive their scene, so
 *   in this continuous clock a spotlight late in a scene (or the final action of
 *   the lecture) is cleared at the next scene's start / at completion, not a
 *   flat 5s later.
 * - **Shared auto-clear timer.** `ActionEngine.scheduleEffectClear` uses one
 *   timer that each new effect *resets*, and `clearAllEffects` drops every active
 *   effect together. So back-to-back effects (within `EFFECT_AUTO_CLEAR_MS` of
 *   each other) all live until the last one's fire + `EFFECT_AUTO_CLEAR_MS` —
 *   the earlier effect is *extended*, not cleared on its own schedule.
 *
 * `advancesCursorMs` (0 for these) is untouched — only the visual hint changes.
 *
 * @param completionMs the final cursor clock (when the last scene's actions are
 *        exhausted and playback completes → `clearEffects`).
 */
function clampFireAndForgetLifetimes(segments: TimelineSegment[], completionMs: number): void {
  // First segment startMs per scene index → the wall-clock of that scene's
  // boundary clearEffects. Every scene yields ≥1 segment, so all indices exist.
  const sceneStartMs = new Map<number, number>();
  for (const seg of segments) {
    if (!sceneStartMs.has(seg.sceneIndex)) sceneStartMs.set(seg.sceneIndex, seg.startMs);
  }

  segments.forEach((seg, i) => {
    if (seg.blocking) return; // only fire-and-forget effects have a clearable lifetime

    // The next clearEffects boundary after this effect: the start of the next
    // scene, or completion if this is the last scene.
    const nextSceneStart = sceneStartMs.get(seg.sceneIndex + 1);
    const boundaryMs = nextSceneStart ?? completionMs;

    // Shared auto-clear deadline, chained through any later effects in THIS scene
    // that fire before it elapses (each resets the shared timer). Segments are in
    // non-decreasing startMs order, so a forward walk suffices.
    let deadlineMs = seg.startMs + EFFECT_AUTO_CLEAR_MS;
    for (let j = i + 1; j < segments.length; j++) {
      const other = segments[j];
      if (other.sceneIndex !== seg.sceneIndex) break; // cleared at the boundary anyway
      if (other.blocking) continue; // blocking actions don't touch the effect timer
      // Chain breaks at exact equality too: the earlier effect's clear timer was
      // registered first (same 5000ms delay as the reading timer that triggers
      // the later effect), so it fires before the later effect resets it. Its
      // predecessor is therefore cleared at exactly `deadlineMs`, not extended.
      if (other.startMs >= deadlineMs) break; // timer already fired; chain broken
      deadlineMs = Math.max(deadlineMs, other.startMs + EFFECT_AUTO_CLEAR_MS);
    }

    const clearMs = Math.min(boundaryMs, deadlineMs);
    seg.durationMs = Math.max(0, clearMs - seg.startMs);
  });
}
