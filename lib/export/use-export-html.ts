'use client';

import { useState, useCallback } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import type { Scene } from '@/lib/types/stage';
import type { LegacySpeechAction } from '@/lib/types/action';
import {
  STANDALONE_PLAYER_STRING_KEYS,
  type StandalonePlayerStrings,
} from './standalone-html/contract';
import {
  STANDALONE_HTML_SIZE_WARNING_BYTES,
  StandaloneHtmlTooLargeError,
} from './standalone-html/limits';

const log = createLogger('ExportHtml');

/** Whether any speech in the classroom has narration audio to embed. */
export function classroomHasNarration(scenes: readonly Scene[]): boolean {
  return scenes.some((scene) =>
    (scene.actions ?? []).some((action) => {
      if (action.type !== 'speech') return false;
      const speech = action as LegacySpeechAction;
      return !!speech.audioId || !!speech.audioUrl;
    }),
  );
}

/** Whether any slide in the classroom carries a video element. */
function classroomHasSlideVideo(scenes: readonly Scene[]): boolean {
  return scenes.some((scene) => {
    const content = scene.content as { type?: string; canvas?: { elements?: unknown[] } };
    if (content?.type !== 'slide') return false;
    return (content.canvas?.elements ?? []).some(
      (element) => (element as { type?: string } | null)?.type === 'video',
    );
  });
}

/**
 * Whether the "with narration and video" export adds anything: narration
 * audio, or a slide video (only that export carries videos).
 */
export function classroomHasPlaybackMedia(scenes: readonly Scene[]): boolean {
  return classroomHasNarration(scenes) || classroomHasSlideVideo(scenes);
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1);
}

/** How long the ZIP fallback notice stays up; it carries instructions. */
const ZIP_FALLBACK_TOAST_MS = 12_000;

export interface ExportHtmlOptions {
  /** Embed narration audio and video clips (see `buildStandaloneHtmlExport`). */
  includeNarration: boolean;
}

export function useExportHtml() {
  const [exporting, setExporting] = useState(false);
  const { t, locale } = useI18n();

  const exportStandaloneHtml = useCallback(
    async ({ includeNarration }: ExportHtmlOptions) => {
      const { stage, scenes } = useStageStore.getState();
      if (!stage?.id || scenes.length === 0) return;

      setExporting(true);
      const toastId = toast.loading(t('export.exporting'));

      try {
        // Loaded on demand: the export path pulls in the snapshot collectors,
        // which the header that hosts this hook should not carry.
        const { buildStandaloneHtmlExport, classroomUrlFor } =
          await import('./standalone-html/build-standalone-html');
        const strings = Object.fromEntries(
          STANDALONE_PLAYER_STRING_KEYS.map((key) => [key, t(`export.htmlPlayer.${key}`)]),
        ) as StandalonePlayerStrings;
        // Anyone with the link can open the classroom, so PBL scenes always
        // link back to it on this deployment.
        const classroomUrl = classroomUrlFor(window.location.origin, stage.id);

        const {
          format,
          blob,
          fileName,
          inlineFailures,
          unresolvedMedia,
          missingAudioCount,
          byteSize,
          singleFileBytes,
        } = await buildStandaloneHtmlExport(stage, scenes, {
          strings,
          lang: locale,
          classroomUrl,
          includeNarration,
          // Too large for one file: the page plus its media folders, zipped.
          format: 'auto',
          zipReadme: t('export.htmlZipReadme'),
        });

        saveAs(blob, fileName);

        const partialCount = inlineFailures.length + unresolvedMedia.length;
        // Bundling failures and missing narration are different problems, so
        // each gets its own wording.
        const notes = [
          partialCount > 0 ? t('export.inlinePartial', { count: partialCount }) : undefined,
          missingAudioCount > 0
            ? t('export.narrationMissing', { count: missingAudioCount })
            : undefined,
        ].filter((note): note is string => !!note);
        if (format === 'zip') {
          // The ZIP only plays once extracted, which nobody expects from an
          // "HTML" export: say why it is a ZIP and what to do with it, and
          // leave the toast up long enough to read.
          log.warn('Standalone HTML export saved as a ZIP:', { singleFileBytes, byteSize });
          toast.warning(
            t('export.htmlZipFallback', { size: formatMegabytes(singleFileBytes ?? byteSize) }),
            {
              id: toastId,
              description: [t('export.htmlZipFallbackDesc'), ...notes].join(' '),
              duration: ZIP_FALLBACK_TOAST_MS,
            },
          );
        } else if (byteSize > STANDALONE_HTML_SIZE_WARNING_BYTES) {
          log.warn('Standalone HTML export is large:', { byteSize });
          toast.warning(
            t(includeNarration ? 'export.htmlLarge' : 'export.htmlLargeSilent', {
              size: formatMegabytes(byteSize),
            }),
            { id: toastId, description: notes.length > 0 ? notes.join(' ') : undefined },
          );
        } else if (notes.length > 0) {
          log.warn('Some referenced assets could not be embedded:', {
            inlineFailures,
            unresolvedMedia,
            missingAudioCount,
          });
          toast.warning(notes.join(' '), { id: toastId });
        } else {
          toast.success(t('export.exportSuccess'), { id: toastId });
        }
      } catch (error) {
        if (error instanceof StandaloneHtmlTooLargeError) {
          // Too large even for the ZIP: its page alone passes the ceiling
          // (media inside interactive scenes stays in the page), or the
          // archive passes 4 GiB. Leaving narration out only helps when it
          // was included.
          log.warn(
            'Standalone HTML export refused as too large:',
            error.kind,
            error.estimatedBytes,
          );
          const size = formatMegabytes(error.estimatedBytes);
          const key =
            error.kind === 'page'
              ? includeNarration
                ? 'export.htmlPageTooLarge'
                : 'export.htmlPageTooLargeSilent'
              : includeNarration
                ? 'export.htmlTooLarge'
                : 'export.htmlTooLargeSilent';
          toast.error(t(key, { size }), { id: toastId });
          return;
        }
        log.error('Standalone HTML export failed:', error);
        toast.error(t('export.exportFailed'), { id: toastId });
      } finally {
        setExporting(false);
      }
    },
    [t, locale],
  );

  return { exporting, exportStandaloneHtml };
}
