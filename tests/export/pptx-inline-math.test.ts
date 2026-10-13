// @vitest-environment jsdom
import JSZip from 'jszip';
import katex from 'katex';
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

import {
  createTextDocument,
  serializeTextDocument,
} from '../../packages/@openmaic/editor/src/react/text/prosemirror/document';
import { buildPptxBlob } from '@/lib/export/use-export-pptx';
import { proseToPlainText } from '@/lib/export/pptx-rich-text';
import { sanitizeProseHtml } from '@/lib/sanitize/scene-content';

/** Prose as the slide text editor serializes it: each formula a rendered KaTeX tree. */
function editorHtml(parts: (string | { latex: string })[]): string {
  const body = parts
    .map((part) => {
      if (typeof part === 'string') return part;
      const span = document.createElement('span');
      span.setAttribute('data-inline-math', part.latex);
      return span.outerHTML;
    })
    .join('');
  const html = serializeTextDocument(createTextDocument(`<p>${body}</p>`));
  // Guard the fixture: the editor output is a rendered KaTeX formula.
  expect(html).toContain('class="katex"');
  return html;
}

function slideWith(elements: Record<string, unknown>[]): Slide {
  return {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    background: { type: 'solid', color: '#ffffff' },
    theme: {
      fontName: 'Arial',
      fontColor: '#111111',
      backgroundColor: '#ffffff',
      themeColors: ['#111111'],
    },
    elements,
  } as unknown as Slide;
}

const geometry = { left: 40, top: 40, width: 600, height: 120, rotate: 0 };

function textElement(content: string): Record<string, unknown> {
  return { id: 'text-1', type: 'text', ...geometry, content, defaultFontName: 'Arial' };
}

async function exportedTextRuns(elements: Record<string, unknown>[]): Promise<string[]> {
  const slide = slideWith(elements);
  const scene = {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene',
    order: 1,
    content: { type: 'slide', canvas: slide },
  } as Scene;
  const blob = await buildPptxBlob([slide], [scene], 0.5625, 1000, 100, 1, 'stage-1');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return Array.from(doc.getElementsByTagName('a:t'), (node) => node.textContent ?? '');
}

const FORMULAS = ['E=mc^2', '\\frac{a}{b}', 'a<b \\& c'];

function sentence(): (string | { latex: string })[] {
  return [
    'Energy ',
    { latex: FORMULAS[0] },
    ', ratio ',
    { latex: FORMULAS[1] },
    ' and ',
    { latex: FORMULAS[2] },
    ' done.',
  ];
}

const EXPECTED_TEXT = `Energy ${FORMULAS[0]}, ratio ${FORMULAS[1]} and ${FORMULAS[2]} done.`;

describe('PPTX export of inline formulas in slide prose', () => {
  it('writes a stored formula as one run holding its LaTeX source', async () => {
    const stored = sanitizeProseHtml(editorHtml(sentence()));
    // The stored form: source only, no KaTeX markup.
    expect(stored).toContain('<span data-inline-math="E=mc^2">E=mc^2</span>');
    expect(stored).not.toContain('katex');

    const runs = await exportedTextRuns([textElement(stored)]);

    for (const latex of FORMULAS) expect(runs).toContain(latex);
    expect(runs.join('')).toBe(EXPECTED_TEXT);
  });

  it('writes unsaved editor markup the same way, not the text of the KaTeX tree', async () => {
    const runs = await exportedTextRuns([textElement(editorHtml(sentence()))]);

    for (const latex of FORMULAS) expect(runs).toContain(latex);
    expect(runs.join('')).toBe(EXPECTED_TEXT);
  });

  it('recovers the source of a KaTeX tree that has only its TeX annotation', async () => {
    // The PPTX importer emits KaTeX's default output without the attribute.
    const imported = `<p>Area ${katex.renderToString('\\sqrt{x}', { displayMode: false })} units</p>`;
    expect(imported).toContain('application/x-tex');
    expect(imported).not.toContain('data-inline-math');

    const runs = await exportedTextRuns([textElement(imported)]);

    expect(runs.join('')).toBe('Area \\sqrt{x} units');
  });

  it('keeps the formula run styled like the text around it', async () => {
    const stored = sanitizeProseHtml(
      '<p><strong><span style="color: #ff0000"><span data-inline-math="x^2">x^2</span></span></strong></p>',
    );
    expect(stored).toContain('data-inline-math="x^2"');
    const slide = slideWith([textElement(stored)]);
    const scene = {
      id: 'scene-1',
      stageId: 'stage-1',
      type: 'slide',
      title: 'Scene',
      order: 1,
      content: { type: 'slide', canvas: slide },
    } as Scene;
    const blob = await buildPptxBlob([slide], [scene], 0.5625, 1000, 100, 1, 'stage-1');
    const xml = await (await JSZip.loadAsync(await blob.arrayBuffer()))
      .file('ppt/slides/slide1.xml')!
      .async('string');

    const run = xml.match(
      /<a:r><a:rPr([^>]*)>((?:(?!<\/a:rPr>)[\s\S])*)<\/a:rPr><a:t>x\^2<\/a:t><\/a:r>/,
    );
    expect(run?.[1]).toContain('b="1"');
    expect(run?.[2]).toContain('<a:srgbClr val="FF0000"/>');
  });

  it('writes formulas in shape text and table cells as their source', async () => {
    const stored = sanitizeProseHtml(editorHtml(['Shape ', { latex: 'x^2' }]));
    const cell = sanitizeProseHtml(editorHtml(['R&D ', { latex: 'y_1' }]));
    expect(cell).toContain('R&amp;D');

    const runs = await exportedTextRuns([
      {
        id: 'shape-1',
        type: 'shape',
        ...geometry,
        viewBox: [200, 200],
        path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
        fill: '#ffffff',
        fixedRatio: false,
        text: {
          content: stored,
          defaultFontName: 'Arial',
          defaultColor: '#111111',
          align: 'middle',
        },
      },
      {
        id: 'table-1',
        type: 'table',
        ...geometry,
        top: 300,
        colWidths: [1],
        data: [[{ id: 'c1', colspan: 1, rowspan: 1, text: cell }]],
      },
    ]);

    expect(runs.join('')).toContain('Shape x^2');
    expect(runs).toContain('R&D y_1');
  });
});

