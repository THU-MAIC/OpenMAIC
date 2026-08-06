'use client';

import { useState, useCallback, useRef } from 'react';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { db, mediaFileKey } from '@/lib/utils/database';
import type { AudioFileRecord } from '@/lib/utils/database';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import {
  agentConfigFromManifest,
  type ClassroomManifest,
  type ManifestScene,
} from '@/lib/export/classroom-zip-types';
import { rewriteAudioRefsToIds } from '@/lib/export/classroom-zip-utils';
import { createLogger } from '@/lib/logger';
import { canonicalizeLegacyScene, mutateDocument, type AppDocument } from '@/lib/document-store';
import { putAsset, removeAsset } from '@/lib/media/asset-pool';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';
import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';
import type JSZip from 'jszip';
import type { Slide } from '@openmaic/dsl';
import type { Stage } from '@/lib/types/stage';

const log = createLogger('ImportClassroom');

export interface ImportedMediaMappings {
  refToNewId: Record<string, string>;
  posterRefToNewId: Record<string, string>;
  posterByMediaRef: Record<string, string>;
}

function rewriteImportedMediaRef(value: string, mapped: string | undefined): string | undefined {
  if (mapped) return mapped;
  if (isConcreteMediaAddress(value) || isGeneratedMediaPlaceholder(value)) return value;
  return undefined;
}

function mediaPathSuffix(mimeType: string | undefined): string | undefined {
  const subtype = mimeType?.split('/')[1];
  return subtype ? `.${subtype}` : undefined;
}

export function mediaRefFromZipPath(zipPath: string, mimeType?: string): string {
  const relative = zipPath.startsWith('media/') ? zipPath.slice('media/'.length) : zipPath;
  const suffix = mediaPathSuffix(mimeType);
  if (suffix && relative.endsWith(suffix)) return relative.slice(0, -suffix.length);
  const slash = relative.lastIndexOf('/');
  const dot = relative.lastIndexOf('.');
  return dot > slash ? relative.slice(0, dot) : relative;
}

