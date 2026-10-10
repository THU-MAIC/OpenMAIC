// @vitest-environment jsdom
/**
 * Inline formulas at the persistence boundary: editor inline math is stored
 * as LaTeX source only (`<span data-inline-math="SRC">SRC</span>`), the editor
 * parses it back, nothing authored rides along with it, and formula-free
 * prose is untouched.
 */
import katex from 'katex';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import {
  createTextDocument,
  serializeTextDocument,
} from '../../packages/@openmaic/editor/src/react/text/prosemirror/document';
import { MAX_INLINE_MATH_SOURCE } from '@openmaic/renderer';
import { sanitizeProseHtml, sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';

const LATEX = '\\sqrt{x}+\\frac{a}{b}';

/** Prose HTML exactly as the editor saves it, for one formula. */
function editorHtmlFor(latex: string, prefix = 'Area: '): string {
  const span = document.createElement('span');
  span.setAttribute('data-inline-math', latex);
  return serializeTextDocument(createTextDocument(`<p>${prefix}${span.outerHTML} units</p>`));
}

function editorHtml(): string {
  const html = editorHtmlFor(LATEX);
  // Guard the fixture itself: the editor output is a rendered KaTeX formula.
  expect(html).toContain('data-inline-math');
  expect(html).toContain('<svg');
  expect(html).toContain('<annotation');
  return html;
}

function sceneWith(html: string) {
  const base = { left: 0, top: 0, width: 400, height: 80, rotate: 0 };
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Formulas',
    order: 0,
    content: {
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
        ],
      },
    },
  };
}

type Scene = ReturnType<typeof sceneWith>;

function proseFields(scene: Scene): string[] {
  const [text, shape, table] = scene.content.canvas.elements as unknown as [
    { content: string },
    { text: { content: string } },
    { data: Array<Array<{ text: string }>> },
  ];
  return [text.content, shape.text.content, table.data[0][0].text];
}

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

/** The inline-math nodes the editor parses back out of stored prose. */
function editorFormulas(html: string): string[] {
  const found: string[] = [];
  createTextDocument(html).descendants((node: ProseMirrorNode) => {
    if (node.type.name === 'inline_math') found.push(node.attrs.latex as string);
  });
  return found;
}

/** The stored form of one formula. */
function stored(latex: string): string {
  const span = document.createElement('span');
  span.setAttribute('data-inline-math', latex);
  span.textContent = latex;
  return span.outerHTML;
}

