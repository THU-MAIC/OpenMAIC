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

/** Per-probe timeout (ms). A blob whose metadata never loads must not wedge export. */
const PROBE_TIMEOUT_MS = 10_000;
/** How many media-duration probes run at once (bounded so a big deck can't thrash). */
const PROBE_CONCURRENCY = 6;

/**
 * Run `worker` over `items` with bounded concurrency, collecting results. Order
 * is not significant to callers (they key results into a Map), so this drains a
 * shared cursor from `PROBE_CONCURRENCY` lanes.
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i]);
    }
  });
  await Promise.all(lanes);
}

/**
 * Probe a video blob's natural duration (ms) via an off-document `<video>`.
 * Resolves `null` when metadata never loads (the compiler then caps the dwell).
 * A watchdog forces `null` after {@link PROBE_TIMEOUT_MS} so a blob that never
 * fires `loadedmetadata`/`error` can't leave the whole export stuck compiling.
 */
function probeVideoDurationMs(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.preload = 'metadata';
    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(value);
    };
    const timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS);
    video.onloadedmetadata = () =>
      done(Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

/**
 * Probe a narration audio blob's natural duration (ms) via an off-document
 * `<audio>`. Symmetric to {@link probeVideoDurationMs}. Resolves `null` when
 * metadata never loads, and — via the same watchdog — after
 * {@link PROBE_TIMEOUT_MS} if neither event ever fires.
 *
 * This is the source of truth for narration timing: the TTS-time
 * `AudioFileRecord.duration` was only recorded for classrooms generated after
 * #861, so most existing courses have it unset and would otherwise fall back to
 * text-length *estimates* — which run short and truncate the narration / advance
 * the timeline early. Reading the real bytes makes the scheduled dwell match the
 * clip for every classroom that actually has audio.
 */
function probeAudioDurationMs(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      resolve(value);
    };
    const timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS);
    audio.onloadedmetadata = () =>
      done(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null);
    audio.onerror = () => done(null);
    audio.src = url;
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

  // Probe real audio durations from the local blobs up front, so the compiler's
  // sync `audioDurationMs` is an accurate table lookup rather than a text-length
  // estimate. Only local blobs can be probed here; an ossKey-only (evicted)
  // record has no bytes to read, so it falls back to the stored duration (or
  // estimate) — the same asymmetry the video probe accepts. Probes run with
  // bounded concurrency (each has its own timeout) so a large deck resolves
  // quickly without one stuck blob wedging the export.
  const audioDurationMsByAudioId = new Map<string, number>();
  const probableAudio = [...audioById].filter(([, record]) => record.blob.size > 0);
  await mapWithConcurrency(probableAudio, PROBE_CONCURRENCY, async ([audioId, record]) => {
    const ms = await probeAudioDurationMs(record.blob);
    if (ms !== null) audioDurationMsByAudioId.set(audioId, ms);
  });

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
  // collect time for the render. Bounded concurrency + per-probe timeout, as above.
  const videoDurationMsByElementId = new Map<string, number>();
  const probableVideo = [...mediaByElementId].filter(
    ([, record]) => record.type === 'video' && !record.error && record.blob.size > 0,
  );
  await mapWithConcurrency(probableVideo, PROBE_CONCURRENCY, async ([elementId, record]) => {
    const ms = await probeVideoDurationMs(record.blob);
    if (ms !== null) videoDurationMsByElementId.set(elementId, ms);
  });

  const timing: TimingProbe = {
    audioDurationMs(action: SpeechAction): number | null {
      if (!action.audioId) return null;
      // Prefer the real probed duration; fall back to the stored TTS duration
      // (older records), then null (→ compiler estimates from text length).
      const probed = audioDurationMsByAudioId.get(action.audioId);
      if (probed != null) return probed;
      const record = audioById.get(action.audioId);
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
      const probed = audioDurationMsByAudioId.get(action.audioId);
      return {
        id: action.audioId,
        mimeType: record.blob.type || undefined,
        format: record.format || 'mp3',
        durationMs:
          probed ?? (typeof record.duration === 'number' ? record.duration * 1000 : undefined),
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
