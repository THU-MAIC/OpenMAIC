'use client';

// lib/export/scorm/use-export-scorm.ts
//
// SCORM 1.2 export orchestrator. Follows the same client-hook pattern as
// `useExportClassroom` / `useExportPPTX`: gather state from the stage store,
// collect binary media from IndexedDB, assemble the package with JSZip and
// hand it to FileSaver.
//
// Package layout (see SDD "Exportación SCORM"):
//   imsmanifest.xml     SCORM 1.2 manifest (single SCO)
//   index.html          embedded player entry point
//   css/, js/           player assets
//   data/course.json    portable course payload (ScormCourseData)
//   slides/*.png        pre-rendered slide snapshots
//   audio/*             narration audio blobs
//   interactive/*.html  asset-inlined interactive pages

import { useState, useCallback, useRef } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { slideToPng } from '@openmaic/renderer/snapshot';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { db } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';
import { preparePBLScenesForDocumentPersistence } from '@/lib/pbl/v2/runtime/document-persistence';
import type { Scene, SlideContent, QuizContent, PBLContent } from '@/lib/types/stage';
import { inlineHtmlAssets, createAssetFetcher, type InlineReport } from '../inline-assets';
import { createProxiedFetch } from '../proxied-fetch';
import {
  SCORM_FORMAT_VERSION,
  SCORM_PACKAGE_EXTENSION,
  type ScormCourseData,
  type ScormScene,
} from './scorm-types';
import { buildImsManifest } from './scorm-manifest';
import { SCORM_PLAYER_FILES } from './scorm-player-template';
import {
  sceneFileStem,
  buildTranscript,
  sceneAudioIds,
  quizToScormQuestions,
  pblSummary,
  audioExtension,
  buildPackageIdentifier,
  sanitizeFileName,
} from './scorm-utils';
import { resolveSlideMedia } from './scorm-slide-resolver';

const log = createLogger('ExportScorm');

/** Default passing score (%) reported to the LMS via adlcp:masteryscore. */
const DEFAULT_MASTERY_SCORE = 60;

/** Snapshot output width in px — 1600 keeps text crisp at typical LMS sizes. */
const SNAPSHOT_WIDTH = 1600;

interface CollectedScormAudio {
  zipPath: string;
  blob: Blob;
}

