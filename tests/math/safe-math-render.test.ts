// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import katex from 'katex';
import temml from 'temml';
import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { safeKatexOptions } from '@openmaic/dsl';
import { TextBlock } from '@/components/workbench/chat/text-block';
import { freshMacrosOptions } from '@/lib/markdown/safe-math-plugin';
import { renderLatexToHtml } from '@/lib/quiz/math-text';
import { renderLatexElementHtml } from '@/lib/edit/slide-edit-elements';
import { latexToOmml } from '@/lib/export/latex-to-omml';
import { sanitizeSlideRichText } from '@/lib/export/standalone-html/rich-text';
import type { SlideContent } from '@/lib/types/stage';
import { createTextDocument } from '../../packages/@openmaic/editor/src/react/text/prosemirror/document';
import { renderLatexSource } from '../../packages/@openmaic/editor/src/ui/latex/latex-editor';
import { LEGITIMATE_MATH_CORPUS } from '../fixtures/math-corpus';
import { MACRO_EXPANSION_INPUTS } from '../fixtures/math-expansion-inputs';

/**
 * Unguarded, these inputs take 4 to 70 seconds per render. Guarded, the bare
 * engine paths take a few milliseconds; the DOM and Markdown paths add their
 * own parsing of a long error output, so the budget leaves room for a loaded
 * CI runner while staying far below the unguarded cost.
 */
const TIME_BUDGET_MS = 500;
/**
 * Output stays proportional to the input (error spans included): at most this
 * many characters per input character. Unguarded, these inputs produce
 * tens to hundreds of times their size.
 */
const OUTPUT_CHARS_PER_INPUT_CHAR = 64;

function timed<T>(render: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = render();
  return { value, ms: performance.now() - start };
}

function attempt(render: () => string): string {
  try {
    return render();
  } catch (error) {
    return `ERROR ${(error as Error).message}`;
  }
}

function slideWithInlineMath(latex: string): SlideContent {
  return {
    type: 'slide',
    canvas: {
      id: 'slide',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: '' },
      elements: [
        {
          type: 'text',
          id: 'text',
          left: 0,
          top: 0,
          width: 400,
          height: 80,
          rotate: 0,
          content: `<p><span data-inline-math="${latex}"></span></p>`,
          defaultFontName: '',
          defaultColor: '#000',
        },
      ] as PPTElement[],
    },
  } as SlideContent;
}

/** Every render path, as each module exposes it, reduced to "input → output text". */
const RENDER_PATHS: Record<string, (latex: string) => string> = {
  'quiz math text': (latex) => renderLatexToHtml(latex) ?? '',
  'slide latex element': (latex) => renderLatexElementHtml(latex) ?? '',
  'pptx export (temml)': (latex) => latexToOmml(latex) ?? '',
  'standalone HTML inline math': (latex) => {
    const { content } = sanitizeSlideRichText(slideWithInlineMath(latex));
    const element = content.canvas.elements[0];
    return element.type === 'text' ? element.content : '';
  },
  'editor latex dialog': (latex) => {
    const result = renderLatexSource(latex);
    return 'html' in result ? (result.html ?? '') : (result.error ?? '');
  },
  'workbench chat markdown (display)': (latex) =>
    renderToStaticMarkup(createElement(TextBlock, { text: `$$\n${latex}\n$$` })),
  'workbench chat markdown (streaming)': (latex) =>
    renderToStaticMarkup(
      createElement(TextBlock, { text: `Result: $$${latex}$$`, streaming: true }),
    ),
  'editor inline math node': (latex) => {
    const doc = createTextDocument(`<p><span data-inline-math="${latex}"></span></p>`);
    return JSON.stringify(doc.toJSON());
  },
};

