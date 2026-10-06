'use client';

import { useState, useCallback } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import {
  STANDALONE_PLAYER_STRING_KEYS,
  type StandalonePlayerStrings,
} from './standalone-html/contract';

const log = createLogger('ExportHtml');

export function useExportHtml() {
  const [exporting, setExporting] = useState(false);
  const { t, locale } = useI18n();

  const exportStandaloneHtml = useCallback(async () => {
    const { stage, scenes } = useStageStore.getState();
    if (!stage?.id || scenes.length === 0) return;

    setExporting(true);
    const toastId = toast.loading(t('export.exporting'));

    try {
      // Loaded on demand: the export path pulls in the snapshot collectors,
      // which the header that hosts this hook should not carry.
      const { buildStandaloneHtmlExport, resolvePublicClassroomUrlForScenes } =
        await import('./standalone-html/build-standalone-html');
      const strings = Object.fromEntries(
        STANDALONE_PLAYER_STRING_KEYS.map((key) => [key, t(`export.htmlPlayer.${key}`)]),
      ) as StandalonePlayerStrings;
      // Bounded, and skipped without a PBL scene: the link is optional and
      // must never hold up the download.
      const classroomUrl = await resolvePublicClassroomUrlForScenes(scenes, stage.id, {
        origin: window.location.origin,
      });

      const { html, fileName, inlineFailures, unresolvedMedia } = await buildStandaloneHtmlExport(
        stage,
        scenes,
        { strings, lang: locale, classroomUrl },
      );

      saveAs(new Blob([html], { type: 'text/html;charset=utf-8' }), fileName);

      const partialCount = inlineFailures.length + unresolvedMedia.length;
      if (partialCount > 0) {
        log.warn('Some referenced assets could not be embedded:', {
          inlineFailures,
          unresolvedMedia,
        });
        toast.warning(t('export.inlinePartial', { count: partialCount }), { id: toastId });
      } else {
        toast.success(t('export.exportSuccess'), { id: toastId });
      }
    } catch (error) {
      log.error('Standalone HTML export failed:', error);
      toast.error(t('export.exportFailed'), { id: toastId });
    } finally {
      setExporting(false);
    }
  }, [t, locale]);

  return { exporting, exportStandaloneHtml };
}
