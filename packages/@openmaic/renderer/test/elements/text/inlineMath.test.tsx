// @vitest-environment jsdom
import type { ReactElement } from 'react';
import katex from 'katex';
import { render } from '@testing-library/react';
import type { PPTShapeElement, PPTTableElement, PPTTextElement } from '@openmaic/dsl';
import { describe, expect, it, vi } from 'vitest';
import { BaseShapeElement } from '../../../src/elements/shape/BaseShapeElement';
import { StaticTable } from '../../../src/elements/table/StaticTable';
import { BaseTextElement } from '../../../src/elements/text/BaseTextElement';
import {
  INLINE_MATH_MAX_ROOT_FORMULAS,
  INLINE_MATH_SYNC_SOURCE_BUDGET,
  MAX_INLINE_MATH_SOURCE,
  completeInlineMath,
  renderInlineMath,
} from '../../../src/utils/inlineMath';

const LATEX = '\\sqrt{x}+\\frac{a}{b}';

/** Stored prose: the formula as source only. */
function stored(latex: string): string {
  const span = document.createElement('span');
  span.setAttribute('data-inline-math', latex);
  span.textContent = latex;
  return span.outerHTML;
}

function host(html: string): HTMLElement {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
}

function expectTypeset(root: ParentNode, latex: string): void {
  const formulas = root.querySelectorAll('[data-inline-math]');
  expect(formulas).toHaveLength(1);
  const formula = formulas[0];
  expect(formula.getAttribute('data-inline-math')).toBe(latex);
  expect(formula.classList.contains('katex')).toBe(true);
  expect(formula.querySelector('.katex')).toBeNull();
  expect(formula.querySelector('math')).toBeNull();
}

