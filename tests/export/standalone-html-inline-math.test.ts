// @vitest-environment jsdom
import katex from 'katex';
import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import {
  createTextDocument,
  serializeTextDocument,
} from '../../packages/@openmaic/editor/src/react/text/prosemirror/document';
import { sanitizeSlideRichText } from '@/lib/export/standalone-html/rich-text';
import type { SlideContent } from '@/lib/types/stage';

const LATEX = '\\sqrt{x}+\\frac{a}{b}';

/** Prose HTML exactly as the editor saves it: parsed and re-serialized through its schema. */
function editorHtml(): string {
  const html = serializeTextDocument(
    createTextDocument(`<p>Area: <span data-inline-math="${LATEX}"></span> units</p>`),
  );
  // Guard the fixture itself: the editor output is a rendered KaTeX formula.
  expect(html).toContain('data-inline-math');
  expect(html).toContain('<svg');
  return html;
}

/** What a fresh KaTeX render of the formula looks like, without its wrapper attributes. */
function freshRenderBody(): string {
  const html = katex.renderToString(LATEX, { output: 'html', throwOnError: false, trust: false });
  return html.replace(/^<span class="katex">/, '');
}

function slideWith(html: string): SlideContent {
  const base = { left: 0, top: 0, width: 400, height: 80, rotate: 0 };
  return {
    type: 'slide',
    canvas: {
      id: 'slide',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: '' },
      elements: [
        {
          ...base,
          type: 'text',
          id: 'text',
          content: html,
          defaultFontName: '',
          defaultColor: '#000',
        },
        {
          ...base,
          type: 'shape',
          id: 'shape',
          viewBox: [200, 200],
          path: 'M 0 0 L 200 0 L 200 200 Z',
          fixedRatio: false,
          fill: '#fff',
          text: { content: html, defaultFontName: '', defaultColor: '#000', align: 'middle' },
        },
        {
          ...base,
          type: 'table',
          id: 'table',
          outline: { width: 1, style: 'solid', color: '#000' },
          colWidths: [1],
          cellMinHeight: 20,
          data: [[{ id: 'c', colspan: 1, rowspan: 1, text: html }]],
        },
      ] as PPTElement[],
    },
  } as SlideContent;
}

function proseFields(content: SlideContent): string[] {
  return content.canvas.elements.flatMap((element) => {
    if (element.type === 'text') return [element.content];
    if (element.type === 'shape') return element.text ? [element.text.content] : [];
    if (element.type === 'table') return [element.data[0][0].text];
    return [];
  });
}

describe('standalone HTML inline formulas', () => {
  it('keeps editor inline math intact in text, shape text and table cells', () => {
    const { content, discarded } = sanitizeSlideRichText(slideWith(editorHtml()));
    expect(discarded).toEqual([]);
    for (const html of proseFields(content)) {
      expect(html).toContain(`data-inline-math="${LATEX}"`);
      expect(html).toContain(freshRenderBody());
      expect(html).toContain('<svg'); // the radical
      expect(html).toMatch(/style="top:/); // positioned fraction parts
      expect(html.startsWith('<p>Area: ')).toBe(true);
      expect(html).toContain(' units</p>');
      expect(html).not.toContain('contenteditable');
      expect(html).not.toContain('<math');
      expect(html).toContain('katex'); // so the export ships the math fonts
    }
  });

  it('recovers the source from the KaTeX annotation when the attribute is missing', () => {
    const withAnnotation = katex.renderToString(LATEX, { output: 'htmlAndMathml' });
    const { content } = sanitizeSlideRichText(slideWith(`<p>${withAnnotation}</p>`));
    expect(proseFields(content)[0]).toContain(`data-inline-math="${LATEX}"`);
    expect(proseFields(content)[0]).toContain(freshRenderBody());
  });

  it('never carries authored markup through a formula wrapper', () => {
    const forged = `<p><span data-inline-math="x"><img src="x" onerror="alert(1)"></span></p>`;
    const { content } = sanitizeSlideRichText(slideWith(forged));
    const [html] = proseFields(content);
    expect(html).not.toContain('onerror');
    expect(html).toContain('data-inline-math="x"');
  });
});
