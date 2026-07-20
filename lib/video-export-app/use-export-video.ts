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

// Module-level, NOT a per-hook ref: this hook lives in the export menu, which
// unmounts as soon as the ZIP click closes it — a per-instance ref would reset
// to false on the next mount and let a second concurrent snapshot/ZIP pipeline
// start. A module singleton makes the in-flight guard survive remounts.
let exportInFlight = false;

export function useExportVideo() {
  const [exporting, setExporting] = useState(false);
  const { t } = useI18n();

  const exportVideo = useCallback(
    async (resolution: VideoResolution = '1080p') => {
      if (exportInFlight) return;

      exportInFlight = true;
      setExporting(true);
      const toastId = toast.loading(t('export.videoCompiling'));

      try {
        toast.loading(t('export.videoRendering'), { id: toastId });
        const { zipBlob, stageName, missingCount, errorCount } = await buildExportZip(resolution);

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
        exportInFlight = false;
        setExporting(false);
      }
    },
    [t],
  );

  return { exporting, exportVideo };
}