describe('renderInlineMath', () => {
  it('typesets a source-only formula from its attribute', () => {
    const root = host(`<p>Area: ${stored(LATEX)} units</p>`);
    renderInlineMath(root);
    expectTypeset(root, LATEX);
    expect(root.querySelector('svg')).not.toBeNull(); // the radical
    expect(root.innerHTML).toMatch(/style="top:/);
    expect(root.textContent).toMatch(/^Area: .* units$/);
  });

  it('re-renders older content that still carries KaTeX markup', () => {
    const editor = katex
      .renderToString(LATEX)
      .replace('<span class="katex">', `<span class="katex" data-inline-math="${LATEX}">`);
    const root = host(`<p>${editor}</p>`);
    renderInlineMath(root);
    expectTypeset(root, LATEX);
  });

  it('is stable when run again', () => {
    const root = host(`<p>${stored('x^2')} and ${stored('y_1')}</p>`);
    renderInlineMath(root);
    const once = root.innerHTML;
    renderInlineMath(root);
    expect(root.innerHTML).toBe(once);
  });

  it('shows over-long sources as text', () => {
    const latex = 'x'.repeat(MAX_INLINE_MATH_SOURCE + 1);
    const root = host(`<p>${stored(latex)}</p>`);
    renderInlineMath(root);
    expect(root.querySelector('.katex')).toBeNull();
    expect(root.textContent).toBe(latex);
  });

  it('cannot define macros or run away on a macro bomb', () => {
    const bomb =
      `\\def\\a{${'x+'.repeat(500)}}` +
      `\\def\\b{${'\\a'.repeat(10)}}\\def\\c{${'\\b'.repeat(10)}}${'\\c'.repeat(9)}`;
    const root = host(`<p>${stored(bomb)}</p>`);
    const started = performance.now();
    renderInlineMath(root);
    expect(performance.now() - started).toBeLessThan(500);
    expect(root.textContent!.length).toBeLessThan(bomb.length * 2);
  });

  it('typesets ordinary formulas exactly as the previous hardened options did', () => {
    // The options this module used before it adopted `safeKatexOptions`.
    const previous = {
      displayMode: false,
      output: 'html',
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      maxExpand: 1000,
      macros: Object.fromEntries(
        [
          '\\def',
          '\\gdef',
          '\\edef',
          '\\xdef',
          '\\let',
          '\\futurelet',
          '\\global',
          '\\newcommand',
          '\\renewcommand',
          '\\providecommand',
        ].map((name) => [name, '']),
      ),
    } as const;
    for (const latex of [
      LATEX,
      'e^{i\\pi}+1=0',
      '\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}',
      '\\alpha \\neq \\beta \\iff \\gamma \\dots',
      '\\mathbb{R}^n \\to \\mathbb{R}',
    ]) {
      const root = host(`<p>${stored(latex)}</p>`);
      renderInlineMath(root);
      const reference = document.createElement('span');
      katex.render(latex, reference, { ...previous, macros: { ...previous.macros } });
      reference.firstElementChild!.setAttribute('data-inline-math', latex);
      expect(root.querySelector('[data-inline-math]')!.outerHTML).toBe(
        reference.firstElementChild!.outerHTML,
      );
    }
  });

  it('keeps formula-defined macros inert, within and across formulas', () => {
    const root = host(
      `<p>${stored('\\def\\leak{LEAKED}\\leak')} ${stored('\\newcommand{\\nc}{LEAKED}\\nc')} ` +
        `${stored('\\gdef\\shared{LEAKED}x')} ${stored('\\shared')}</p>`,
    );
    renderInlineMath(root);
    const formulas = root.querySelectorAll('[data-inline-math]');
    expect(formulas).toHaveLength(4);
    for (const formula of formulas) expect(formula.classList.contains('katex')).toBe(true);
    expect(root.textContent).not.toContain('LEAKED');
    // The undefined names are shown like any unknown command, as their source.
    const shown = [...formulas].map((formula) => formula.textContent);
    expect(shown).toEqual(['\\leak', '\\nc', 'x', '\\shared']);
  });

  it('typesets long legitimate formulas that expand many built-in macros', () => {
    // 30 × (\neq, \iff, \, and \dots): well over 100 built-in expansions.
    const latex = Array.from(
      { length: 30 },
      (_, i) => `a_{${i}} \\neq b_{${i}} \\iff c\\,d \\dots`,
    ).join(',\\ ');
    const root = host(`<p>${stored(latex)}</p>`);
    renderInlineMath(root);
    expectTypeset(root, latex);
    expect(root.querySelector('.katex-error')).toBeNull();
  });

  it('keeps the source of a formula KaTeX rejects', () => {
    const root = host(`<p>${stored('\\frac{')}</p>`);
    renderInlineMath(root);
    expect(root.querySelector('[data-inline-math]')?.getAttribute('data-inline-math')).toBe(
      '\\frac{',
    );
  });

  it('treats the source as text, never markup', () => {
    const latex = 'x</span><img src=x onerror=alert(1)>';
    const root = host(`<p>${stored(latex)}</p>`);
    renderInlineMath(root);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('[data-inline-math]')?.getAttribute('data-inline-math')).toBe(latex);
  });
});

