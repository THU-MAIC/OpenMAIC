import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import type { Scene } from '@/lib/types/stage';

vi.mock('@/lib/device-storage/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: { mediaFiles: { get: vi.fn().mockResolvedValue(undefined) } },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  getAssetPool: () => ({ resolve: vi.fn().mockResolvedValue(null), release: vi.fn() }),
}));

import { buildPptxBlob, buildResourcePackZip } from '@/lib/export/use-export-pptx';
import {
  interactivePagePath,
  listInteractivePages,
  planPptxDeck,
  pptxDeckScenes,
  relativeHyperlinkTarget,
} from '@/lib/export/pptx-scene-placeholders';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

function slide(id: string, elements: unknown[] = []): Slide {
  return {
    id,
    viewportSize: 1000,
    viewportRatio: 0.5625,
    background: { type: 'solid', color: '#ffffff' },
    theme: {
      fontName: 'Arial',
      fontColor: '#111111',
      backgroundColor: '#fafafa',
      themeColors: ['#2255aa'],
    },
    elements,
  } as unknown as Slide;
}

function slideScene(id: string, canvas: Slide): Scene {
  return {
    id,
    stageId: 'stage-1',
    type: 'slide',
    title: `Slide ${id}`,
    order: 0,
    content: { type: 'slide', canvas },
  } as Scene;
}

function interactiveScene(id: string, title: unknown, html = '<p>page</p>'): Scene {
  return {
    id,
    stageId: 'stage-1',
    type: 'interactive',
    title,
    order: 0,
    content: { type: 'interactive', url: '', html },
    actions: [{ id: `${id}-speech`, type: 'speech', text: `Narration for ${id}` }],
  } as unknown as Scene;
}

function quizScene(id: string, title: string): Scene {
  return {
    id,
    stageId: 'stage-1',
    type: 'quiz',
    title,
    order: 0,
    actions: [{ id: `${id}-speech`, type: 'speech', text: 'The answer is A: SECRET-NARRATION' }],
    content: {
      type: 'quiz',
      questions: [
        {
          id: 'q1',
          type: 'single',
          question: 'Which planet is largest?',
          options: [
            { label: 'Jupiter', value: 'A' },
            { label: 'Mars', value: 'B' },
          ],
          answer: ['A'],
          analysis: 'SECRET-ANALYSIS',
        },
        { id: 'q2', type: 'short_answer', question: 'Explain   orbital\nresonance.' },
      ],
    },
  } as unknown as Scene;
}

function pblScene(id: string): Scene {
  return {
    id,
    stageId: 'stage-1',
    type: 'pbl',
    title: 'Project week',
    order: 0,
    content: { type: 'pbl', projectConfig: {} },
  } as unknown as Scene;
}

// Slide A links to slide B. Lesson order puts an interactive, a quiz and a PBL
// scene between them, so B's PPTX slide number differs from its slides index.
const slideB = slide('slide-b');
const slideA = slide('slide-a', [
  {
    id: 'link-shape',
    type: 'shape',
    left: 100,
    top: 100,
    width: 200,
    height: 100,
    rotate: 0,
    viewBox: [200, 100],
    path: 'M0 0 L200 0 L200 100 L0 100 Z',
    fill: '#ff0000',
    fixedRatio: false,
    link: { type: 'slide', target: 'slide-b' },
  },
]);
const sceneA = slideScene('a', slideA);
const sceneB = slideScene('b', slideB);
const lesson: Scene[] = [
  sceneA,
  interactiveScene('i1', 'Demo #1: 50% done?'),
  quizScene('q', 'Check-in'),
  pblScene('p'),
  interactiveScene('i-empty', 'No html', ''),
  sceneB,
];

const ratioPx2Pt = (96 / 72) * (1000 / 960);

/** Plan and build a PPTX the way the Resource Pack hook does. */
function buildLessonPptx(scenes: Scene[]) {
  const slideScenes = scenes.filter((s) => s.content.type === 'slide');
  const slides = slideScenes.map((s) => (s.content as { canvas: Slide }).canvas);
  return buildPptxBlob(
    slides,
    slideScenes,
    0.5625,
    1000,
    100,
    ratioPx2Pt,
    'stage-1',
    planPptxDeck(scenes, t, { linkInteractivePages: true }),
  );
}

function buildPack(scenes: Scene[], getPptxBlob = () => buildLessonPptx(scenes)) {
  return buildResourcePackZip(scenes, {
    viewportRatio: 0.5625,
    viewportSize: 1000,
    ratioPx2Inch: 100,
    ratioPx2Pt,
    fileName: 'deck',
    getPptxBlob,
  });
}

async function loadZip(blob: Blob) {
  return JSZip.loadAsync(await blob.arrayBuffer());
}

async function readText(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  if (!file) throw new Error(`missing ${name}`);
  return file.async('string');
}

function buildDeck(linkInteractivePages: boolean) {
  return buildPptxBlob(
    [slideA, slideB],
    [sceneA, sceneB],
    0.5625,
    1000,
    1000 / 10,
    (96 / 72) * (1000 / 960),
    'stage-1',
    planPptxDeck(lesson, t, { linkInteractivePages }),
  );
}

