'use client';

/**
 * Browser collection layer — resolve the binary bytes for a compiled
 * {@link VideoTimeline}'s asset plan.
 *
 * The pure compiler already produced the layout: `ir.assets.entries` names every
 * bundled asset, its `kind`, its zip-relative `path`, and whether its bytes are
 * `present`. This layer just fills those paths with real `Blob`s — narration and
 * media come straight from the Dexie records the DI factory already loaded (no
 * second read), and slide base frames are rendered here via `slideToPng`. Because
 * the plan owns paths and dedup, this is a byte-fetch loop, not a second planner.
 *
 * The slide-snapshot + generated-media-resolution logic is adapted from the
 * frame-export pipeline in PR #849 (the objectURL lifecycle in particular): a
 * cloned slide has its generated-media placeholders swapped for objectURLs, is
 * snapshotted, and the URLs are revoked immediately so memory stays bounded on a
 * large classroom.
 *
 * App-side / impure: reaches into Dexie records, the renderer snapshot, and the
 * DOM — outside the `lib/video-export/**` purity boundary by design.
 */
import { slideToPng } from '@openmaic/renderer/snapshot';
import type { PPTElement, PPTVideoElement, Slide } from '@openmaic/dsl';
import type { VideoTimeline } from '@/lib/video-export';
import type { Scene, SlideContent } from '@/lib/types/stage';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import type { MediaFileRecord } from '@/lib/utils/database';
import type { VideoTimelineRecords } from './timeline-deps';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { withAssetUrl, type AssetUrlLeaseState } from '@/lib/media/use-asset-url';
import {
  MISSING_ASSET_LEASE,
  isConcreteMediaAddress,
  renderableMediaUrl,
  resolveMediaRef,
  type MediaTaskState,
} from '@/lib/media/resolve-media-ref';
import { slideMediaReferenceSlots } from '@/lib/media/slide-media-slots';
import { resolveVideoMediaForElement } from '@/lib/media/media-task-resolution';

export interface CollectOptions {
  /** Slide-snapshot render width in px (frame height follows the slide ratio). Default 1920. */
  frameWidth?: number;
  /** Called after each asset is resolved, for progress UX. */
  onProgress?: (done: number, total: number) => void;
}

export interface CollectResult {
  /** zip-relative path → bytes, for every present asset the plan named. */
  blobs: Map<string, Blob>;
  /** Plan entries whose bytes could not be produced (missing record / render failure). */
  missing: string[];
}

type SnapshotMediaElement = { type: string; src?: string; mediaRef?: string; poster?: string };

/** `frame:<sceneId>` → `<sceneId>`. */
function frameSceneId(assetId: string): string | null {
  return assetId.startsWith('frame:') ? assetId.slice('frame:'.length) : null;
}

function blobWithType(blob: Blob, mimeType: string): Blob {
  return blob.type ? blob : new Blob([blob], { type: mimeType });
}

/** Per-decode timeout (ms) so a video whose metadata/frame never loads can't wedge export. */
const FIRST_FRAME_TIMEOUT_MS = 8000;

/**
 * Decode a video blob's first frame to a PNG object URL, for use as a poster.
 *
 * Generated videos often carry no poster (a provider-optional field), so the
 * base-frame snapshot — which can't draw a `<video>` — would show blank where
 * the clip sits outside its play window. Seeking to frame ~0 and drawing it to
 * a canvas gives the same "paused on the first frame" look most players show.
 * Returns null (caller leaves poster unset) on decode failure, a CORS-tainted
 * frame, or timeout — never throws, so one bad video can't fail the export.
 */
function decodeFirstFramePosterUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(value);
    };
    const timer = setTimeout(() => done(null), FIRST_FRAME_TIMEOUT_MS);
    const capture = () => {
      try {
        if (video.videoWidth === 0 || video.videoHeight === 0) return done(null);
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return done(null);
        ctx.drawImage(video, 0, 0);
        done(canvas.toDataURL('image/png'));
      } catch {
        // CORS-tainted frame or draw failure.
        done(null);
      }
    };
    video.onloadeddata = () => {
      // Nudge off frame 0 so decoders that hold a black pre-roll frame yield a
      // real image; `seeked` then fires with the frame painted.
      if (video.readyState >= 2 && video.currentTime === 0 && video.duration > 0) {
        video.currentTime = Math.min(0.1, video.duration / 2);
      } else {
        capture();
      }
    };
    video.onseeked = capture;
    video.onerror = () => done(null);
    video.src = url;
  });
}