describe('slide elements typeset inline formulas', () => {
  const box = { left: 0, top: 0, width: 400, height: 80, rotate: 0 };
  const html = `<p>Area: ${stored(LATEX)} units</p>`;

  it('in text elements', () => {
    const { container } = render(
      <BaseTextElement
        elementInfo={
          {
            ...box,
            id: 't',
            type: 'text',
            content: html,
            defaultFontName: '',
            defaultColor: '#000',
          } as PPTTextElement
        }
      />,
    );
    expectTypeset(container, LATEX);
  });

  it('in shape text', () => {
    const { container } = render(
      <BaseShapeElement
        elementInfo={
          {
            ...box,
            id: 's',
            type: 'shape',
            viewBox: [200, 200],
            path: 'M 0 0 L 200 0 L 200 200 Z',
            fixedRatio: false,
            fill: '#fff',
            text: { content: html, defaultFontName: '', defaultColor: '#000', align: 'middle' },
          } as PPTShapeElement
        }
      />,
    );
    expectTypeset(container, LATEX);
  });

  it('in table cells, again when a cell changes', () => {
    const table = (text: string) =>
      ({
        ...box,
        id: 'tb',
        type: 'table',
        outline: { width: 1, style: 'solid', color: '#000' },
        colWidths: [1],
        cellMinHeight: 20,
        data: [[{ id: 'c', colspan: 1, rowspan: 1, text }]],
      }) as PPTTableElement;
    const { container, rerender } = render(<StaticTable elementInfo={table(html)} />);
    expectTypeset(container, LATEX);
    rerender(<StaticTable elementInfo={table(`<p>${stored('y^2')}</p>`)} />);
    expectTypeset(container, 'y^2');
  });

  const textElement = (content: string, left = 0) =>
    ({
      ...box,
      left,
      id: 't',
      type: 'text',
      content,
      defaultFontName: '',
      defaultColor: '#000',
    }) as PPTTextElement;
  const shapeElement = (content: string, left = 0) =>
    ({
      ...box,
      left,
      id: 's',
      type: 'shape',
      viewBox: [200, 200],
      path: 'M 0 0 L 200 0 L 200 200 Z',
      fixedRatio: false,
      fill: '#fff',
      text: { content, defaultFontName: '', defaultColor: '#000', align: 'middle' },
    }) as PPTShapeElement;
  const tableElement = (text: string, width = 400) =>
    ({
      ...box,
      width,
      id: 'tb',
      type: 'table',
      outline: { width: 1, style: 'solid', color: '#000' },
      colWidths: [1],
      cellMinHeight: 20,
      data: [[{ id: 'c', colspan: 1, rowspan: 1, text }]],
    }) as PPTTableElement;

  it('stay typeset when only geometry changes, and follow content changes', () => {
    const text = render(<BaseTextElement elementInfo={textElement(html)} />);
    text.rerender(<BaseTextElement elementInfo={textElement(html, 120)} />);
    expectTypeset(text.container, LATEX);
    text.rerender(<BaseTextElement elementInfo={textElement(`<p>${stored('z_1')}</p>`, 120)} />);
    expectTypeset(text.container, 'z_1');

    const shape = render(<BaseShapeElement elementInfo={shapeElement(html)} />);
    shape.rerender(<BaseShapeElement elementInfo={shapeElement(html, 120)} />);
    expectTypeset(shape.container, LATEX);
    shape.rerender(<BaseShapeElement elementInfo={shapeElement(`<p>${stored('z_2')}</p>`, 120)} />);
    expectTypeset(shape.container, 'z_2');

    const table = render(<StaticTable elementInfo={tableElement(html)} />);
    table.rerender(<StaticTable elementInfo={tableElement(html, 500)} />);
    expectTypeset(table.container, LATEX);
    table.rerender(<StaticTable elementInfo={tableElement(`<p>${stored('z_3')}</p>`, 500)} />);
    expectTypeset(table.container, 'z_3');
  });

  it('stay typeset when re-rendered with identical content, and on A→B→A→A', () => {
    const a = `<p>${stored('x^2')}</p>`;
    const b = `<p>${stored('y^2')}</p>`;
    const cases = [
      [BaseTextElement, (content: string) => textElement(content)],
      [BaseShapeElement, (content: string) => shapeElement(content)],
      [StaticTable, (content: string) => tableElement(content)],
    ] as const;
    for (const [Component, make] of cases) {
      const Element = Component as unknown as (props: { elementInfo: unknown }) => ReactElement;
      const same = make(a);
      const view = render(<Element elementInfo={same} />);
      view.rerender(<Element elementInfo={same} />);
      expectTypeset(view.container, 'x^2');
      for (const [content, latex] of [
        [b, 'y^2'],
        [a, 'x^2'],
        [a, 'x^2'],
      ] as const) {
        view.rerender(<Element elementInfo={make(content)} />);
        expectTypeset(view.container, latex);
      }
      view.unmount();
    }
  });
});

