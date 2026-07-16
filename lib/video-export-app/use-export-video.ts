'use client';

/**
 * `useExportVideo` — the classroom → Hyperframes video-export flow.
 *
 * Orchestrates the whole pipeline app-side: load the DI deps (Dexie durations +
 * asset presence), run the pure compiler to the `VideoTimeline` IR, emit the
 * Hyperframes project text, collect the asset bytes (slide snapshots + narration
 * / media), package the self-contained ZIP, and download it. Mirrors the existing
 * export hooks (`use-export-classroom`): imperative store read, a single sonner
 * toast id for progress, `saveAs` for download, `{ exporting, exportVideo }` out.
 *
 * App-side / impure: this is the composition root that wires the pure compiler
 * (`@/lib/video-export`) to its browser-backed dependencies.
 */
import { useCallback, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { compileVideoTimeline } from '@/lib/video-export';
import { useStageStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { db } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';
import { createVideoTimelineDeps } from './timeline-deps';
import { collectVideoAssets } from './collect';
import { packageVideoZip } from './package-zip';
import { emitHyperframes } from '@/lib/video-export';

const log = createLogger('ExportVideo');

/** Selectable render resolutions (16:9). Width drives slide-snapshot render width too. */
export const VIDEO_RESOLUTIONS = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
} as const;

export type VideoResolution = keyof typeof VIDEO_RESOLUTIONS;

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_') || 'classroom';
}

export function useExportVideo() {
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const { t } = useI18n();

  const exportVideo = useCallback(
    async (resolution: VideoResolution = '1080p') => {
      if (exportingRef.current) return;

      const { stage, scenes } = useStageStore.getState();
      if (!stage?.id || scenes.length === 0) {
        toast.error(t('export.videoNoScenes'));
        return;
      }

      exportingRef.current = true;
      setExporting(true);
      const toastId = toast.loading(t('export.videoCompiling'));
      const { width, height } = VIDEO_RESOLUTIONS[resolution];

      try {
        const latest = await db.stages.get(stage.id).catch(() => undefined);
        const stageName = latest?.name || stage.name || 'classroom';

        // 1. DI deps (Dexie durations + asset presence) → 2. pure compile to IR.
        const deps = await createVideoTimelineDeps({ stage: { id: stage.id }, scenes });
        const ir = compileVideoTimeline({ stage: { id: stage.id, name: stageName }, scenes }, deps);

        // 3. emit the Hyperframes project text.
        const project = emitHyperframes(ir, { width, height });

        // 4. collect asset bytes (slide snapshots + narration/media).
        toast.loading(t('export.videoRendering'), { id: toastId });
        const { blobs, missing } = await collectVideoAssets(ir, scenes, deps.records, {
          frameWidth: width,
        });

        // 5. package the self-contained ZIP.
        toast.loading(t('export.videoPackaging'), { id: toastId });
        const zipBlob = await packageVideoZip(project, blobs);

        saveAs(zipBlob, `${sanitizeFilename(stageName)}-video.zip`);
        toast.success(t('export.videoSuccess'), { id: toastId });

        const errors = ir.diagnostics.filter((d) => d.severity !== 'info').length;
        if (missing.length > 0 || errors > 0) {
          toast.warning(t('export.videoWarnings', { assets: missing.length, diagnostics: errors }));
        }
      } catch (error) {
        log.error('Video export failed:', error);
        toast.error(t('export.videoFailed'), { id: toastId });
      } finally {
        exportingRef.current = false;
        setExporting(false);
      }
    },
    [t],
  );

  return { exporting, exportVideo };
}
