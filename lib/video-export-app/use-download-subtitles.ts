'use client';

/**
 * `useDownloadSubtitles` — download the classroom narration as a subtitle file
 * (`.srt` by default) without rendering a video.
 *
 * The "clean video + sidecar subtitles" path (#867 item 2): with burn-in off,
 * the exported MP4 has no captions, so the user downloads the subtitle file here
 * and adds it in their own editor. Reuses {@link compileSubtitles}, which runs
 * only the compiler (no asset collection, no ZIP, no render service), so it's
 * fast and works whether or not the render service is configured.
 *
 * App-side / impure: store read, sonner toast, `saveAs` download.
 */
import { useCallback, useState } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { acquireExport, releaseExport } from './export-in-flight';
import { compileSubtitles, NoScenesError, sanitizeFilename } from './build-export-zip';

const log = createLogger('DownloadSubtitles');

export type SubtitleFormat = 'srt' | 'vtt';

export function useDownloadSubtitles() {
  const [downloading, setDownloading] = useState(false);
  const { t } = useI18n();

  const downloadSubtitles = useCallback(
    async (format: SubtitleFormat = 'srt') => {
      if (downloading) return;
      // Shared with the ZIP export: both funnel through the same stage-store /
      // Dexie compile, so only one export operation runs at a time.
      if (!acquireExport()) return;
      setDownloading(true);
      const toastId = toast.loading(t('export.subtitlesCompiling'));
      try {
        const { srt, vtt, stageName, cueCount } = await compileSubtitles();
        if (cueCount === 0) {
          toast.error(t('export.subtitlesEmpty'), { id: toastId });
          return;
        }
        const content = format === 'vtt' ? vtt : srt;
        const mime = format === 'vtt' ? 'text/vtt' : 'application/x-subrip';
        const blob = new Blob([content], { type: `${mime};charset=utf-8` });
        saveAs(blob, `${sanitizeFilename(stageName)}.${format}`);
        toast.success(t('export.subtitlesSuccess'), { id: toastId });
      } catch (error) {
        if (error instanceof NoScenesError) {
          toast.error(t('export.videoNoScenes'), { id: toastId });
        } else {
          log.error('Subtitle download failed:', error);
          toast.error(t('export.subtitlesFailed'), { id: toastId });
        }
      } finally {
        releaseExport();
        setDownloading(false);
      }
    },
    [downloading, t],
  );

  return { downloading, downloadSubtitles };
}
