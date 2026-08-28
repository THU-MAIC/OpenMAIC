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
  type MediaIndexEntry,
} from '@/lib/export/classroom-zip-types';
import { rewriteAudioRefsToIds } from '@/lib/export/classroom-zip-utils';
import { createLogger } from '@/lib/logger';
import { canonicalizeLegacyScene, mutateDocument, type AppDocument } from '@/lib/document-store';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';
import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';
import type JSZip from 'jszip';
import type { Slide } from '@openmaic/dsl';
import type { Stage } from '@/lib/types/stage';

const log = createLogger('ImportClassroom');

export interface ImportedMediaMappings {
  readonly refToNewId: ReadonlyMap<string, string>;
  readonly posterRefToNewId: ReadonlyMap<string, string>;
  readonly posterByMediaRef: ReadonlyMap<string, string>;
}

export interface ImportedAudioMappings {
  readonly pathToId: ReadonlyMap<string, string>;
  readonly sourceRefToId: ReadonlyMap<string, string>;
}

/** Content type the importer writes for serialized narration metadata. */
export function importedAudioContentType(
  meta: Pick<MediaIndexEntry, 'mimeType' | 'format'>,
  blobType: string,
): string {
  return meta.mimeType || blobType || `audio/${meta.format || 'mp3'}`;
}

type ImportedRefMapping = ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>;

function mappedString(mapping: ImportedRefMapping, key: string): string | undefined {
  const value =
    mapping instanceof Map
      ? mapping.get(key)
      : Object.hasOwn(mapping, key)
        ? (mapping as Readonly<Record<string, unknown>>)[key]
        : undefined;
  return typeof value === 'string' ? value : undefined;
}

