'use client';

import { useState, useCallback, useRef } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';

import { useStageStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import type { Scene, InteractiveContent } from '@/lib/types/stage';

import { collectAssets, getSceneAssetHrefs } from './asset-collector';
import { buildManifest } from './manifest';
import { getScormBridgeJs } from './scorm-bridge';
import { buildSlideSection } from './slide-sco';
import { buildQuizSection } from './quiz-sco';
import { buildInteractiveSection } from './interactive-sco';
import { buildCourseHtml, type SceneMeta } from './course-builder';

const log = createLogger('ExportSCORM');

export interface ScormExportOptions {
  includeVideos: boolean;
}

function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'course';
}

function isExportableScene(scene: Scene): boolean {
  if (scene.content.type === 'pbl') return false;
  if (scene.content.type === 'interactive') {
    return Boolean((scene.content as InteractiveContent).html);
  }
  return true;
}

/**
 * React hook for SCORM 1.2 export.
 *
 * Generates a single-SCO package: all scenes in one index.html with internal
 * JS navigation. Fixes LMS iframe navigation issues from multi-SCO approach.
 *
 * What gets exported:
 * - slide scenes → <section> with absolute-positioned canvas + TTS narration
 * - quiz scenes  → <section> with single/multiple choice questions + SCORM scoring
 * - interactive scenes (with html) → <section> wrapping content in an iframe
 *
 * Excluded: pbl scenes, interactive scenes without html,
 *           whiteboards, multi-agent chat, short-answer questions.
 */
export function useExportScorm(): {
  exporting: boolean;
  exportScorm: (options: ScormExportOptions) => void;
} {
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const { t } = useI18n();

  const scenes = useStageStore((s) => s.scenes);
  const stage = useStageStore((s) => s.stage);

  const withExportGuard = useCallback(
    (action: () => Promise<void>) => {
      if (exportingRef.current) return;
      exportingRef.current = true;
      setExporting(true);
      setTimeout(async () => {
        try {
          await action();
        } catch (err) {
          log.error('SCORM export failed:', err);
          toast.error(t('export.exportFailed'));
        } finally {
          exportingRef.current = false;
          setExporting(false);
        }
      }, 100);
    },
    [t],
  );

  const exportScorm = useCallback(
    (options: ScormExportOptions) => {
      withExportGuard(async () => {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();

        const fileName = stage?.name || 'course';
        const courseId = sanitizeId(fileName);
        const courseTitle = stage?.name ?? fileName;

        // 1. Filter to exportable scenes only
        const exportableScenes = scenes.filter(isExportableScene);

        if (exportableScenes.length === 0) {
          toast.error(t('export.exportFailed'));
          return;
        }

        // 2. Collect all media assets (fetch blobs, resolve placeholders)
        const assetMap = await collectAssets(exportableScenes, options.includeVideos);

        // 3. Write asset blobs into ZIP
        for (const entry of assetMap.entries()) {
          zip.file(entry.zipPath, entry.blob);
        }

        // 4. Build scene section fragments
        const sectionResults: Array<{ html: string; meta: SceneMeta; title: string }> = [];
        let needsKatex = false;
        let hasQuiz = false;

        for (let i = 0; i < exportableScenes.length; i++) {
          const scene = exportableScenes[i];

          if (scene.content.type === 'slide') {
            const res = buildSlideSection({ scene, sceneIndex: i, assetMap, includeVideos: options.includeVideos });
            sectionResults.push({ html: res.html, meta: res.meta, title: scene.title });
            if (res.needsKatex) needsKatex = true;
          } else if (scene.content.type === 'quiz') {
            const res = buildQuizSection(scene, i);
            sectionResults.push({ html: res.html, meta: res.meta, title: scene.title });
            hasQuiz = true;
          } else if (scene.content.type === 'interactive') {
            const res = buildInteractiveSection(scene, i);
            sectionResults.push({ html: res.html, meta: res.meta, title: scene.title });
          }
        }

        // 5. Assemble single index.html
        const courseHtml = buildCourseHtml({
          courseName: courseTitle,
          sections: sectionResults,
          needsKatex,
        });
        zip.file('index.html', courseHtml);

        // 6. Write scorm_bridge.js
        zip.file('scorm_bridge.js', getScormBridgeJs());

        // 7. Write imsmanifest.xml (single-SCO pointing to index.html)
        const allAssetHrefs = exportableScenes.flatMap((scene, i) =>
          getSceneAssetHrefs(scene, i, assetMap, options.includeVideos),
        );
        const manifest = buildManifest({
          courseId,
          courseTitle,
          assetHrefs: allAssetHrefs,
          masteryScore: hasQuiz ? 80 : undefined,
        });
        zip.file('imsmanifest.xml', manifest);

        // 8. Generate ZIP and trigger download
        const zipBlob = await zip.generateAsync({
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 },
        });
        saveAs(zipBlob, `${fileName}_scorm.zip`);
        toast.success(t('export.exportSuccess'));
      });
    },
    [withExportGuard, scenes, stage, t],
  );

  return { exporting, exportScorm };
}
