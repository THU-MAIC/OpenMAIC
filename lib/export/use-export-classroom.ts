'use client';

import { useState, useCallback } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  CLASSROOM_ZIP_FORMAT_VERSION,
  CLASSROOM_ZIP_EXTENSION,
  manifestAgentFromConfig,
  type ClassroomManifest,
  type ManifestStage,
  type ManifestAgent,
  type ManifestScene,
  type MediaIndexEntry,
} from './classroom-zip-types';
import {
  collectAudioFiles,
  collectedAudioMediaIndexEntry,
  collectedMediaIndexEntry,
  collectMediaFiles,
  collectVideoPosters,
  actionsToManifest,
  audioArchivePath,
  collectLegacyAudioForExport,
  legacyAudioMediaIndexEntry,
} from './classroom-zip-utils';
import { createLogger } from '@/lib/logger';
import { buildStageAssetManifest } from '@/lib/media/asset-manifest';
import {
  inlineHtmlAssets,
  createAssetFetcher,
  type InlineOptions,
  type InlineReport,
} from './inline-assets';
import { createProxiedFetch } from './proxied-fetch';
import type { SceneContent, Scene, Stage } from '@/lib/types/stage';
import { preparePBLScenesForDocumentPersistence } from '@/lib/pbl/v2/runtime/document-persistence';
import { accessDocument, type DocumentMigrationDeps } from '@/lib/document-store';

export async function inlineSceneContent(
  content: SceneContent,
  options?: InlineOptions,
): Promise<{ content: SceneContent; report: InlineReport }> {
  if (content?.type !== 'interactive' || !('html' in content) || !content.html) {
    return { content, report: { inlined: [], failed: [] } };
  }
  const { html, report } = await inlineHtmlAssets(content.html, options);
  return { content: { ...content, html }, report };
}

const log = createLogger('ExportClassroom');

/**
 * One consistent export snapshot of a classroom: the portable manifest plus
 * the bytes of every payload it names. Both the `.maic.zip` archive and the
 * standalone HTML export are serialized from this one structure, so the two
 * formats cannot drift apart.
 */
export interface ClassroomExportSnapshot {
  manifest: ClassroomManifest;
  /**
   * Archive path → bytes, for every collected payload (narration, generated
   * media, and generated-video posters). Keys match `manifest.mediaIndex`,
   * except the archive paths of captured video posters.
   */
  files: Map<string, Blob>;
  /** Video source ref → the poster frame captured for that video, when one exists. */
  videoPosters: Map<string, Blob>;
  /** Stage name as the authoritative document holds it. */
  stageName: string;
  inlineFailures: InlineReport['failed'];
  missingAudioCount: number;
}

/** What a snapshot collects; every payload is collected by default. */
export interface ClassroomExportSnapshotOptions {
  /** Collect narration audio: stored rows and legacy audio URLs. */
  audio?: boolean;
  /**
   * Collect video bytes. When false, generated videos contribute only the
   * poster frame captured for them; posters referenced by elements are images
   * and are always collected.
   */
  videoBytes?: boolean;
}

/** The archive a classroom export produces, ready to save. */
export interface ClassroomExportZip {
  zip: Blob;
  fileName: string;
  inlineFailures: InlineReport['failed'];
  missingAudioCount: number;
}