describe('math rendering with user macro definitions disabled', () => {
  for (const [path, render] of Object.entries(RENDER_PATHS)) {
    for (const [name, input] of Object.entries(MACRO_EXPANSION_INPUTS)) {
      it(`${path}: ${name} renders quickly with small output`, () => {
        const { value, ms } = timed(() => render(input));
        expect(ms).toBeLessThan(TIME_BUDGET_MS);
        expect(value.length).toBeLessThan(OUTPUT_CHARS_PER_INPUT_CHAR * input.length);
      });
    }
  }

  describe('workbench chat math does not share engine state', () => {
    const chat = (text: string) => renderToStaticMarkup(createElement(TextBlock, { text }));
    const ALIGN = '$$\n\\begin{align}x&=y\\end{align}\n$$';
    const PROBE = '$$\n\\@eqnsw\n$$';
    // `\@eqnsw` is undefined until an align environment sets it to "1".
    const visibleText = (html: string) => html.replace(/<[^>]*>/g, '');

    it('across messages', () => {
      const before = chat(PROBE);
      expect(visibleText(before)).toContain('\\@eqnsw');
      chat(ALIGN);
      expect(chat(PROBE)).toBe(before);
    });

    it('across formulas in one message', () => {
      // Undefined, the probe renders its source (in the HTML and the
      // annotation); leaked, it renders the digit 1 instead.
      const both = visibleText(chat(`${ALIGN}\n\n${PROBE}`));
      expect(both).toContain('\\@eqnsw\\@eqnsw');
      expect(both).not.toContain('1\\@eqnsw1');
    });

    it('gives every spread of the plugin options a fresh macros object', () => {
      const options = freshMacrosOptions({ errorColor: 'red' }) as { macros: object };
      const first = { ...options };
      const second = { ...options };
      expect(first.macros).not.toBe(second.macros);
      expect(first).toMatchObject({ errorColor: 'red', trust: false });
      expect(first.macros).toHaveProperty(['\\def']);
    });
  });

  it('does not carry a \\gdef from one render into the next', () => {
    expect(renderLatexToHtml('\\gdef\\leaked{LEAK}x')).not.toBeNull();
    expect(renderLatexToHtml('\\leaked')).toBeNull();

    const shared = { '\\keep': 'K' };
    const first = safeKatexOptions({ macros: shared });
    katex.renderToString('\\gdef\\leaked{LEAK}\\keep', first);
    const second = safeKatexOptions({ macros: shared });
    expect(second.macros).not.toBe(first.macros);
    expect(Object.keys(shared)).toEqual(['\\keep']);
    expect(katex.renderToString('\\keep', second)).toContain('K');
    expect(() => katex.renderToString('\\leaked', { ...second, throwOnError: true })).toThrow(
      /Undefined control sequence/,
    );
  });

  it('swallows each definition form without rendering its body', () => {
    const forms = [
      '\\def\\ma#1{BODY}',
      '\\gdef\\ma{BODY}',
      '\\edef\\ma{BODY}',
      '\\xdef\\ma{BODY}',
      '\\global\\def\\ma{BODY}',
      '\\long\\def\\ma{BODY}',
      '\\newcommand{\\ma}{BODY}',
      '\\newcommand\\ma[2][x]{BODY}',
      '\\renewcommand{\\frac}{BODY}',
      '\\providecommand{\\ma}{BODY}',
      '\\let\\ma=\\frac',
      '\\let\\ma\\frac',
    ];
    const reference = withoutSource(katex.renderToString('y', { output: 'mathml' }));
    for (const form of forms) {
      const html = katex.renderToString(
        `${form} y`,
        safeKatexOptions({ output: 'mathml', throwOnError: true }),
      );
      expect(withoutSource(html), form).toBe(reference);
    }
  });

  it.each([
    // [input, what it renders once the definition is dropped]
    ['\\newcommand{\\ma}{[}x+y', 'x+y'],
    ['\\newcommand{\\ma}{[}x]+y', 'x]+y'],
    ['\\newcommand*\\ma{BODY}+z', '+z'],
    ['\\newcommand{\\ma}[1][{]}]{BODY}+z', '+z'],
    ['\\newcommand\\ma [2] [d] {BODY}+z', '+z'],
    ['\\renewcommand{\\frac}{[}x+y', 'x+y'],
    ['\\renewcommand*{\\frac}[1][{]}]{BODY}+z', '+z'],
    ['\\providecommand{\\ma}{[}x]+y', 'x]+y'],
    ['\\providecommand*\\ma[1]{BODY}+z', '+z'],
  ])('KaTeX and Temml drop exactly the definition in %s', (input, rendered) => {
    const katexOf = (latex: string, options: object) =>
      withoutSource(
        katex.renderToString(latex, { ...options, output: 'mathml', throwOnError: true }),
      );
    expect(katexOf(input, safeKatexOptions())).toBe(katexOf(rendered, {}));
    expect(withoutSource(temml.renderToString(input, safeKatexOptions()))).toBe(
      withoutSource(temml.renderToString(rendered)),
    );
  });

  it('keeps built-in commands that are themselves macros working', () => {
    for (const latex of ['a \\neq b', 'p \\iff q', '1, \\dots, n', 'a \\, b', '\\frac{1}{2}']) {
      expect(renderLatexToHtml(latex), latex).not.toBeNull();
      expect(renderLatexSource(latex), latex).toHaveProperty('html');
    }
  });
});

/** MathML output minus the annotation that echoes the source. */
function withoutSource(mathml: string): string {
  return mathml.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/, '');
}

