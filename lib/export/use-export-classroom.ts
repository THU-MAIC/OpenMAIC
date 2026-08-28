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

/** The archive a classroom export produces, ready to save. */
export interface ClassroomExportZip {
  zip: Blob;
  fileName: string;
  inlineFailures: InlineReport['failed'];
}

/**
 * Build the classroom ZIP from one consistent export snapshot.
 *
 * The authoritative document is accessed FIRST: lazy conversion runs there
 * and persists the allocated ids before anything else reads the media rows.
 * The manifest is then built from the working state (the user's intentional
 * unsaved edits) with its legacy references converted in-memory. Because the
 * durable document was converted first, every reference the working state
 * shares with it reuses the same allocated id, so the ZIP carries exactly
 * the rows media collection sees -- a manifest that named the old handles
 * while the archive was keyed by freshly allocated ids would be unusable.
 *
 * Conversion is best-effort on the export path: a failure rolls back the
 * pass's fresh allocations and falls back to the accessed document snapshot,
 * which is always reference-consistent with the media rows.
 *
 * @param deps Document-store dependencies; production callers omit them and
 * the lazy client store is used. Injectable so tests can pin the boundary.
 */
export async function buildClassroomExportZip(
  stage: Stage,
  scenes: Scene[],
  deps: DocumentMigrationDeps = {},
): Promise<ClassroomExportZip> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  // 1. Access the authoritative document and prepare the working scenes.
  const [freshDocument, documentScenes] = await Promise.all([
    accessDocument(stage.id, deps),
    preparePBLScenesForDocumentPersistence(stage.id, scenes),
  ]);
  const latestName = freshDocument.document?.stage.name || stage.name;

  const exportStage = stage;
  const exportScenes = documentScenes;

  let zipBlob: Blob;
  const aggregateReport: InlineReport = { inlined: [], failed: [] };
  try {
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
    const audioEntries = assetManifest.entries.filter((entry) => entry.kind === 'audio');
    const mediaEntries = assetManifest.entries.filter((entry) => entry.kind !== 'audio');

    // 5. Collect referenced audio and generated media.
    const audioFiles = await collectAudioFiles(audioEntries);
    const mediaFiles = await collectMediaFiles(stage.id, mediaEntries);

    // 6. Build audioId → zipPath mapping for manifest
    const audioIdToPath = new Map<string, string>();
    for (const af of audioFiles) {
      audioIdToPath.set(af.record.id, af.zipPath);
    }

    // 6b. Fetch legacy audio URLs that no local row backs. An unconverted
    // document can carry narration only as an audioUrl; the field itself
    // never enters the manifest, so its bytes must.
    const { audioUrlToPath, blobs: legacyAudioBlobs } = await collectLegacyAudioForExport(
      exportScenes,
      audioIdToPath,
    );

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
      if (!audioIdToPath.has(entry.ref)) {
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

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    // 10. Add media blobs to ZIP
    for (const af of audioFiles) {
      zip.file(af.zipPath, af.record.blob);
    }
    for (const legacy of legacyAudioBlobs) {
      zip.file(legacy.zipPath, legacy.blob);
    }
    for (const mf of mediaFiles) {
      zip.file(mf.zipPath, mf.record.blob);
      if (mf.record.poster) {
        zip.file(mf.posterZipPath, mf.record.poster);
      }
    }

    // 11. Generate
    zipBlob = await zip.generateAsync({ type: 'blob' });
  } catch (error) {
    throw error;
  }
  const safeName = latestName.replace(/[\\/:*?"<>|]/g, '_') || 'classroom';
  return {
    zip: zipBlob,
    fileName: `${safeName}${CLASSROOM_ZIP_EXTENSION}`,
    inlineFailures: aggregateReport.failed,
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
      const { zip, fileName, inlineFailures } = await buildClassroomExportZip(stage, scenes);

      saveAs(zip, fileName);

      if (inlineFailures.length > 0) {
        log.warn('Some interactive-scene assets could not be inlined:', inlineFailures);
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
        toast.warning(t('export.inlinePartial', { count: inlineFailures.length }), {
          description: hosts.join(', '),
        });
      }
      toast.success(t('export.exportSuccess'), { id: toastId });
    } catch (error) {
      log.error('Classroom ZIP export failed:', error);
      toast.error(t('export.exportFailed'), { id: toastId });
    } finally {
      setExporting(false);
    }
  }, [t]);

  return { exporting, exportClassroomZip };
}
