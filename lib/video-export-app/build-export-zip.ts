'use client';

/**
 * `buildExportZip` — the shared prefix of both video-export paths.
 *
 * Runs the whole browser-side pipeline up to (and including) the self-contained
 * ZIP: load DI deps (Dexie durations + asset presence) → pure-compile to the
 * `VideoTimeline` IR → emit the Hyperframes project text → collect asset bytes
 * (slide snapshots + narration/media) → package the ZIP.
 *
 * Both `useExportVideo` (download the ZIP for local CLI rendering) and
 * `useRenderVideo` (upload the ZIP to the render service for MP4) call this so
 * the two paths can never drift.
 *
 * App-side / impure: reads the store + Dexie and does IO.
 */
import { compileVideoTimeline, emitHyperframes, toSrt, toVtt } from '@/lib/video-export';
import { useStageStore } from '@/lib/store';
import type { Locale } from '@/lib/i18n';
import { accessDocument } from '@/lib/document-store';
import { createVideoTimelineDeps } from './timeline-deps';
import { collectVideoAssets } from './collect';
import { getVideoExportCoverLabels, resolveVideoExportCta } from './cover-config';
import { NoScenesError, VIDEO_RESOLUTIONS, type VideoResolution } from './export-options';
import { createQuizLayoutProbe } from './quiz-layout';
import { packageVideoZip } from './package-zip';

export {
  NoScenesError,
  sanitizeFilename,
  VIDEO_FPS,
  VIDEO_QUALITIES,
  VIDEO_RESOLUTIONS,
  type VideoFps,
  type VideoQuality,
  type VideoResolution,
} from './export-options';

export interface BuildExportZipResult {
  zipBlob: Blob;
  stageName: string;
  /** Number of asset-plan entries whose bytes couldn't be produced. */
  missingCount: number;
  /** Non-info diagnostics from the compiler. */
  errorCount: number;
}

let warnedInvalidVideoExportCta = false;

/** Resolve the build-time public setting at the app boundary, warning once. */
function configuredVideoExportCta() {
  const raw = process.env.NEXT_PUBLIC_VIDEO_EXPORT_CTA_DESTINATION;
  const cta = resolveVideoExportCta(raw);
  const value = raw?.trim();
  const isExpectedNull = !value || value.toLowerCase() === 'off';

  if (!cta && !isExpectedNull && !warnedInvalidVideoExportCta) {
    warnedInvalidVideoExportCta = true;
    console.warn(
      'Ignoring invalid NEXT_PUBLIC_VIDEO_EXPORT_CTA_DESTINATION; video-export CTA is disabled.',
    );
  }
  return cta;
}

/**
 * Shared compile prologue for both export paths: read the current stage + scenes
 * from the store (throwing {@link NoScenesError} when empty), resolve the display
 * name from Dexie, load the DI deps (Dexie durations + asset presence + measured
 * geometry), and pure-compile to the {@link VideoTimeline} IR. Both the full ZIP
 * build and the subtitles-only path go through here so their timing/assets/
 * geometry wiring can never drift.
 */
async function compileStageIr(options: {
  resolution: VideoResolution;
  locale: Locale;
  labels: ReturnType<typeof getVideoExportCoverLabels>;
  skipGeometry?: boolean;
  skipInteractiveHtml?: boolean;
}): Promise<{
  ir: ReturnType<typeof compileVideoTimeline>;
  stageName: string;
  scenes: ReturnType<typeof useStageStore.getState>['scenes'];
  deps: Awaited<ReturnType<typeof createVideoTimelineDeps>>;
}> {
  const { stage, scenes } = useStageStore.getState();
  if (!stage?.id || scenes.length === 0) {
    throw new NoScenesError('No scenes to export');
  }

  const latest = await accessDocument(stage.id).catch(() => undefined);
  const stageName = latest?.document?.stage.name || stage.name || 'classroom';
  const { width, height } = VIDEO_RESOLUTIONS[options.resolution];

  const [deps, quizLayout] = await Promise.all([
    createVideoTimelineDeps({
      stage: { id: stage.id },
      scenes,
      skipGeometry: options.skipGeometry,
      skipInteractiveHtml: options.skipInteractiveHtml,
    }),
    createQuizLayoutProbe({
      scenes,
      width,
      height,
      locale: options.locale,
      labels: options.labels,
    }),
  ]);
  const ir = compileVideoTimeline(
    { stage: { id: stage.id, name: stageName }, scenes },
    {
      timing: deps.timing,
      assets: deps.assets,
      geometry: deps.geometry,
      interactive: deps.interactive,
      quizLayout,
    },
  );

  return { ir, stageName, scenes, deps };
}

