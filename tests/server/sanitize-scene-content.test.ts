// @vitest-environment jsdom
/**
 * Scene-content sanitizer invariants.
 *
 * INVARIANT: stored slide HTML is restricted to the formatting vocabulary the
 * renderer produces. These tests prove (a) that realistic slide formatting —
 * drawn from real stage/scene fixtures and the editor round-trip corpus in this
 * repo — survives sanitization unchanged at the DOM level, and (b) that markup
 * outside that vocabulary (event handlers, script elements, javascript: URLs,
 * embedded frames) does not survive.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import katex from 'katex';
import {
  sanitizeLatexHtml,
  sanitizeProseHtml,
  sanitizeSceneContent,
} from '@/lib/server/sanitize-scene-content';

// ---------------------------------------------------------------------------
// DOM-level canonicalization: proves the sanitized fragment renders the same
// tree as the input, ignoring only cosmetic attribute serialization
// differences (style whitespace, attribute order).
// ---------------------------------------------------------------------------

function styleDeclarations(style: string): Array<[string, string]> {
  return style
    .split(';')
    .map((decl) => decl.trim())
    .filter(Boolean)
    .map((decl): [string, string] => {
      const colon = decl.indexOf(':');
      if (colon === -1) return [decl.toLowerCase(), ''];
      return [decl.slice(0, colon).trim().toLowerCase(), decl.slice(colon + 1).trim()];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function canonNode(node: ChildNode): unknown {
  if (node.nodeType === Node.TEXT_NODE) return ['text', node.textContent ?? ''];
  if (node.nodeType !== Node.ELEMENT_NODE) return ['node', String(node.nodeType)];

  const element = node as Element;
  const attrs: unknown[] = [];
  for (const attribute of Array.from(element.attributes).sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  )) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    if (name === 'style') {
      attrs.push(['style', styleDeclarations(value)]);
    } else if (name === 'class') {
      attrs.push(['class', value.split(/\s+/).filter(Boolean)]);
    } else {
      attrs.push([name, value]);
    }
  }
  const children = Array.from(element.childNodes).map(canonNode);
  return ['element', element.tagName.toLowerCase(), attrs, children];
}

function canon(html: string): unknown {
  const template = document.createElement('template');
  template.innerHTML = html;
  return Array.from(template.content.childNodes).map(canonNode);
}

function expectProseUnchanged(html: string): void {
  expect(canon(sanitizeProseHtml(html)), html).toEqual(canon(html));
}

// ---------------------------------------------------------------------------
// Real repo fixture content
// ---------------------------------------------------------------------------

/** Read real stored scene JSON fixtures and collect every HTML-bearing string. */
function fixtureHtmlStrings(...jsonPaths: string[]): string[] {
  const collected: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (record.type === 'text' && typeof record.content === 'string') {
      collected.push(record.content);
    } else if (
      record.type === 'shape' &&
      typeof record.text === 'object' &&
      record.text !== null &&
      typeof (record.text as Record<string, unknown>).content === 'string'
    ) {
      collected.push((record.text as Record<string, unknown>).content as string);
    } else if (record.type === 'table' && Array.isArray(record.data)) {
      const text: string[] = [];
      const rows = record.data as unknown[][];
      rows.forEach((row) =>
        row.forEach((cell) => {
          if (
            typeof cell === 'object' &&
            cell !== null &&
            typeof (cell as Record<string, unknown>).text === 'string'
          ) {
            text.push((cell as Record<string, unknown>).text as string);
          }
        }),
      );
      collected.push(...text);
    } else if (record.type === 'latex' && typeof record.html === 'string') {
      collected.push(record.html);
    }
    Object.values(record).forEach(walk);
  };
  for (const jsonPath of jsonPaths) {
    const parsed = JSON.parse(readFileSync(new URL(jsonPath, import.meta.url), 'utf-8')) as unknown;
    walk(parsed);
  }
  return collected;
}

const evalSceneFixtures = [
  '../../eval/whiteboard-layout/scenarios/econ-tech-innovation.json',
  '../../eval/whiteboard-layout/scenarios/math-quadratic-inequality.json',
  '../../eval/whiteboard-layout/scenarios/med-gcp-compliance.json',
  '../../eval/whiteboard-layout/scenarios/finance-tax-architecture.json',
  '../../eval/whiteboard-layout/scenarios/primary-math-rotation.json',
  '../../eval/whiteboard-layout/scenarios/physics-force-decomposition.json',
  '../../eval/orchestration/scenarios/answer-content.json',
];

// ---------------------------------------------------------------------------
// 1. Removing what must not survive
// ---------------------------------------------------------------------------

