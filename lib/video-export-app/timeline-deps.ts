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
import type {
  PlayVideoAction,
  SpeechAction,
  SceneCore,
  SpotlightAction,
  LaserAction,
} from '@openmaic/dsl';
import type { AssetMeta, AssetSource, GeometryProbe, TimingProbe } from '@/lib/video-export';
import type { Scene, SlideContent } from '@/lib/types/stage';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import { measureSlideElementGeometry, type MeasuredGeometry } from '@openmaic/renderer/snapshot';
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
  geometry: GeometryProbe;
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
 * The generated-media reference a slide element points at, mirroring the live
 * playback engine's bridge (`lib/action/engine.ts` `resolveMediaPlaceholderId`):
 * prefer the explicit `mediaRef`, then a legacy `src` that is itself a media
 * placeholder id. Returns undefined for elements that carry no generated media.
 *
 * A `play_video` action targets the slide element by its `.id`, but the media
 * records are keyed by this ref (`gen_vid_…`), so the asset/duration lookups must
 * bridge id → ref or every generated video misses and is dropped from the export.
 */
function elementMediaRef(el: { mediaRef?: unknown; src?: unknown }): string | undefined {
  if (typeof el.mediaRef === 'string' && el.mediaRef) return el.mediaRef;
  if (typeof el.src === 'string' && isMediaPlaceholder(el.src)) return el.src;
  return undefined;
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
  /**
   * Skip the off-screen content-box geometry measurement (an off-screen React
   * render per slide scene). Geometry only positions spotlight/laser/video
   * effects — it never affects timing — so the subtitles-only path passes `true`
   * to avoid that cost. Audio/video *duration* probes always run: they set the
   * timeline (and thus cue timings), so the sidecar SRT/VTT stays in sync with
   * the burned-in video. Defaults to false (full geometry for the ZIP/render).
   */
  skipGeometry?: boolean;
}): Promise<VideoTimelineDeps> {
  const { stage, scenes, skipGeometry = false } = input;

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

  // Media: all generated media for this stage, keyed by media ref (`gen_vid_…` /
  // `gen_img_…` — the stored `stageId:` prefix stripped), NOT the slide element
  // id that `play_video` actions target.
  const mediaRecords = await db.mediaFiles.where('stageId').equals(stage.id).toArray();
  const mediaByElementId = new Map<string, MediaFileRecord>();
  for (const record of mediaRecords) {
    const elementId = record.id.includes(':') ? record.id.split(':').slice(1).join(':') : record.id;
    mediaByElementId.set(elementId, record);
  }

  // Bridge slide element `.id` → media ref, so a `play_video`/media lookup by the
  // element id resolves to the record keyed by its ref. Without this every
  // generated video misses and is silently dropped from the export (compile →
  // present:false → no `<video>` emitted, no bytes collected). Mirrors the live
  // engine's `resolveMediaPlaceholderId`.
  //
  // Scoped **by scene**, not deck-wide: element ids are only unique within a
  // slide (e.g. `video_001` recurs across scenes), so a single flat map is
  // last-writer-wins and would resolve an earlier scene's `play_video` to a
  // later scene's media ref — the wrong asset and duration. Keying by scene id
  // keeps each slide's bridge isolated.
  const mediaRefBySceneElement = new Map<string, Map<string, string>>();
  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const elements = (scene.content as SlideContent)?.canvas?.elements ?? [];
    const byElement = new Map<string, string>();
    for (const el of elements) {
      const ref = elementMediaRef(el as { mediaRef?: unknown; src?: unknown });
      if (ref) byElement.set((el as { id: string }).id, ref);
    }
    if (byElement.size > 0) mediaRefBySceneElement.set(scene.id, byElement);
  }
  /** Resolve a `play_video` element id to the media map's key (its ref) within a scene, or pass through. */
  const resolveMediaKey = (elementId: string, sceneId: string): string =>
    mediaRefBySceneElement.get(sceneId)?.get(elementId) ?? elementId;

  // `timing.videoDurationMs` receives only the action (no scene), but the bridge
  // above is now scene-scoped, so pre-resolve each `play_video`'s media ref by
  // (scene, elementId) and key it on the action object. Action identity is
  // stable end-to-end: the compiler's normalize pass preserves the same action
  // references and the choreography passes them straight back to
  // `getVideoDurationMs` — the same identity contract `resolveAvailableVideos`
  // relies on. Falls back to the raw element id for any action not seen here.
  const videoRefByAction = new Map<PlayVideoAction, string>();
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type !== 'play_video') continue;
      const playVideo = action as PlayVideoAction;
      videoRefByAction.set(playVideo, resolveMediaKey(playVideo.elementId, scene.id));
    }
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
      const key = videoRefByAction.get(action) ?? action.elementId;
      return videoDurationMsByElementId.get(key) ?? null;
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
    media(elementId: string, scene: SceneCore): AssetMeta | null {
      // `elementId` is the slide element `.id` a `play_video` targets; the media
      // records are keyed by the element's media ref, so bridge id → ref first,
      // scoped to this scene (element ids recur across slides).
      const key = resolveMediaKey(elementId, scene.id);
      const record = mediaByElementId.get(key);
      if (!record) return null;
      return {
        id: record.id,
        mimeType: record.mimeType,
        format: formatFromMime(record.mimeType),
        durationMs: videoDurationMsByElementId.get(key),
        present: mediaPresent(record),
      };
    },
  };

  // Pre-measure the rendered content-box geometry of every element a
  // spotlight/laser/play_video targets, by scene. The compiler's GeometryProbe
  // is synchronous, so (like durations) this async off-screen render happens up
  // front and the probe is a table lookup. Measuring the `.element-content` box
  // (auto-height text + 10px padding) — the same box the live overlay and the
  // frame PNG use — aligns effects with where the element actually paints
  // instead of its authored outer box (issue #867 item 5).
  //
  // Skipped for the subtitles-only path (`skipGeometry`): geometry positions
  // effects but never touches timing, so the empty probe just degrades every
  // effect to the authored-box calc — irrelevant when no video/frames are
  // emitted — while saving an off-screen React render per slide.
  const geometryBySceneElement = new Map<string, Map<string, MeasuredGeometry>>();
  for (const scene of scenes) {
    if (skipGeometry) break;
    if (scene.type !== 'slide') continue;
    const targetIds = new Set<string>();
    for (const action of scene.actions ?? []) {
      if (action.type === 'spotlight') targetIds.add((action as SpotlightAction).elementId);
      else if (action.type === 'laser') targetIds.add((action as LaserAction).elementId);
      else if (action.type === 'play_video') targetIds.add((action as PlayVideoAction).elementId);
    }
    if (targetIds.size === 0) continue;
    const slide = (scene.content as SlideContent)?.canvas;
    if (!slide) continue;
    try {
      const measured = await measureSlideElementGeometry(slide, [...targetIds]);
      if (measured.size > 0) geometryBySceneElement.set(scene.id, measured);
    } catch {
      // A measurement failure degrades to the compiler's authored-box calc — the
      // effect still renders, just at the pre-#867 position. Never fail export.
    }
  }

  const geometry: GeometryProbe = {
    contentGeometry(elementId: string, scene: SceneCore) {
      return geometryBySceneElement.get(scene.id)?.get(elementId) ?? null;
    },
  };

  return {
    timing,
    assets,
    geometry,
    records: { audioById, mediaByElementId, videoDurationMsByElementId },
  };
}