describe('inline math typesetting budget', () => {
  /** A distinct ~1900-character matrix: expensive to typeset and never cached. */
  const matrix = (index: number) =>
    `\\begin{pmatrix}${Array.from({ length: 160 }, (_, k) => `a_{${index}${k}}`).join('&')}\\end{pmatrix}`.slice(
      0,
      1_900,
    );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  it('typesets ordinary prose in one pass', () => {
    const root = host(
      Array.from({ length: 60 }, (_, index) => `<p>${stored(`x_{${index}}^2+${index}`)}</p>`).join(
        '',
      ),
    );
    expect(renderInlineMath(root)).toBe(false);
    expect(root.querySelectorAll('.katex[data-inline-math]')).toHaveLength(60);
  });

  it('leaves heavy formulas past the budget for later passes', async () => {
    const sources = Array.from({ length: 8 }, (_, index) => `${matrix(index)}+${index}`);
    expect(sources.every((source) => source.length <= MAX_INLINE_MATH_SOURCE)).toBe(true);
    const root = host(sources.map((source) => `<p>${stored(source)}</p>`).join(''));
    expect(renderInlineMath(root)).toBe(true);
    const first = root.querySelectorAll('.katex[data-inline-math]').length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(Math.ceil(INLINE_MATH_SYNC_SOURCE_BUDGET / 1_900));
    let passes = 1;
    while (renderInlineMath(root)) passes += 1;
    expect(passes).toBeGreaterThan(1);
    expect(root.querySelectorAll('.katex[data-inline-math]')).toHaveLength(sources.length);
  });

  it('typesets everything at once when asked to complete', () => {
    const sources = Array.from({ length: 6 }, (_, index) => `${matrix(index + 20)}+${index}`);
    const root = host(sources.map((source) => `<p>${stored(source)}</p>`).join(''));
    expect(renderInlineMath(root, { complete: true })).toBe(false);
    expect(root.querySelectorAll('.katex[data-inline-math]')).toHaveLength(sources.length);
  });

  it('shows formulas past the hard cap as text', () => {
    const count = INLINE_MATH_MAX_ROOT_FORMULAS + 2;
    const root = host(
      `<p>${Array.from({ length: count }, (_, index) => stored(`q_{${index}}`)).join(' ')}</p>`,
    );
    renderInlineMath(root, { complete: true });
    expect(root.querySelectorAll('.katex[data-inline-math]')).toHaveLength(
      INLINE_MATH_MAX_ROOT_FORMULAS,
    );
    expect(root.textContent).toContain(`q_{${count - 1}}`);
  });

  it('finishes the rest in idle time after mount', async () => {
    const box = { left: 0, top: 0, width: 400, height: 80, rotate: 0 };
    const sources = Array.from({ length: 6 }, (_, index) => `${matrix(index + 40)}+${index}`);
    const content = sources.map((source) => `<p>${stored(source)}</p>`).join('');
    const element = {
      ...box,
      id: 'heavy',
      type: 'text',
      content,
      defaultFontName: '',
      defaultColor: '#000',
    } as PPTTextElement;
    const view = render(<BaseTextElement elementInfo={element} />);
    const typeset = () => view.container.querySelectorAll('.katex[data-inline-math]').length;
    expect(typeset()).toBeLessThan(sources.length);
    for (let index = 0; index < 20 && typeset() < sources.length; index += 1) await settle();
    expect(typeset()).toBe(sources.length);
  });

  it('cancels idle work on unmount, and a late idle callback does nothing', () => {
    const callbacks = new Map<number, () => void>();
    let next = 0;
    const request = vi.fn((callback: () => void) => {
      next += 1;
      callbacks.set(next, callback);
      return next;
    });
    const cancel = vi.fn((handle: number) => callbacks.delete(handle));
    vi.stubGlobal('requestIdleCallback', request);
    vi.stubGlobal('cancelIdleCallback', cancel);
    try {
      const sources = Array.from({ length: 6 }, (_, index) => `${matrix(index + 60)}+${index}`);
      const element = {
        left: 0,
        top: 0,
        width: 400,
        height: 80,
        rotate: 0,
        id: 'heavy-3',
        type: 'text',
        content: sources.map((source) => `<p>${stored(source)}</p>`).join(''),
        defaultFontName: '',
        defaultColor: '#000',
      } as PPTTextElement;
      const view = render(<BaseTextElement elementInfo={element} />);
      expect(request).toHaveBeenCalled();
      const [handle, late] = [...callbacks.entries()].at(-1)!;
      view.unmount();
      expect(cancel).toHaveBeenCalledWith(handle);
      const typeset = vi.spyOn(katex, 'render');
      late();
      expect(typeset).not.toHaveBeenCalled();
      typeset.mockRestore();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps progress through repeated commits with formulas too large to cache', async () => {
    // Each render is ~170 KB of markup, over the cache's per-entry limit.
    const sources = Array.from({ length: 6 }, (_, index) => `${matrix(index + 80)}+${index}`);
    const content = sources.map((source) => `<p>${stored(source)}</p>`).join('');
    const box = { top: 0, width: 400, height: 80, rotate: 0 };
    const views = [
      (left: number) => (
        <BaseTextElement
          elementInfo={
            {
              ...box,
              left,
              id: 'big-text',
              type: 'text',
              content,
              defaultFontName: '',
              defaultColor: '#000',
            } as PPTTextElement
          }
        />
      ),
      (left: number) => (
        <BaseShapeElement
          elementInfo={
            {
              ...box,
              left,
              id: 'big-shape',
              type: 'shape',
              viewBox: [200, 200],
              path: 'M 0 0 L 200 0 L 200 200 Z',
              fixedRatio: false,
              fill: '#fff',
              text: { content, defaultFontName: '', defaultColor: '#000', align: 'middle' },
            } as PPTShapeElement
          }
        />
      ),
      (left: number) => (
        <StaticTable
          elementInfo={
            {
              ...box,
              left,
              id: 'big-table',
              type: 'table',
              outline: { width: 1, style: 'solid', color: '#000' },
              colWidths: [1],
              cellMinHeight: 20,
              data: [[{ id: 'c', colspan: 1, rowspan: 1, text: content }]],
            } as PPTTableElement
          }
        />
      ),
    ];
    for (const view of views) {
      const mounted = render(view(0));
      const typeset = () => mounted.container.querySelectorAll('.katex[data-inline-math]');
      expect(typeset()[0].outerHTML.length).toBeGreaterThan(64_000);
      let previous = typeset().length;
      const first = typeset()[0];
      for (let commit = 1; commit <= 5; commit += 1) {
        mounted.rerender(view(commit * 10));
        expect(typeset().length).toBeGreaterThanOrEqual(previous);
        expect(typeset()[0]).toBe(first);
        previous = typeset().length;
      }
      for (let index = 0; index < 20 && typeset().length < sources.length; index += 1) {
        await settle();
      }
      expect(typeset()).toHaveLength(sources.length);
      mounted.unmount();
    }
  });
});

describe('completeInlineMath', () => {
  function rootWith(count: number, prefix: string): HTMLElement {
    const root = document.createElement('div');
    root.setAttribute('data-inline-math-root', '');
    root.innerHTML = `<p>${Array.from({ length: count }, (_, index) => stored(`${prefix}_{${index}}`)).join(' ')}</p>`;
    return root;
  }

  it('applies the hard cap to each root on its own', () => {
    const container = document.createElement('div');
    const roots = [rootWith(600, 'a'), rootWith(600, 'b')];
    container.append(...roots);
    completeInlineMath(container);
    for (const root of roots) {
      expect(root.querySelectorAll('.katex[data-inline-math]')).toHaveLength(600);
    }
  });

  it('caps a root the same way whatever earlier passes typeset', () => {
    const count = INLINE_MATH_MAX_ROOT_FORMULAS + 2;
    const root = rootWith(count, 'c');
    const tail = document.createElement('p');
    for (const formula of [...root.querySelectorAll('[data-inline-math]')].slice(-3)) {
      tail.append(formula);
    }
    root.append(tail);
    // Typeset the tail first, as a separate pass over part of the root would.
    renderInlineMath(tail, { complete: true });
    expect(tail.querySelectorAll('.katex[data-inline-math]')).toHaveLength(3);
    renderInlineMath(root, { complete: true });
    expect(root.querySelectorAll('.katex[data-inline-math]')).toHaveLength(
      INLINE_MATH_MAX_ROOT_FORMULAS,
    );
    expect(tail.querySelectorAll('.katex[data-inline-math]')).toHaveLength(1);
    expect(tail.textContent).toContain(`c_{${count - 1}}`);
    renderInlineMath(root, { complete: true });
    expect(root.querySelectorAll('.katex[data-inline-math]')).toHaveLength(
      INLINE_MATH_MAX_ROOT_FORMULAS,
    );
  });
});