describe('sanitizeProseHtml — content outside the renderer vocabulary', () => {
  it('drops an inline event handler while preserving surrounding markup', () => {
    const input =
      '<p>Keep <strong>bold</strong> and <em>italic</em></p><p><img src="x" onerror="alert(1)">tail</p>';
    const output = sanitizeProseHtml(input);

    expect(output).not.toContain('onerror');
    expect(output).not.toContain('<img');
    expect(canon(output)).toEqual(
      canon('<p>Keep <strong>bold</strong> and <em>italic</em></p><p>tail</p>'),
    );
  });

  it('drops script elements including their body', () => {
    const output = sanitizeProseHtml('<p>a</p><script>alert(1)</script><p>b</p>');
    expect(output).not.toContain('<script');
    expect(output).not.toContain('alert(1)');
    expect(canon(output)).toEqual(canon('<p>a</p><p>b</p>'));
  });

  it('drops every on* attribute on any tag', () => {
    const output = sanitizeProseHtml(
      '<p onclick="x()" onmouseover="y()">t</p><span ondblclick="z()">s</span>',
    );
    expect(output).not.toMatch(/\son\w+=/);
    expect(canon(output)).toEqual(canon('<p>t</p><span>s</span>'));
  });

  it('drops javascript: URLs from links but keeps the link text', () => {
    const output = sanitizeProseHtml('<p><a href="javascript:alert(1)">click</a></p>');
    expect(output).not.toContain('javascript:');
    expect(canon(output)).toEqual(canon('<p><a>click</a></p>'));
  });

  it('drops iframe, object and embed from element content', () => {
    const output = sanitizeProseHtml(
      '<p>ok</p><iframe src="https://example.com"></iframe><object data="x"></object><embed src="y">',
    );
    expect(output).not.toContain('<iframe');
    expect(output).not.toContain('<object');
    expect(output).not.toContain('<embed');
    expect(canon(output)).toEqual(canon('<p>ok</p>'));
  });

  it('never allows style properties outside the typography vocabulary', () => {
    const output = sanitizeProseHtml(
      '<p style="color:red; background:url(https://evil.test/x); position:fixed; font-size:14px">t</p>',
    );
    expect(output).not.toContain('background:');
    expect(output).not.toContain('url(');
    expect(output).not.toContain('position:');
    expect(canon(output)).toEqual(canon('<p style="color:red;font-size:14px">t</p>'));
  });
});