describe('sanitizeSceneContent — inline formulas', () => {
  it('stores editor inline math as source in text, shape text and table cells', () => {
    const sanitized = sanitizeSceneContent(sceneWith(editorHtml()));
    for (const html of proseFields(sanitized)) {
      expect(html).toBe(`<p>Area: ${stored(LATEX)} units</p>`);
      expect(editorFormulas(html)).toEqual([LATEX]);
      // The editor re-renders it from source.
      const reopened = serializeTextDocument(createTextDocument(html));
      expect(reopened).toContain('<svg');
      expect(reopened).toContain(`data-inline-math="${LATEX}"`);
    }
  });

  it('round-trips through the editor and the sanitizer again unchanged', () => {
    const [stored] = proseFields(sanitizeSceneContent(sceneWith(editorHtml())));
    const resaved = serializeTextDocument(createTextDocument(stored));
    expect(proseFields(sanitizeSceneContent(sceneWith(resaved)))[0]).toBe(stored);
  });

  it('is idempotent for formula content', () => {
    const inputs = [
      editorHtml(),
      editorHtmlFor('x^2', 'two: ') + editorHtmlFor('\\alpha & \\beta "q" &lt;', 'and '),
      editorHtmlFor('\\frac{', 'malformed: '),
      editorHtmlFor('', 'empty: '),
      `<p>${katex.renderToString(LATEX, { output: 'htmlAndMathml' })}</p>`,
    ];
    for (const input of inputs) {
      const once = sanitizeSceneContent(sceneWith(input));
      const twice = sanitizeSceneContent(once);
      expect(twice).toEqual(once);
      expect(sanitizeProseHtml(sanitizeProseHtml(input))).toBe(sanitizeProseHtml(input));
    }
  });

  it('keeps the source of malformed and empty formulas', () => {
    const malformed = sanitizeProseHtml(editorHtmlFor('\\frac{'));
    expect(editorFormulas(malformed)).toEqual(['\\frac{']);
    expect(attributeNames(malformed).filter((name) => name.startsWith('on'))).toEqual([]);
    const empty = sanitizeProseHtml(editorHtmlFor(''));
    expect(empty).toBe('<p>Area: <span data-inline-math></span> units</p>');
    expect(editorFormulas(empty)).toEqual(['']);
  });

  it('keeps an over-long formula as a formula: the length bound applies to typesetting only', () => {
    const latex = 'x+'.repeat(MAX_INLINE_MATH_SOURCE);
    const once = sanitizeProseHtml(editorHtmlFor(latex));
    expect(once).toBe(`<p>Area: ${stored(latex)} units</p>`);
    expect(editorFormulas(once)).toEqual([latex]);
    expect(sanitizeProseHtml(once)).toBe(once);
    const atLimit = 'x'.repeat(MAX_INLINE_MATH_SOURCE);
    expect(sanitizeProseHtml(stored(atLimit))).toBe(stored(atLimit));
  });

  it('recovers the source from the KaTeX annotation when the attribute is missing', () => {
    const withAnnotation = katex.renderToString(LATEX, { output: 'htmlAndMathml' });
    expect(sanitizeProseHtml(`<p>${withAnnotation}</p>`)).toBe(`<p>${stored(LATEX)}</p>`);
  });

  it('leaves content flattened before this fix as it is', () => {
    // No attribute and no annotation: the source is gone and cannot be recovered.
    const flattened = katex
      .renderToString(LATEX, { output: 'html' })
      .replace(/<svg[\s\S]*?<\/svg>/g, '')
      .replace(/ style="[^"]*"/g, '');
    const html = `<p>Area: ${flattened} units</p>`;
    const once = sanitizeProseHtml(html);
    expect(once).not.toContain('data-inline-math');
    expect(sanitizeProseHtml(once)).toBe(once);
  });

  it('never carries authored markup through a formula wrapper', () => {
    const forged = [
      '<p><span data-inline-math="x" onclick="alert(1)"><img src="x" onerror="alert(2)"></span>',
      '<span class="katex" data-inline-math="y" style="background:red">',
      '<a href="javascript:alert(3)">z</a></span></p>',
    ].join('');
    for (const html of proseFields(sanitizeSceneContent(sceneWith(forged)))) {
      expect(html).not.toContain('onerror');
      expect(html).not.toContain('javascript');
      expect(html).not.toContain('background');
      expect(attributeNames(html).filter((name) => name.startsWith('on'))).toEqual([]);
      expect(editorFormulas(html)).toEqual(['x', 'y']);
      expect(html).toBe(`<p>${stored('x')}${stored('y')}</p>`);
    }
  });

  it('only treats spans as formulas, as the editor does', () => {
    const html = sanitizeProseHtml('<p data-inline-math="x">kept text</p>');
    expect(html).toBe('<p>kept text</p>');
  });

  for (const latex of [
    'x%$& onmouseover=alert(1) a=\n',
    'x%$` onmouseover=alert(1) a=\n',
    "x%$' onmouseover=alert(1) a=\n",
    'x%$1 onmouseover=alert(1) a=\n',
    'x%$$ onmouseover=alert(1) a=\n',
    'x" onmouseover="alert(1)',
    'x</span><img src=x onerror=alert(1)>',
  ]) {
    it(`treats LaTeX as plain source (${JSON.stringify(latex.slice(1, 6))})`, () => {
      const sanitized = sanitizeSceneContent(sceneWith(editorHtmlFor(latex)));
      for (const html of proseFields(sanitized)) {
        expect(attributeNames(html).filter((name) => name.startsWith('on'))).toEqual([]);
        expect(parse(html).querySelector('img')).toBeNull();
        const roots = parse(html).querySelectorAll('[data-inline-math]');
        expect(roots).toHaveLength(1);
        expect(roots[0].getAttribute('data-inline-math')).toBe(latex);
        expect(roots[0].textContent).toBe(latex);
      }
      expect(sanitizeSceneContent(sanitized)).toEqual(sanitized);
    });
  }

  it('does not let marker-like text duplicate or inject formulas', () => {
    const forged = [
      'openmaicmath&#48;x0x',
      'openmaic<foo></foo>math0x0x',
      'openmaicmath0x0x',
      '<a href="#" title="openmaicmath0x0x">link</a> ',
    ].join(' ');
    for (const html of proseFields(sanitizeSceneContent(sceneWith(editorHtmlFor('y^2', forged))))) {
      const fragment = parse(html);
      expect(fragment.querySelectorAll('[data-inline-math]')).toHaveLength(1);
      expect(fragment.querySelector('a')?.getAttribute('title')).toBe('openmaicmath0x0x');
      expect(fragment.textContent).toContain('openmaicmath0x0x');
    }
  });

  it('handles formulas inside template contents without leaking their markup', () => {
    const html = [
      '<p>start</p><template><img src="https://example.com/lost.png">',
      '<span data-inline-math="x"><img src="x" onerror="alert(1)"></span>',
      '<template><span data-inline-math="y"><script>alert(2)</script></span></template></template>',
    ].join('');
    for (const out of proseFields(sanitizeSceneContent(sceneWith(html)))) {
      expect(out).not.toContain('example.com');
      expect(out).not.toContain('<template');
      expect(out).not.toContain('script');
      expect(attributeNames(out).filter((name) => name.startsWith('on'))).toEqual([]);
      expect(editorFormulas(out)).toEqual(['x', 'y']);
    }
  });
});

describe('sanitizeSceneContent — formula-free prose', () => {
  it('is sanitized exactly as before', () => {
    const cases: Array<[string, string]> = [
      [
        '<table><span>x</span><tr><td>c</td></tr></table>',
        '<table><span>x</span><tr><td>c</td></tr></table>',
      ],
      [
        '<p style="color:#ff0000; font-size:14px"><b>bold</b> rendered with KaTeX</p>',
        '<p style="color:#ff0000;font-size:14px"><b>bold</b> rendered with KaTeX</p>',
      ],
      ['<p onclick="x()">a &amp; b<img src=x onerror=y></p>', '<p>a &amp; b</p>'],
      ['plain text', 'plain text'],
    ];
    for (const [input, expected] of cases) {
      expect(sanitizeProseHtml(input)).toBe(expected);
    }
  });
});
