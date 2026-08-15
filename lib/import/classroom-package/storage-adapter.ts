import type { ClassroomManifest, ManifestScene } from '@/lib/export/classroom-zip-types';
import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';
import { putAsset } from '@/lib/media/asset-pool';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';
import type { Stage } from '@/lib/types/stage';
import { db, mediaFileKey, type AudioFileRecord, type MediaFileRecord } from '@/lib/utils/database';
import type { Slide } from '@openmaic/dsl';
import { buildMediaElementIdMap, mediaElementIdFromPath, normalizedMediaPath } from './media-refs';
import {
  ClassroomPackageError,
  type ClassroomPackageLimits,
  type ResolvedClassroomPackageSource,
} from './types';

export interface ImportedPackageMediaMappings {
  refToNewId: Record<string, string>;
  posterRefToNewId: Record<string, string>;
  posterByMediaRef: Record<string, string>;
}

export interface MaterializedPackageAssets {
  audioRefToNewId: Record<string, string>;
  mediaMappings: ImportedPackageMediaMappings;
  /** Every id was newly allocated by this import and is safe to remove on rollback. */
  allocatedAssetIds: string[];
  audioCount: number;
  mediaCount: number;
}

interface MaterializePackageAssetsOptions {
  signal?: AbortSignal;
  limits: ClassroomPackageLimits;
  allocatedAssetIds?: string[];
  onProgress?: (prepared: number, total: number) => void;
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new ClassroomPackageError('aborted', '课程包导入已取消。');
  }
}

function mediaPathSuffix(mimeType: string | undefined): string | undefined {
  const subtype = mimeType?.split('/')[1];
  return subtype ? `.${subtype}` : undefined;
}

/** Convert a portable ZIP path back to the opaque reference stored in a scene. */
export function mediaRefFromPackagePath(packagePath: string, mimeType?: string): string {
  const relative = packagePath.startsWith('media/')
    ? packagePath.slice('media/'.length)
    : packagePath;
  const suffix = mediaPathSuffix(mimeType);
  if (suffix && relative.endsWith(suffix)) return relative.slice(0, -suffix.length);
  const slash = relative.lastIndexOf('/');
  const dot = relative.lastIndexOf('.');
  return dot > slash ? relative.slice(0, dot) : relative;
}

function siblingPosterPackagePath(packagePath: string, mimeType?: string): string {
  const suffix = mediaPathSuffix(mimeType);
  if (suffix && packagePath.endsWith(suffix)) {
    return `${packagePath.slice(0, -suffix.length)}.poster.jpg`;
  }
  return packagePath.replace(/\.[^/]+$/, '.poster.jpg');
}

function sceneSlides(scene: ManifestScene): Slide[] {
  const slides: Slide[] = [];
  if (scene.content.type === 'slide') slides.push(scene.content.canvas);
  slides.push(...(scene.whiteboards ?? []));
  return slides;
}

function posterRefsForMedia(manifest: ClassroomManifest, mediaRef: string): string[] {
  const refs = new Set<string>();
  for (const scene of manifest.scenes) {
    for (const slide of sceneSlides(scene)) {
      for (const element of slide.elements) {
        if (
          element.type === 'video' &&
          (element.src === mediaRef || element.mediaRef === mediaRef) &&
          element.poster
        ) {
          refs.add(element.poster);
        }
      }
    }
  }
  return [...refs];
}

function rewriteImportedMediaRef(value: string, mapped: string | undefined): string | undefined {
  if (mapped) return mapped;
  if (isConcreteMediaAddress(value) || isGeneratedMediaPlaceholder(value)) return value;
  return undefined;
}

