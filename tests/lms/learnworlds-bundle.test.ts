// tests/lms/learnworlds-bundle.test.ts
//
// Unit tests for the LearnWorlds per-activity bundle assembler.

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  activityPackageFileName,
  fullCoursePackageFileName,
  buildBundleReadme,
  buildLearnWorldsBundle,
  LEARNWORLDS_BUNDLE_EXTENSION,
  type LearnWorldsBundleStrings,
  type LearnWorldsBundleEntry,
} from '@/lib/lms/learnworlds-bundle';
import type { ScormScenePayload } from '@/lib/export/scorm/scorm-core';
import type { ScormCourseData } from '@/lib/export/scorm/scorm-types';

const STRINGS: LearnWorldsBundleStrings = {
  readmeTitle: 'Importación a LearnWorlds',
  readmeIntro: 'Sube cada archivo a su sección.',
  readmeSectionHeader: 'Sección (actividad)',
  readmeTypeHeader: 'Tipo',
  readmeFileHeader: 'Archivo a subir',
  readmeFullCourseNote: 'Alternativa: curso completo en',
  kindLabels: {
    slide: 'Página',
    quiz: 'Cuestionario',
    interactive: 'Interactiva',
    pbl: 'Proyecto',
  },
};

function slidePayload(order: number, title: string): ScormScenePayload {
  return {
    scene: { kind: 'slide', title, order, imagePath: `slides/0${order + 1}_x.png` },
    files: [
      {
        path: `slides/0${order + 1}_x.png`,
        data: new Uint8Array([137, 80, 78, 71]) as unknown as Blob,
      },
    ],
  };
}

function quizPayload(order: number, title: string): ScormScenePayload {
  return {
    scene: {
      kind: 'quiz',
      title,
      order,
      questions: [
        {
          id: 'q1',
          type: 'single',
          question: '¿2+2?',
          options: [
            { label: '4', value: 'a' },
            { label: '5', value: 'b' },
          ],
          answer: ['a'],
          points: 10,
        },
      ],
    },
    files: [],
  };
}

describe('activityPackageFileName', () => {
  it('numbers packages 1:1 with sections and sanitizes titles', () => {
    expect(activityPackageFileName(0, 'Intro a React')).toBe('01_Intro_a_React.scorm.zip');
    expect(activityPackageFileName(11, 'Quiz: final?')).toBe('12_Quiz_final.scorm.zip');
  });
});

describe('buildBundleReadme', () => {
  it('renders a mapping table with one row per activity', () => {
    const entries: LearnWorldsBundleEntry[] = [
      { fileName: '01_Intro.scorm.zip', sectionTitle: 'Intro', kind: 'slide' },
      { fileName: '02_Test.scorm.zip', sectionTitle: 'Test | final', kind: 'quiz' },
    ];
    const md = buildBundleReadme('Mi Curso', entries, STRINGS);
    expect(md).toContain('# Importación a LearnWorlds — Mi Curso');
    expect(md).toContain('| 1 | Intro | Página | `01_Intro.scorm.zip` |');
    // Pipes inside titles must be escaped to keep the table valid.
    expect(md).toContain('Test \\| final');
    expect(md).toContain(fullCoursePackageFileName());
  });
});

describe('buildLearnWorldsBundle', () => {
  it('produces one mini SCORM per activity plus the full-course package and README', async () => {
    const result = await buildLearnWorldsBundle({
      course: { title: 'Curso Demo', description: 'Desc', language: 'es' },
      payloads: [slidePayload(0, 'Presentación'), quizPayload(1, 'Evaluación')],
      strings: STRINGS,
    });

    expect(result.fileName).toBe(`Curso_Demo${LEARNWORLDS_BUNDLE_EXTENSION}`);
    expect(result.entries).toHaveLength(2);

    const bundle = await JSZip.loadAsync(result.blob);
    const names = Object.keys(bundle.files);
    expect(names).toContain('LEEME.md');
    expect(names).toContain('01_Presentación.scorm.zip');
    expect(names).toContain('02_Evaluación.scorm.zip');
    expect(names).toContain(fullCoursePackageFileName());
  });

  it('each mini package is a valid single-SCO SCORM with only its own scene', async () => {
    const result = await buildLearnWorldsBundle({
      course: { title: 'Curso Demo' },
      payloads: [slidePayload(0, 'Presentación'), quizPayload(1, 'Evaluación')],
      strings: STRINGS,
    });
    const bundle = await JSZip.loadAsync(result.blob);

    const quizZipData = await bundle.file('02_Evaluación.scorm.zip')!.async('uint8array');
    const quizZip = await JSZip.loadAsync(quizZipData);
    const names = Object.keys(quizZip.files);
    expect(names).toContain('imsmanifest.xml');
    expect(names).toContain('index.html');
    expect(names).toContain('data/course.json');

    const courseJson = JSON.parse(
      await quizZip.file('data/course.json')!.async('string'),
    ) as ScormCourseData;
    expect(courseJson.scenes).toHaveLength(1);
    expect(courseJson.scenes[0].kind).toBe('quiz');
    expect(courseJson.course.title).toBe('Evaluación');
    // Quiz questions travel with the mini package.
    const quizScene = courseJson.scenes[0] as Extract<
      ScormCourseData['scenes'][number],
      { kind: 'quiz' }
    >;
    expect(quizScene.questions).toHaveLength(1);

    const manifest = await quizZip.file('imsmanifest.xml')!.async('string');
    expect(manifest).toContain('<schemaversion>1.2</schemaversion>');
    expect(manifest).toContain('adlcp:masteryscore');
  });

  it('slide media files are carried into their mini package', async () => {
    const result = await buildLearnWorldsBundle({
      course: { title: 'Curso Demo' },
      payloads: [slidePayload(0, 'Presentación')],
      strings: STRINGS,
    });
    const bundle = await JSZip.loadAsync(result.blob);
    const slideZipData = await bundle.file('01_Presentación.scorm.zip')!.async('uint8array');
    const slideZip = await JSZip.loadAsync(slideZipData);
    expect(Object.keys(slideZip.files)).toContain('slides/01_x.png');
    const manifest = await slideZip.file('imsmanifest.xml')!.async('string');
    expect(manifest).toContain('slides/01_x.png');
  });
});