/** Options for a full export-ZIP build. */
export interface BuildExportZipOptions {
  resolution: VideoResolution;
  /** Burn the subtitle overlay into the video. Default false (sidecar SRT/VTT only). */
  burnInSubtitles?: boolean;
  /** Locale the card chrome and the emitted document are written in. */
  locale: Locale;
}

/**
 * Build the export ZIP for the current stage at the given resolution. Throws
 * {@link NoScenesError} when there's nothing to export.
 */
export async function buildExportZip(
  options: BuildExportZipOptions,
): Promise<BuildExportZipResult> {
  const { resolution, burnInSubtitles = false, locale } = options;
  const { width, height } = VIDEO_RESOLUTIONS[resolution];

  // Resolve the chrome before the first await: compiling the IR takes seconds
  // (Dexie probes, off-screen measurement), and the learner may switch the UI
  // language while it runs. Reading the labels here pins one export to one
  // locale instead of whichever language happened to win the race.
  const labels = getVideoExportCoverLabels(locale);
  const cta = configuredVideoExportCta();

  // 1. DI deps (Dexie durations + asset presence + measured geometry) → 2. pure compile.
  const { ir, stageName, scenes, deps } = await compileStageIr({
    resolution,
    locale,
    labels,
  });

  // 3. emit the Hyperframes project text.
  const project = emitHyperframes(ir, {
    width,
    height,
    burnInSubtitles,
    labels,
    locale,
    cta,
  });

  // 4. collect asset bytes (slide snapshots + narration/media).
  const { blobs, missing } = await collectVideoAssets(ir, scenes, deps.records, {
    frameWidth: width,
  });

  // 5. package the self-contained ZIP.
  const zipBlob = await packageVideoZip(project, blobs);

  const errorCount = ir.diagnostics.filter((d) => d.severity !== 'info').length;
  return {
    zipBlob,
    stageName,
    missingCount: missing.length,
    errorCount,
  };
}

export interface CompiledSubtitles {
  srt: string;
  vtt: string;
  stageName: string;
  /** Number of usable cues (positive-span, non-empty). 0 → nothing to download. */
  cueCount: number;
}

/**
 * Compile just the subtitle track for the current stage — the same cues the
 * export ZIP carries, without collecting asset bytes, snapshotting frames, or
 * touching the render service. Lets the user download SRT/VTT to add captions in
 * their own editor (the "clean video + sidecar subtitles" path, #867 item 2).
 * Throws {@link NoScenesError} when there's nothing to export.
 *
 * Passes `skipGeometry` so the compile skips the off-screen content-box
 * measurement (an off-screen render per slide) that only positions effects —
 * subtitles need only the timeline, and audio/video *duration* probes still run
 * so these cues match the ones the burned-in video would carry.
 */
export interface CompileSubtitlesOptions {
  resolution: VideoResolution;
  locale: Locale;
}

export async function compileSubtitles(
  options: CompileSubtitlesOptions,
): Promise<CompiledSubtitles> {
  // Pin the same localized chrome before the first await that a full export at
  // this resolution uses; Quiz measurement and timing therefore cannot drift.
  const labels = getVideoExportCoverLabels(options.locale);
  const { ir, stageName } = await compileStageIr({
    ...options,
    labels,
    skipGeometry: true,
    skipInteractiveHtml: true,
  });

  return {
    srt: toSrt(ir.subtitles),
    vtt: toVtt(ir.subtitles),
    stageName,
    cueCount: ir.subtitles.filter((c) => c.text.trim() && c.endMs > c.startMs).length,
  };
}
