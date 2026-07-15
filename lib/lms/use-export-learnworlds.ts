'use client';

// lib/lms/use-export-learnworlds.ts
//
// "Export to LearnWorlds" orchestrator. Combines two steps:
//   1. Publish the course structure (course + sections) to the user's
//      LearnWorlds school through the Learnworlds-MCP server, proxied by
//      the /api/lms/learnworlds route.
//   2. Generate and download the SCORM package locally (reusing the SCORM
//      export pipeline) so the user can upload it as a SCORM unit — the
//      LearnWorlds public API does not support SCORM file uploads.
//
// Follows the same client-hook pattern as `useExportScorm`.

import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { useExportScorm } from '@/lib/export/scorm/use-export-scorm';
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
  const { exportScorm } = useExportScorm();

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
      // 1. Build the publish payload from the current course structure.
      const courseTitle = stage.name || 'OpenMAIC Course';
      const payload: LearnWorldsPublishPayload = {
        title: courseTitle,
        titleId: buildTitleId(courseTitle),
        description: stage.description || '',
        access: 'draft',
        sections: [...scenes]
          .sort((a, b) => a.order - b.order)
          .map((scene) => ({ title: scene.title, kind: scene.content.type })),
      };

      // 2. Publish structure via the MCP-backed API route.
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
      const successMessage =
        result.sectionsFailed > 0
          ? t('export.learnworldsPartial', { failed: result.sectionsFailed })
          : t('export.learnworldsSuccess', { sections: result.sectionsCreated });

      toast.success(successMessage, {
        id: toastId,
        duration: 15000,
        description: t('export.learnworldsUploadHint'),
        ...(result.adminUrl
          ? {
              action: {
                label: t('export.learnworldsOpenAdmin'),
                onClick: () => window.open(result.adminUrl, '_blank', 'noopener'),
              },
            }
          : {}),
      });
      if (result.warnings.length > 0) {
        log.warn('LearnWorlds publish warnings:', result.warnings);
      }

      // 3. Generate + download the SCORM package for manual upload.
      await exportScorm();
    } catch (error) {
      log.error('LearnWorlds export failed:', error);
      toast.error(t('export.learnworldsFailed'), { id: toastId });
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  }, [t, exportScorm]);

  return { publishing, exportToLearnWorlds };
}