/**
 * Resolve the bytes for one asset, preferring the local Dexie blob and falling
 * back to the record's CDN URL (`ossKey`) so a live-mode classroom whose local
 * blobs were LRU-evicted under storage pressure still exports a self-contained
 * ZIP (issue #865: "live-mode ossKey audio fetched at compile time"). Returns
 * `null` when neither a local blob nor a fetchable URL yields bytes.
 */
async function resolveBytes(
  blob: Blob | undefined,
  ossKey: string | undefined,
): Promise<Blob | null> {
  if (blob && blob.size > 0) return blob;
  if (!ossKey) return null;
  try {
    const res = await fetch(ossKey);
    if (!res.ok) return null;
    const fetched = await res.blob();
    return fetched.size > 0 ? fetched : null;
  } catch {
    return null;
  }
}

function mediaRefFromRecordId(recordId: string): string {
  return recordId.includes(':') ? recordId.split(':').slice(1).join(':') : recordId;
}

export function resolveVideoExportMediaBinding(
  ref: string | undefined,
  task: MediaTaskState | undefined,
  lease: AssetUrlLeaseState = MISSING_ASSET_LEASE,
  mediaGenerationDisabled = false,
) {
  const resolution = resolveMediaRef(ref, task, lease, mediaGenerationDisabled);
  return { resolution, src: renderableMediaUrl(resolution) ?? '' };
}

async function resolveMediaBytesWithFallback(
  assetId: string,
  record: MediaFileRecord | undefined,
  stageId?: string,
): Promise<Blob | null> {
  const usableRecord = record && !record.error ? record : undefined;
  const ref = record ? mediaRefFromRecordId(record.id) : assetId;
  const tasks = useMediaGenerationStore.getState().tasks;
  const task =
    tasks[ref] ??
    Object.values(tasks).find(
      (candidate) =>
        candidate.placeholderRef === ref && (!stageId || candidate.stageId === stageId),
    );
  const effectiveTask = task && (!stageId || task.stageId === stageId) ? task : undefined;
  if (!isConcreteMediaAddress(ref)) {
    try {
      const pooled = await withAssetUrl(ref, async (url) => {
        if (!url) return null;
        const binding = resolveVideoExportMediaBinding(ref, effectiveTask, {
          status: 'resolved',
          url,
        });
        return binding.src ? resolveBytes(undefined, binding.src) : null;
      });
      if (pooled) return pooled;
    } catch {
      // The compatibility record remains the fallback when pool access fails.
    }
  }
  const stored = await resolveBytes(usableRecord?.blob, usableRecord?.ossKey);
  if (stored) {
    const state = resolveVideoExportMediaBinding(ref, effectiveTask, {
      status: 'resolved',
      url: 'dexie:media',
    }).resolution;
    if (state.kind === 'url') return stored;
  }

  const resolved = resolveVideoExportMediaBinding(ref, effectiveTask).src;
  return resolved ? resolveBytes(undefined, resolved) : null;
}

/** The generated-image ref an element points at, when it is an unresolved placeholder. */
function snapshotImageMediaRef(element: SnapshotMediaElement): string | undefined {
  if (element.type === 'image' && element.src && isMediaPlaceholder(element.src))
    return element.src;
  return undefined;
}

/**
 * Clone a slide and swap each generated-media placeholder for an objectURL over
 * the resolved bytes, returning a `revoke` that releases them. Adapted from
 * PR #849's `resolveGeneratedMediaForSnapshot`.
 *
 * Bytes are resolved via {@link resolveBytes} (local blob first, then the CDN
 * `ossKey` / `posterOssKey`), so a live-mode record whose local blob was
 * LRU-evicted is still restored into the base-frame snapshot — otherwise the
 * frame PNG would be missing the generated image/video even though the
 * standalone asset entry was fetched.
 */