function siblingPosterZipPath(zipPath: string, mimeType?: string): string {
  const suffix = mediaPathSuffix(mimeType);
  if (suffix && zipPath.endsWith(suffix)) return `${zipPath.slice(0, -suffix.length)}.poster.jpg`;
  return zipPath.replace(/\.[^/]+$/, '.poster.jpg');
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

export function rewriteImportedSlideMediaRefs(
  slide: Slide,
  mappings: ImportedMediaMappings,
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

export function rewriteImportedVideoManifest(
  manifest: Stage['videoManifest'],
  mappings: ImportedMediaMappings,
): Stage['videoManifest'] {
  if (!manifest) return manifest;
  return Object.fromEntries(
    Object.entries(manifest).flatMap(([ref, entry]) => {
      const rewritten = rewriteImportedMediaRef(ref, mappings.refToNewId[ref]);
      return rewritten ? [[rewritten, entry] as const] : [];
    }),
  );
}

/** Allocate imported audio only after its ZIP entry has been confirmed present. */
export async function materializeImportedAudio(
  zip: JSZip,
  manifest: ClassroomManifest,
  stageId: string,
  createdAt: number,
  allocatedIds: string[] = [],
): Promise<Record<string, string>> {
  const mappings: Record<string, string> = {};
  for (const [zipPath, meta] of Object.entries(manifest.mediaIndex ?? {})) {
    if (meta.type !== 'audio' || meta.missing) continue;
    const zipEntry = zip.file(zipPath);
    if (!zipEntry) continue;
    const blob = await zipEntry.async('blob');
    const assetId = await putAsset(blob, {
      contentType: blob.type || `audio/${meta.format || 'mp3'}`,
      mediaType: 'audio',
      duration: meta.duration,
      voice: meta.voice,
    });
    allocatedIds.push(assetId);
    mappings[zipPath] = assetId;
    const record: AudioFileRecord = {
      id: assetId,
      stageId,
      blob,
      format: meta.format || 'mp3',
      duration: meta.duration,
      voice: meta.voice,
      createdAt,
    };
    await db.audioFiles.put(record);
  }
  return mappings;
}

/** Allocate imported media into the browser-global pool and mirror it to Dexie. */
export async function materializeImportedMedia(
  zip: JSZip,
  manifest: ClassroomManifest,
  stageId: string,
  createdAt: number,
  allocatedIds: string[] = [],
): Promise<ImportedMediaMappings> {
  const mappings: ImportedMediaMappings = {
    refToNewId: {},
    posterRefToNewId: {},
    posterByMediaRef: {},
  };

  const imported: Array<{
    oldRef: string;
    assetId: string;
    type: 'image' | 'video';
    posterBlob?: Blob;
    prompt?: string;
  }> = [];

  for (const [zipPath, meta] of Object.entries(manifest.mediaIndex ?? {})) {
    if ((meta.type !== 'generated' && meta.type !== 'image') || meta.missing) continue;
    const zipEntry = zip.file(zipPath);
    if (!zipEntry) continue;
    const blob = await zipEntry.async('blob');
    const oldRef = mediaRefFromZipPath(zipPath, meta.mimeType);
    const mimeType = meta.mimeType || 'image/jpeg';
    const type = mimeType.startsWith('video/') ? 'video' : 'image';
    const posterEntry =
      type === 'video' ? zip.file(siblingPosterZipPath(zipPath, meta.mimeType)) : null;
    const posterBlob = posterEntry ? await posterEntry.async('blob') : undefined;
    const assetId = await putAsset(blob, {
      contentType: mimeType,
      mediaType: type,
      prompt: meta.prompt,
    });
    allocatedIds.push(assetId);
    mappings.refToNewId[oldRef] = assetId;

    await db.mediaFiles.put({
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
    });
    imported.push({ oldRef, assetId, type, posterBlob, prompt: meta.prompt });
  }

  // A modern ZIP can contain both the video's legacy sibling poster and the
  // poster's own mediaIndex entry. Reuse that entry's freshly allocated id;
  // only older ZIPs need an extra allocation for the sibling poster bytes.
  for (const entry of imported) {
    if (entry.type !== 'video' || !entry.posterBlob) continue;
    const oldPosterRefs = posterRefsForMedia(manifest, entry.oldRef);
    let posterAssetId = oldPosterRefs
      .map((oldPosterRef) => mappings.refToNewId[oldPosterRef])
      .find(Boolean);
    if (!posterAssetId) {
      posterAssetId = await putAsset(entry.posterBlob, {
        contentType: entry.posterBlob.type || 'image/jpeg',
        mediaType: 'video-poster',
        parentRef: entry.assetId,
      });
      allocatedIds.push(posterAssetId);
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
    }
    mappings.posterByMediaRef[entry.oldRef] = posterAssetId;
    for (const oldPosterRef of oldPosterRefs) {
      mappings.posterRefToNewId[oldPosterRef] = posterAssetId;
    }
  }
  return mappings;
}

export type ImportPhase =
  | 'idle'
  | 'parsing'
  | 'validating'
  | 'writingMedia'
  | 'writingCourse'
  | 'done';

export function useImportClassroom(onSuccess?: () => void) {
  const [importing, setImporting] = useState(false);
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useI18n();

  const triggerFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Reset input so same file can be re-selected
      e.target.value = '';

      setImporting(true);
      setPhase('parsing');
      const toastId = toast.loading(t('import.parsing'));

      let importedStageId: string | undefined;
      const importedPoolIds: string[] = [];
      let importCommitted = false;
      try {
        // 0. Size check — warn for files over 200MB
        const MAX_SAFE_SIZE = 200 * 1024 * 1024;
        if (file.size > MAX_SAFE_SIZE) {
          log.warn(`Large ZIP file: ${(file.size / 1024 / 1024).toFixed(0)}MB`);
        }

        // 1. Parse ZIP
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync(file);

        const manifestFile = zip.file('manifest.json');
        if (!manifestFile) {
          toast.error(t('import.error.invalidManifest'), { id: toastId });
          return;
        }

        // 2. Validate
        setPhase('validating');
        toast.loading(t('import.validating'), { id: toastId });

        const manifestText = await manifestFile.async('text');
        let manifest: ClassroomManifest;
        try {
          manifest = JSON.parse(manifestText);
        } catch {
          toast.error(t('import.error.invalidManifest'), { id: toastId });
          return;
        }

        if (!manifest.stage || !manifest.scenes || !Array.isArray(manifest.scenes)) {
          toast.error(t('import.error.missingData'), { id: toastId });
          return;
        }

        // 3. Generate new IDs
        const newStageId = nanoid();
        importedStageId = newStageId;
        const now = Date.now();

        // Agent ID mapping: index → new ID
        const newAgentIds: string[] = (manifest.agents ?? []).map(() => nanoid());
        const studentAgentIndex =
          manifest.agents?.findIndex((agent) => agent.role === 'student') ?? -1;
        const nonTeacherAgentIndex =
          manifest.agents?.findIndex((agent) => agent.role !== 'teacher') ?? -1;
        const fallbackDiscussionAgentIndex =
          studentAgentIndex >= 0
            ? studentAgentIndex
            : nonTeacherAgentIndex >= 0
              ? nonTeacherAgentIndex
              : undefined;

        // 4. Write media to IndexedDB
        setPhase('writingMedia');
        toast.loading(t('import.writingMedia'), { id: toastId });

        const audioRefToNewId = await materializeImportedAudio(
          zip,
          manifest,
          newStageId,
          now,
          importedPoolIds,
        );

        const mediaMappings = await materializeImportedMedia(
          zip,
          manifest,
          newStageId,
          now,
          importedPoolIds,
        );

        // 5. Write course data
        setPhase('writingCourse');
        toast.loading(t('import.writingCourse'), { id: toastId });

        // Rebuild the roster as stage-embedded configs: the stage document is
        // the single source of truth for generated agents (voice included), so
        // an import round-trips the roster without any side-table writes.
        const importedAgentConfigs: GeneratedAgentConfig[] = (manifest.agents ?? []).map((a, i) =>
          agentConfigFromManifest(a, newAgentIds[i]),
        );

        const document: AppDocument = {
          stage: {
            id: newStageId,
            name: manifest.stage.name || 'Imported Classroom',
            description: manifest.stage.description,
            languageDirective: manifest.stage.language,
            style: manifest.stage.style,
            createdAt: manifest.stage.createdAt || now,
            updatedAt: now,
            agentIds: newAgentIds.length > 0 ? newAgentIds : undefined,
            ...(manifest.stage.videoManifest
              ? {
                  videoManifest: rewriteImportedVideoManifest(
                    manifest.stage.videoManifest,
                    mediaMappings,
                  ),
                }
              : {}),
            ...(importedAgentConfigs.length > 0
              ? { generatedAgentConfigs: importedAgentConfigs }
              : {}),
          },
          scenes: manifest.scenes.map((mScene: ManifestScene, index: number) => {
            const newSceneId = nanoid();
            const actions = mScene.actions
              ? rewriteAudioRefsToIds(mScene.actions, audioRefToNewId, {
                  agentIds: newAgentIds,
                  fallbackDiscussionAgentIndex,
                })
              : undefined;
            const multiAgent = mScene.multiAgent?.enabled
              ? {
                  enabled: true,
                  agentIds: (mScene.multiAgent.agentIndices ?? [])
                    .map((idx) => newAgentIds[idx])
                    .filter(Boolean),
                  directorPrompt: mScene.multiAgent.directorPrompt,
                }
              : undefined;

            const content =
              mScene.content.type === 'slide'
                ? {
                    ...mScene.content,
                    canvas: rewriteImportedSlideMediaRefs(mScene.content.canvas, mediaMappings),
                  }
                : mScene.content;
            return canonicalizeLegacyScene({
              id: newSceneId,
              stageId: newStageId,
              title: mScene.title,
              order: mScene.order ?? index,
              content,
              actions,
              whiteboards: mScene.whiteboards?.map((slide) =>
                rewriteImportedSlideMediaRefs(slide, mediaMappings),
              ),
              multiAgent,
              createdAt: now,
              updatedAt: now,
            });
          }),
        };

        // The document is the commit point: one aggregate write under its per-stage lock.
        await mutateDocument(newStageId, async (_existing, store) => store.saveDocument(document));
        importCommitted = true;
        setPhase('done');
      } catch (error) {
        log.error('Classroom ZIP import failed:', error);
        const isQuotaError = error instanceof DOMException && error.name === 'QuotaExceededError';
        toast.error(isQuotaError ? t('import.error.storageFull') : t('import.error.invalidZip'), {
          id: toastId,
        });
      } finally {
        // Media files cannot join the aggregate document transaction. Until the
        // document commit point, compensate every row/allocation individually.
        const cleanup = async (label: string, operation: () => Promise<unknown>) => {
          try {
            await operation();
          } catch (cleanupError) {
            log.error(`Failed to undo imported ${label}:`, cleanupError);
          }
        };
        if (!importCommitted && importedStageId) {
          const stageId = importedStageId;
          await cleanup('document', async () => {
            await mutateDocument(stageId, async (_document, store) =>
              store.deleteDocument(stageId),
            );
          });
          await cleanup('generated media', () =>
            db.mediaFiles.where('stageId').equals(stageId).delete(),
          );
          await cleanup('audio files', () =>
            db.audioFiles.where('stageId').equals(stageId).delete(),
          );
        }
        if (!importCommitted) {
          for (const id of importedPoolIds) {
            await cleanup(`asset pool entry ${id}`, () => removeAsset(id));
          }
        }
        setImporting(false);
        setPhase('idle');
      }
      // A consumer callback is outside the rollback region: its exception
      // cannot make a fully committed classroom lose its already-owned assets.
      if (importCommitted) {
        toast.success(t('import.success'), { id: toastId });
        onSuccess?.();
      }
    },
    [t, onSuccess],
  );

  return {
    importing,
    phase,
    fileInputRef,
    triggerFileSelect,
    handleFileChange,
  };
}