export function useExportScorm() {
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const { t } = useI18n();

  const exportScorm = useCallback(async () => {
    const { stage, scenes } = useStageStore.getState();
    if (!stage?.id || scenes.length === 0 || exportingRef.current) return;

    exportingRef.current = true;
    setExporting(true);
    const toastId = toast.loading(t('export.exporting'));

    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      // 1. Fresh course metadata + PBL scenes normalized for persistence
      //    (strips ephemeral learner runtime state, same as classroom ZIP).
      const freshStage = await db.stages.get(stage.id);
      const courseTitle = freshStage?.name || stage.name || 'course';
      const documentScenes = await preparePBLScenesForDocumentPersistence(stage.id, scenes);
      const orderedScenes = [...documentScenes].sort((a, b) => a.order - b.order);

      // 2. Collect narration audio per scene (blobs from IndexedDB).
      const audioIdToPath = new Map<string, string>();
      const collectedAudio: CollectedScormAudio[] = [];
      for (const scene of orderedScenes) {
        for (const audioId of sceneAudioIds(scene)) {
          if (audioIdToPath.has(audioId)) continue;
          const record = await db.audioFiles.get(audioId);
          if (!record) continue;
          const zipPath = `audio/${audioId}.${audioExtension(record.format)}`;
          audioIdToPath.set(audioId, zipPath);
          collectedAudio.push({ zipPath, blob: record.blob });
        }
      }

      // 3. Transform scenes → portable SCORM scenes, rendering snapshots and
      //    inlining interactive assets along the way.
      const sharedFetcher = createAssetFetcher({ fetchImpl: createProxiedFetch() });
      const aggregateReport: InlineReport = { inlined: [], failed: [] };
      const scormScenes: ScormScene[] = [];
      const extraFiles: { path: string; data: Blob | string }[] = [];

      for (let i = 0; i < orderedScenes.length; i++) {
        const scene = orderedScenes[i] as Scene;
        const stem = sceneFileStem(i, scene.title);
        const transcript = buildTranscript(scene);
        const audioPaths = sceneAudioIds(scene)
          .map((id) => audioIdToPath.get(id))
          .filter((p): p is string => !!p);

        if (scene.content.type === 'slide') {
          const canvas = resolveSlideMedia((scene.content as SlideContent).canvas);
          const imagePath = `slides/${stem}.png`;
          try {
            const png = (await slideToPng(canvas, {
              width: SNAPSHOT_WIDTH,
              pixelRatio: 1,
              format: 'blob',
            })) as Blob;
            extraFiles.push({ path: imagePath, data: png });
          } catch (err) {
            log.warn(`Slide snapshot failed for scene "${scene.title}":`, err);
            // Ship a 1×1 transparent PNG placeholder so the player never 404s.
            extraFiles.push({ path: imagePath, data: TRANSPARENT_PNG_BLOB() });
          }
          scormScenes.push({
            kind: 'slide',
            title: scene.title,
            order: scene.order,
            imagePath,
            ...(transcript ? { transcript } : {}),
            ...(audioPaths.length ? { audioPaths } : {}),
          });
        } else if (scene.content.type === 'quiz') {
          scormScenes.push({
            kind: 'quiz',
            title: scene.title,
            order: scene.order,
            questions: quizToScormQuestions(scene.content as QuizContent),
          });
        } else if (scene.content.type === 'interactive') {
          let htmlPath: string | undefined;
          if (scene.content.html) {
            const { html, report } = await inlineHtmlAssets(scene.content.html, {
              fetcher: sharedFetcher,
            });
            for (const u of report.inlined)
              if (!aggregateReport.inlined.includes(u)) aggregateReport.inlined.push(u);
            for (const f of report.failed)
              if (!aggregateReport.failed.some((g) => g.url === f.url))
                aggregateReport.failed.push(f);
            htmlPath = `interactive/${stem}.html`;
            extraFiles.push({ path: htmlPath, data: html });
          }
          scormScenes.push({
            kind: 'interactive',
            title: scene.title,
            order: scene.order,
            ...(htmlPath ? { htmlPath } : {}),
            ...(scene.content.url ? { url: scene.content.url } : {}),
            ...(transcript ? { transcript } : {}),
            ...(audioPaths.length ? { audioPaths } : {}),
          });
        } else if (scene.content.type === 'pbl') {
          scormScenes.push({
            kind: 'pbl',
            title: scene.title,
            order: scene.order,
            ...(pblSummary(scene.content as PBLContent)
              ? { summary: pblSummary(scene.content as PBLContent) }
              : {}),
            ...(transcript ? { transcript } : {}),
          });
        }
      }

      // 4. Assemble course.json.
      const courseData: ScormCourseData = {
        formatVersion: SCORM_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        appVersion: process.env.npm_package_version || '0.0.0',
        course: {
          title: courseTitle,
          ...(stage.description ? { description: stage.description } : {}),
          ...(stage.languageDirective ? { language: stage.languageDirective } : {}),
        },
        masteryScore: DEFAULT_MASTERY_SCORE,
        scenes: scormScenes,
      };

      // 5. Assemble the ZIP: player, manifest, data, media.
      for (const [path, content] of Object.entries(SCORM_PLAYER_FILES)) {
        zip.file(path, content);
      }
      zip.file('data/course.json', JSON.stringify(courseData, null, 2));
      for (const f of extraFiles) zip.file(f.path, f.data);
      for (const af of collectedAudio) zip.file(af.zipPath, af.blob);

      const resourceFiles = [
        ...Object.keys(SCORM_PLAYER_FILES),
        'data/course.json',
        ...extraFiles.map((f) => f.path),
        ...collectedAudio.map((a) => a.zipPath),
      ];
      zip.file(
        'imsmanifest.xml',
        buildImsManifest({
          identifier: buildPackageIdentifier(courseTitle),
          title: courseTitle,
          description: stage.description,
          resourceFiles,
          masteryScore: DEFAULT_MASTERY_SCORE,
        }),
      );

      // 6. Generate + download.
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      saveAs(zipBlob, `${sanitizeFileName(courseTitle)}${SCORM_PACKAGE_EXTENSION}`);

      if (aggregateReport.failed.length > 0) {
        log.warn('Some interactive-scene assets could not be inlined:', aggregateReport.failed);
        const hosts = [
          ...new Set(
            aggregateReport.failed.map((f) => {
              try {
                return new URL(f.url).host;
              } catch {
                return f.url;
              }
            }),
          ),
        ];
        toast.warning(t('export.inlinePartial', { count: aggregateReport.failed.length }), {
          description: hosts.join(', '),
        });
      }
      toast.success(t('export.exportSuccess'), { id: toastId });
    } catch (error) {
      log.error('SCORM export failed:', error);
      toast.error(t('export.exportFailed'), { id: toastId });
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }, [t]);

  return { exporting, exportScorm };
}

/** 1×1 transparent PNG used as a snapshot fallback. */
function TRANSPARENT_PNG_BLOB(): Blob {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: 'image/png' });
}