describe('sanitizeLatexHtml — KaTeX snapshot policy', () => {
  it('removes handlers, scripts and foreign tags from a KaTeX snapshot', () => {
    const input =
      '<span class="katex">E</span><img src=x onerror="alert(1)"><script>alert(2)</script>';
    const output = sanitizeLatexHtml(input);

    expect(output).not.toContain('onerror');
    expect(output).not.toContain('<img');
    expect(output).not.toContain('<script');
    expect(canon(output)).toEqual(canon('<span class="katex">E</span>'));
  });

  it('keeps real KaTeX HTML (spans + layout svg) semantically unchanged', () => {
    const formulas = [
      'E = mc^2',
      '\\frac{a}{b} + \\sqrt{x^2 + y^2}',
      'H_2O \\quad \\text{water}',
      '\\sum_{i=1}^{n} i^2',
      '\\begin{cases} 1 & x>0 \\\\ 0 & x\\le 0 \\end{cases}',
      '\\cancel{5} + \\overrightarrow{AB}',
    ];
    for (const formula of formulas) {
      const html = katex.renderToString(formula, {
        throwOnError: false,
        displayMode: true,
        output: 'html',
      });
      expect(canon(sanitizeLatexHtml(html)), formula).toEqual(canon(html));
    }
  });

  it('preserves the camelCase layout-svg attributes browsers need', () => {
    const html = katex.renderToString('\\sqrt{x}', {
      throwOnError: false,
      displayMode: true,
      output: 'html',
    });
    const output = sanitizeLatexHtml(html);
    if (html.includes('viewBox=')) {
      expect(output).toContain('viewBox=');
    }
    if (html.includes('preserveAspectRatio=')) {
      expect(output).toContain('preserveAspectRatio=');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Fidelity: realistic slide formatting survives unchanged
// ---------------------------------------------------------------------------

describe('sanitizeProseHtml — fidelity over the editor round-trip corpus', () => {
  it('keeps nested marks, links and alignment (editor round-trip fixture)', () => {
    // Verbatim from packages/@openmaic/editor/test/react/text/prosemirror-schema.test.ts.
    const html =
      '<blockquote><p style="text-align: center"><a href="https://maic.chat"><strong><u><span style="font-size: 28px; color: #ff0000">MAIC</span></u></strong></a></p></blockquote><ol><li><p>One</p></li></ol>';
    expectProseUnchanged(html);
  });

  it('keeps lists in the exact shape the renderer emits them', () => {
    // Verbatim from packages/@openmaic/renderer/test/SlideCanvas.test.tsx.
    expectProseUnchanged('<ul><li>Bullet</li></ul><ol><li>Number</li></ol>');
    expectProseUnchanged(
      '<ul style="list-style-type: disc"><li><p>A</p></li></ul><ol start="3"><li><p>B</p></li></ol>',
    );
  });

  it('keeps paragraph geometry imported from PPTX (round-trip fixture)', () => {
    // Verbatim from packages/@openmaic/editor/test/react/text/prosemirror-schema.test.ts.
    expectProseUnchanged(
      '<div style="padding: 4.8px 9.6px"><p style="margin-left: 78px; text-indent: -30px; padding-top: 7.3px; margin-top: 8px; margin-bottom: 5px">Text</p></div>',
    );
  });

  it('keeps bullet-glyph inline-block spans (round-trip fixture)', () => {
    // Verbatim from packages/@openmaic/editor/test/react/text/prosemirror-schema.test.ts.
    expectProseUnchanged(
      '<p><span style="display: inline-block; width: 30px; text-indent: 0; box-sizing: border-box">■</span>1954年清华大学首创</p>',
    );
    expectProseUnchanged(
      '<p><span style="display: inline-block; width: 30px; height: 24px; vertical-align: middle; margin: 1px 2px; padding: 3px 4px">■</span><span style="display: inline-block; width: 12px; margin-left: 5px; padding-right: 6px">•</span>Text</p>',
    );
  });

  it('keeps explicit line breaks and run-level spans (round-trip fixture)', () => {
    // Verbatim from packages/@openmaic/editor/test/react/text/prosemirror-schema.test.ts.
    expectProseUnchanged(
      '<p><span style="font-size: 29.3px">1954年清华大学首创“先进集体”</span><br><span style="font-size: 29.3px">评选制度</span></p>',
    );
  });

  it('keeps character spacing, indentation and nowrap (round-trip fixtures)', () => {
    // Verbatim from packages/@openmaic/editor/test/react/text/prosemirror-schema.test.ts.
    expectProseUnchanged(
      '<p style="text-indent: 78px"><span style="letter-spacing: 1.5pt">Indented text</span></p>',
    );
    expectProseUnchanged('<p style="white-space: nowrap">在集体中成长，与集体共成长</p>');
    expectProseUnchanged('<p style="font-size: 14px; line-height: 1.2">Text</p>');
  });

  it('keeps inline marks: code, sub, sup, mark, strike variants, underline', () => {
    expectProseUnchanged(
      'text <code>const x = 1</code> <sub>sub</sub> <sup>sup</sup> <mark data-index="1">hi</mark> <s>del</s> <strike>old</strike> <u>under</u> <b>b</b> <i>i</i>',
    );
  });

  it('keeps structural table markup when present in a stored body', () => {
    expectProseUnchanged(
      '<table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell <sup>2</sup></td><td colspan="2">Wide</td></tr></tbody></table>',
    );
  });
});

describe('real stored scene fixtures — full payload walker fidelity', () => {
  it('leaves every HTML-bearing string of real scene fixtures unchanged', () => {
    const strings = fixtureHtmlStrings(...evalSceneFixtures);
    expect(strings.length).toBeGreaterThan(20);
    for (const html of strings) {
      expectProseUnchanged(html);
    }
  });

  it('leaves real text-element content unchanged when sanitizing a whole scene', () => {
    // Real scene structure: eval/orchestration/scenarios/answer-content.json,
    // scene 0 text element "content".
    const scene = {
      id: 'scene-0',
      stageId: 'eval-answer-content',
      title: '二次函数',
      order: 0,
      type: 'slide',
      content: {
        type: 'slide',
        canvas: {
          id: 'slide-0',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          theme: {
            backgroundColor: '#ffffff',
            themeColors: ['#5b9bd5'],
            fontColor: '#333333',
            fontName: 'Microsoft YaHei',
          },
          elements: [
            {
              type: 'text',
              id: 'title-el',
              content: '<p style="font-size: 32px;"><b>二次函数 y = ax² + bx + c</b></p>',
              left: 50,
              top: 50,
              width: 900,
              height: 100,
              rotate: 0,
              defaultFontName: 'Microsoft YaHei',
              defaultColor: '#333333',
            },
          ],
        },
      },
    };

    const sanitized = sanitizeSceneContent(scene);
    const element = sanitized.content.canvas.elements[0];
    expect(canon(element.content)).toEqual(
      canon('<p style="font-size: 32px;"><b>二次函数 y = ax² + bx + c</b></p>'),
    );
    expect(sanitized).not.toBe(scene);
  });
});

// ---------------------------------------------------------------------------
// 3. Payload walker: element-kind coverage and untouched non-HTML fields
// ---------------------------------------------------------------------------

function slideSceneWithElements(elements: unknown[]): unknown {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    title: 'Scene',
    order: 0,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: 'slide-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#5b9bd5'],
          fontColor: '#333333',
          fontName: 'Microsoft YaHei',
        },
        elements,
      },
    },
  };
}