function rewriteImportedMediaRef(value: unknown, mapped: string | undefined): string | undefined {
  if (mapped) return mapped;
  if (typeof value !== 'string') return undefined;
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
  audioRefToNewId: ImportedRefMapping = new Map(),
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
                mappedString(mappings.refToNewId, slide.background.image.src),
              ) ?? '',
          },
        }
      : slide.background;
  return {
    ...slide,
    background,
    elements: slide.elements.map((element) => {
      if (element.type === 'image') {
        const src =
          rewriteImportedMediaRef(element.src, mappedString(mappings.refToNewId, element.src)) ??
          '';
        return src === element.src ? element : { ...element, src };
      }
      if (element.type === 'audio') {
        const src =
          rewriteImportedMediaRef(element.src, mappedString(audioRefToNewId, element.src)) ?? '';
        return src === element.src ? element : { ...element, src };
      }
      if (element.type !== 'video') return element;
      const oldMediaRef = element.mediaRef || element.src || '';
      const src = element.src
        ? (rewriteImportedMediaRef(element.src, mappedString(mappings.refToNewId, element.src)) ??
          '')
        : undefined;
      const mediaRef = element.mediaRef
        ? rewriteImportedMediaRef(
            element.mediaRef,
            mappedString(mappings.refToNewId, element.mediaRef),
          )
        : undefined;
      const poster = element.poster
        ? rewriteImportedMediaRef(
            element.poster,
            mappedString(mappings.posterRefToNewId, element.poster) ??
              mappedString(mappings.refToNewId, element.poster),
          )
        : mappedString(mappings.posterByMediaRef, oldMediaRef);
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
      const rewritten = rewriteImportedMediaRef(ref, mappedString(mappings.refToNewId, ref));
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
): Promise<ImportedAudioMappings> {
  const pathToId = new Map<string, string>();
  const sourceRefToId = new Map<string, string>();
  // Sorting makes malformed duplicate-sourceRef handling independent of JSON
  // object insertion order: the lexicographically first ZIP path owns the
  // source-ref alias, while every genuine ZIP path remains addressable.
  const entries = Object.entries(manifest.mediaIndex ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [zipPath, meta] of entries) {
    if (meta.type !== 'audio' || meta.missing) continue;
    const zipEntry = zip.file(zipPath);
    if (!zipEntry) continue;
    const blob = await zipEntry.async('blob');
    const audioId = nanoid();
    allocatedIds.push(audioId);
    pathToId.set(zipPath, audioId);
    const relativePath = zipPath.startsWith('audio/') ? zipPath.slice('audio/'.length) : zipPath;
    const formatSuffix = meta.format ? `.${meta.format}` : undefined;
    const sourceRef =
      (typeof meta.sourceRef === 'string' ? meta.sourceRef : undefined) ??
      (formatSuffix && relativePath.endsWith(formatSuffix)
        ? relativePath.slice(0, -formatSuffix.length)
        : relativePath.replace(/\.[^/.]+$/, ''));
    if (!sourceRefToId.has(sourceRef)) sourceRefToId.set(sourceRef, audioId);
    const record: AudioFileRecord = {
      id: audioId,
      stageId,
      blob,
      format: meta.format || 'mp3',
      duration: meta.duration,
      voice: meta.voice,
      createdAt,
    };
    await db.audioFiles.put(record);
  }
  return { pathToId, sourceRefToId };
}

/** Materialize imported media directly into the stage's Dexie byte rows. */
export async function materializeImportedMedia(
  zip: JSZip,
  manifest: ClassroomManifest,
  stageId: string,
  createdAt: number,
  allocatedIds: string[] = [],
): Promise<ImportedMediaMappings> {
  const refToNewId = new Map<string, string>();
  const posterRefToNewId = new Map<string, string>();
  const posterByMediaRef = new Map<string, string>();
  const mappings: ImportedMediaMappings = {
    refToNewId,
    posterRefToNewId,
    posterByMediaRef,
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
    const oldRef =
      typeof meta.sourceRef === 'string'
        ? meta.sourceRef
        : mediaRefFromZipPath(zipPath, meta.mimeType);
    const mimeType = meta.mimeType || 'image/jpeg';
    const type = importedMediaKind(mimeType);
    const posterEntry =
      type === 'video' ? zip.file(siblingPosterZipPath(zipPath, meta.mimeType)) : null;
    const posterBlob = posterEntry ? await posterEntry.async('blob') : undefined;
    const mediaId = nanoid();
    allocatedIds.push(mediaId);
    refToNewId.set(oldRef, mediaId);

    await db.mediaFiles.put({
      id: mediaFileKey(stageId, mediaId),
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
    imported.push({ oldRef, assetId: mediaId, type, posterBlob, prompt: meta.prompt });
  }

  // A modern ZIP can contain both the video's legacy sibling poster and the
  // poster's own mediaIndex entry. Reuse that entry's freshly allocated id;
  // only older ZIPs need an extra allocation for the sibling poster bytes.
  for (const entry of imported) {
    if (entry.type !== 'video' || !entry.posterBlob) continue;
    const oldPosterRefs = posterRefsForMedia(manifest, entry.oldRef);
    let posterAssetId = oldPosterRefs
      .map((oldPosterRef) => mappedString(mappings.refToNewId, oldPosterRef))
      .find((value): value is string => typeof value === 'string');
    if (!posterAssetId) {
      posterAssetId = nanoid();
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
    posterByMediaRef.set(entry.oldRef, posterAssetId);
    for (const oldPosterRef of oldPosterRefs) {
      posterRefToNewId.set(oldPosterRef, posterAssetId);
    }
  }
  return mappings;
}

/** Classification used for imported generated media after export normalization. */
export function importedMediaKind(mimeType: string): 'image' | 'video' {
  return mimeType.startsWith('video/') ? 'video' : 'image';
}

export type ImportPhase =
  | 'idle'
  | 'parsing'
  | 'validating'
  | 'writingMedia'
  | 'writingCourse'
  | 'done';

export function useImportClassroom(onSuccess?: (importedStageId: string) => void) {
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

        const audioMappings = await materializeImportedAudio(
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
              ? rewriteAudioRefsToIds(mScene.actions, audioMappings.pathToId, {
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
                    canvas: rewriteImportedSlideMediaRefs(
                      mScene.content.canvas,
                      mediaMappings,
                      audioMappings.sourceRefToId,
                    ),
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
                rewriteImportedSlideMediaRefs(slide, mediaMappings, audioMappings.sourceRefToId),
              ),
              multiAgent,
              createdAt: now,
              updatedAt: now,
            });
          }),
        };

        // The document is the commit point: one aggregate write under its
        // per-stage lock. Wholesale replacement: the imported aggregate
        // overwrites the whole document, so eager conversion of whatever
        // currently sits there would allocate assets the import immediately
        // replaces.
        await mutateDocument(
          newStageId,
          async (_existing, store) => store.saveDocument(document),
          {},
          { mode: 'replace' },
        );
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
        setImporting(false);
        setPhase('idle');
      }
      // A consumer callback is outside the rollback region: its exception
      // cannot make a fully committed classroom lose its already-owned assets.
      if (importCommitted) {
        toast.success(t('import.success'), { id: toastId });
        onSuccess?.(importedStageId!);
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