/** File-system-safe base name for an exported classroom. */
export function classroomExportBaseName(stageName: string): string {
  return stageName.replace(/[\\/:*?"<>|]/g, '_') || 'classroom';
}

/**
 * Build one consistent classroom export snapshot.
 *
 * The authoritative document is accessed FIRST: lazy conversion runs there
 * and persists the allocated ids before anything else reads the media rows.
 * The manifest is then built from the working state (the user's intentional
 * unsaved edits) with its legacy references converted in-memory. Because the
 * durable document was converted first, every reference the working state
 * shares with it reuses the same allocated id, so the export carries exactly
 * the rows media collection sees -- a manifest that named the old handles
 * while the payloads were keyed by freshly allocated ids would be unusable.
 *
 * Conversion is best-effort on the export path: a failure rolls back the
 * pass's fresh allocations and falls back to the accessed document snapshot,
 * which is always reference-consistent with the media rows.
 *
 * @param deps Document-store dependencies; production callers omit them and
 * the lazy client store is used. Injectable so tests can pin the boundary.
 * @param options Payloads to leave out, for formats that do not carry them.
 * The manifest then names no path for them (skipped narration is not reported
 * missing either).
 */
export async function buildClassroomExportSnapshot(
  stage: Stage,
  scenes: Scene[],
  deps: DocumentMigrationDeps = {},
  options: ClassroomExportSnapshotOptions = {},
): Promise<ClassroomExportSnapshot> {
  const includeAudio = options.audio !== false;
  const includeVideoBytes = options.videoBytes !== false;

  // 1. Access the authoritative document and prepare the working scenes.
  const [freshDocument, documentScenes] = await Promise.all([
    accessDocument(stage.id, deps),
    preparePBLScenesForDocumentPersistence(stage.id, scenes),
  ]);
  const latestName = freshDocument.document?.stage.name || stage.name;

  const exportStage = stage;
  const exportScenes = documentScenes;

  let missingAudioCount = 0;
  const aggregateReport: InlineReport = { inlined: [], failed: [] };

  // 3. Collect the roster from the in-memory stage (single source of truth;
  // the in-memory stage already carries any lazily migrated voice fields).
  const agentConfigs = exportStage.generatedAgentConfigs ?? stage.generatedAgentConfigs ?? [];

  // 4. Enumerate exactly the references in the converted export snapshot.
  // Both collectors take their reference sets from this manifest, so orphan
  // compatibility rows do not ride into the archive.
  // Classroom ZIP v1 has never serialized Stage.whiteboard. Exclude those
  // refs here: archiving their bytes would create an unreconstructable,
  // permanently orphaned payload on import. Scene whiteboards remain part of
  // the portable manifest and are still collected.
  const assetManifest = await buildStageAssetManifest(exportStage, exportScenes, stage.id, {
    includeStageWhiteboard: false,
  });
  const audioEntries = includeAudio
    ? assetManifest.entries.filter((entry) => entry.kind === 'audio')
    : [];
  const mediaEntries = assetManifest.entries.filter(
    (entry) => entry.kind !== 'audio' && (includeVideoBytes || entry.kind !== 'video'),
  );
  const posterOnlyVideoEntries = includeVideoBytes
    ? []
    : assetManifest.entries.filter((entry) => entry.kind === 'video');

  // 5. Collect referenced audio and generated media.
  const audioFiles = includeAudio ? await collectAudioFiles(audioEntries) : [];
  const mediaFiles = await collectMediaFiles(stage.id, mediaEntries);
  const posterOnlyVideos = includeVideoBytes
    ? []
    : await collectVideoPosters(stage.id, posterOnlyVideoEntries);

  // 6. Build audioId → zipPath mapping for manifest
  const audioIdToPath = new Map<string, string>();
  for (const af of audioFiles) {
    audioIdToPath.set(af.record.id, af.zipPath);
  }

  // 6b. Fetch legacy audio URLs that no local row backs. An unconverted
  // document can carry narration only as an audioUrl; the field itself
  // never enters the manifest, so its bytes must.
  const {
    audioUrlToPath,
    blobs: legacyAudioBlobs,
    fullyRescuedAudioIds,
  } = includeAudio
    ? await collectLegacyAudioForExport(exportScenes, audioIdToPath)
    : {
        audioUrlToPath: new Map<string, string>(),
        blobs: [],
        fullyRescuedAudioIds: new Set<string>(),
      };

  // 7. Build manifest
  const manifestStage: ManifestStage = {
    name: latestName,
    description: exportStage.description,
    language: exportStage.languageDirective,
    style: exportStage.style,
    videoManifest: exportStage.videoManifest,
    createdAt: exportStage.createdAt,
    updatedAt: exportStage.updatedAt,
  };

  const manifestAgents: ManifestAgent[] = agentConfigs.map(manifestAgentFromConfig);

  // Build agent ID → index mapping for multiAgent references
  const agentIdToIndex = new Map<string, number>();
  agentConfigs.forEach((a, i) => agentIdToIndex.set(a.id, i));

  const sharedFetcher = createAssetFetcher({ fetchImpl: createProxiedFetch() });
  const manifestScenes: ManifestScene[] = await Promise.all(
    exportScenes.map(async (scene) => {
      const { content, report } = await inlineSceneContent(scene.content, {
        fetcher: sharedFetcher,
      });
      for (const u of report.inlined)
        if (!aggregateReport.inlined.includes(u)) aggregateReport.inlined.push(u);
      for (const f of report.failed)
        if (!aggregateReport.failed.some((g) => g.url === f.url)) aggregateReport.failed.push(f);
      return {
        type: scene.type,
        title: scene.title,
        order: scene.order,
        content,
        actions: scene.actions
          ? actionsToManifest(scene.actions, audioIdToPath, agentIdToIndex, audioUrlToPath)
          : undefined,
        whiteboards: scene.whiteboards,
        ...(scene.multiAgent?.enabled
          ? {
              multiAgent: {
                enabled: true,
                agentIndices: (scene.multiAgent.agentIds ?? [])
                  .map((id) => agentIdToIndex.get(id))
                  .filter((i): i is number => i !== undefined),
                directorPrompt: scene.multiAgent.directorPrompt,
              },
            }
          : {}),
      };
    }),
  );

  // 8. Build mediaIndex
  const mediaIndexEntries: Array<[string, MediaIndexEntry]> = [];

  for (const af of audioFiles) {
    mediaIndexEntries.push([af.zipPath, collectedAudioMediaIndexEntry(af)]);
  }
  for (const legacy of legacyAudioBlobs) {
    mediaIndexEntries.push([legacy.zipPath, legacyAudioMediaIndexEntry(legacy)]);
  }
  for (const mf of mediaFiles) {
    mediaIndexEntries.push([mf.zipPath, collectedMediaIndexEntry(mf)]);
  }

  // Referenced audio whose bytes resolved nowhere is reported as missing.
  // Legacy audioUrl-only narration is outside the standardized manifest and
  // is handled by collectLegacyAudioForExport above.
  for (const [index, entry] of audioEntries.entries()) {
    if (!audioIdToPath.has(entry.ref) && !fullyRescuedAudioIds.has(entry.ref)) {
      missingAudioCount += 1;
      mediaIndexEntries.push([
        audioArchivePath(index, 'mp3'),
        {
          type: 'audio',
          sourceRef: entry.ref,
          missing: true,
        },
      ]);
    }
  }
  const mediaIndex = Object.fromEntries(mediaIndexEntries);

  // 9. Assemble manifest
  const manifest: ClassroomManifest = {
    formatVersion: CLASSROOM_ZIP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: process.env.npm_package_version || '0.0.0',
    stage: manifestStage,
    agents: manifestAgents,
    scenes: manifestScenes,
    mediaIndex,
  };

  // 10. Gather the payload bytes
  const files = new Map<string, Blob>();
  const videoPosters = new Map<string, Blob>();
  for (const af of audioFiles) {
    files.set(af.zipPath, af.record.blob);
  }
  for (const legacy of legacyAudioBlobs) {
    files.set(legacy.zipPath, legacy.blob);
  }
  for (const mf of mediaFiles) {
    files.set(mf.zipPath, mf.record.blob);
    if (mf.record.poster) {
      files.set(mf.posterZipPath, mf.record.poster);
      videoPosters.set(mf.sourceRef, mf.record.poster);
    }
  }
  for (const video of posterOnlyVideos) {
    videoPosters.set(video.sourceRef, video.poster);
  }

  return {
    manifest,
    files,
    videoPosters,
    stageName: latestName,
    inlineFailures: aggregateReport.failed,
    missingAudioCount,
  };
}

/**
 * Build the classroom ZIP from one consistent export snapshot
 * ({@link buildClassroomExportSnapshot}).
 */
export async function buildClassroomExportZip(
  stage: Stage,
  scenes: Scene[],
  deps: DocumentMigrationDeps = {},
): Promise<ClassroomExportZip> {
  const JSZip = (await import('jszip')).default;
  const snapshot = await buildClassroomExportSnapshot(stage, scenes, deps);

  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(snapshot.manifest, null, 2));
  for (const [path, blob] of snapshot.files) {
    zip.file(path, blob);
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' });

  return {
    zip: zipBlob,
    fileName: `${classroomExportBaseName(snapshot.stageName)}${CLASSROOM_ZIP_EXTENSION}`,
    inlineFailures: snapshot.inlineFailures,
    missingAudioCount: snapshot.missingAudioCount,
  };
}

export function useExportClassroom() {
  const [exporting, setExporting] = useState(false);
  const { t } = useI18n();

  const exportClassroomZip = useCallback(async () => {
    const { stage, scenes } = useStageStore.getState();
    if (!stage?.id || scenes.length === 0) return;

    setExporting(true);
    const toastId = toast.loading(t('export.exporting'));

    try {
      const { zip, fileName, inlineFailures, missingAudioCount } = await buildClassroomExportZip(
        stage,
        scenes,
      );

      saveAs(zip, fileName);

      const partialCount = inlineFailures.length + missingAudioCount;
      if (partialCount > 0) {
        log.warn('Some referenced assets could not be bundled:', {
          inlineFailures,
          missingAudioCount,
        });
        const hosts = [
          ...new Set(
            inlineFailures.map((f) => {
              try {
                return new URL(f.url).host;
              } catch {
                return f.url;
              }
            }),
          ),
        ];
        toast.warning(t('export.inlinePartial', { count: partialCount }), {
          id: toastId,
          description: hosts.length > 0 ? hosts.join(', ') : undefined,
        });
      } else {
        toast.success(t('export.exportSuccess'), { id: toastId });
      }
    } catch (error) {
      log.error('Classroom ZIP export failed:', error);
      toast.error(t('export.exportFailed'), { id: toastId });
    } finally {
      setExporting(false);
    }
  }, [t]);

  return { exporting, exportClassroomZip };
}
