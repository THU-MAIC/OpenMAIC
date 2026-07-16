'use client';

/**
 * App-side implementations of the video-timeline compiler's DI boundary
 * ({@link TimingProbe} / {@link AssetSource} from `lib/video-export/deps`).
 *
 * The compiler is pure and its DI interfaces are **synchronous** by design: the
 * app resolves every duration and asset descriptor up front (Dexie reads,
 * durations stored at TTS time #861, video durations probed here from the
 * blobs), hands the compiler a set of in-memory tables, and the interface
 * methods are then plain synchronous lookups. This factory does that async
 * pre-load and returns the sync deps plus the loaded records, which the
 * byte-collection layer (#865 collection layer) reuses so Dexie is read once.
 *
 * This module lives in `lib/video-export-app/` — the impure, app-side companion
 * to the pure `lib/video-export/` compiler — precisely because it reaches into
 * `@/lib/utils/database` and (for video probing) the DOM, the two concerns the
 * compiler's purity boundary keeps out.
 */
import type { PlayVideoAction, SpeechAction, SceneCore } from '@openmaic/dsl';
import type { AssetMeta, AssetSource, TimingProbe } from '@/lib/video-export';
import type { Scene } from '@/lib/types/stage';
import { db, type AudioFileRecord, type MediaFileRecord } from '@/lib/utils/database';

/** Loaded source records, keyed for both metadata (compiler) and byte collection. */
export interface VideoTimelineRecords {
  /** Audio records by `audioId`. */
  audioById: Map<string, AudioFileRecord>;
  /** Media records by `elementId` (the `stageId:` prefix stripped). */
  mediaByElementId: Map<string, MediaFileRecord>;
  /** Probed video durations (ms) by `elementId`; absent when unprobeable. */
  videoDurationMsByElementId: Map<string, number>;
}

export interface VideoTimelineDeps {
  timing: TimingProbe;
  assets: AssetSource;
  records: VideoTimelineRecords;
}

/**
 * A media record is "present" when its bytes are recoverable at collect time:
 * either a real local blob, or a CDN `ossKey` to fetch from (live-mode records
 * whose local blob was LRU-evicted). Failed tasks (`error`) are never present.
 */
function mediaPresent(record: MediaFileRecord | undefined): record is MediaFileRecord {
  return !!record && !record.error && (record.blob.size > 0 || !!record.ossKey);
}

/** File-extension hint from a mime type (`video/mp4` → `mp4`), for the asset-plan naming. */
function formatFromMime(mimeType: string | undefined): string | undefined {
  return mimeType?.split('/')[1] || undefined;
}

/**
 * Probe a video blob's natural duration (ms) via an off-document `<video>`.
 * Resolves `null` when metadata never loads (the compiler then caps the dwell).
 */
function probeVideoDurationMs(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.preload = 'metadata';
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(value);
    };
    video.onloadedmetadata = () =>
      done(Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

/**
 * Load the Dexie-backed records for a classroom and build the synchronous
 * compiler deps over them. Audio durations come from the stored records
 * (seconds → ms); video durations are probed from the media blobs here so the
 * compiler's sync `videoDurationMs` is a table lookup.
 */
export async function createVideoTimelineDeps(input: {
  stage: { id: string };
  scenes: Scene[];
}): Promise<VideoTimelineDeps> {
  const { stage, scenes } = input;

  // Audio: load only the records referenced by speech actions.
  const audioIds = new Set<string>();
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type === 'speech' && (action as SpeechAction).audioId) {
        audioIds.add((action as SpeechAction).audioId!);
      }
    }
  }
  const audioById = new Map<string, AudioFileRecord>();
  for (const audioId of audioIds) {
    const record = await db.audioFiles.get(audioId);
    if (record) audioById.set(audioId, record);
  }

  // Media: all generated media for this stage, keyed by elementId.
  const mediaRecords = await db.mediaFiles.where('stageId').equals(stage.id).toArray();
  const mediaByElementId = new Map<string, MediaFileRecord>();
  for (const record of mediaRecords) {
    const elementId = record.id.includes(':') ? record.id.split(':').slice(1).join(':') : record.id;
    mediaByElementId.set(elementId, record);
  }

  // Probe video durations up front so `videoDurationMs` can be synchronous.
  // Only local blobs are probed; ossKey-only (evicted) records have no bytes to
  // probe here, so the compiler caps their dwell — the bytes are still fetched at
  // collect time for the render.
  const videoDurationMsByElementId = new Map<string, number>();
  for (const [elementId, record] of mediaByElementId) {
    if (record.type !== 'video' || record.error || record.blob.size === 0) continue;
    const ms = await probeVideoDurationMs(record.blob);
    if (ms !== null) videoDurationMsByElementId.set(elementId, ms);
  }

  const timing: TimingProbe = {
    audioDurationMs(action: SpeechAction): number | null {
      const record = action.audioId ? audioById.get(action.audioId) : undefined;
      if (!record || typeof record.duration !== 'number') return null;
      return Math.round(record.duration * 1000);
    },
    videoDurationMs(action: PlayVideoAction): number | null {
      return videoDurationMsByElementId.get(action.elementId) ?? null;
    },
  };

  const assets: AssetSource = {
    audio(action: SpeechAction): AssetMeta | null {
      if (!action.audioId) return null;
      const record = audioById.get(action.audioId);
      if (!record) return { id: action.audioId, present: false };
      return {
        id: action.audioId,
        mimeType: record.blob.type || undefined,
        format: record.format || 'mp3',
        durationMs: typeof record.duration === 'number' ? record.duration * 1000 : undefined,
        // Present when locally held or fetchable from its CDN ossKey at collect time.
        present: record.blob.size > 0 || !!record.ossKey,
      };
    },
    media(elementId: string, _scene: SceneCore): AssetMeta | null {
      const record = mediaByElementId.get(elementId);
      if (!record) return null;
      return {
        id: record.id,
        mimeType: record.mimeType,
        format: formatFromMime(record.mimeType),
        durationMs: videoDurationMsByElementId.get(elementId),
        present: mediaPresent(record),
      };
    },
  };

  return {
    timing,
    assets,
    records: { audioById, mediaByElementId, videoDurationMsByElementId },
  };
}