describe('sanitizeSceneContent — payload walker', () => {
  it('sanitizes text, shape text and table cell text and latex snapshots in one pass', () => {
    const scene = slideSceneWithElements([
      {
        type: 'text',
        id: 't1',
        content: '<p><img src=x onerror="a()">keep <strong>bold</strong></p>',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        defaultFontName: 'Arial',
        defaultColor: '#333',
      },
      {
        type: 'shape',
        id: 's1',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
        viewBox: [100, 100],
        path: 'M0 0',
        fixedRatio: true,
        fill: '#fff',
        text: {
          content: '<p onclick="x()"><em>shape text</em></p>',
          defaultFontName: 'Arial',
          defaultColor: '#333',
          align: 'middle',
        },
      },
      {
        type: 'table',
        id: 'tbl1',
        left: 0,
        top: 0,
        width: 100,
        height: 60,
        rotate: 0,
        outline: { width: 1, color: '#000', style: 'solid' },
        colWidths: [1],
        cellMinHeight: 30,
        data: [
          [
            {
              id: 'c1',
              colspan: 1,
              rowspan: 1,
              text: '<strong>H</strong><sub>2</sub>O<script>a()</script>',
            },
          ],
        ],
      },
      {
        type: 'latex',
        id: 'l1',
        left: 0,
        top: 0,
        width: 200,
        height: 60,
        rotate: 0,
        latex: 'x',
        html: '<span class="katex">x</span><svg onload="a()"><line x1="0" y1="0" x2="1" y2="1" stroke-width="0.04em"/></svg>',
        color: '#000',
        fixedRatio: true,
      },
    ]);

    const sanitized = sanitizeSceneContent(scene) as {
      content: { canvas: { elements: Array<Record<string, unknown>> } };
    };
    const [textEl, shapeEl, tableEl, latexEl] = sanitized.content.canvas.elements;

    expect(String(textEl.content)).not.toContain('onerror');
    expect(String(textEl.content)).not.toContain('<img');
    expect(canon(String(textEl.content))).toEqual(canon('<p>keep <strong>bold</strong></p>'));

    const shapeText = shapeEl.text as Record<string, unknown>;
    expect(String(shapeText.content)).not.toContain('onclick');
    expect(canon(String(shapeText.content))).toEqual(canon('<p><em>shape text</em></p>'));

    const cellText = (tableEl.data as Array<Array<Record<string, unknown>>>)[0][0].text as string;
    expect(cellText).not.toContain('<script');
    expect(canon(cellText)).toEqual(canon('<strong>H</strong><sub>2</sub>O'));

    const latexHtml = latexEl.html as string;
    expect(latexHtml).not.toContain('onload');
    expect(latexHtml).not.toContain('<svg onload');
    expect(canon(latexHtml)).toEqual(
      canon(
        '<span class="katex">x</span><svg><line x1="0" y1="0" x2="1" y2="1" stroke-width="0.04em"/></svg>',
      ),
    );
  });

  it('does not touch code element lines (plain text, not HTML)', () => {
    const code = 'int a = 1 < 2 && 3 > 2; // a < b "quoted"';
    const scene = slideSceneWithElements([
      {
        type: 'code',
        id: 'code-1',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
        language: 'cpp',
        lines: [{ id: 'L1', content: code }],
        showLineNumbers: true,
        fontSize: 14,
      },
    ]);

    const sanitized = sanitizeSceneContent(scene) as {
      content: { canvas: { elements: Array<{ lines: Array<{ content: string }> }> } };
    };
    expect(sanitized.content.canvas.elements[0].lines[0].content).toBe(code);
  });

  it('returns a new tree and leaves the caller payload untouched', () => {
    const scene = slideSceneWithElements([
      {
        type: 'text',
        id: 't1',
        content: '<p onclick="x()">hello</p>',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        defaultFontName: 'Arial',
        defaultColor: '#333',
      },
    ]);
    const before = JSON.stringify(scene);
    const sanitized = sanitizeSceneContent(scene);
    expect(JSON.stringify(scene)).toBe(before);
    expect(sanitized).not.toBe(scene);
  });

  it('is idempotent: sanitizing an already-sanitized payload changes nothing', () => {
    const scene = slideSceneWithElements([
      {
        type: 'text',
        id: 't1',
        content: '<p style="color:#ff0000; font-size:14px"><b>bold</b></p>',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        defaultFontName: 'Arial',
        defaultColor: '#333',
      },
    ]);
    const once = sanitizeSceneContent(scene);
    const twice = sanitizeSceneContent(once);
    expect(twice).toEqual(once);
  });
});
