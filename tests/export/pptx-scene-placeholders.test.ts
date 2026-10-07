import { inflateSync } from 'node:zlib';
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
  truncateToWidth,
} from '@/lib/export/pptx-scene-placeholders';
import { qrMatrix } from '@/lib/export/qr-png';
import { legacyPBLSceneFixture } from '../fixtures/pbl-v1-scene';

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

const microtask = (id: string) => ({
  id,
  title: `Task ${id}`,
  status: 'todo',
  assignee: 'user',
  hints: ['SECRET-HINT'],
  order: 0,
});
const milestone = (id: string, title: string, order: number) => ({
  id,
  title,
  description: 'SECRET-MILESTONE-DESCRIPTION',
  status: 'locked',
  order,
  microtasks: [microtask(`${id}-t`)],
});

/** A runnable PBL v2 project with secrets planted where slides must not look. */
function pblProject(overrides: Record<string, unknown> = {}) {
  return {
    uiPhase: 'hero',
    title: 'Design a school greenhouse',
    description: 'Plan a greenhouse on a budget.',
    learningObjective: 'Apply the limiting factors of photosynthesis to a real design.',
    tags: [],
    language: 'en-US',
    proficiency: 'beginner',
    status: 'active',
    scenario: {
      setting: 'SECRET-SETTING',
      goal: 'Present a design the principal can approve.',
      learnerRole: 'Lead designer',
      characters: [{ id: 'c1', name: 'Ms. Rivera', persona: 'SECRET-PERSONA' }],
    },
    roles: [{ id: 'r1', type: 'instructor', name: 'Coach', systemPrompt: 'SECRET-ROLE-PROMPT' }],
    // Listed out of order: the slide follows `order`.
    milestones: [
      milestone('m2', 'Sketch the design', 1),
      milestone('m1', 'Research limiting factors', 0),
    ],
    submissions: [{ id: 's1', content: 'SECRET-SUBMISSION' }],
    evaluations: [{ id: 'e1', rubric: 'SECRET-RUBRIC', feedback: 'SECRET-EVALUATION' }],
    threads: [{ id: 'th1', messages: [{ id: 'msg', content: 'SECRET-CHAT' }] }],
    engagementEvents: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const PBL_SECRETS = [
  'SECRET-HINT',
  'SECRET-MILESTONE-DESCRIPTION',
  'SECRET-SETTING',
  'SECRET-PERSONA',
  'SECRET-ROLE-PROMPT',
  'SECRET-SUBMISSION',
  'SECRET-RUBRIC',
  'SECRET-EVALUATION',
  'SECRET-CHAT',
  'SECRET-PBL-NARRATION',
];

function pblScene(
  id: string,
  content: Record<string, unknown> = { projectV2: pblProject() },
): Scene {
  return {
    id,
    stageId: 'stage-1',
    type: 'pbl',
    title: 'Project week',
    order: 0,
    actions: [{ id: `${id}-speech`, type: 'speech', text: 'SECRET-PBL-NARRATION' }],
    content: { type: 'pbl', ...content },
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

const CLASSROOM_URL = 'https://example.org/classroom/stage-1';
const sceneUrl = (sceneId: string) => `https://example.org/classroom/stage-1?scene=${sceneId}`;

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
    planPptxDeck(scenes, t, { linkInteractivePages: true, classroomUrl: CLASSROOM_URL }),
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

function buildDeck(linkInteractivePages: boolean, classroomUrl: string | null = CLASSROOM_URL) {
  return buildPptxBlob(
    [slideA, slideB],
    [sceneA, sceneB],
    0.5625,
    1000,
    1000 / 10,
    (96 / 72) * (1000 / 960),
    'stage-1',
    planPptxDeck(lesson, t, {
      linkInteractivePages,
      classroomUrl: classroomUrl ?? undefined,
    }),
  );
}

/** Module matrix read back from a 1-bit grayscale PNG (true = dark). */
function readQrPng(png: Uint8Array, modulesPerSide: number): boolean[][] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let pos = 8;
  let width = 0;
  const idat: Uint8Array[] = [];
  while (pos < png.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = new DataView(data.buffer, data.byteOffset).getUint32(0);
      expect([data[8], data[9]]).toEqual([1, 0]); // 1-bit grayscale
    }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = Math.ceil(width / 8);
  const scale = width / modulesPerSide;
  const pixelIsDark = (x: number, y: number) => {
    const byte = raw[y * (rowBytes + 1) + 1 + (x >> 3)];
    return (byte & (0x80 >> (x & 7))) === 0;
  };
  return Array.from({ length: modulesPerSide }, (_, my) =>
    Array.from({ length: modulesPerSide }, (_, mx) =>
      pixelIsDark(Math.floor((mx + 0.5) * scale), Math.floor((my + 0.5) * scale)),
    ),
  );
}

/** The PNG image a slide references, read from the PPTX. */
async function slideImage(zip: JSZip, slideNumber: number): Promise<Uint8Array | null> {
  const rels = await readText(zip, `ppt/slides/_rels/slide${slideNumber}.xml.rels`);
  const target = rels.match(/relationships\/image" Target="\.\.\/media\/([^"]+\.png)"/)?.[1];
  if (!target) return null;
  return zip.file(`ppt/media/${target}`)!.async('uint8array');
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
  it('keeps lesson order with PBL in place and skips html-less interactive scenes', () => {
    const deck = planPptxDeck(lesson, t, { linkInteractivePages: true });
    expect(
      deck.map((e) => (e.kind === 'slide' ? `slide:${e.slideIndex}` : e.placeholder.scene.id)),
    ).toEqual(['slide:0', 'i1', 'q', 'p', 'slide:1']);
  });

  it('links interactive placeholders to the offline page only when a pack ships', () => {
    const withPack = planPptxDeck(lesson, t, {
      linkInteractivePages: true,
      classroomUrl: CLASSROOM_URL,
    });
    const standalone = planPptxDeck(lesson, t, {
      linkInteractivePages: false,
      classroomUrl: CLASSROOM_URL,
    });
    const [packEntry, standaloneEntry] = [withPack[1], standalone[1]];
    if (packEntry.kind !== 'placeholder' || standaloneEntry.kind !== 'placeholder') {
      throw new Error('expected placeholders');
    }
    expect(packEntry.placeholder.offline?.target).toBe(
      relativeHyperlinkTarget(listInteractivePages(lesson)[0].path),
    );
    expect(standaloneEntry.placeholder.offline).toBeUndefined();
    // Both link to the scene in the online classroom.
    expect(packEntry.placeholder.online?.url).toBe(sceneUrl('i1'));
    expect(standaloneEntry.placeholder.online?.url).toBe(sceneUrl('i1'));
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
    expect(slideFiles).toHaveLength(5);

    expect(await readText(zip, 'ppt/slides/slide2.xml')).toContain('Demo #1: 50% done?');
    const quizXml = await readText(zip, 'ppt/slides/slide3.xml');
    expect(quizXml).toContain('Check-in');
    expect(quizXml).toContain('Which planet is largest?');
    // Question stems only: options, answers and analysis stay out of the deck.
    expect(quizXml).not.toContain('Jupiter');
    expect(quizXml).not.toContain('SECRET-ANALYSIS');
    expect(await readText(zip, 'ppt/slides/slide4.xml')).toContain('Project week');
  });

  it('resolves slide-to-slide links to the PPTX slide number after insertion', async () => {
    const zip = await loadZip(await buildDeck(true));
    const rels = await readText(zip, 'ppt/slides/_rels/slide1.xml.rels');
    // slide-b is slides[1] but the 5th PPTX slide (three placeholders before it).
    expect(rels).toMatch(/relationships\/slide" Target="slide5\.xml"/);
    expect(rels).not.toContain('Target="slide2.xml"');
  });

  it('writes the interactive link as an external relationship with the relative target', async () => {
    const zip = await loadZip(await buildDeck(true));
    const rels = await readText(zip, 'ppt/slides/_rels/slide2.xml.rels');
    expect(rels).toContain(
      'Target="interactive/01_Demo%20%231_%2050%25%20done_.html" TargetMode="External"',
    );
    const xml = await readText(zip, 'ppt/slides/slide2.xml');
    expect(xml).toContain('export.placeholder.openOffline');
    expect(xml).toContain('<a:hlinkClick');
  });

  it('omits the offline link in a standalone PPTX', async () => {
    const zip = await loadZip(await buildDeck(false));
    const rels = await readText(zip, 'ppt/slides/_rels/slide2.xml.rels');
    expect(rels).not.toContain('interactive/');
    expect(await readText(zip, 'ppt/slides/slide2.xml')).not.toContain(
      'export.placeholder.openOffline',
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
  it('counts quiz, interactive and PBL scenes as PPTX content', () => {
    expect(pptxDeckScenes([quizScene('q', 'Q')])).toHaveLength(1);
    expect(pptxDeckScenes([interactiveScene('i', 'I')])).toHaveLength(1);
    expect(pptxDeckScenes([interactiveScene('i', 'I', '')])).toHaveLength(0);
    expect(pptxDeckScenes([pblScene('p')])).toHaveLength(1);
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

  it('exports a PBL-only lesson as a PPTX, with no HTML page in the pack', async () => {
    const result = await buildPack([pblScene('p')]);
    expect(result.empty).toBe(false);
    const pack = await loadZip(result.blob!);
    expect(Object.keys(pack.files).filter((n) => !pack.files[n].dir)).toEqual(['deck.pptx']);
    const pptx = await JSZip.loadAsync(await pack.file('deck.pptx')!.async('uint8array'));
    expect(await readText(pptx, 'ppt/slides/slide1.xml')).toContain('Project week');
    expect(pptx.file('ppt/slides/slide2.xml')).toBeNull();
  });

  it('reports a lesson without any exportable scene as empty', async () => {
    const getPptxBlob = vi.fn(async () => new Blob([new Uint8Array([1])]));
    const result = await buildPack([interactiveScene('i', 'No html', '')], getPptxBlob);
    expect(result.empty).toBe(true);
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
    expect(first.placeholder.offline?.path).toBe('interactive/01.html');

    const result = await buildPack(scenes);
    const pack = await loadZip(result.blob!);
    expect(pack.file('interactive/01.html')).not.toBeNull();
    const pptx = await JSZip.loadAsync(await pack.file('deck.pptx')!.async('uint8array'));
    expect(await readText(pptx, 'ppt/slides/_rels/slide1.xml.rels')).toContain(
      'Target="interactive/01.html" TargetMode="External"',
    );
  });
});

describe('online link and QR code', () => {
  for (const linkInteractivePages of [true, false]) {
    const mode = linkInteractivePages ? 'Resource Pack PPTX' : 'standalone PPTX';

    it(`links every placeholder to its online scene in the ${mode}`, async () => {
      const zip = await loadZip(await buildDeck(linkInteractivePages));
      for (const [slideNumber, sceneId] of [
        [2, 'i1'],
        [3, 'q'],
      ] as const) {
        const rels = await readText(zip, `ppt/slides/_rels/slide${slideNumber}.xml.rels`);
        expect(rels).toContain(`Target="${sceneUrl(sceneId)}" TargetMode="External"`);
        const xml = await readText(zip, `ppt/slides/slide${slideNumber}.xml`);
        expect(xml).toContain('export.placeholder.openOnline');
        expect(xml).toContain(sceneUrl(sceneId));
      }
    });

    it(`embeds a QR code that encodes the online scene URL in the ${mode}`, async () => {
      const zip = await loadZip(await buildDeck(linkInteractivePages));
      for (const [slideNumber, sceneId] of [
        [2, 'i1'],
        [3, 'q'],
      ] as const) {
        const png = await slideImage(zip, slideNumber);
        expect(png).not.toBeNull();
        const expected = await qrMatrix(sceneUrl(sceneId));
        expect(readQrPng(png!, expected.length)).toEqual(expected);
      }
    });
  }

  it('draws no button or QR code without an online classroom', async () => {
    const zip = await loadZip(await buildDeck(true, null));
    expect(await slideImage(zip, 3)).toBeNull();
    expect(await readText(zip, 'ppt/slides/slide3.xml')).not.toContain(
      'export.placeholder.openOnline',
    );
  });

  it('keeps the quiet zone light around the code', async () => {
    const matrix = await qrMatrix(sceneUrl('q'));
    const edge = [...matrix[0], ...matrix[matrix.length - 1], ...matrix.map((row) => row[0])];
    expect(edge.every((dark) => !dark)).toBe(true);
  });
});

describe('link hotspots', () => {
  interface SlideShape {
    index: number;
    xml: string;
    box: { x: number; y: number; w: number; h: number };
    target?: string;
    hasText: boolean;
  }

  async function slideShapes(zip: JSZip, slideNumber: number): Promise<SlideShape[]> {
    const xml = await readText(zip, `ppt/slides/slide${slideNumber}.xml`);
    const rels = await readText(zip, `ppt/slides/_rels/slide${slideNumber}.xml.rels`);
    const targets = new Map(
      [...rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
    return [...xml.matchAll(/<p:(sp|pic)>[\s\S]*?<\/p:\1>/g)].map((m, index) => {
      const shape = m[0];
      const off = shape.match(/<a:off x="(\d+)" y="(\d+)"\/>/)!;
      const ext = shape.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/)!;
      const rId = shape.match(/<a:hlinkClick r:id="(rId\d+)"/)?.[1];
      return {
        index,
        xml: shape,
        box: { x: +off[1], y: +off[2], w: +ext[1], h: +ext[2] },
        target: rId ? targets.get(rId) : undefined,
        hasText: /<a:t>[^<]+<\/a:t>/.test(shape),
      };
    });
  }

  const covers = (outer: SlideShape['box'], inner: SlideShape['box']) =>
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h;
  const overlaps = (a: SlideShape['box'], b: SlideShape['box']) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const isHotspot = (s: SlideShape) =>
    !!s.target &&
    !s.hasText &&
    !s.xml.includes('<p:txBody>') &&
    /<p:cNvPr [^>]*><a:hlinkClick /.test(s.xml) &&
    /<\/a:prstGeom><a:solidFill><a:srgbClr val="FFFFFF"><a:alpha val="0"\/>/.test(s.xml) &&
    /<a:ln[^>]*><a:solidFill><a:srgbClr val="FFFFFF"><a:alpha val="0"\/>/.test(s.xml);

  for (const linkInteractivePages of [true, false]) {
    const mode = linkInteractivePages ? 'Resource Pack PPTX' : 'standalone PPTX';

    it(`puts a top-most invisible hotspot over every link in the ${mode}`, async () => {
      const zip = await loadZip(await buildDeck(linkInteractivePages));
      for (const [slideNumber, expectedHotspots] of [
        [2, linkInteractivePages ? 3 : 2], // interactive: button, QR + URL, offline link
        [3, 2], // quiz: button, QR + URL
      ] as const) {
        const shapes = await slideShapes(zip, slideNumber);
        const hotspots = shapes.filter(isHotspot);
        expect(hotspots).toHaveLength(expectedHotspots);

        // Visible linked elements: the button shape and every linked text box.
        const linked = shapes.filter(
          (s) => s.target && !isHotspot(s) && (s.hasText || s.xml.includes('prst="roundRect"')),
        );
        expect(linked.length).toBeGreaterThanOrEqual(expectedHotspots);
        for (const element of linked) {
          const hotspot = hotspots.find(
            (h) =>
              h.index > element.index && h.target === element.target && covers(h.box, element.box),
          );
          expect(hotspot, `hotspot over ${element.xml.slice(0, 80)}`).toBeDefined();
          // Nothing is drawn above the hotspot where it lies.
          const above = shapes.filter(
            (s) => s.index > hotspot!.index && overlaps(s.box, hotspot!.box),
          );
          expect(above).toEqual([]);
        }
      }
    });
  }

  it('covers the QR code and the URL under it with one hotspot', async () => {
    const zip = await loadZip(await buildDeck(false));
    const shapes = await slideShapes(zip, 3);
    const qr = shapes.find((s) => s.xml.startsWith('<p:pic>'))!;
    const url = shapes.find((s) => s.hasText && s.xml.includes(`>${sceneUrl('q')}<`))!;
    const hotspot = shapes.find(
      (s) => isHotspot(s) && covers(s.box, qr.box) && covers(s.box, url.box),
    );
    expect(hotspot?.target).toBe(sceneUrl('q'));
  });
});

describe('PBL placeholders', () => {
  const pblEntry = (
    scene: Scene,
    options = { linkInteractivePages: true, classroomUrl: CLASSROOM_URL },
  ) => {
    const entry = planPptxDeck([scene], t, options)[0];
    if (entry.kind !== 'placeholder') throw new Error('expected placeholder');
    return entry.placeholder;
  };

  it('summarizes the goal and milestones in order, with no offline link', () => {
    const placeholder = pblEntry(pblScene('p'));
    expect(placeholder.sceneType).toBe('pbl');
    expect(placeholder.typeLabel).toBe('export.placeholder.pblLabel');
    expect(placeholder.title).toBe('Project week');
    expect(placeholder.description).toBe('export.placeholder.pblDesc');
    expect(placeholder.lead).toBe(
      'export.placeholder.pblGoal:{"goal":"Apply the limiting factors of photosynthesis to a real design."}',
    );
    expect(placeholder.meta).toBe('export.placeholder.pblMilestoneCount:{"count":2}');
    expect(placeholder.items).toEqual(['Research limiting factors', 'Sketch the design']);
    expect(placeholder.online?.url).toBe(sceneUrl('p'));
    expect(placeholder.offline).toBeUndefined();
  });

  it('falls back to the scenario goal and truncates long goals, titles and milestones', () => {
    const long = (word: string) => Array.from({ length: 40 }, () => word).join(' ');
    const placeholder = pblEntry(
      pblScene('p', {
        projectV2: pblProject({
          learningObjective: '',
          scenario: { goal: long('goal'), characters: [] },
          milestones: Array.from({ length: 6 }, (_, i) => milestone(`m${i}`, long(`m${i}`), i)),
        }),
      }),
    );
    expect(placeholder.lead).toMatch(/"goal":"goal goal .*…"/);
    const goal = JSON.parse(placeholder.lead!.slice(placeholder.lead!.indexOf(':') + 1)).goal;
    expect(goal.length).toBeLessThanOrEqual(64);
    // The count says how many milestones there are; four titles are listed.
    expect(placeholder.meta).toBe('export.placeholder.pblMilestoneCount:{"count":6}');
    expect(placeholder.items).toHaveLength(4);
    for (const item of placeholder.items!) {
      expect(item.length).toBeLessThanOrEqual(66);
      expect(item.endsWith('…')).toBe(true);
    }

    const untitled = pblEntry({ ...pblScene('p'), title: long('title') } as Scene);
    expect(untitled.title.length).toBeLessThanOrEqual(120);
  });

  it('cuts lines by display width, counting CJK characters twice', () => {
    expect(truncateToWidth('abc', 3)).toBe('abc');
    expect(truncateToWidth('abcdef', 4)).toBe('abc…');
    expect(truncateToWidth('设计一个火星基地', 8)).toBe('设计一…');
    expect(truncateToWidth('  a\n b  ', 10)).toBe('a b');
  });

  it('upgrades a legacy project the way the classroom does', () => {
    const placeholder = pblEntry({
      ...legacyPBLSceneFixture,
      stageId: 'stage-1',
    } as Scene);
    expect(placeholder.meta).toMatch(/pblMilestoneCount/);
    expect(placeholder.items!.length).toBeGreaterThan(0);
  });

  it('falls back to title and description when the project is missing or unreadable', () => {
    for (const content of [{}, { projectConfig: {} }, { projectV2: { title: 'broken' } }]) {
      const placeholder = pblEntry({ ...pblScene('p', content), title: '' } as Scene);
      expect(placeholder.title).toBe('export.placeholder.pblLabel');
      expect(placeholder.description).toBe('export.placeholder.pblDesc');
      expect(placeholder.lead).toBeUndefined();
      expect(placeholder.meta).toBeUndefined();
      expect(placeholder.items).toEqual([]);
    }
  });

  for (const linkInteractivePages of [true, false]) {
    const mode = linkInteractivePages ? 'Resource Pack PPTX' : 'standalone PPTX';

    it(`links online with a QR code and hotspots in the ${mode}, leaking nothing`, async () => {
      const zip = await loadZip(await buildDeck(linkInteractivePages));
      const xml = await readText(zip, 'ppt/slides/slide4.xml');
      const rels = await readText(zip, 'ppt/slides/_rels/slide4.xml.rels');
      expect(xml).toContain('Project week');
      expect(xml).toContain('Research limiting factors');
      expect(rels).toContain(`Target="${sceneUrl('p')}" TargetMode="External"`);
      expect(rels).not.toContain('interactive/');

      const png = await slideImage(zip, 4);
      const expected = await qrMatrix(sceneUrl('p'));
      expect(readQrPng(png!, expected.length)).toEqual(expected);

      const hotspots = [...xml.matchAll(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*<\/p:sp>/g)]
        .map((m) => m[0])
        .filter((sp) => sp.includes('<a:hlinkClick') && !/<a:t>[^<]+<\/a:t>/.test(sp))
        .filter((sp) => sp.includes('<a:alpha val="0"/>'));
      expect(hotspots).toHaveLength(2); // button, QR code + URL

      const notes = await readText(zip, 'ppt/notesSlides/notesSlide4.xml');
      for (const secret of PBL_SECRETS) {
        expect(xml).not.toContain(secret);
        expect(notes).not.toContain(secret);
      }
    });
  }
});

describe('placeholder slides turned off', () => {
  it('plans the slide scenes only', () => {
    const deck = planPptxDeck(lesson, t, {
      linkInteractivePages: true,
      classroomUrl: CLASSROOM_URL,
      includePlaceholders: false,
    });
    expect(deck).toEqual([
      { kind: 'slide', slideIndex: 0 },
      { kind: 'slide', slideIndex: 1 },
    ]);
    expect(pptxDeckScenes(lesson, { includePlaceholders: false })).toEqual([sceneA, sceneB]);
  });

  it('builds a slides-only PPTX in the Resource Pack, which still ships the HTML pages', async () => {
    const result = await buildResourcePackZip(lesson, {
      viewportRatio: 0.5625,
      viewportSize: 1000,
      ratioPx2Inch: 100,
      ratioPx2Pt,
      fileName: 'deck',
      includePlaceholders: false,
      getPptxBlob: () =>
        buildPptxBlob(
          [slideA, slideB],
          [sceneA, sceneB],
          0.5625,
          1000,
          100,
          ratioPx2Pt,
          'stage-1',
          planPptxDeck(lesson, t, {
            linkInteractivePages: true,
            classroomUrl: CLASSROOM_URL,
            includePlaceholders: false,
          }),
        ),
    });
    expect(result.skippedPptx).toBe(false);
    const pack = await loadZip(result.blob!);
    expect(pack.file('interactive/01_Demo #1_ 50% done_.html')).not.toBeNull();
    const pptx = await JSZip.loadAsync(await pack.file('deck.pptx')!.async('uint8array'));
    expect(pptx.file('ppt/slides/slide2.xml')).not.toBeNull();
    expect(pptx.file('ppt/slides/slide3.xml')).toBeNull();
    // Slide links point at the slides-only numbering again.
    expect(await readText(pptx, 'ppt/slides/_rels/slide1.xml.rels')).toMatch(
      /relationships\/slide" Target="slide2\.xml"/,
    );
  });

  it('ships the HTML pages without a PPTX when the lesson has no slide scene', async () => {
    const getPptxBlob = vi.fn(async () => new Blob([new Uint8Array([1])]));
    const scenes = [interactiveScene('i', 'Widget'), quizScene('q', 'Check'), pblScene('p')];
    const result = await buildResourcePackZip(scenes, {
      viewportRatio: 0.5625,
      viewportSize: 1000,
      ratioPx2Inch: 100,
      ratioPx2Pt,
      fileName: 'deck',
      includePlaceholders: false,
      getPptxBlob,
    });
    expect(result.empty).toBe(false);
    expect(result.skippedPptx).toBe(true);
    expect(getPptxBlob).not.toHaveBeenCalled();
    const pack = await loadZip(result.blob!);
    expect(Object.keys(pack.files).filter((n) => !pack.files[n].dir)).toEqual([
      'interactive/01_Widget.html',
    ]);
  });

  it('reports nothing to ship when there is neither a slide nor an HTML page', async () => {
    const result = await buildResourcePackZip([quizScene('q', 'Check'), pblScene('p')], {
      viewportRatio: 0.5625,
      viewportSize: 1000,
      ratioPx2Inch: 100,
      ratioPx2Pt,
      fileName: 'deck',
      includePlaceholders: false,
      getPptxBlob: vi.fn(),
    });
    expect(result.empty).toBe(true);
  });
});