async function resolveGeneratedMedia(
  source: Slide,
  mediaByElementId: Map<string, MediaFileRecord>,
  stageId?: string,
): Promise<{ slide: Slide; revoke: () => void }> {
  const slide = structuredClone(source);
  const objectUrls: string[] = [];

  const slots = [...slideMediaReferenceSlots(slide)];
  const backgroundSlot = slots.find((slot) => slot.kind === 'background-image');
  const backgroundRef = backgroundSlot?.read();
  if (backgroundSlot && backgroundRef && isMediaPlaceholder(backgroundRef)) {
    const record = mediaByElementId.get(backgroundRef);
    const bytes = await resolveMediaBytesWithFallback(backgroundRef, record, stageId);
    if (bytes && (!record || record.type === 'image')) {
      const url = URL.createObjectURL(
        blobWithType(bytes, record?.mimeType || bytes.type || 'image/png'),
      );
      objectUrls.push(url);
      backgroundSlot.write(url);
    } else {
      const tasks = useMediaGenerationStore.getState().tasks;
      const task =
        tasks[backgroundRef] ??
        Object.values(tasks).find(
          (candidate) =>
            candidate.placeholderRef === backgroundRef &&
            (!stageId || candidate.stageId === stageId),
        );
      const effectiveTask = task && (!stageId || task.stageId === stageId) ? task : undefined;
      if (!renderableMediaUrl(resolveMediaRef(backgroundRef, effectiveTask))) {
        backgroundSlot.write('');
      }
    }
  }

  const mediaElements = new Set<SnapshotMediaElement>();
  for (const slot of slots) {
    if (slot.element) mediaElements.add(slot.element as SnapshotMediaElement);
  }
  const documentElements = [...mediaElements] as PPTElement[];
  for (const element of mediaElements) {
    let resolvedPoster = false;
    if (element.type === 'video' && element.poster && isMediaPlaceholder(element.poster)) {
      const posterRecord = mediaByElementId.get(element.poster);
      const posterBytes = await resolveMediaBytesWithFallback(
        element.poster,
        posterRecord,
        stageId,
      );
      if (posterBytes) {
        const poster = URL.createObjectURL(
          blobWithType(posterBytes, posterRecord?.mimeType || posterBytes.type || 'image/jpeg'),
        );
        objectUrls.push(poster);
        element.poster = poster;
        resolvedPoster = true;
      } else if (!renderableMediaUrl(resolveMediaRef(element.poster, undefined))) {
        element.poster = undefined;
      }
    }
    const tasks = useMediaGenerationStore.getState().tasks;
    const ref =
      element.type === 'video'
        ? resolveVideoMediaForElement(tasks, element as PPTVideoElement, stageId, documentElements)
            .sourceRef
        : snapshotImageMediaRef(element);
    if (!ref) continue;
    const record = mediaByElementId.get(ref);
    const bytes = await resolveMediaBytesWithFallback(ref, record, stageId);
    if (!bytes) {
      const task =
        tasks[ref] ??
        Object.values(tasks).find(
          (candidate) =>
            candidate.placeholderRef === ref && (!stageId || candidate.stageId === stageId),
        );
      const effectiveTask = task && (!stageId || task.stageId === stageId) ? task : undefined;
      if (!renderableMediaUrl(resolveMediaRef(ref, effectiveTask))) element.src = '';
      continue;
    }
    if (element.type === 'image' && (!record || record.type === 'image')) {
      const url = URL.createObjectURL(
        blobWithType(bytes, record?.mimeType || bytes.type || 'image/png'),
      );
      objectUrls.push(url);
      element.src = url;
    } else if (element.type === 'video' && (!record || record.type === 'video')) {
      const mimeType = record?.mimeType || bytes.type || 'video/mp4';
      const url = URL.createObjectURL(blobWithType(bytes, mimeType));
      objectUrls.push(url);
      element.src = url;
      const posterBytes = resolvedPoster
        ? null
        : await resolveBytes(record?.poster, record?.posterOssKey);
      if (posterBytes) {
        const poster = URL.createObjectURL(blobWithType(posterBytes, 'image/jpeg'));
        objectUrls.push(poster);
        element.poster = poster;
      } else if (!resolvedPoster) {
        // No stored poster (generated videos usually have none) — decode the
        // video's first frame so the base snapshot shows it instead of blank
        // where the clip sits outside its play window. The frame is a data URL
        // (no object-URL lifecycle to revoke).
        const firstFrame = await decodeFirstFramePosterUrl(blobWithType(bytes, mimeType));
        if (firstFrame) element.poster = firstFrame;
      }
    }
  }

  return { slide, revoke: () => objectUrls.forEach((url) => URL.revokeObjectURL(url)) };
}

