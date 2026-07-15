import { describe, test, expect } from 'vitest';
import { buildImsManifest, escapeXml } from '@/lib/export/scorm/scorm-manifest';
import {
  sanitizeFileName,
  sceneFileStem,
  buildTranscript,
  sceneAudioIds,
  quizToScormQuestions,
  audioExtension,
  buildPackageIdentifier,
} from '@/lib/export/scorm/scorm-utils';
import { SCORM_PLAYER_FILES } from '@/lib/export/scorm/scorm-player-template';
import type { Scene, QuizContent } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';

// ─── escapeXml ────────────────────────────────────────────────

describe('escapeXml', () => {
  test('escapes all five XML special characters', () => {
    expect(escapeXml(`<a & "b" 'c'>`)).toBe('&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');
  });

  test('passes plain text through unchanged', () => {
    expect(escapeXml('Curso de Física 101')).toBe('Curso de Física 101');
  });
});

// ─── buildImsManifest ─────────────────────────────────────────

describe('buildImsManifest', () => {
  const manifest = buildImsManifest({
    identifier: 'openmaic.fisica.abc123',
    title: 'Física <Avanzada> & Más',
    description: 'Curso completo',
    resourceFiles: ['index.html', 'data/course.json', 'slides/01_intro.png'],
    masteryScore: 60,
  });

  test('declares SCORM 1.2 schema', () => {
    expect(manifest).toContain('<schema>ADL SCORM</schema>');
    expect(manifest).toContain('<schemaversion>1.2</schemaversion>');
  });

  test('escapes the title in XML', () => {
    expect(manifest).toContain('Física &lt;Avanzada&gt; &amp; Más');
    expect(manifest).not.toContain('<Avanzada>');
  });

  test('references index.html as the single SCO entry point', () => {
    expect(manifest).toContain('adlcp:scormtype="sco" href="index.html"');
  });

  test('lists every resource file', () => {
    expect(manifest).toContain('<file href="index.html" />');
    expect(manifest).toContain('<file href="data/course.json" />');
    expect(manifest).toContain('<file href="slides/01_intro.png" />');
  });

  test('carries the mastery score', () => {
    expect(manifest).toContain('<adlcp:masteryscore>60</adlcp:masteryscore>');
  });

  test('has balanced structural tags and XML declaration', () => {
    expect(manifest.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    for (const tag of [
      'manifest',
      'metadata',
      'organizations',
      'organization',
      'resources',
      'resource',
      'title',
      'item',
    ]) {
      const opens = manifest.match(new RegExp(`<${tag}[\\s>]`, 'g'))?.length ?? 0;
      const closes = manifest.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
      expect(closes, `unbalanced <${tag}>`).toBe(opens);
    }
    // No raw unescaped ampersands or angle brackets leaked from the title.
    expect(manifest).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

// ─── sanitizeFileName / sceneFileStem ─────────────────────────

describe('sanitizeFileName', () => {
  test('strips path-hostile characters and collapses whitespace', () => {
    expect(sanitizeFileName('¿Qué es / SCORM? <test>')).toBe('¿Qué_es_SCORM_test');
  });

  test('falls back to "scene" when nothing survives', () => {
    expect(sanitizeFileName('///***')).toBe('scene');
  });

  test('caps length at 60 chars', () => {
    expect(sanitizeFileName('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('sceneFileStem', () => {
  test('zero-pads the index and prefixes it to the safe title', () => {
    expect(sceneFileStem(0, 'Intro a React')).toBe('01_Intro_a_React');
    expect(sceneFileStem(11, 'Cierre')).toBe('12_Cierre');
  });
});

// ─── buildTranscript / sceneAudioIds ──────────────────────────

function makeSpeechScene(actions: Partial<SpeechAction>[]): Scene {
  return {
    id: 's1',
    stageId: 'stage1',
    type: 'slide',
    title: 'Escena',
    order: 0,
    content: { type: 'slide', canvas: {} as never },
    actions: actions.map(
      (a, i) => ({ id: `a${i}`, type: 'speech', text: '', ...a }) as SpeechAction,
    ),
  } as unknown as Scene;
}

describe('buildTranscript', () => {
  test('joins speech texts in playback order', () => {
    const scene = makeSpeechScene([{ text: 'Hola.' }, { text: 'Bienvenidos al curso.' }]);
    expect(buildTranscript(scene)).toBe('Hola.\n\nBienvenidos al curso.');
  });

  test('returns undefined when there is no narration', () => {
    const scene = makeSpeechScene([]);
    expect(buildTranscript(scene)).toBeUndefined();
  });
});

describe('sceneAudioIds', () => {
  test('collects unique audioIds preserving order', () => {
    const scene = makeSpeechScene([
      { text: 'a', audioId: 'audio-1' },
      { text: 'b', audioId: 'audio-2' },
      { text: 'c', audioId: 'audio-1' },
      { text: 'd' },
    ]);
    expect(sceneAudioIds(scene)).toEqual(['audio-1', 'audio-2']);
  });
});

// ─── quizToScormQuestions ─────────────────────────────────────

describe('quizToScormQuestions', () => {
  test('maps questions with options, answers and analysis', () => {
    const content: QuizContent = {
      type: 'quiz',
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
          analysis: 'Aritmética básica',
          points: 2,
          hasAnswer: true,
        },
        { id: 'q2', type: 'short_answer', question: 'Explica.' },
      ],
    };
    const result = quizToScormQuestions(content);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 'q1',
      type: 'single',
      answer: ['B'],
      analysis: 'Aritmética básica',
      points: 2,
    });
    expect(result[1]).toMatchObject({ id: 'q2', type: 'short_answer' });
    expect(result[1]).not.toHaveProperty('answer');
  });
});

// ─── audioExtension / buildPackageIdentifier ──────────────────

describe('audioExtension', () => {
  test('accepts known formats and defaults to mp3', () => {
    expect(audioExtension('wav')).toBe('wav');
    expect(audioExtension('MP3')).toBe('mp3');
    expect(audioExtension(undefined)).toBe('mp3');
    expect(audioExtension('../evil')).toBe('mp3');
  });
});

describe('buildPackageIdentifier', () => {
  test('produces a slugged, unique identifier', () => {
    const id = buildPackageIdentifier('Curso de Física 101');
    expect(id).toMatch(/^openmaic\.curso-de-f-sica-101\.[a-z0-9-]{8}$/);
    expect(buildPackageIdentifier('X')).not.toBe(buildPackageIdentifier('X'));
  });

  test('falls back to "course" for empty names', () => {
    expect(buildPackageIdentifier('!!!')).toMatch(/^openmaic\.course\./);
  });
});

// ─── Player template sanity ───────────────────────────────────

describe('SCORM_PLAYER_FILES', () => {
  test('ships the four static player files', () => {
    expect(Object.keys(SCORM_PLAYER_FILES).sort()).toEqual([
      'css/player.css',
      'index.html',
      'js/player.js',
      'js/scorm-api.js',
    ]);
  });

  test('index.html wires both scripts and the stylesheet', () => {
    const html = SCORM_PLAYER_FILES['index.html'];
    expect(html).toContain('js/scorm-api.js');
    expect(html).toContain('js/player.js');
    expect(html).toContain('css/player.css');
  });

  test('player consumes data/course.json and talks SCORM 1.2', () => {
    const player = SCORM_PLAYER_FILES['js/player.js'];
    expect(player).toContain("fetch('data/course.json')");
    expect(player).toContain('cmi.core.score.raw');
    expect(player).toContain('cmi.core.lesson_status');
    const api = SCORM_PLAYER_FILES['js/scorm-api.js'];
    expect(api).toContain('LMSInitialize');
    expect(api).toContain('LMSCommit');
    expect(api).toContain('LMSFinish');
  });
});
