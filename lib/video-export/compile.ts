/**
 * `compileVideoTimeline` — the pure compile pipeline.
 *
 * Composes the ordered passes into the `VideoTimeline` IR:
 *
 *   normalize → probe → timeline → visuals → interactive → reflow → geometry → assets → (unsupported) → assemble
 *
 * Every pass is a pure function; live app state enters only through the injected
 * {@link TimingProbe} / {@link AssetSource} (issue #864 DI boundary), so the whole
 * compile runs — and is unit-tested — with no FFmpeg / Chrome / DOM. The result
 * is the system contract; the (future) Hyperframes emitter is a downstream
 * consumer of it.
 *
 * Diagnostics from all passes are concatenated in pass order, so the manifest
 * reads as a chronological export report. Quiz/PBL become deterministic cover
 * visuals; remaining scene families the compiler cannot render are represented
 * with an `unsupported-scene` marker + diagnostic and a placeholder base.
 *
 * Pure: no IO beyond the injected dependencies.
 */
import type { SceneType, PlayVideoAction, Action } from '@openmaic/dsl';
import type {
  AssetSource,
  CompileConfig,
  CompilerScene,
  GeometryProbe,
  QuizLayoutProbe,
  TimingProbe,
} from './deps';
import {
  CANVAS,
  VIDEO_TIMELINE_COMPILER,
  VIDEO_TIMELINE_SCHEMA,
  VIDEO_TIMELINE_VERSION,
  type Diagnostic,
  type VideoTimeline,
  type VideoTimelineScene,
} from './ir';
import { normalizeScenes } from './passes/normalize';
import { buildTimelineOptions } from './passes/probe';
import { buildTimeline } from './passes/timeline';
import { applyVisuals } from './passes/visuals';
import { applyInteractiveHtml } from './passes/interactive';
import { reflowQuizTimelines } from './passes/reflow';
import { applyGeometry } from './passes/geometry';
import { planAssets } from './passes/assets';

export interface CompileInput {
  /** The stage/classroom being exported (only id + name are read). */
  stage: { id: string; name: string };
  scenes: readonly CompilerScene[];
}

export interface CompileDeps {
  timing: TimingProbe;
  assets: AssetSource;
  /**
   * Optional rendered-geometry source. When present, spotlight/laser/video
   * placement uses each element's measured content-box geometry instead of the
   * authored outer box, so effects align with where the element actually paints
   * (issue #867 item 5). Omitted in pure/unit contexts — the compiler then uses
   * the deterministic authored-box calc.
   */
  geometry?: GeometryProbe;
  /** Optional prepared-HTML adapter; omitted callers degrade interactive scenes. */
  interactive?: import('./deps').InteractiveHtmlSource;
  /** Optional app-premeasured Quiz question-list layouts. */
  quizLayout?: QuizLayoutProbe;
  config?: CompileConfig;
}

/** Human-readable reason a scene family is not rendered by this compiler slice. */
function unsupportedReason(type: SceneType): string {
  switch (type) {
    case 'interactive':
      return 'Interactive HTML was not prepared for static rendering; represented by markers.';
    default:
      return 'This scene family is preserved as markers but is not rendered by this compiler slice.';
  }
}

/**
 * Mark unsupported scenes: attach a placeholder `base.reason`, prepend an
 * `unsupported-scene` marker spanning the scene, and record a diagnostic. Slide
 * supported scenes pass through untouched.
 */
function markUnsupported(
  scenes: readonly VideoTimelineScene[],
  diagnostics: Diagnostic[],
): VideoTimelineScene[] {
  return scenes.map((scene) => {
    if (scene.supported) return scene;
    const reason =
      scene.base.kind === 'placeholder' && scene.base.reason
        ? scene.base.reason
        : unsupportedReason(scene.type);
    diagnostics.push({
      severity: 'warn',
      code: 'unsupported-scene',
      sceneId: scene.id,
      message: `Scene "${scene.title}" (${scene.type}) is not rendered: ${reason}`,
    });
    return {
      ...scene,
      base: { ...scene.base, kind: 'placeholder', reason },
      markers: [
        {
          actionIndex: 0,
          kind: 'unsupported-scene',
          startMs: scene.startMs,
          durationMs: scene.durationMs,
          note: reason,
        },
        ...scene.markers,
      ],
    };
  });
}

