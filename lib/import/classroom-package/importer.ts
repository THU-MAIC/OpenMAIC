import { nanoid } from 'nanoid';
import { agentConfigFromManifest, type ManifestScene } from '@/lib/export/classroom-zip-types';
import { rewriteAudioRefsToIds } from '@/lib/export/classroom-zip-utils';
import { canonicalizeLegacyScene, mutateDocument, type AppDocument } from '@/lib/document-store';
import { createLogger } from '@/lib/logger';
import { removeAsset } from '@/lib/media/asset-pool';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import { db } from '@/lib/utils/database';
import {
  completeImportJob,
  failImportJob,
  startImportJob,
  updateImportJob,
  upsertCourseMetadata,
} from '@/lib/workspace';
import {
  ClassroomPackageError,
  type ClassroomPackageProgress,
  type ClassroomPackageScan,
  type ImportClassroomPackageOptions,
  type ImportedClassroomPackage,
} from './types';
import {
  materializePackageAssets,
  rewritePackageSlideMediaRefs,
  rewritePackageVideoManifest,
} from './storage-adapter';

const log = createLogger('ClassroomPackageImporter');

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new ClassroomPackageError('aborted', '课程包导入已取消。');
  }
}

function report(
  options: ImportClassroomPackageOptions,
  phase: ClassroomPackageProgress['phase'],
  progress: number,
  message: string,
) {
  try {
    options.onProgress?.({ phase, progress, message });
  } catch (error) {
    // Persistence must not be rolled back because a view-level progress
    // listener failed. The import history remains the durable status source.
    log.warn('Classroom package progress listener failed:', error);
  }
}

function isQuotaError(error: unknown): boolean {
  return !!error && typeof error === 'object' && /quota/i.test(String((error as Error).name));
}

