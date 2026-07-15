'use client';

// lib/export/scorm/scorm-core.ts
//
// Reusable core of the SCORM 1.2 export pipeline, extracted from
// `use-export-scorm.ts` so multiple flows can share it:
//   - "Export SCORM" (menu): one package with the whole course.
//   - "Export to LearnWorlds": one mini-package per activity (scene), since
//     the LearnWorlds public API cannot create learning units and each
//     activity must be uploaded as its own SCORM unit.
//
// The expensive work (slide snapshots, audio collection, interactive asset
// inlining) runs ONCE via `buildScormScenePayloads`; `assembleScormZip` then
// packages any subset of the prepared scenes into a valid single-SCO package.

import { slideToPng } from '@openmaic/renderer/snapshot';
import { db } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';
import type { Scene, SlideContent, QuizContent, PBLContent } from '@/lib/types/stage';
import { inlineHtmlAssets, createAssetFetcher, type InlineReport } from '../inline-assets';
import { createProxiedFetch } from '../proxied-fetch';
import { SCORM_FORMAT_VERSION, type ScormCourseData, type ScormScene } from './scorm-types';
import { buildImsManifest } from './scorm-manifest';
import { SCORM_PLAYER_FILES } from './scorm-player-template';
import {
  sceneFileStem,
  buildTranscript,
  sceneAudioIds,
  quizToScormQuestions,
  pblSummary,
  audioExtension,
  buildPackageIdentifier,
} from './scorm-utils';
import { resolveSlideMedia } from './scorm-slide-resolver';

const log = createLogger('ScormCore');

/** Default passing score (%) reported to the LMS via adlcp:masteryscore. */
export const DEFAULT_MASTERY_SCORE = 60;

/** Snapshot output width in px — 1600 keeps text crisp at typical LMS sizes. */
const SNAPSHOT_WIDTH = 1600;

/** A binary/text file that belongs to one prepared scene. */
export interface ScormSceneFile {
  path: string;
  data: Blob | string;
}

/** A fully prepared scene: portable descriptor + the files it references. */
export interface ScormScenePayload {
  scene: ScormScene;
  files: ScormSceneFile[];
}

export interface ScormScenePayloadsResult {
  payloads: ScormScenePayload[];
  /** Aggregated asset-inlining report across all interactive scenes. */
  inlineReport: InlineReport;
}

export interface ScormCourseMeta {
  title: string;
  description?: string;
  language?: string;
}

/**
 * Run the expensive per-scene preparation once: slide snapshots, narration
 * audio collection from IndexedDB, interactive HTML asset inlining and quiz
 * mapping. Scenes must already be normalized/persisted (PBL prepared) and
 * sorted by order.
 */