/** Render one slide scene to a PNG frame blob, releasing objectURLs immediately after. */
async function renderFrame(
  slide: Slide,
  mediaByElementId: Map<string, MediaFileRecord>,
  width: number,
  stageId?: string,
): Promise<Blob> {
  const { slide: resolved, revoke } = await resolveGeneratedMedia(slide, mediaByElementId, stageId);
  try {
    const output = await slideToPng(resolved, {
      width,
      pixelRatio: 1,
      backgroundColor: '#ffffff',
      format: 'blob',
    });
    return output instanceof Blob ? output : await fetch(output).then((r) => r.blob());
  } finally {
    revoke();
  }
}

/**
 * Collect the bytes for every present entry in the IR's asset plan. Frames are
 * rendered from the matching slide scene; audio/video bytes come from the loaded
 * Dexie records. Absent or unrenderable entries are reported in `missing` rather
 * than throwing, so one bad asset does not fail the whole export.
 */
export async function collectVideoAssets(
  ir: VideoTimeline,
  scenes: Scene[],
  records: VideoTimelineRecords,
  options: CollectOptions = {},
): Promise<CollectResult> {
  const width = options.frameWidth ?? 1920;
  const blobs = new Map<string, Blob>();
  const missing: string[] = [];

  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const mediaById = new Map<string, MediaFileRecord>();
  for (const record of records.mediaByElementId.values()) mediaById.set(record.id, record);

  // Only the owning entries carry bytes; dedup entries reuse the owner's path.
  const owners = ir.assets.entries.filter((e) => e.present && !e.dedupOf);
  let done = 0;

  for (const entry of owners) {
    if (blobs.has(entry.path)) {
      options.onProgress?.(++done, owners.length);
      continue;
    }
    try {
      if (entry.kind === 'frame') {
        const sceneId = frameSceneId(entry.assetId);
        const scene = sceneId ? sceneById.get(sceneId) : undefined;
        if (scene && scene.content.type === 'slide') {
          const slide = (scene.content as SlideContent).canvas;
          blobs.set(
            entry.path,
            await renderFrame(slide, records.mediaByElementId, width, scene.stageId),
          );
        } else {
          missing.push(entry.path);
        }
      } else if (entry.kind === 'audio') {
        const record = records.audioById.get(entry.assetId);
        const bytes = await resolveBytes(record?.blob, record?.ossKey);
        if (bytes) blobs.set(entry.path, bytes);
        else missing.push(entry.path);
      } else if (entry.kind === 'video' || entry.kind === 'image') {
        const record = mediaById.get(entry.assetId);
        const bytes = await resolveMediaBytesWithFallback(
          entry.assetId,
          record,
          record?.stageId ?? scenes[0]?.stageId,
        );
        if (bytes) blobs.set(entry.path, bytes);
        else missing.push(entry.path);
      } else if (entry.kind === 'poster') {
        const record = mediaById.get(entry.assetId);
        const bytes = await resolveBytes(record?.poster, record?.posterOssKey);
        if (bytes) blobs.set(entry.path, bytes);
        else missing.push(entry.path);
      } else if (entry.kind === 'html') {
        const html = records.interactiveHtml.content(entry.assetId);
        if (html) blobs.set(entry.path, new Blob([html], { type: 'text/html;charset=utf-8' }));
        else missing.push(entry.path);
      }
    } catch {
      missing.push(entry.path);
    }
    options.onProgress?.(++done, owners.length);
  }

  return { blobs, missing };
}
