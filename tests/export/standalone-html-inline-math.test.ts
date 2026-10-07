// @vitest-environment jsdom
import katex from 'katex';
import { describe, expect, it, vi } from 'vitest';

// Lets a test make the resource inventory throw, to prove it cannot affect the export.
vi.mock('parse-srcset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('parse-srcset')>();
  return {
    default: (value: string) => {
      if (value.includes('inventory-failure')) throw new Error('inventory failure');
      return actual.default(value);
    },
  };
});
import type { PPTElement } from '@openmaic/dsl';
import {
  createTextDocument,
  serializeTextDocument,
} from '../../packages/@openmaic/editor/src/react/text/prosemirror/document';
import { sanitizeSlideRichText } from '@/lib/export/standalone-html/rich-text';
import { sanitizeSceneContent } from '@/lib/sanitize/scene-content';
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

/** A fresh KaTeX render of the formula as the DOM serializes it, without its root tag. */
function freshRenderBody(): string {
  const template = document.createElement('template');
  template.innerHTML = katex.renderToString(LATEX, {
    output: 'html',
    throwOnError: false,
    trust: false,
  });
  return template.content.firstElementChild!.innerHTML;
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
  it('keeps persisted formulas intact when exporting a saved classroom', () => {
    const saved = sanitizeSceneContent(slideWith(editorHtml()));
    const { content, discarded } = sanitizeSlideRichText(saved);
    expect(discarded).toEqual([]);
    for (const html of proseFields(content)) {
      const root = parse(html);
      expect(root.querySelectorAll('[data-inline-math]')).toHaveLength(1);
      expect(root.querySelector('[data-inline-math]')?.getAttribute('data-inline-math')).toBe(
        LATEX,
      );
      expect(html).toContain(freshRenderBody());
      expect(createTextDocument(html).eq(createTextDocument(editorHtml()))).toBe(true);
    }
  });

  it('leaves source-only spans empty for the export renderer to fill', () => {
    const { content } = sanitizeSceneContent(
      { type: 'text', content: `<p>Area: <span data-inline-math="${LATEX}"></span></p>` },
      { keepInlineMathSource: true },
    );
    const formula = parse(content).querySelector('[data-inline-math]');
    expect(formula?.getAttribute('data-inline-math')).toBe(LATEX);
    expect(formula?.childNodes).toHaveLength(0);
  });

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

  function parse(html: string): DocumentFragment {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
  }

  /** Every attribute name in the output, to catch any event handler. */
  function attributeNames(html: string): string[] {
    return [...parse(html).querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].map((attribute) => attribute.name),
    );
  }

  function editorHtmlFor(latex: string, prefix = ''): string {
    const span = document.createElement('span');
    span.setAttribute('data-inline-math', latex);
    return serializeTextDocument(createTextDocument(`<p>${prefix}${span.outerHTML} end</p>`));
  }

  for (const latex of [
    'x%$& onmouseover=alert(1) a=\n',
    'x%$` onmouseover=alert(1) a=\n',
    "x%$' onmouseover=alert(1) a=\n",
    'x%$1 onmouseover=alert(1) a=\n',
    'x%$$ onmouseover=alert(1) a=\n',
  ]) {
    it(`treats replacement patterns in LaTeX as plain source (${JSON.stringify(latex.slice(1, 4))})`, () => {
      const { content } = sanitizeSlideRichText(slideWith(editorHtmlFor(latex)));
      for (const html of proseFields(content)) {
        expect(attributeNames(html).filter((name) => name.startsWith('on'))).toEqual([]);
        const roots = parse(html).querySelectorAll('[data-inline-math]');
        expect(roots).toHaveLength(1);
        expect(roots[0].getAttribute('data-inline-math')).toBe(latex);
        expect(roots[0].classList.contains('katex')).toBe(true);
      }
    });
  }

  it('does not let marker-like text duplicate or inject formulas', () => {
    const forged = [
      'openmaicmath&#48;x0x',
      'openmaic<foo></foo>math0x0x',
      'openmaicmath0x0x',
      '<a href="#" title="openmaicmath0x0x">link</a>',
    ].join(' ');
    const { content } = sanitizeSlideRichText(slideWith(editorHtmlFor('y^2', forged)));
    for (const html of proseFields(content)) {
      const fragment = parse(html);
      expect(fragment.querySelectorAll('.katex')).toHaveLength(1);
      expect(fragment.querySelector('a')?.getAttribute('title')).toBe('openmaicmath0x0x');
      expect(fragment.textContent).toContain('openmaicmath0x0x');
    }
  });

  it('reports resources inside formula wrappers and every CSS reference form', () => {
    const html = [
      '<p><span data-inline-math="x" style="background:url(https://example.com/wrapper.png)">',
      '<img src="https://example.com/lost.png"></span>',
      '<span style="background:url(&quot;https://example.com/a(1).png&quot;)">q</span>',
      '<span style="background:u\\72l(https://example.com/escaped.png)">e</span>',
      '<img srcset="https://example.com/s1.png 1x, https://example.com/s2.png 2x">',
      '</p>',
      '<style>/* url(https://example.com/comment.png) */ p { background: url(https://example.com/sheet.png) }</style>',
    ].join('');
    const { content, discarded } = sanitizeSlideRichText(slideWith(html));
    expect([...new Set(discarded)].sort()).toEqual(
      [
        'https://example.com/a(1).png',
        'https://example.com/escaped.png',
        'https://example.com/lost.png',
        'https://example.com/s1.png',
        'https://example.com/s2.png',
        'https://example.com/sheet.png',
        'https://example.com/wrapper.png',
      ].sort(),
    );
    for (const out of proseFields(content)) {
      expect(out).not.toContain('example.com/lost.png');
      expect(out).not.toContain('<img');
      expect(parse(out).querySelectorAll('.katex')).toHaveLength(1);
    }
  });

  it('decodes CSS escapes per spec instead of aborting the export', () => {
    const html = [
      '<style>a{background:url("\\110000.png")}',
      'b{background:url("\\0 zero.png")}',
      'c{background:url("\\D800 surrogate.png")}',
      // An escaped newline continues the string.
      'd{background:url("line\\\ncontinued.png")}</style>',
      '<p>text</p>',
    ].join('');
    const { content, discarded } = sanitizeSlideRichText(slideWith(html));
    expect(discarded).toEqual(
      expect.arrayContaining(['�.png', '�zero.png', '�surrogate.png', 'linecontinued.png']),
    );
    expect(proseFields(content)[0]).toBe('<p>text</p>');
  });

  it('never lets a failing inventory abort or change sanitization', () => {
    const html = [
      '<p>before <img srcset="https://example.com/inventory-failure.png 1x">',
      `<img src="x" onerror="alert(1)"> after</p>`,
    ].join('');
    const editor = editorHtml();
    const { content } = sanitizeSlideRichText(slideWith(`${html}${editor}`));
    const { content: reference } = sanitizeSlideRichText(
      slideWith(`<p>before  after</p>${editor}`),
    );
    for (const [out, expected] of proseFields(content).map(
      (field, index) => [field, proseFields(reference)[index]] as const,
    )) {
      expect(out).toBe(expected);
      expect(out).not.toContain('onerror');
    }
  });

  it('inventories and strips inside template contents, nested ones included', () => {
    const html = [
      '<p>start</p><template><img src="https://example.com/lost.png">',
      '<span data-inline-math="x"><img src="https://example.com/inner.png"></span>',
      '<template><img src="https://example.com/nested.png"></template></template>',
    ].join('');
    const { content, discarded } = sanitizeSlideRichText(slideWith(html));
    expect([...new Set(discarded)].sort()).toEqual(
      [
        'https://example.com/inner.png',
        'https://example.com/lost.png',
        'https://example.com/nested.png',
      ].sort(),
    );
    for (const out of proseFields(content)) {
      expect(out).not.toContain('example.com');
      expect(out).not.toContain('<template');
      expect(attributeNames(out).filter((name) => name.startsWith('on'))).toEqual([]);
    }
  });
});
