// End-to-end (in-memory) SCORM package assembly test.
//
// Builds a full package the same way `useExportScorm` does — player files,
// imsmanifest.xml, data/course.json, slide PNG, quiz — but without the
// browser-only pieces (IndexedDB, snapshot rendering), then unzips it back
// and asserts the structural contract any SCORM 1.2 LMS relies on.
import { describe, test, expect } from 'vitest';
import JSZip from 'jszip';
import { buildImsManifest } from '@/lib/export/scorm/scorm-manifest';
import { SCORM_PLAYER_FILES } from '@/lib/export/scorm/scorm-player-template';
import { buildPackageIdentifier, sceneFileStem } from '@/lib/export/scorm/scorm-utils';
import {
  SCORM_FORMAT_VERSION,
  type ScormCourseData,
  type ScormScene,
} from '@/lib/export/scorm/scorm-types';

async function buildTestPackage(): Promise<JSZip> {
  const zip = new JSZip();

  const scenes: ScormScene[] = [
    {
      kind: 'slide',
      title: 'Introducción',
      order: 0,
      imagePath: `slides/${sceneFileStem(0, 'Introducción')}.png`,
      transcript: 'Bienvenidos al curso.',
      audioPaths: ['audio/a1.mp3'],
    },
    {
      kind: 'quiz',
      title: 'Evaluación',
      order: 1,
      questions: [
        {
          id: 'q1',
          type: 'single',
          question: '¿2+2?',
          options: [
            { label: 'Tres', value: 'A' },
            { label: 'Cuatro', value: 'B' },
          ],
          answer: ['B'],
        },
      ],
    },
    {
      kind: 'interactive',
      title: 'Simulador',
      order: 2,
      htmlPath: `interactive/${sceneFileStem(2, 'Simulador')}.html`,
    },
  ];

  const courseData: ScormCourseData = {
    formatVersion: SCORM_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: '0.3.0',
    course: { title: 'Curso de Prueba' },
    masteryScore: 60,
    scenes,
  };

  for (const [path, content] of Object.entries(SCORM_PLAYER_FILES)) zip.file(path, content);
  zip.file('data/course.json', JSON.stringify(courseData, null, 2));
  zip.file('slides/01_Introducción.png', new Uint8Array([137, 80, 78, 71]));
  zip.file('audio/a1.mp3', new Uint8Array([0xff, 0xfb]));
  zip.file('interactive/03_Simulador.html', '<!DOCTYPE html><html><body>sim</body></html>');

  const resourceFiles = [
    ...Object.keys(SCORM_PLAYER_FILES),
    'data/course.json',
    'slides/01_Introducción.png',
    'audio/a1.mp3',
    'interactive/03_Simulador.html',
  ];
  zip.file(
    'imsmanifest.xml',
    buildImsManifest({
      identifier: buildPackageIdentifier('Curso de Prueba'),
      title: 'Curso de Prueba',
      resourceFiles,
      masteryScore: 60,
    }),
  );
  return zip;
}

describe('SCORM package assembly (e2e in-memory)', () => {
  test('round-trips through zip and keeps the SCORM 1.2 contract', async () => {
    const zip = await buildTestPackage();
    const blob = await zip.generateAsync({ type: 'uint8array' });
    const reopened = await JSZip.loadAsync(blob);

    // imsmanifest.xml must live at the package root — hard LMS requirement.
    const manifest = reopened.file('imsmanifest.xml');
    expect(manifest).not.toBeNull();
    const manifestXml = await manifest!.async('string');
    expect(manifestXml).toContain('<schemaversion>1.2</schemaversion>');
    expect(manifestXml).toContain('href="index.html"');

    // The SCO entry point and player assets are present.
    for (const path of Object.keys(SCORM_PLAYER_FILES)) {
      expect(reopened.file(path), `missing ${path}`).not.toBeNull();
    }

    // course.json parses back and covers every scene kind exported.
    const courseJson = JSON.parse(
      await reopened.file('data/course.json')!.async('string'),
    ) as ScormCourseData;
    expect(courseJson.formatVersion).toBe(SCORM_FORMAT_VERSION);
    expect(courseJson.scenes.map((s) => s.kind)).toEqual(['slide', 'quiz', 'interactive']);

    // Every file referenced by course.json exists in the package.
    for (const scene of courseJson.scenes) {
      if (scene.kind === 'slide') {
        expect(reopened.file(scene.imagePath), scene.imagePath).not.toBeNull();
        for (const a of scene.audioPaths ?? []) {
          expect(reopened.file(a), a).not.toBeNull();
        }
      }
      if (scene.kind === 'interactive' && scene.htmlPath) {
        expect(reopened.file(scene.htmlPath), scene.htmlPath).not.toBeNull();
      }
    }

    // Every <file href> in the manifest resolves inside the package.
    const hrefs = [...manifestXml.matchAll(/<file href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(reopened.file(href), `manifest references missing file ${href}`).not.toBeNull();
    }
  });
});
