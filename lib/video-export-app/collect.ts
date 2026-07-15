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
import type { Slide } from '@openmaic/dsl';
import type { VideoTimeline } from '@/lib/video-export';
import type { Scene, SlideContent } from '@/lib/types/stage';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import type { MediaFileRecord } from '@/lib/utils/database';
import type { VideoTimelineRecords } from './timeline-deps';

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

/** The generated-media ref an element points at, when it is an unresolved placeholder. */
function snapshotMediaRef(element: SnapshotMediaElement): string | undefined {
  if (element.type === 'image' && element.src && isMediaPlaceholder(element.src))
    return element.src;
  if (element.type === 'video') {
    if (element.mediaRef && isMediaPlaceholder(element.mediaRef)) return element.mediaRef;
    if (element.src && isMediaPlaceholder(element.src)) return element.src;
  }
  return undefined;
}

/**
 * Clone a slide and swap each generated-media placeholder for an objectURL over
 * the collected bytes, returning a `revoke` that releases them. Adapted from
 * PR #849's `resolveGeneratedMediaForSnapshot`.
 */
function resolveGeneratedMedia(
  source: Slide,
  mediaByElementId: Map<string, MediaFileRecord>,
): { slide: Slide; revoke: () => void } {
  const slide = structuredClone(source);
  const objectUrls: string[] = [];

  for (const element of slide.elements as SnapshotMediaElement[]) {
    const ref = snapshotMediaRef(element);
    if (!ref) continue;
    const record = mediaByElementId.get(ref);
    if (!record || record.error || record.blob.size === 0) {
      if (element.type === 'image') element.src = '';
      continue;
    }
    if (element.type === 'image' && record.type === 'image') {
      const url = URL.createObjectURL(blobWithType(record.blob, record.mimeType));
      objectUrls.push(url);
      element.src = url;
    } else if (element.type === 'video' && record.type === 'video') {
      const url = URL.createObjectURL(blobWithType(record.blob, record.mimeType));
      objectUrls.push(url);
      element.src = url;
      if (record.poster) {
        const poster = URL.createObjectURL(blobWithType(record.poster, 'image/jpeg'));
        objectUrls.push(poster);
        element.poster = poster;
      }
    } else if (element.type === 'image') {
      element.src = '';
    }
  }

  return { slide, revoke: () => objectUrls.forEach((url) => URL.revokeObjectURL(url)) };
}

/** Render one slide scene to a PNG frame blob, releasing objectURLs immediately after. */
async function renderFrame(
  slide: Slide,
  mediaByElementId: Map<string, MediaFileRecord>,
  width: number,
): Promise<Blob> {
  const { slide: resolved, revoke } = resolveGeneratedMedia(slide, mediaByElementId);
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
          blobs.set(entry.path, await renderFrame(slide, records.mediaByElementId, width));
        } else {
          missing.push(entry.path);
        }
      } else if (entry.kind === 'audio') {
        const record = records.audioById.get(entry.assetId);
        if (record?.blob?.size) blobs.set(entry.path, record.blob);
        else missing.push(entry.path);
      } else if (entry.kind === 'video' || entry.kind === 'image') {
        const record = mediaById.get(entry.assetId);
        if (record?.blob?.size) blobs.set(entry.path, record.blob);
        else missing.push(entry.path);
      } else if (entry.kind === 'poster') {
        const record = mediaById.get(entry.assetId);
        if (record?.poster) blobs.set(entry.path, record.poster);
        else missing.push(entry.path);
      }
    } catch {
      missing.push(entry.path);
    }
    options.onProgress?.(++done, owners.length);
  }

  return { blobs, missing };
}
