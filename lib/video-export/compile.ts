/**
 * `compileVideoTimeline` — the pure compile pipeline.
 *
 * Composes the ordered passes into the `VideoTimeline` IR:
 *
 *   normalize → probe → timeline → geometry → assets → (unsupported) → assemble
 *
 * Every pass is a pure function; live app state enters only through the injected
 * {@link TimingProbe} / {@link AssetSource} (issue #864 DI boundary), so the whole
 * compile runs — and is unit-tested — with no FFmpeg / Chrome / DOM. The result
 * is the system contract; the (future) Hyperframes emitter is a downstream
 * consumer of it.
 *
 * Diagnostics from all passes are concatenated in pass order, so the manifest
 * reads as a chronological export report. Scene families the compiler cannot
 * render (quiz/interactive/pbl) are represented with an `unsupported-scene`
 * marker + diagnostic and a placeholder base — never silently dropped.
 *
 * Pure: no IO beyond the injected dependencies.
 */
import type { SceneType } from '@openmaic/dsl';
import type { AssetSource, CompileConfig, CompilerScene, TimingProbe } from './deps';
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
  config?: CompileConfig;
}

/** Human-readable reason a scene family is not rendered by this compiler slice. */
function unsupportedReason(type: SceneType): string {
  switch (type) {
    case 'quiz':
      return 'Quiz scenes are represented by markers; video rendering is deferred to the Hyperframes renderer.';
    case 'interactive':
      return 'Interactive/widget scenes require runtime playback; represented by markers in this slice.';
    case 'pbl':
      return 'PBL scenes require the OpenMAIC task runtime; represented by markers in this slice.';
    default:
      return 'This scene family is preserved as markers but is not rendered by this compiler slice.';
  }
}

/**
 * Mark unsupported scenes: attach a placeholder `base.reason`, prepend an
 * `unsupported-scene` marker spanning the scene, and record a diagnostic. Slide
 * scenes pass through untouched.
 */
function markUnsupported(
  scenes: readonly VideoTimelineScene[],
  diagnostics: Diagnostic[],
): VideoTimelineScene[] {
  return scenes.map((scene) => {
    if (scene.supported) return scene;
    const reason = unsupportedReason(scene.type);
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

export function compileVideoTimeline(input: CompileInput, deps: CompileDeps): VideoTimeline {
  const config = deps.config ?? {};

  // 1. normalize — deterministic order + action validation.
  const normalized = normalizeScenes(input.scenes);

  // 2. probe — adapt the TimingProbe into the choreography option shape.
  const opts = buildTimelineOptions(deps.timing, config);

  // 3. timeline — index→time expansion folded into per-scene buckets + subtitles.
  const timeline = buildTimeline(normalized.scenes, opts);

  // 4. geometry — resolve effect element geometry (degrade on miss).
  const geometry = applyGeometry(timeline.scenes, normalized.scenes);

  // 5. assets — dedup + naming plan; stamp asset refs onto segments.
  const assets = planAssets(normalized.scenes, geometry.scenes, deps.assets);

  // 6. unsupported scene families → markers + diagnostics.
  const unsupportedDiagnostics: Diagnostic[] = [];
  const scenes = markUnsupported(assets.scenes, unsupportedDiagnostics);

  const diagnostics: Diagnostic[] = [
    ...normalized.diagnostics,
    ...timeline.diagnostics,
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
    totalDurationMs: timeline.totalDurationMs,
    scenes,
    subtitles: timeline.subtitles,
    assets: assets.plan,
    diagnostics,
  };
}
