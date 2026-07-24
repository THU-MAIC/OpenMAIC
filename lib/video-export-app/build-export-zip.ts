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
import { compileVideoTimeline, emitHyperframes } from '@/lib/video-export';
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
 * Build the export ZIP for the current stage at the given resolution. Throws
 * {@link NoScenesError} when there's nothing to export.
 */
export async function buildExportZip(resolution: VideoResolution): Promise<BuildExportZipResult> {
  const { stage, scenes } = useStageStore.getState();
  if (!stage?.id || scenes.length === 0) {
    throw new NoScenesError('No scenes to export');
  }

  const { width, height } = VIDEO_RESOLUTIONS[resolution];

  const latest = await accessDocument(stage.id).catch(() => undefined);
  const stageName = latest?.document?.stage.name || stage.name || 'classroom';

  // 1. DI deps (Dexie durations + asset presence) → 2. pure compile to IR.
  const deps = await createVideoTimelineDeps({ stage: { id: stage.id }, scenes });
  const ir = compileVideoTimeline({ stage: { id: stage.id, name: stageName }, scenes }, deps);

  // 3. emit the Hyperframes project text.
  const project = emitHyperframes(ir, { width, height });

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
