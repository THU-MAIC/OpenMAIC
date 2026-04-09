/**
 * SCORM package exporter.
 *
 * Loads a complete course + all referenced stages, optionally pre-renders TTS,
 * then builds a zip containing:
 *   - imsmanifest.xml
 *   - index.html
 *   - runtime/player.js, player.css, scorm-api-wrapper.js
 *   - content/course.json + content/stages/{id}.json
 *   - assets/audio/*.mp3 (if mode === 'full')
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { readCourse } from '@/lib/server/course-storage';
import { readClassroom, type PersistedClassroomData } from '@/lib/server/classroom-storage';
import type { CompleteCourse } from '@/lib/types/course';
import { buildManifest, type ScormVersion } from './manifest-builder';
import { prerenderCourseAudio, type TTSConfig } from './tts-prerenderer';

export type ExportMode = 'full' | 'light' | 'structure';

export interface ExportOptions {
  courseId: string;
  version: ScormVersion;
  mode: ExportMode;
  ttsConfig?: TTSConfig;
  onProgress?: (stage: string, done?: number, total?: number) => void;
}

export interface ExportResult {
  zip: Uint8Array;
  filename: string;
  stats: {
    stageCount: number;
    sceneCount: number;
    audioCount: number;
    sizeBytes: number;
  };
}

const TEMPLATES_DIR = path.join(process.cwd(), 'lib', 'export', 'scorm', 'templates');

async function readTemplate(name: string): Promise<string> {
  return fs.readFile(path.join(TEMPLATES_DIR, name), 'utf-8');
}

export async function exportCourseToScorm(opts: ExportOptions): Promise<ExportResult> {
  const report = (stage: string, done?: number, total?: number) => {
    opts.onProgress?.(stage, done, total);
  };

  report('loading-course');
  const course = await readCourse(opts.courseId);
  if (!course) throw new Error(`Course not found: ${opts.courseId}`);

  report('loading-stages');
  const stageIds = collectStageIds(course);
  const stages: PersistedClassroomData[] = [];
  for (const sid of stageIds) {
    const s = await readClassroom(sid);
    if (s) stages.push(s);
  }

  // Strip server-only content based on mode
  if (opts.mode === 'structure') {
    for (const stage of stages) {
      for (const scene of stage.scenes) {
        // Keep only text-based content; drop actions
        scene.actions = [];
        scene.whiteboards = [];
      }
    }
  }

  // Pre-render TTS if mode === 'full'
  let prerenderedAudio: Awaited<ReturnType<typeof prerenderCourseAudio>> = [];
  if (opts.mode === 'full' && opts.ttsConfig) {
    report('rendering-tts');
    prerenderedAudio = await prerenderCourseAudio(stages, opts.ttsConfig, (done, total) => {
      report('rendering-tts', done, total);
    });
  }

  report('building-zip');
  const zip = new JSZip();

  // Load templates
  const [playerJs, playerCss, scormWrapper, indexTemplate] = await Promise.all([
    readTemplate('player.js'),
    readTemplate('player.css'),
    readTemplate('scorm-api-wrapper.js'),
    readTemplate('index.html.template'),
  ]);

  // Substitute course variables into index.html
  const indexHtml = indexTemplate
    .replace(/\{\{COURSE_TITLE\}\}/g, escapeHtml(course.title))
    .replace(/\{\{LANGUAGE\}\}/g, course.language || 'es-MX');

  // Runtime files
  zip.file('index.html', indexHtml);
  zip.file('runtime/player.js', playerJs);
  zip.file('runtime/player.css', playerCss);
  zip.file('runtime/scorm-api-wrapper.js', scormWrapper);

  // Content files
  zip.file('content/course.json', JSON.stringify(course, null, 2));
  for (const stage of stages) {
    zip.file(`content/stages/${stage.id}.json`, JSON.stringify(stage, null, 2));
  }

  // Audio assets
  for (const audio of prerenderedAudio) {
    const filename = `assets/audio/${audio.audioId}.${audio.format}`;
    zip.file(filename, audio.buffer);
  }

  // Collect all file paths for the manifest
  const resourceFiles: string[] = [];
  zip.forEach((relativePath, file) => {
    if (!file.dir) resourceFiles.push(relativePath);
  });

  // Manifest (must be added after collecting files, but the manifest itself
  // doesn't need to reference itself)
  const manifestXml = buildManifest({
    courseId: course.id,
    courseTitle: course.title,
    courseDescription: course.description,
    language: course.language,
    version: opts.version,
    resourceFiles,
    modules: course.modules.map((m) => ({ id: m.id, title: m.title })),
  });
  zip.file('imsmanifest.xml', manifestXml);

  report('compressing');
  const zipBuffer = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const sceneCount = stages.reduce((sum, s) => sum + s.scenes.length, 0);

  return {
    zip: zipBuffer,
    filename: `${sanitizeFilename(course.title)}-scorm${opts.version === '2004' ? '2004' : '12'}.zip`,
    stats: {
      stageCount: stages.length,
      sceneCount,
      audioCount: prerenderedAudio.length,
      sizeBytes: zipBuffer.byteLength,
    },
  };
}

function collectStageIds(course: CompleteCourse): string[] {
  const ids = new Set<string>();
  for (const mod of course.modules) {
    for (const sid of mod.stageIds) ids.add(sid);
  }
  return Array.from(ids);
}

function sanitizeFilename(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60) || 'course';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
