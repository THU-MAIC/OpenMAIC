'use client';

// lib/lms/learnworlds-bundle.ts
//
// Assembles the LearnWorlds import bundle: since the LearnWorlds public API
// has no endpoint to create learning units or upload files, each activity is
// shipped as its own single-SCO SCORM 1.2 mini-package, numbered 1:1 with the
// sections created via the MCP. The bundle also carries the whole-course
// package as an alternative, plus a README mapping every ZIP to its section.

import {
  assembleScormZip,
  zipOutputType,
  type ScormScenePayload,
  type ScormCourseMeta,
} from '@/lib/export/scorm/scorm-core';
import { SCORM_PACKAGE_EXTENSION } from '@/lib/export/scorm/scorm-types';
import { sceneFileStem, sanitizeFileName } from '@/lib/export/scorm/scorm-utils';

/** Extension of the downloadable LearnWorlds bundle. */
export const LEARNWORLDS_BUNDLE_EXTENSION = '.learnworlds.zip';

/** Localized strings injected by the caller (kept out of this pure module). */
export interface LearnWorldsBundleStrings {
  /** README title, e.g. "Importación a LearnWorlds". */
  readmeTitle: string;
  /** Intro paragraph explaining the manual upload step. */
  readmeIntro: string;
  /** Column header: section number/name. */
  readmeSectionHeader: string;
  /** Column header: activity type. */
  readmeTypeHeader: string;
  /** Column header: file to upload. */
  readmeFileHeader: string;
  /** Note about the whole-course package. */
  readmeFullCourseNote: string;
  /** Human labels per activity kind. */
  kindLabels: Record<'slide' | 'quiz' | 'interactive' | 'pbl', string>;
}

export interface LearnWorldsBundleOptions {
  course: ScormCourseMeta;
  payloads: ScormScenePayload[];
  strings: LearnWorldsBundleStrings;
  masteryScore?: number;
  appVersion?: string;
}

export interface LearnWorldsBundleEntry {
  /** e.g. `01_Introduccion.scorm.zip` */
  fileName: string;
  sectionTitle: string;
  kind: 'slide' | 'quiz' | 'interactive' | 'pbl';
}

export interface LearnWorldsBundleResult {
  blob: Blob;
  fileName: string;
  entries: LearnWorldsBundleEntry[];
}

/** File name of the per-activity mini package for scene index `i`. */
export function activityPackageFileName(index: number, title: string): string {
  return `${sceneFileStem(index, title)}${SCORM_PACKAGE_EXTENSION}`;
}

/** File name of the whole-course package inside the bundle. */
export function fullCoursePackageFileName(): string {
  return `00_Curso_Completo${SCORM_PACKAGE_EXTENSION}`;
}

/** Build the README.md content mapping each ZIP to its target section. */
export function buildBundleReadme(
  courseTitle: string,
  entries: LearnWorldsBundleEntry[],
  strings: LearnWorldsBundleStrings,
): string {
  const lines: string[] = [
    `# ${strings.readmeTitle} — ${courseTitle}`,
    '',
    strings.readmeIntro,
    '',
    `| # | ${strings.readmeSectionHeader} | ${strings.readmeTypeHeader} | ${strings.readmeFileHeader} |`,
    '| --- | --- | --- | --- |',
  ];
  entries.forEach((e, i) => {
    lines.push(
      `| ${i + 1} | ${e.sectionTitle.replace(/\|/g, '\\|')} | ${strings.kindLabels[e.kind]} | \`${e.fileName}\` |`,
    );
  });
  lines.push('', `> ${strings.readmeFullCourseNote} \`${fullCoursePackageFileName()}\``, '');
  return lines.join('\n');
}

/**
 * Assemble the LearnWorlds bundle ZIP:
 *   LEEME.md
 *   00_Curso_Completo.scorm.zip
 *   NN_<Actividad>.scorm.zip   (one per scene, numbered like the sections)
 */
export async function buildLearnWorldsBundle(
  options: LearnWorldsBundleOptions,
): Promise<LearnWorldsBundleResult> {
  const { course, payloads, strings } = options;
  const JSZip = (await import('jszip')).default;
  const bundle = new JSZip();
  const entries: LearnWorldsBundleEntry[] = [];

  // One mini-package per activity (payloads are already in scene order).
  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i];
    const fileName = activityPackageFileName(i, payload.scene.title);
    const miniZip = await assembleScormZip({
      course: {
        title: payload.scene.title,
        description: course.title,
        ...(course.language ? { language: course.language } : {}),
      },
      payloads: [payload],
      masteryScore: options.masteryScore,
      appVersion: options.appVersion,
    });
    bundle.file(fileName, miniZip);
    entries.push({
      fileName,
      sectionTitle: payload.scene.title,
      kind: payload.scene.kind,
    });
  }

  // Whole-course package as an alternative import path.
  const fullZip = await assembleScormZip({
    course,
    payloads,
    masteryScore: options.masteryScore,
    appVersion: options.appVersion,
  });
  bundle.file(fullCoursePackageFileName(), fullZip);

  // README with the 1:1 mapping.
  bundle.file('LEEME.md', buildBundleReadme(course.title, entries, strings));

  const blob = (await bundle.generateAsync({ type: zipOutputType() })) as Blob;
  return {
    blob,
    fileName: `${sanitizeFileName(course.title)}${LEARNWORLDS_BUNDLE_EXTENSION}`,
    entries,
  };
}