/**
 * Pre-resolve which `play_video` actions have available media, keyed by the
 * action **object identity**. An action is "available" only when the
 * {@link AssetSource} returns a meta with `present: true`. The timeline pass uses
 * this to give an unavailable clip a 0ms dwell (skip), instead of letting a
 * silent safety-cap shift later actions.
 *
 * Keyed by object reference, not `action.id`: the DSL does not enforce
 * stage-wide action-id uniqueness, so two scenes could share an id (e.g.
 * `duplicate`) — an id-keyed set would then conflate their availability and
 * leave a contradictory IR (a 5-minute dwell on a segment later stamped
 * `skipped`). `resolveActionTimeline` receives these same normalized scene
 * objects and passes each action back to `getVideoDurationMs` by reference, so
 * identity lookup is exact. Availability must be decided here — before
 * `resolveActionTimeline` fixes dwell — because asset planning runs after the
 * timeline is laid out.
 */
function resolveAvailableVideos(
  scenes: readonly CompilerScene[],
  assets: AssetSource,
): Set<Action> {
  const available = new Set<Action>();
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type !== 'play_video') continue;
      const meta = assets.media((action as PlayVideoAction).elementId, scene);
      if (meta?.present) available.add(action);
    }
  }
  return available;
}

export function compileVideoTimeline(input: CompileInput, deps: CompileDeps): VideoTimeline {
  const config = deps.config ?? {};

  // 1. normalize — deterministic order + action validation.
  const normalized = normalizeScenes(input.scenes);

  // 2. probe — adapt the TimingProbe into the choreography option shape. Video
  //    availability is resolved up front (via the AssetSource) so an unavailable
  //    play_video gets a 0ms dwell in the timeline pass — it is skipped, not
  //    blocked for up to MAX_VIDEO_WAIT_MS, so later actions are not shifted.
  const availableVideos = resolveAvailableVideos(normalized.scenes, deps.assets);
  const opts = buildTimelineOptions(deps.timing, config, (action) => availableVideos.has(action));

  // 3. timeline — index→time expansion folded into per-scene buckets + subtitles.
  const timeline = buildTimeline(normalized.scenes, opts);

  // 4. visuals — turn Quiz/PBL authored data into whole-scene static covers.
  const visuals = applyVisuals(timeline.scenes, normalized.scenes, deps.quizLayout);

  // 5. interactive HTML — promote successfully prepared pages to a first-class base.
  const interactive = applyInteractiveHtml(visuals.scenes, normalized.scenes, deps.interactive);

  // 6. reflow — compiler-added Quiz tails shift every later absolute timestamp,
  //    including first-class interactive bases prepared by the preceding pass.
  const reflow = reflowQuizTimelines(
    interactive.scenes,
    timeline.subtitles,
    timeline.totalDurationMs,
    visuals.extensionsMs,
  );

  // 7. geometry — resolve effect + video element placement (degrade on miss).
  //    Prefers measured content-box geometry when a GeometryProbe is supplied.
  const geometry = applyGeometry(reflow.scenes, normalized.scenes, deps.geometry);

  // 8. assets — dedup + naming plan; stamp asset refs onto segments.
  const assets = planAssets(normalized.scenes, geometry.scenes, deps.assets);

  // 9. remaining unsupported scene families → markers + diagnostics.
  const unsupportedDiagnostics: Diagnostic[] = [];
  const scenes = markUnsupported(assets.scenes, unsupportedDiagnostics);

  const diagnostics: Diagnostic[] = [
    ...normalized.diagnostics,
    ...timeline.diagnostics,
    ...visuals.diagnostics,
    ...interactive.diagnostics,
    ...geometry.diagnostics,
    ...assets.diagnostics,
    ...unsupportedDiagnostics,
  ];

  return {
    schema: VIDEO_TIMELINE_SCHEMA,
    version: VIDEO_TIMELINE_VERSION,
    compiler: VIDEO_TIMELINE_COMPILER,
    stage: { id: input.stage.id, name: input.stage.name },
    canvas: CANVAS,
    config: {
      playbackSpeed: config.playbackSpeed ?? 1,
      ttsEnabled: timeline.ttsEnabled,
      whiteboardInitiallyOpen: config.whiteboardInitiallyOpen ?? false,
    },
    totalDurationMs: reflow.totalDurationMs,
    scenes,
    subtitles: reflow.subtitles,
    assets: assets.plan,
    diagnostics,
  };
}
