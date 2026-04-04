'use client';

import { useState, useCallback, useRef } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';

import { useStageStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import type { Scene, InteractiveContent } from '@/lib/types/stage';

import { collectAssets, getSceneAssetHrefs } from './asset-collector';
import { buildManifest, type ScoEntry } from './manifest';
import { getScormBridgeJs } from './scorm-bridge';
import { buildSlideSco } from './slide-sco';
import { buildQuizSco } from './quiz-sco';
import { buildInteractiveSco } from './interactive-sco';

const log = createLogger('ExportSCORM');

export interface ScormExportOptions {
  includeVideos: boolean;
}

function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'course';
}

function pad2(n: number): string {
  return String(n + 1).padStart(2, '0');
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
 * Mirrors the useExportPPTX pattern: guard against concurrent exports,
 * show toast on success/failure, lazy-import JSZip for code splitting.
 *
 * What gets exported:
 * - slide scenes → HTML SCO with absolutepositioned canvas + TTS narration
 * - quiz scenes  → HTML SCO with single/multiple choice questions + SCORM scoring
 * - interactive scenes (with html) → HTML SCO wrapping content in an iframe
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

        // 1. Filter to exportable scenes only
        const exportableScenes = scenes.filter(isExportableScene);

        if (exportableScenes.length === 0) {
          toast.error(t('export.exportFailed'));
          return;
        }

        // 2. Build SCO href list (used in every SCO for navigation)
        const allScoHrefs = exportableScenes.map(
          (_, i) => `scos/scene_${pad2(i)}.html`,
        );

        // 3. Collect all media assets (fetch blobs, resolve placeholders)
        const assetMap = await collectAssets(exportableScenes, options.includeVideos);

        // 4. Write asset blobs into ZIP
        for (const entry of assetMap.entries()) {
          zip.file(entry.zipPath, entry.blob);
        }

        // 5. Build SCO HTML pages + collect ScoEntry metadata for manifest
        const scoEntries: ScoEntry[] = [];

        for (let i = 0; i < exportableScenes.length; i++) {
          const scene = exportableScenes[i];
          const href = allScoHrefs[i];
          const sceneId = `scene_${pad2(i)}`;
          let html = '';

          if (scene.content.type === 'slide') {
            html = buildSlideSco({
              scene,
              sceneIndex: i,
              totalScenes: exportableScenes.length,
              allScoHrefs,
              assetMap,
              includeVideos: options.includeVideos,
            });
          } else if (scene.content.type === 'quiz') {
            html = buildQuizSco({
              scene,
              sceneIndex: i,
              totalScenes: exportableScenes.length,
              allScoHrefs,
            });
          } else if (scene.content.type === 'interactive') {
            html = buildInteractiveSco({
              scene,
              sceneIndex: i,
              totalScenes: exportableScenes.length,
              allScoHrefs,
            });
          }

          if (!html) continue;

          zip.file(href, html);

          const assetHrefs = getSceneAssetHrefs(scene, i, assetMap, options.includeVideos);

          scoEntries.push({
            id: sceneId,
            title: scene.title,
            href,
            isQuiz: scene.content.type === 'quiz',
            assetHrefs,
          });
        }

        // 6. Write scorm_bridge.js
        zip.file('scorm_bridge.js', getScormBridgeJs());

        // 7. Write imsmanifest.xml
        const manifest = buildManifest(courseId, stage?.name ?? fileName, scoEntries);
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