/** Rewrite legacy/generated slide references to v0.3.2 asset-pool ids. */
export function rewritePackageSlideMediaRefs(
  slide: Slide,
  mappings: ImportedPackageMediaMappings,
): Slide {
  const background =
    slide.background?.type === 'image' && slide.background.image
      ? {
          ...slide.background,
          image: {
            ...slide.background.image,
            src:
              rewriteImportedMediaRef(
                slide.background.image.src,
                mappings.refToNewId[slide.background.image.src],
              ) ?? '',
          },
        }
      : slide.background;

  return {
    ...slide,
    background,
    elements: slide.elements.map((element) => {
      if (element.type === 'image') {
        const src = rewriteImportedMediaRef(element.src, mappings.refToNewId[element.src]) ?? '';
        return src === element.src ? element : { ...element, src };
      }
      if (element.type !== 'video') return element;

      const oldMediaRef = element.mediaRef || element.src || '';
      const src = element.src
        ? (rewriteImportedMediaRef(element.src, mappings.refToNewId[element.src]) ?? '')
        : undefined;
      const mediaRef = element.mediaRef
        ? rewriteImportedMediaRef(element.mediaRef, mappings.refToNewId[element.mediaRef])
        : undefined;
      const poster = element.poster
        ? rewriteImportedMediaRef(
            element.poster,
            mappings.posterRefToNewId[element.poster] ?? mappings.refToNewId[element.poster],
          )
        : mappings.posterByMediaRef[oldMediaRef];
      const rewritten = { ...element, ...(src !== undefined ? { src } : {}) };
      if (mediaRef) rewritten.mediaRef = mediaRef;
      else delete rewritten.mediaRef;
      if (poster) rewritten.poster = poster;
      else delete rewritten.poster;
      return rewritten;
    }),
  };
}

export function rewritePackageVideoManifest(
  manifest: Stage['videoManifest'],
  mappings: ImportedPackageMediaMappings,
): Stage['videoManifest'] {
  if (!manifest) return manifest;
  return Object.fromEntries(
    Object.entries(manifest).flatMap(([ref, entry]) => {
      const rewritten = rewriteImportedMediaRef(ref, mappings.refToNewId[ref]);
      return rewritten ? [[rewritten, entry] as const] : [];
    }),
  );
}

/**
 * Put package bytes in the v0.3.2 browser-wide asset pool and maintain the
 * Dexie mirror rows used by export/thumbnails. These writes deliberately occur
 * before the document commit and are compensated by the caller if anything
 * later fails: IndexedDB cannot provide one transaction across the asset pool,
 * document store, and workspace database.
 */