describe('interactive page naming', () => {
  it('numbers only scenes that have html and sanitizes illegal file-name characters', () => {
    const pages = listInteractivePages(lesson);
    expect(pages.map((p) => p.path)).toEqual(['interactive/01_Demo #1_ 50% done_.html']);
    expect(interactivePagePath(12, 'a/b')).toBe('interactive/12_a_b.html');
  });

  it('falls back to a numbered file name for a missing or blank title', () => {
    const pages = listInteractivePages([
      interactiveScene('u1', undefined),
      interactiveScene('u2', '   '),
      interactiveScene('u3', '  Spaced  '),
    ]);
    expect(pages.map((p) => p.path)).toEqual([
      'interactive/01.html',
      'interactive/02.html',
      'interactive/03_Spaced.html',
    ]);
  });

  it('percent-encodes URI-significant characters but keeps non-ASCII text', () => {
    expect(relativeHyperlinkTarget('interactive/01_Demo #1_ 50% done_.html')).toBe(
      'interactive/01_Demo%20%231_%2050%25%20done_.html',
    );
    expect(relativeHyperlinkTarget('interactive/02_Ångström.html')).toBe(
      'interactive/02_Ångström.html',
    );
  });
});

describe('planPptxDeck', () => {
  it('keeps lesson order, skips PBL and html-less interactive scenes', () => {
    const deck = planPptxDeck(lesson, t, { linkInteractivePages: true });
    expect(
      deck.map((e) => (e.kind === 'slide' ? `slide:${e.slideIndex}` : e.placeholder.scene.id)),
    ).toEqual(['slide:0', 'i1', 'q', 'slide:1']);
  });

  it('links interactive placeholders to the pack page only when a pack ships', () => {
    const withPack = planPptxDeck(lesson, t, { linkInteractivePages: true });
    const standalone = planPptxDeck(lesson, t, { linkInteractivePages: false });
    const [packEntry, standaloneEntry] = [withPack[1], standalone[1]];
    if (packEntry.kind !== 'placeholder' || standaloneEntry.kind !== 'placeholder') {
      throw new Error('expected placeholders');
    }
    expect(packEntry.placeholder.link?.target).toBe(
      relativeHyperlinkTarget(listInteractivePages(lesson)[0].path),
    );
    expect(packEntry.placeholder.description).toBe('export.placeholder.interactiveDesc');
    expect(standaloneEntry.placeholder.link).toBeUndefined();
    expect(standaloneEntry.placeholder.description).toBe(
      'export.placeholder.interactiveDescNoPack',
    );
  });

  it('summarizes a quiz by count and question stems', () => {
    const quiz = planPptxDeck(lesson, t, { linkInteractivePages: false })[2];
    if (quiz.kind !== 'placeholder') throw new Error('expected placeholder');
    expect(quiz.placeholder.meta).toBe('export.placeholder.quizQuestionCount:{"count":2}');
    expect(quiz.placeholder.items).toEqual([
      'Which planet is largest?',
      'Explain orbital resonance.',
    ]);
  });
});