/** The paragraphs of each exported table cell, as their text. */
async function exportedCellParagraphs(cells: string[]): Promise<string[][]> {
  const slide = slideWith([
    {
      id: 'table-1',
      type: 'table',
      ...geometry,
      colWidths: cells.map(() => 1 / cells.length),
      data: [cells.map((text, index) => ({ id: `c${index}`, colspan: 1, rowspan: 1, text }))],
    },
  ]);
  const scene = {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene',
    order: 1,
    content: { type: 'slide', canvas: slide },
  } as Scene;
  const blob = await buildPptxBlob([slide], [scene], 0.5625, 1000, 100, 1, 'stage-1');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return Array.from(doc.getElementsByTagName('a:tc'), (cell) =>
    Array.from(cell.getElementsByTagName('a:p'), (paragraph) =>
      Array.from(paragraph.getElementsByTagName('a:t'), (node) => node.textContent ?? '').join(''),
    ),
  );
}

describe('PPTX export of table cell lines', () => {
  it('keeps newlines in plain cell text as paragraphs, with or without an ampersand', async () => {
    expect(await exportedCellParagraphs(['R&D\nSales', 'A\nB', 'R&amp;D\nSales'])).toEqual([
      ['R&D', 'Sales'],
      ['A', 'B'],
      ['R&D', 'Sales'],
    ]);
  });

  it('keeps empty paragraphs, line breaks and newlines in cell markup', async () => {
    expect(
      await exportedCellParagraphs([
        '<p>A</p><p></p><p>B</p>',
        '<p>A<br>B</p><p><br></p><p>C</p>',
        '<p>R&amp;D\nSales <span data-inline-math="x^2">x^2</span></p>',
      ]),
    ).toEqual([
      ['A', '', 'B'],
      ['A', 'B', '', 'C'],
      ['R&D', 'Sales x^2'],
    ]);
  });
});

describe('proseToPlainText', () => {
  it('returns text without markup unchanged', () => {
    expect(proseToPlainText('Topic sentence')).toBe('Topic sentence');
  });

  it('drops tags, decodes references and keeps line structure', () => {
    expect(proseToPlainText('<p>a &lt; b &amp; c</p><p>d<br/>e&#xA0;f</p>')).toBe(
      'a < b & c\nd\ne f',
    );
  });

  it('decodes references in plain text without touching its lines', () => {
    expect(proseToPlainText('R&D\nSales')).toBe('R&D\nSales');
    expect(proseToPlainText('a &lt; b\n&amp; c')).toBe('a < b\n& c');
    expect(proseToPlainText('a < b')).toBe('a < b');
  });

  it('keeps empty paragraphs and does not add lines for trailing or nested breaks', () => {
    expect(proseToPlainText('<p>A</p><p></p><p>B</p>')).toBe('A\n\nB');
    expect(proseToPlainText('<p>A<br></p><p>B</p>')).toBe('A\nB');
    expect(proseToPlainText('<li><p>A</p></li><li><p>B</p></li>')).toBe('A\nB');
    expect(proseToPlainText('a<br><br>b')).toBe('a\n\nb');
  });

  it('turns inline formulas into their source', () => {
    expect(proseToPlainText('Sum <span data-inline-math="a&lt;b">a&lt;b</span>!')).toBe('Sum a<b!');
  });
});