export async function materializePackageAssets(
  manifest: ClassroomManifest,
  source: ResolvedClassroomPackageSource,
  stageId: string,
  createdAt: number,
  options: MaterializePackageAssetsOptions,
): Promise<MaterializedPackageAssets> {
  const allocatedAssetIds = options.allocatedAssetIds ?? [];
  const audioRefToNewId: Record<string, string> = {};
  const mediaMappings: ImportedPackageMediaMappings = {
    refToNewId: {},
    posterRefToNewId: {},
    posterByMediaRef: {},
  };
  const indexedEntries = Object.entries(manifest.mediaIndex ?? {}).filter(([rawPath, entry]) => {
    const path = normalizedMediaPath(rawPath);
    return !!path && !entry.missing && source.entries.has(path);
  });
  const total = indexedEntries.length;
  let prepared = 0;
  let audioCount = 0;
  let mediaCount = 0;
  let actualBytes = 0;
  const accountedPaths = new Set<string>();

  const readCheckedBlob = async (rawPath: string): Promise<Blob> => {
    abortIfNeeded(options.signal);
    const path = normalizedMediaPath(rawPath);
    const entry = path ? source.entries.get(path) : undefined;
    if (!path || !entry) {
      throw new ClassroomPackageError('import-failed', `课程资源不存在：${rawPath}`);
    }
    const blob = await entry.readBlob();
    abortIfNeeded(options.signal);
    if (blob.size > options.limits.maxEntryBytes) {
      throw new ClassroomPackageError('limits-exceeded', `单个资源超过安全上限：${path}`);
    }
    if (!accountedPaths.has(path)) {
      accountedPaths.add(path);
      actualBytes += blob.size;
      if (actualBytes > options.limits.maxUncompressedBytes) {
        throw new ClassroomPackageError('limits-exceeded', '资源实际体积超过安全上限。');
      }
    }
    return blob;
  };

  const markPrepared = () => {
    prepared += 1;
    options.onProgress?.(prepared, total);
  };

  for (const [rawPath, meta] of indexedEntries) {
    if (meta.type !== 'audio') continue;
    const blob = await readCheckedBlob(rawPath);
    const assetId = await putAsset(blob, {
      contentType: blob.type || meta.mimeType || `audio/${meta.format || 'mp3'}`,
      mediaType: 'audio',
      duration: meta.duration,
      voice: meta.voice,
    });
    allocatedAssetIds.push(assetId);
    audioRefToNewId[rawPath] = assetId;
    const record: AudioFileRecord = {
      id: assetId,
      stageId,
      blob,
      format: meta.format || normalizedMediaPath(rawPath)?.split('.').pop() || 'mp3',
      duration: meta.duration,
      voice: meta.voice,
      createdAt,
    };
    await db.audioFiles.put(record);
    audioCount += 1;
    markPrepared();
  }

  const mediaElementIds = buildMediaElementIdMap(
    indexedEntries
      .filter(([, entry]) => entry.type === 'generated' || entry.type === 'image')
      .map(([rawPath]) => rawPath),
  );
  const mediaEntries = indexedEntries
    .filter(([, entry]) => entry.type === 'generated' || entry.type === 'image')
    .sort(([leftPath], [rightPath]) => {
      const leftStable = mediaElementIds.get(leftPath);
      const rightStable = mediaElementIds.get(rightPath);
      const leftCanonical = leftStable === mediaElementIdFromPath(leftPath) ? 0 : 1;
      const rightCanonical = rightStable === mediaElementIdFromPath(rightPath) ? 0 : 1;
      return leftCanonical - rightCanonical || leftPath.localeCompare(rightPath);
    });
  const imported: Array<{
    oldRef: string;
    stableRef: string;
    assetId: string;
    type: 'image' | 'video';
    posterBlob?: Blob;
    prompt?: string;
  }> = [];

  for (const [rawPath, meta] of mediaEntries) {
    const blob = await readCheckedBlob(rawPath);
    const path = normalizedMediaPath(rawPath)!;
    const oldRef = mediaRefFromPackagePath(path, meta.mimeType);
    const stableRef = mediaElementIds.get(rawPath) ?? oldRef;
    const mimeType = meta.mimeType || blob.type || 'image/jpeg';
    const type = mimeType.startsWith('video/') ? 'video' : 'image';
    const posterPath = type === 'video' ? siblingPosterPackagePath(path, meta.mimeType) : undefined;
    const posterBlob =
      posterPath && source.entries.has(posterPath) ? await readCheckedBlob(posterPath) : undefined;
    const assetId = await putAsset(blob, {
      contentType: mimeType,
      mediaType: type,
      prompt: meta.prompt,
    });
    allocatedAssetIds.push(assetId);
    // The canonical media/ path owns a legacy basename. Other same-basename
    // files retain deterministic suffixed refs and can never overwrite it.
    mediaMappings.refToNewId[oldRef] ??= assetId;
    mediaMappings.refToNewId[stableRef] = assetId;

    const record: MediaFileRecord = {
      id: mediaFileKey(stageId, assetId),
      stageId,
      type,
      blob,
      mimeType,
      size: meta.size || blob.size,
      poster: posterBlob,
      prompt: meta.prompt || '',
      params: '',
      createdAt,
    };
    await db.mediaFiles.put(record);
    mediaCount += 1;
    imported.push({ oldRef, stableRef, assetId, type, posterBlob, prompt: meta.prompt });
    markPrepared();
  }

  // A video poster is an independently addressable asset in v0.3.2. Reuse a
  // poster already present in mediaIndex; allocate legacy sibling bytes only
  // when the package does not have such an entry.
  for (const entry of imported) {
    if (entry.type !== 'video' || !entry.posterBlob) continue;
    const oldPosterRefs = posterRefsForMedia(manifest, entry.oldRef);
    let posterAssetId = oldPosterRefs
      .map((oldPosterRef) => mediaMappings.refToNewId[oldPosterRef])
      .find(Boolean);
    if (!posterAssetId) {
      posterAssetId = await putAsset(entry.posterBlob, {
        contentType: entry.posterBlob.type || 'image/jpeg',
        mediaType: 'video-poster',
        parentRef: entry.assetId,
      });
      allocatedAssetIds.push(posterAssetId);
      await db.mediaFiles.put({
        id: mediaFileKey(stageId, posterAssetId),
        stageId,
        type: 'image',
        blob: entry.posterBlob,
        mimeType: entry.posterBlob.type || 'image/jpeg',
        size: entry.posterBlob.size,
        prompt: entry.prompt || '',
        params: '',
        createdAt,
      });
      mediaCount += 1;
    }
    mediaMappings.posterByMediaRef[entry.oldRef] = posterAssetId;
    mediaMappings.posterByMediaRef[entry.stableRef] = posterAssetId;
    for (const oldPosterRef of oldPosterRefs) {
      mediaMappings.posterRefToNewId[oldPosterRef] = posterAssetId;
    }
  }

  return {
    audioRefToNewId,
    mediaMappings,
    allocatedAssetIds,
    audioCount,
    mediaCount,
  };
}
