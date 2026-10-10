// @vitest-environment jsdom
/**
 * The app's slide renderer typesets stored inline formulas
 * (`<span data-inline-math="SRC">SRC</span>`) in text, shape and table prose,
 * keeps them typeset across re-renders that leave the content alone, and
 * re-typesets when the content changes.
 */
import { createElement, type ComponentType } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PPTShapeElement, PPTTableElement, PPTTextElement } from '@openmaic/dsl';
import { afterEach, describe, expect, it } from 'vitest';
import { BaseShapeElement } from '@/components/slide-renderer/components/element/ShapeElement/BaseShapeElement';
import { StaticTable } from '@/components/slide-renderer/components/element/TableElement/StaticTable';
import { BaseTextElement } from '@/components/slide-renderer/components/element/TextElement/BaseTextElement';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LATEX = '\\sqrt{x}+\\frac{a}{b}';
const box = { left: 0, top: 0, width: 400, height: 80, rotate: 0 };

function stored(latex: string): string {
  const span = document.createElement('span');
  span.setAttribute('data-inline-math', latex);
  span.textContent = latex;
  return span.outerHTML;
}

const prose = (latex: string) => `<p>Area: ${stored(latex)} units</p>`;

const text = (content: string, left = 0) =>
  ({
    ...box,
    left,
    id: 't',
    type: 'text',
    content,
    defaultFontName: '',
    defaultColor: '#000',
  }) as PPTTextElement;
const shape = (content: string, left = 0) =>
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
const table = (content: string, width = 400) =>
  ({
    ...box,
    width,
    id: 'tb',
    type: 'table',
    outline: { width: 1, style: 'solid', color: '#000' },
    colWidths: [1],
    cellMinHeight: 20,
    data: [[{ id: 'c', colspan: 1, rowspan: 1, text: content }]],
  }) as PPTTableElement;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount<P extends object>(component: ComponentType<P>, props: P): (next: P) => void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(component, props)));
  return (next) => act(() => root!.render(createElement(component, next)));
}

function expectTypeset(latex: string): void {
  const formulas = host!.querySelectorAll('[data-inline-math]');
  expect(formulas).toHaveLength(1);
  expect(formulas[0].getAttribute('data-inline-math')).toBe(latex);
  expect(formulas[0].classList.contains('katex')).toBe(true);
}

describe('app slide renderer — inline formulas', () => {
  it('in text elements, across a move and a content change', () => {
    const update = mount(BaseTextElement, { elementInfo: text(prose(LATEX)) });
    expectTypeset(LATEX);
    update({ elementInfo: text(prose(LATEX), 120) });
    expectTypeset(LATEX);
    update({ elementInfo: text(prose('y^2'), 120) });
    expectTypeset('y^2');
  });

  it('in shape text, across a move and a content change', () => {
    const update = mount(BaseShapeElement, { elementInfo: shape(prose(LATEX)) });
    expectTypeset(LATEX);
    update({ elementInfo: shape(prose(LATEX), 120) });
    expectTypeset(LATEX);
    update({ elementInfo: shape(prose('y^2'), 120) });
    expectTypeset('y^2');
  });

  it('in table cells, across a resize and a content change', () => {
    const update = mount(StaticTable, { elementInfo: table(prose(LATEX)) });
    expectTypeset(LATEX);
    update({ elementInfo: table(prose(LATEX), 500) });
    expectTypeset(LATEX);
    update({ elementInfo: table(prose('y^2'), 500) });
    expectTypeset('y^2');
  });

  it('stays typeset on identical re-renders and on A→B→A→A, in every element', () => {
    const cases = [
      [BaseTextElement, (content: string) => text(content)],
      [BaseShapeElement, (content: string) => shape(content)],
      [StaticTable, (content: string) => table(content)],
    ] as const;
    for (const [component, make] of cases) {
      const same = make(prose('x^2'));
      const update = mount(component as ComponentType<{ elementInfo: unknown }>, {
        elementInfo: same,
      });
      update({ elementInfo: same });
      expectTypeset('x^2');
      for (const latex of ['y^2', 'x^2', 'x^2']) {
        update({ elementInfo: make(prose(latex)) });
        expectTypeset(latex);
      }
      act(() => root?.unmount());
      host?.remove();
      root = null;
      host = null;
    }
  });

  it('keeps progress through repeated commits with formulas too large to cache', async () => {
    // A ~1360-character matrix renders to ~170 KB of markup: over the cache's
    // per-entry limit, so every re-typeset is full price.
    const matrix = (index: number) =>
      `\\begin{pmatrix}${Array.from({ length: 160 }, (_, k) => `a_{${index}${k}}`).join('&')}\\end{pmatrix}`;
    const content = Array.from(
      { length: 6 },
      (_, index) => `<p>${stored(matrix(index + 300))}</p>`,
    ).join('');
    const cases = [
      [BaseTextElement, (left: number) => text(content, left)],
      [StaticTable, (left: number) => table(content, 400 + left)],
    ] as const;
    for (const [component, make] of cases) {
      const update = mount(component as ComponentType<{ elementInfo: unknown }>, {
        elementInfo: make(0),
      });
      const typeset = () => host!.querySelectorAll('.katex[data-inline-math]');
      let previous = typeset().length;
      const first = typeset()[0];
      for (let commit = 1; commit <= 5; commit += 1) {
        update({ elementInfo: make(commit * 10) });
        expect(typeset().length).toBeGreaterThanOrEqual(previous);
        expect(typeset()[0]).toBe(first);
        previous = typeset().length;
      }
      for (let index = 0; index < 20 && typeset().length < 6; index += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
        });
      }
      expect(typeset()).toHaveLength(6);
      act(() => root?.unmount());
      host?.remove();
      root = null;
      host = null;
    }
  });
});
