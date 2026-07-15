'use client';

// lib/lms/use-export-learnworlds.ts
//
// "Export to LearnWorlds" orchestrator. Combines three steps:
//   1. Prepare the portable SCORM payloads ONCE (snapshots, audio,
//      interactive asset inlining) via the shared scorm-core pipeline.
//   2. Publish the course structure (course + sections) to the user's
//      LearnWorlds school through the Learnworlds-MCP server, proxied by
//      the /api/lms/learnworlds route. Each section description references
//      the exact SCORM file to upload, since the LearnWorlds public API has
//      no endpoint to create learning units or upload files.
//   3. Assemble and download the LearnWorlds bundle: one SCORM mini-package
//      per activity (numbered 1:1 with the sections) + the whole-course
//      package + a README mapping files to sections.
//
// Follows the same client-hook pattern as `useExportScorm`.

import { useState, useCallback, useRef } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/utils/database';
import { preparePBLScenesForDocumentPersistence } from '@/lib/pbl/v2/runtime/document-persistence';
import { buildScormScenePayloads } from '@/lib/export/scorm/scorm-core';
import {
  buildLearnWorldsBundle,
  activityPackageFileName,
  type LearnWorldsBundleStrings,
} from './learnworlds-bundle';
import type { LearnWorldsPublishPayload, LearnWorldsPublishResult } from './types';
import { validateLearnWorldsConfig } from './types';

const log = createLogger('ExportLearnWorlds');

/** Build a LearnWorlds-safe titleId slug from the course title. */
export function buildTitleId(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const suffix = Date.now().toString(36).slice(-4);
  return slug ? `${slug}-${suffix}` : `openmaic-course-${suffix}`;
}

export function useExportLearnWorlds() {
  const [publishing, setPublishing] = useState(false);
  const publishingRef = useRef(false);
  const { t } = useI18n();

  const exportToLearnWorlds = useCallback(async () => {
    const { stage, scenes } = useStageStore.getState();
    const config = useSettingsStore.getState().learnWorldsConfig;
    if (!stage?.id || scenes.length === 0 || publishingRef.current) return;

    if (!config.enabled || validateLearnWorldsConfig(config).length > 0) {
      toast.error(t('export.learnworldsNotConfigured'));
      return;
    }

    publishingRef.current = true;
    setPublishing(true);
    const toastId = toast.loading(t('export.learnworldsPublishing'));

    try {
      // 1. Prepare portable payloads once (snapshots, audio, inlined assets).
      const freshStage = await db.stages.get(stage.id);
      const courseTitle = freshStage?.name || stage.name || 'OpenMAIC Course';
      const documentScenes = await preparePBLScenesForDocumentPersistence(stage.id, scenes);
      const orderedScenes = [...documentScenes].sort((a, b) => a.order - b.order);
      const { payloads, inlineReport } = await buildScormScenePayloads(orderedScenes);

      const kindLabels: LearnWorldsBundleStrings['kindLabels'] = {
        slide: t('export.activityKindSlide'),
        quiz: t('export.activityKindQuiz'),
        interactive: t('export.activityKindInteractive'),
        pbl: t('export.activityKindPbl'),
      };

      // 2. Publish structure via the MCP-backed API route. Every section
      //    description tells the author exactly which SCORM file to upload.
      const payload: LearnWorldsPublishPayload = {
        title: courseTitle,
        titleId: buildTitleId(courseTitle),
        description: stage.description || '',
        access: 'draft',
        sections: payloads.map((p, i) => ({
          title: p.scene.title,
          kind: p.scene.kind,
          description: t('export.learnworldsSectionDesc', {
            type: kindLabels[p.scene.kind],
            file: activityPackageFileName(i, p.scene.title),
          }),
        })),
      };

      const res = await fetch('/api/lms/learnworlds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'publish', config, course: payload }),
      });
      const data = (await res.json()) as {
        success: boolean;
        result?: LearnWorldsPublishResult;
        error?: string;
      };

      if (!data.success || !data.result?.ok) {
        const errorDetail = data.result?.error || data.error || 'Unknown error';
        log.error('LearnWorlds publish failed:', errorDetail);
        toast.error(t('export.learnworldsFailed'), {
          id: toastId,
          description: errorDetail.slice(0, 200),
        });
        return;
      }

      const result = data.result;
      if (result.warnings.length > 0) {
        log.warn('LearnWorlds publish warnings:', result.warnings);
      }

      // 3. Assemble + download the per-activity bundle.
      toast.loading(t('export.learnworldsBundling'), { id: toastId });
      const bundle = await buildLearnWorldsBundle({
        course: {
          title: courseTitle,
          ...(stage.description ? { description: stage.description } : {}),
          ...(stage.languageDirective ? { language: stage.languageDirective } : {}),
        },
        payloads,
        strings: {
          readmeTitle: t('export.learnworldsReadmeTitle'),
          readmeIntro: t('export.learnworldsReadmeIntro'),
          readmeSectionHeader: t('export.learnworldsReadmeSection'),
          readmeTypeHeader: t('export.learnworldsReadmeType'),
          readmeFileHeader: t('export.learnworldsReadmeFile'),
          readmeFullCourseNote: t('export.learnworldsReadmeFullCourse'),
          kindLabels,
        },
      });
      saveAs(bundle.blob, bundle.fileName);

      if (inlineReport.failed.length > 0) {
        log.warn('Some interactive-scene assets could not be inlined:', inlineReport.failed);
        toast.warning(t('export.inlinePartial', { count: inlineReport.failed.length }));
      }

      const successMessage =
        result.sectionsFailed > 0
          ? t('export.learnworldsPartial', { failed: result.sectionsFailed })
          : t('export.learnworldsSuccess', { sections: result.sectionsCreated });

      toast.success(successMessage, {
        id: toastId,
        duration: 15000,
        description: t('export.learnworldsBundleHint', { count: bundle.entries.length }),
        ...(result.adminUrl
          ? {
              action: {
                label: t('export.learnworldsOpenAdmin'),
                onClick: () => window.open(result.adminUrl, '_blank', 'noopener'),
              },
            }
          : {}),
      });
    } catch (error) {
      log.error('LearnWorlds export failed:', error);
      toast.error(t('export.learnworldsFailed'), { id: toastId });
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  }, [t]);

  return { publishing, exportToLearnWorlds };
}