describe('legitimate formulas render exactly as before', () => {
  const variants = [
    { output: 'htmlAndMathml', displayMode: false },
    { output: 'html', displayMode: true },
    { output: 'mathml', displayMode: true },
  ] as const;

  for (const latex of LEGITIMATE_MATH_CORPUS) {
    it(`KaTeX and Temml: ${latex}`, () => {
      for (const variant of variants) {
        const before = attempt(() =>
          katex.renderToString(latex, { ...variant, throwOnError: false, strict: false }),
        );
        const after = attempt(() =>
          katex.renderToString(
            latex,
            safeKatexOptions({ ...variant, throwOnError: false, strict: false }),
          ),
        );
        expect(after).toBe(before);
      }
      expect(attempt(() => temml.renderToString(latex, safeKatexOptions()))).toBe(
        attempt(() => temml.renderToString(latex)),
      );
    });
  }
});

describe('Temml script arguments after an inert definition', () => {
  // Stock Temml reports these as parse errors; with the definition expanded
  // to nothing, Temml throws a TypeError on the bare script (as stock Temml
  // does for `x^`). The PPTX export, the only Temml consumer, returns null.
  it.each([
    'x^',
    'x^\\notag',
    'x^\\nonumber',
    'x_\\def\\y{}',
    'x^\\let\\a b',
    'x^\\newcommand{\\y}{1}',
  ])('latexToOmml(%s) is null rather than throwing', (latex) => {
    expect(latexToOmml(latex)).toBeNull();
  });
});