async function commitClassroomPackage(
  scan: ClassroomPackageScan,
  importJobId: string,
  options: ImportClassroomPackageOptions = {},
): Promise<ImportedClassroomPackage> {
  if (!scan.preview.canImport) {
    throw new ClassroomPackageError(
      'unsupported-format',
      '课程包预检未通过，请先处理报告中的错误。',
    );
  }
  abortIfNeeded(options.signal);
  const { manifest, source } = scan;
  const newStageId = nanoid();
  const now = Date.now();
  const newAgentIds = (manifest.agents ?? []).map(() => nanoid());
  const studentAgentIndex = manifest.agents?.findIndex((agent) => agent.role === 'student') ?? -1;
  const nonTeacherAgentIndex =
    manifest.agents?.findIndex((agent) => agent.role !== 'teacher') ?? -1;
  const fallbackDiscussionAgentIndex =
    studentAgentIndex >= 0
      ? studentAgentIndex
      : nonTeacherAgentIndex >= 0
        ? nonTeacherAgentIndex
        : undefined;
  const offlineStatus =
    scan.preview.offlineLevel === 'network-required'
      ? 'network_required'
      : scan.preview.offlineLevel;
  const sourceKind =
    scan.source.kind === 'zip'
      ? 'imported_zip'
      : scan.source.kind === 'folder'
        ? 'imported_folder'
        : 'library';

  const allocatedAssetIds: string[] = [];
  let documentWritten = false;
  let metadataWritten = false;
  try {
    report(options, 'preparing', 3, '正在写入本地课程资源…');
    await updateImportJob(importJobId, { status: 'writing_media', progress: 3 });
    const assets = await materializePackageAssets(manifest, source, newStageId, now, {
      signal: options.signal,
      limits: scan.limits,
      allocatedAssetIds,
      onProgress: (prepared, total) =>
        report(
          options,
          'preparing',
          5 + (total ? (prepared / total) * 70 : 70),
          `正在准备资源 ${prepared}/${total}`,
        ),
    });

    await updateImportJob(importJobId, { status: 'writing_course', progress: 80 });
    abortIfNeeded(options.signal);

    const importedAgentConfigs: GeneratedAgentConfig[] = (manifest.agents ?? []).map(
      (agent, index) => agentConfigFromManifest(agent, newAgentIds[index]),
    );
    const document: AppDocument = {
      stage: {
        id: newStageId,
        name: manifest.stage.name || '导入的课程',
        description: manifest.stage.description,
        languageDirective: manifest.stage.language,
        style: manifest.stage.style,
        createdAt: manifest.stage.createdAt || now,
        updatedAt: now,
        agentIds: newAgentIds.length ? newAgentIds : undefined,
        ...(manifest.stage.videoManifest
          ? {
              videoManifest: rewritePackageVideoManifest(
                manifest.stage.videoManifest,
                assets.mediaMappings,
              ),
            }
          : {}),
        ...(importedAgentConfigs.length ? { generatedAgentConfigs: importedAgentConfigs } : {}),
      },
      scenes: manifest.scenes.map((scene: ManifestScene, index: number) => {
        const actions = scene.actions
          ? rewriteAudioRefsToIds(scene.actions, assets.audioRefToNewId, {
              agentIds: newAgentIds,
              fallbackDiscussionAgentIndex,
            })
          : undefined;
        const multiAgent = scene.multiAgent?.enabled
          ? {
              enabled: true,
              agentIds: (scene.multiAgent.agentIndices ?? [])
                .map((agentIndex) => newAgentIds[agentIndex])
                .filter(Boolean),
              directorPrompt: scene.multiAgent.directorPrompt,
            }
          : undefined;
        const content =
          scene.content.type === 'slide'
            ? {
                ...scene.content,
                canvas: rewritePackageSlideMediaRefs(scene.content.canvas, assets.mediaMappings),
              }
            : scene.content;
        return canonicalizeLegacyScene({
          id: nanoid(),
          stageId: newStageId,
          title: scene.title || `场景 ${index + 1}`,
          order: scene.order ?? index,
          content,
          actions,
          whiteboards: scene.whiteboards?.map((slide) =>
            rewritePackageSlideMediaRefs(slide, assets.mediaMappings),
          ),
          multiAgent,
          createdAt: now,
          updatedAt: now,
        });
      }),
    };

    report(options, 'writing', 82, '正在提交课程文档…');
    // v0.3.2's aggregate document write is the course-content commit point.
    // Assets live in another database and are compensated below until the
    // workspace metadata and durable import history are also complete.
    await mutateDocument(newStageId, async (_existing, store) => store.saveDocument(document));
    documentWritten = true;
    await updateImportJob(importJobId, { status: 'writing_course', progress: 92 });
    abortIfNeeded(options.signal);

    await upsertCourseMetadata(newStageId, {
      kind: 'original',
      source: {
        kind: sourceKind,
        sourceName: scan.preview.packageName,
        importJobId,
        formatVersion: scan.preview.formatVersion,
        importedAt: now,
      },
      offlineStatus,
      offlineIssueCount:
        scan.preview.missingResources.length + scan.preview.externalResources.length,
    });
    metadataWritten = true;
    const title = document.stage.name;
    await completeImportJob(importJobId, newStageId, {
      detectedTitle: title,
      formatVersion: scan.preview.formatVersion,
      offlineStatus,
      warnings: scan.preview.issues
        .filter((issue) => issue.severity === 'warning')
        .map(({ code, message, path }) => ({ code, message, path })),
    });

    report(options, 'done', 100, '课程已保存到本地');
    return {
      importJobId,
      stageId: newStageId,
      title,
      sceneCount: document.scenes.length,
      mediaCount: assets.mediaCount,
      audioCount: assets.audioCount,
    };
  } catch (error) {
    const cleanup = async (label: string, operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (cleanupError) {
        log.error(`Failed to undo imported ${label}:`, cleanupError);
      }
    };

    // All cleanup operations are idempotent, so also attempt document removal
    // after a failed save in case a configured remote store committed before
    // its response was interrupted.
    await cleanup('document', () =>
      mutateDocument(newStageId, async (_document, store) => store.deleteDocument(newStageId)),
    );
    if (metadataWritten || documentWritten) {
      await cleanup('workspace metadata', () => db.courseMetadata.delete(newStageId));
    }
    await cleanup('generated media mirror rows', () =>
      db.mediaFiles.where('stageId').equals(newStageId).delete(),
    );
    await cleanup('audio mirror rows', () =>
      db.audioFiles.where('stageId').equals(newStageId).delete(),
    );
    for (const assetId of [...new Set(allocatedAssetIds)].reverse()) {
      await cleanup(`asset pool entry ${assetId}`, () => removeAsset(assetId));
    }

    if (error instanceof ClassroomPackageError) throw error;
    const quota = isQuotaError(error);
    throw new ClassroomPackageError(
      quota ? 'storage-full' : 'import-failed',
      quota ? '本地存储空间不足，课程没有被导入。' : '写入本地课程库失败，未保留半成品。',
      error,
    );
  }
}

/**
 * Commit a preflighted package and keep a durable workspace import record.
 * The history entry starts only after the teacher confirms the preview, so
 * opening and cancelling a preview does not create noisy "failed" imports.
 */
export async function importClassroomPackage(
  scan: ClassroomPackageScan,
  options: ImportClassroomPackageOptions = {},
): Promise<ImportedClassroomPackage> {
  const sourceType =
    scan.source.kind === 'zip' ? 'zip' : scan.source.kind === 'folder' ? 'folder' : 'library';
  const job = await startImportJob({
    sourceType,
    sourceName: scan.preview.packageName,
    sourceSize:
      scan.source.kind === 'zip' ? scan.preview.compressedBytes : scan.preview.uncompressedBytes,
    detectedTitle: scan.preview.title,
    formatVersion: scan.preview.formatVersion,
    status: 'writing_media',
  });

  try {
    return await commitClassroomPackage(scan, job.id, options);
  } catch (error) {
    try {
      await failImportJob(job.id, error instanceof Error ? error : String(error));
    } catch {
      // Preserve the original import failure when recording the failure also
      // fails (for example, because the browser storage quota is exhausted).
    }
    throw error;
  }
}