export async function buildScormScenePayloads(
  orderedScenes: Scene[],
): Promise<ScormScenePayloadsResult> {
  const sharedFetcher = createAssetFetcher({ fetchImpl: createProxiedFetch() });
  const inlineReport: InlineReport = { inlined: [], failed: [] };
  const payloads: ScormScenePayload[] = [];
  const audioIdToPath = new Map<string, string>();
  const audioBlobs = new Map<string, Blob>();

  // Collect narration audio blobs once (deduplicated across scenes).
  for (const scene of orderedScenes) {
    for (const audioId of sceneAudioIds(scene)) {
      if (audioIdToPath.has(audioId)) continue;
      const record = await db.audioFiles.get(audioId);
      if (!record) continue;
      const zipPath = `audio/${audioId}.${audioExtension(record.format)}`;
      audioIdToPath.set(audioId, zipPath);
      audioBlobs.set(zipPath, record.blob);
    }
  }

  for (let i = 0; i < orderedScenes.length; i++) {
    const scene = orderedScenes[i];
    const stem = sceneFileStem(i, scene.title);
    const transcript = buildTranscript(scene);
    const audioPaths = sceneAudioIds(scene)
      .map((id) => audioIdToPath.get(id))
      .filter((p): p is string => !!p);
    const files: ScormSceneFile[] = audioPaths.map((p) => ({
      path: p,
      data: audioBlobs.get(p) as Blob,
    }));

    if (scene.content.type === 'slide') {
      const canvas = resolveSlideMedia((scene.content as SlideContent).canvas);
      const imagePath = `slides/${stem}.png`;
      try {
        const png = (await slideToPng(canvas, {
          width: SNAPSHOT_WIDTH,
          pixelRatio: 1,
          format: 'blob',
        })) as Blob;
        files.push({ path: imagePath, data: png });
      } catch (err) {
        log.warn(`Slide snapshot failed for scene "${scene.title}":`, err);
        files.push({ path: imagePath, data: transparentPngBlob() });
      }
      payloads.push({
        scene: {
          kind: 'slide',
          title: scene.title,
          order: scene.order,
          imagePath,
          ...(transcript ? { transcript } : {}),
          ...(audioPaths.length ? { audioPaths } : {}),
        },
        files,
      });
    } else if (scene.content.type === 'quiz') {
      payloads.push({
        scene: {
          kind: 'quiz',
          title: scene.title,
          order: scene.order,
          questions: quizToScormQuestions(scene.content as QuizContent),
        },
        files,
      });
    } else if (scene.content.type === 'interactive') {
      let htmlPath: string | undefined;
      if (scene.content.html) {
        const { html, report } = await inlineHtmlAssets(scene.content.html, {
          fetcher: sharedFetcher,
        });
        for (const u of report.inlined)
          if (!inlineReport.inlined.includes(u)) inlineReport.inlined.push(u);
        for (const f of report.failed)
          if (!inlineReport.failed.some((g) => g.url === f.url)) inlineReport.failed.push(f);
        htmlPath = `interactive/${stem}.html`;
        files.push({ path: htmlPath, data: html });
      }
      payloads.push({
        scene: {
          kind: 'interactive',
          title: scene.title,
          order: scene.order,
          ...(htmlPath ? { htmlPath } : {}),
          ...(scene.content.url ? { url: scene.content.url } : {}),
          ...(transcript ? { transcript } : {}),
          ...(audioPaths.length ? { audioPaths } : {}),
        },
        files,
      });
    } else if (scene.content.type === 'pbl') {
      const summary = pblSummary(scene.content as PBLContent);
      payloads.push({
        scene: {
          kind: 'pbl',
          title: scene.title,
          order: scene.order,
          ...(summary ? { summary } : {}),
          ...(transcript ? { transcript } : {}),
        },
        files,
      });
    }
  }

  return { payloads, inlineReport };
}

export interface AssembleScormZipOptions {
  course: ScormCourseMeta;
  payloads: ScormScenePayload[];
  masteryScore?: number;
  appVersion?: string;
}

/**
 * Assemble a complete, valid single-SCO SCORM 1.2 package (player + manifest
 * + course.json + media) from prepared scene payloads. Returns the ZIP Blob.
 */
export async function assembleScormZip(options: AssembleScormZipOptions): Promise<Blob> {
  const { course, payloads } = options;
  const masteryScore = options.masteryScore ?? DEFAULT_MASTERY_SCORE;
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  const courseData: ScormCourseData = {
    formatVersion: SCORM_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: options.appVersion || process.env.npm_package_version || '0.0.0',
    course: {
      title: course.title,
      ...(course.description ? { description: course.description } : {}),
      ...(course.language ? { language: course.language } : {}),
    },
    masteryScore,
    scenes: payloads.map((p) => p.scene),
  };

  for (const [path, content] of Object.entries(SCORM_PLAYER_FILES)) {
    zip.file(path, content);
  }
  zip.file('data/course.json', JSON.stringify(courseData, null, 2));

  const seen = new Set<string>();
  const resourceFiles = [...Object.keys(SCORM_PLAYER_FILES), 'data/course.json'];
  for (const payload of payloads) {
    for (const f of payload.files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      zip.file(f.path, f.data);
      resourceFiles.push(f.path);
    }
  }

  zip.file(
    'imsmanifest.xml',
    buildImsManifest({
      identifier: buildPackageIdentifier(course.title),
      title: course.title,
      description: course.description,
      resourceFiles,
      masteryScore,
    }),
  );

  return zip.generateAsync({ type: zipOutputType() }) as Promise<Blob>;
}

/**
 * JSZip output type: 'blob' in the browser, 'uint8array' under Node (tests),
 * where jsdom Blobs are not readable by JSZip.
 */
export function zipOutputType(): 'blob' | 'uint8array' {
  return typeof process !== 'undefined' && process.release?.name === 'node' ? 'uint8array' : 'blob';
}

/** 1×1 transparent PNG used as a snapshot fallback. */
export function transparentPngBlob(): Blob {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: 'image/png' });
}
