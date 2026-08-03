'use client';

/**
 * `useExportVideo` — download the classroom as a self-contained Hyperframes
 * project ZIP for local CLI rendering.
 *
 * This is the degrade path (and #865's original behavior): the whole pipeline
 * runs in the browser via {@link buildExportZip}, then the ZIP is saved to disk.
 * When the render service is configured, `useRenderVideo` uploads the same ZIP
 * to produce an MP4 in-app instead.
 *
 * App-side / impure: imperative store read, a single sonner toast id for
 * progress, `saveAs` for download.
 */
import { useCallback, useState } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { acquireExport, releaseExport } from './export-in-flight';
import {
  buildExportZip,
  NoScenesError,
  sanitizeFilename,
  VIDEO_RESOLUTIONS,
  type VideoResolution,
} from './build-export-zip';

const log = createLogger('ExportVideo');

// Re-exported for existing importers (e.g. the export menu).
export { VIDEO_RESOLUTIONS };
export type { VideoResolution };

export function useExportVideo() {
  const [exporting, setExporting] = useState(false);
  const { t } = useI18n();

  const exportVideo = useCallback(
    async (resolution: VideoResolution = '1080p', burnInSubtitles = false) => {
      // Shared with the subtitles-only download: only one export operation reads
      // the stage store / Dexie / off-screen renders at a time.
      if (!acquireExport()) return;

      setExporting(true);
      const toastId = toast.loading(t('export.videoCompiling'));

      try {
        toast.loading(t('export.videoRendering'), { id: toastId });
        const { zipBlob, stageName, missingCount, errorCount } = await buildExportZip({
          resolution,
          burnInSubtitles,
        });

        toast.loading(t('export.videoPackaging'), { id: toastId });
        saveAs(zipBlob, `${sanitizeFilename(stageName)}-video.zip`);
        toast.success(t('export.videoSuccess'), { id: toastId });

        if (missingCount > 0 || errorCount > 0) {
          toast.warning(
            t('export.videoWarnings', { assets: missingCount, diagnostics: errorCount }),
          );
        }
      } catch (error) {
        if (error instanceof NoScenesError) {
          toast.error(t('export.videoNoScenes'), { id: toastId });
        } else {
          log.error('Video export failed:', error);
          toast.error(t('export.videoFailed'), { id: toastId });
        }
      } finally {
        releaseExport();
        setExporting(false);
      }
    },
    [t],
  );

  return { exporting, exportVideo };
}
