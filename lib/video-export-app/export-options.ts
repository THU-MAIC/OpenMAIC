/** Lightweight video-export options shared by always-loaded classroom UI. */

/** Selectable render resolutions (16:9). Width drives slide snapshots and Quiz layout. */
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

export class NoScenesError extends Error {}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_') || 'classroom';
}