describe('buildPptxBlob with scene placeholders', () => {
  it('emits slides in lesson order with placeholders in place', async () => {
    const zip = await loadZip(await buildDeck(true));
    const slideFiles = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    expect(slideFiles).toHaveLength(4);

    expect(await readText(zip, 'ppt/slides/slide2.xml')).toContain('Demo #1: 50% done?');
    const quizXml = await readText(zip, 'ppt/slides/slide3.xml');
    expect(quizXml).toContain('Check-in');
    expect(quizXml).toContain('Which planet is largest?');
    // Question stems only: options, answers and analysis stay out of the deck.
    expect(quizXml).not.toContain('Jupiter');
    expect(quizXml).not.toContain('SECRET-ANALYSIS');
    for (const name of slideFiles) {
      expect(await readText(zip, name)).not.toContain('Project week');
    }
  });

  it('resolves slide-to-slide links to the PPTX slide number after insertion', async () => {
    const zip = await loadZip(await buildDeck(true));
    const rels = await readText(zip, 'ppt/slides/_rels/slide1.xml.rels');
    // slide-b is slides[1] but the 4th PPTX slide (two placeholders before it).
    expect(rels).toMatch(/relationships\/slide" Target="slide4\.xml"/);
    expect(rels).not.toContain('Target="slide2.xml"');
  });

  it('writes the interactive link as an external relationship with the relative target', async () => {
    const zip = await loadZip(await buildDeck(true));
    const rels = await readText(zip, 'ppt/slides/_rels/slide2.xml.rels');
    expect(rels).toContain(
      'Target="interactive/01_Demo%20%231_%2050%25%20done_.html" TargetMode="External"',
    );
    const xml = await readText(zip, 'ppt/slides/slide2.xml');
    expect(xml).toContain('export.placeholder.openInteractive');
    expect(xml).toContain('<a:hlinkClick');
  });

  it('omits the interactive link in a standalone PPTX', async () => {
    const zip = await loadZip(await buildDeck(false));
    const rels = await readText(zip, 'ppt/slides/_rels/slide2.xml.rels');
    expect(rels).not.toContain('interactive/');
    expect(await readText(zip, 'ppt/slides/slide2.xml')).toContain(
      'export.placeholder.interactiveDescNoPack',
    );
  });

  it('keeps the slide-only layout when no deck plan is passed', async () => {
    const blob = await buildPptxBlob(
      [slideA, slideB],
      [sceneA, sceneB],
      0.5625,
      1000,
      100,
      (96 / 72) * (1000 / 960),
      'stage-1',
    );
    const zip = await loadZip(blob);
    const rels = await readText(zip, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels).toMatch(/relationships\/slide" Target="slide2\.xml"/);
    expect(zip.file('ppt/slides/slide3.xml')).toBeNull();
  });
});

describe('Resource Pack with scene placeholders', () => {
  it('ships the HTML page at the path the PPTX placeholder links to', async () => {
    const result = await buildPack(lesson, () => buildDeck(true));
    const pack = await loadZip(result.blob!);
    const pptx = await JSZip.loadAsync(await pack.file('deck.pptx')!.async('uint8array'));
    const rels = await readText(pptx, 'ppt/slides/_rels/slide2.xml.rels');
    const target = rels.match(/Target="(interactive\/[^"]+)" TargetMode="External"/)?.[1];
    expect(target).toBeDefined();
    expect(pack.file(decodeURIComponent(target!))).not.toBeNull();
  });
});

describe('speaker notes on placeholder slides', () => {
  it('keeps interactive narration but leaves quiz narration out', async () => {
    const zip = await loadZip(await buildDeck(true));
    // slide2 = interactive placeholder, slide3 = quiz placeholder
    expect(await readText(zip, 'ppt/notesSlides/notesSlide2.xml')).toContain('Narration for i1');
    const quizNotes = await readText(zip, 'ppt/notesSlides/notesSlide3.xml');
    expect(quizNotes).not.toContain('SECRET-NARRATION');
    expect(quizNotes).not.toContain('The answer is');
  });
});

describe('placeholder-only lessons', () => {
  it('counts quiz and interactive scenes as PPTX content, but not PBL', () => {
    expect(pptxDeckScenes([quizScene('q', 'Q')])).toHaveLength(1);
    expect(pptxDeckScenes([interactiveScene('i', 'I')])).toHaveLength(1);
    expect(pptxDeckScenes([interactiveScene('i', 'I', '')])).toHaveLength(0);
    expect(pptxDeckScenes([pblScene('p')])).toHaveLength(0);
  });

  it('exports a quiz-only lesson as a one-slide PPTX with fallback styling', async () => {
    const zip = await loadZip(await buildLessonPptx([quizScene('q', 'Only quiz')]));
    expect(zip.file('ppt/slides/slide2.xml')).toBeNull();
    const xml = await readText(zip, 'ppt/slides/slide1.xml');
    expect(xml).toContain('Only quiz');
    expect(xml).toContain('<a:srgbClr val="FFFFFF"/>');
  });

  it('ships a pack with the HTML page and the PPTX for interactive + quiz', async () => {
    const scenes = [interactiveScene('i', 'Widget'), quizScene('q', 'Check')];
    const result = await buildPack(scenes);
    expect(result.empty).toBe(false);
    const pack = await loadZip(result.blob!);
    expect(pack.file('interactive/01_Widget.html')).not.toBeNull();
    const pptx = await JSZip.loadAsync(await pack.file('deck.pptx')!.async('uint8array'));
    expect(pptx.file('ppt/slides/slide2.xml')).not.toBeNull();
    expect(await readText(pptx, 'ppt/slides/_rels/slide1.xml.rels')).toContain(
      'Target="interactive/01_Widget.html" TargetMode="External"',
    );
  });

  it('still reports a PBL-only lesson as empty', async () => {
    const getPptxBlob = vi.fn(async () => new Blob([new Uint8Array([1])]));
    const result = await buildPack([pblScene('p')], getPptxBlob);
    expect(result.empty).toBe(true);
    expect(result.blob).toBeNull();
    expect(getPptxBlob).not.toHaveBeenCalled();
  });
});

describe('untitled interactive scenes', () => {
  it('exports without throwing and uses one path for the ZIP entry and the link', async () => {
    const scenes = [interactiveScene('i', undefined), slideScene('s', slide('s'))];
    const deck = planPptxDeck(scenes, t, { linkInteractivePages: true });
    const first = deck[0];
    if (first.kind !== 'placeholder') throw new Error('expected placeholder');
    expect(first.placeholder.title).toBe('export.placeholder.interactiveLabel');
    expect(first.placeholder.link?.path).toBe('interactive/01.html');

    const result = await buildPack(scenes);
    const pack = await loadZip(result.blob!);
    expect(pack.file('interactive/01.html')).not.toBeNull();
    const pptx = await JSZip.loadAsync(await pack.file('deck.pptx')!.async('uint8array'));
    expect(await readText(pptx, 'ppt/slides/_rels/slide1.xml.rels')).toContain(
      'Target="interactive/01.html" TargetMode="External"',
    );
  });
});
