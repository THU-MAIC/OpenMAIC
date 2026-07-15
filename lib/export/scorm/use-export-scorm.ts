'use client';

// lib/export/scorm/use-export-scorm.ts
//
// SCORM 1.2 export orchestrator (whole-course package). The heavy lifting —
// slide snapshots, audio collection, interactive asset inlining and ZIP
// assembly — lives in `scorm-core.ts`, shared with the LearnWorlds
// per-activity bundle flow.
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
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { db } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';
import { preparePBLScenesForDocumentPersistence } from '@/lib/pbl/v2/runtime/document-persistence';
import { SCORM_PACKAGE_EXTENSION } from './scorm-types';
import { sanitizeFileName } from './scorm-utils';
import { buildScormScenePayloads, assembleScormZip } from './scorm-core';

const log = createLogger('ExportScorm');

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
      // 1. Fresh course metadata + PBL scenes normalized for persistence
      //    (strips ephemeral learner runtime state, same as classroom ZIP).
      const freshStage = await db.stages.get(stage.id);
      const courseTitle = freshStage?.name || stage.name || 'course';
      const documentScenes = await preparePBLScenesForDocumentPersistence(stage.id, scenes);
      const orderedScenes = [...documentScenes].sort((a, b) => a.order - b.order);

      // 2. Prepare portable payloads (snapshots, audio, inlined assets).
      const { payloads, inlineReport } = await buildScormScenePayloads(orderedScenes);

      // 3. Assemble + download the single whole-course package.
      const zipBlob = await assembleScormZip({
        course: {
          title: courseTitle,
          ...(stage.description ? { description: stage.description } : {}),
          ...(stage.languageDirective ? { language: stage.languageDirective } : {}),
        },
        payloads,
      });
      saveAs(zipBlob, `${sanitizeFileName(courseTitle)}${SCORM_PACKAGE_EXTENSION}`);

      if (inlineReport.failed.length > 0) {
        log.warn('Some interactive-scene assets could not be inlined:', inlineReport.failed);
        const hosts = [
          ...new Set(
            inlineReport.failed.map((f) => {
              try {
                return new URL(f.url).host;
              } catch {
                return f.url;
              }
            }),
          ),
        ];
        toast.warning(t('export.inlinePartial', { count: inlineReport.failed.length }), {
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
