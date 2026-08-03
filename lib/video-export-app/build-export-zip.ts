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
import { accessDocument } from '@/lib/document-store';
import { createVideoTimelineDeps } from './timeline-deps';
import { collectVideoAssets } from './collect';
import { packageVideoZip } from './package-zip';

/** Selectable render resolutions (16:9). Width drives slide-snapshot render width too. */
export const VIDEO_RESOLUTIONS = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
} as const;

export type VideoResolution = keyof typeof VIDEO_RESOLUTIONS;

/** Selectable frame rates for MP4 rendering. */
export const VIDEO_FPS = [24, 30, 60] as const;
export type VideoFps = (typeof VIDEO_FPS)[number];

/** Producer quality presets (speed vs fidelity). */
export const VIDEO_QUALITIES = ['draft', 'standard', 'high'] as const;
export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

export interface BuildExportZipResult {
  zipBlob: Blob;
  stageName: string;
  /** Number of asset-plan entries whose bytes couldn't be produced. */
  missingCount: number;
  /** Non-info diagnostics from the compiler. */
  errorCount: number;
}

export class NoScenesError extends Error {}

/**
 * Shared compile prologue for both export paths: read the current stage + scenes
 * from the store (throwing {@link NoScenesError} when empty), resolve the display
 * name from Dexie, load the DI deps (Dexie durations + asset presence + measured
 * geometry), and pure-compile to the {@link VideoTimeline} IR. Both the full ZIP
 * build and the subtitles-only path go through here so their timing/assets/
 * geometry wiring can never drift.
 */
async function compileStageIr(options: { skipGeometry?: boolean } = {}): Promise<{
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

  const deps = await createVideoTimelineDeps({
    stage: { id: stage.id },
    scenes,
    skipGeometry: options.skipGeometry,
  });
  const ir = compileVideoTimeline(
    { stage: { id: stage.id, name: stageName }, scenes },
    { timing: deps.timing, assets: deps.assets, geometry: deps.geometry },
  );

  return { ir, stageName, scenes, deps };
}

/** Options for a full export-ZIP build. */
export interface BuildExportZipOptions {
  resolution: VideoResolution;
  /** Burn the subtitle overlay into the video. Default false (sidecar SRT/VTT only). */
  burnInSubtitles?: boolean;
}

/**
 * Build the export ZIP for the current stage at the given resolution. Throws
 * {@link NoScenesError} when there's nothing to export.
 */
export async function buildExportZip(
  options: BuildExportZipOptions,
): Promise<BuildExportZipResult> {
  const { resolution, burnInSubtitles = false } = options;
  const { width, height } = VIDEO_RESOLUTIONS[resolution];

  // 1. DI deps (Dexie durations + asset presence + measured geometry) → 2. pure compile.
  const { ir, stageName, scenes, deps } = await compileStageIr();

  // 3. emit the Hyperframes project text.
  const project = emitHyperframes(ir, { width, height, burnInSubtitles });

  // 4. collect asset bytes (slide snapshots + narration/media).
  const { blobs, missing } = await collectVideoAssets(ir, scenes, deps.records, {
    frameWidth: width,
  });

  // 5. package the self-contained ZIP.
  const zipBlob = await packageVideoZip(project, blobs);

  const errorCount = ir.diagnostics.filter((d) => d.severity !== 'info').length;
  return { zipBlob, stageName, missingCount: missing.length, errorCount };
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_') || 'classroom';
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
export async function compileSubtitles(): Promise<CompiledSubtitles> {
  const { ir, stageName } = await compileStageIr({ skipGeometry: true });

  return {
    srt: toSrt(ir.subtitles),
    vtt: toVtt(ir.subtitles),
    stageName,
    cueCount: ir.subtitles.filter((c) => c.text.trim() && c.endMs > c.startMs).length,
  };
}