describe('built-in equation numbering survives the hardening', () => {
  /** [formula, the explicit tags it shows]. Automatic numbers are CSS counters. */
  const NUMBERED: readonly [string, readonly string[]][] = [
    ['E = mc^2 \\tag{1}', ['(1)']],
    ['E = mc^2 \\tag*{a}', ['a']],
    ['\\begin{equation} x = y \\tag*{(*)} \\end{equation}', ['(*)']],
    ['\\begin{align} a &= b \\tag{1} \\\\ c &= d \\tag*{B} \\\\ e &= f \\end{align}', ['(1)', 'B']],
    [
      '\\begin{align} a &= b \\\\ c &= d \\nonumber \\\\ e &= f \\notag \\\\ g &= h \\tag{9} \\\\ i &= j \\end{align}',
      ['(9)'],
    ],
    ['\\begin{gather} a = b \\notag \\\\ c = d \\tag*{iv} \\end{gather}', ['iv']],
  ];
  const katexDisplay = (latex: string, options: object) =>
    katex.renderToString(latex, { ...options, displayMode: true, throwOnError: true });
  const temmlDisplay = (latex: string, options: object) =>
    temml.renderToString(latex, { ...options, displayMode: true, throwOnError: true });
  /** Visible text: markup and the source annotation removed. */
  const textOf = (html: string) =>
    html.replace(/<annotation[\s\S]*?<\/annotation>/g, '').replace(/<[^>]*>/g, '');

  for (const [latex, tags] of NUMBERED) {
    it(`KaTeX and Temml number ${latex} exactly as stock`, () => {
      for (const output of ['html', 'mathml', 'htmlAndMathml'] as const) {
        expect(katexDisplay(latex, safeKatexOptions({ output })), output).toBe(
          katexDisplay(latex, { output }),
        );
      }
      expect(temmlDisplay(latex, safeKatexOptions())).toBe(temmlDisplay(latex, {}));
      // Guard the comparison itself: stock output does show the tags.
      for (const tag of tags) {
        expect(textOf(katexDisplay(latex, safeKatexOptions({ output: 'html' })))).toContain(tag);
        expect(textOf(temmlDisplay(latex, safeKatexOptions()))).toContain(tag);
      }
    });
  }

  /** Automatic equation numbers: KaTeX's and Temml's counter cells. */
  const autoNumbers = (html: string) => html.match(/class="(?:eqn-num|tml-eqn)"/g)?.length ?? 0;

  it('suppresses align numbers with \\nonumber and \\notag', () => {
    const katexHtml = (latex: string) => katexDisplay(latex, safeKatexOptions({ output: 'html' }));
    const temmlMathml = (latex: string) => temmlDisplay(latex, safeKatexOptions());
    for (const render of [katexHtml, temmlMathml]) {
      expect(
        autoNumbers(render('\\begin{align} a &= b \\\\ c &= d \\\\ e &= f \\end{align}')),
      ).toBe(3);
      expect(
        autoNumbers(
          render('\\begin{align} a &= b \\nonumber \\\\ c &= d \\notag \\\\ e &= f \\end{align}'),
        ),
      ).toBe(1);
    }
  });

  describe('production consumers', () => {
    const consumers: Record<string, (latex: string) => string> = {
      'slide latex element': (latex) => renderLatexElementHtml(latex) ?? '',
      'quiz math text (display)': (latex) => renderLatexToHtml(latex, true) ?? '',
      'editor latex dialog': (latex) => {
        const result = renderLatexSource(latex);
        return 'html' in result ? (result.html ?? '') : `ERROR ${result.error}`;
      },
      'workbench chat markdown': (latex) =>
        renderToStaticMarkup(createElement(TextBlock, { text: `$$\n${latex}\n$$` })),
    };
    for (const [name, render] of Object.entries(consumers)) {
      it(`${name}: shows \\tag, \\tag*, and respects \\notag`, () => {
        expect(textOf(render('E=mc^2\\tag{1}'))).toContain('(1)');
        expect(textOf(render('E=mc^2\\tag*{(A)}'))).toContain('(A)');
        const all = render('\\begin{align} a &= b \\\\ c &= d \\\\ e &= f \\end{align}');
        const some = render(
          '\\begin{align} a &= b \\notag \\\\ c &= d \\nonumber \\\\ e &= f \\end{align}',
        );
        expect(autoNumbers(all)).toBeGreaterThan(0);
        expect(autoNumbers(some)).toBe(autoNumbers(all) / 3);
      });
    }
  });

  describe('the numbering path cannot define or expand anything else', () => {
    const render = (latex: string) => katexDisplay(latex, safeKatexOptions());
    const renderTemml = (latex: string) => temmlDisplay(latex, safeKatexOptions());

    it.each([
      ['a definition inside a tag', 'x \\tag{\\gdef\\ma{LEAK}} \\ma'],
      ['a definition used inside its tag', 'x \\tag{\\gdef\\ma{LEAK}\\ma}'],
      ['a \\newcommand inside a starred tag', 'x \\tag*{\\newcommand{\\ma}{LEAK}\\ma}'],
      [
        'a tag written as \\gdef\\df@tag, then a macro',
        '\\gdef\\df@tag{\\text{a}}\\gdef\\ma{LEAK} x \\ma',
      ],
      ['a recursive \\@eqnsw', '\\gdef\\@eqnsw{\\@eqnsw\\@eqnsw}\\@eqnsw'],
      ['\\@eqnsw set to text', '\\gdef\\@eqnsw{LEAK}\\@eqnsw'],
    ])('%s stays inert', (_name, latex) => {
      for (const engine of [render, renderTemml]) {
        expect(() => engine(latex)).toThrow(
          /Undefined control sequence|Unsupported function name|Multiple \\tag/,
        );
      }
    });

    it.each([
      ['\\tag{\\df@tag}', 'x \\tag{\\df@tag}'],
      ['\\tag{{\\df@tag}}', 'x \\tag{{\\df@tag}}'],
      ['\\gdef\\df@tag{\\text{\\df@tag}}', 'x \\gdef\\df@tag{\\text{\\df@tag}}'],
      [
        '\\expandafter\\gdef\\expandafter\\df@tag',
        'x \\expandafter\\gdef\\expandafter\\df@tag{\\text{\\df@tag}}',
      ],
    ])('self-referencing tag %s is dropped instead of recursing', (_name, latex) => {
      // Stock engines recurse on these until the stack or the expansion budget runs out.
      expect(() => katexDisplay(latex, {})).toThrow(/call stack|Too many expansions/);
      for (const engine of [render, renderTemml]) {
        const html = engine(latex);
        expect(textOf(html)).not.toMatch(/\(|df@tag/);
      }
    });

    it('expands a tag in full once, however often a formula names it', () => {
      const LONG = 'a'.repeat(2000);
      for (const latex of [
        `x \\tag*{${LONG}}${'\\df@tag '.repeat(200)}`,
        `x \\gdef\\df@tag{\\text{${LONG}}}${'\\df@tag '.repeat(200)}`,
      ]) {
        for (const engine of [render, renderTemml]) {
          const text = textOf(engine(latex));
          expect(text.split(LONG).length - 1).toBeLessThanOrEqual(2); // markup text and its MathML copy
          expect(text.length).toBeLessThan(4 * latex.length);
        }
      }
    });

    it('rejects a second tag, including one nested in the first', () => {
      for (const engine of [render, renderTemml]) {
        expect(() => engine('x \\tag{1} \\tag{2}')).toThrow(/Multiple \\tag/);
        expect(() => engine('x \\tag{\\tag{2}}')).toThrow(/Multiple \\tag/);
      }
    });

    it('drops tag shapes the built-ins never produce', () => {
      for (const latex of [
        'x \\gdef\\df@tag{y}',
        'x \\gdef\\df@tag{\\text{a}b}',
        'x \\gdef\\df@tag#1{\\text{#1}}',
      ]) {
        expect(textOf(render(latex)), latex).toBe(textOf(render('x')));
        expect(textOf(renderTemml(latex)), latex).toBe(textOf(renderTemml('x')));
      }
    });
  });
});
