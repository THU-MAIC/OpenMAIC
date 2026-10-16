// @vitest-environment jsdom
import { useRef } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import katex from 'katex';
import type { Slide, PPTTextElement } from '@openmaic/dsl';
import { SlideCanvas } from '../src/SlideCanvas';
import { renderInlineMath, useInlineMath, useInnerHtml } from '../src/utils/inlineMath';

const stored = (latex: string) => {
  const span = document.createElement('span');
  span.setAttribute('data-inline-math', latex);
  span.textContent = latex;
  return span.outerHTML;
};
const matrix = (i: number) =>
  `\\begin{pmatrix}${Array.from({ length: 40 }, (_, k) => `a_{${i + k}}`).join('&')}\\end{pmatrix}`;
const heavy = Array.from({ length: 30 }, (_, i) => matrix(i * 50));
const ordinary = ['x^2', 'y+1', '\\frac{a}{b}'];
const count = (root: ParentNode) => root.querySelectorAll('.katex[data-inline-math]').length;

function slide(id: string, roots: string[][]): Slide {
  return {
    id,
    viewportSize: 1000,
    viewportRatio: 0.5625,
    elements: roots.map(
      (sources, i): PPTTextElement => ({
        id: `${id}-${i}`,
        type: 'text',
        left: 0,
        top: i * 20,
        width: 960,
        height: 520,
        rotate: 0,
        defaultFontName: 'Arial',
        defaultColor: '#000',
        content: sources.map(stored).join(' '),
      }),
    ),
  } as Slide;
}

function Layout({ main, thumbnails }: { main: Slide; thumbnails: Slide[] }) {
  return (
    <>
      <aside>
        {thumbnails.map((item) => (
          <SlideCanvas key={item.id} slide={item} scale={0.2} mathPriority="background" />
        ))}
      </aside>
      <main>
        <SlideCanvas key={main.id} slide={main} scale={1} />
      </main>
    </>
  );
}

// Native work is deliberately advanced at the frame/idle boundaries under test.
function callbackQueue() {
  const callbacks = new Map<number, () => void>();
  let id = 0;
  return {
    callbacks,
    request: (callback: () => void) => {
      callbacks.set(++id, callback);
      return id;
    },
    cancel: (handle: number) => {
      callbacks.delete(handle);
    },
    step() {
      const next = callbacks.entries().next().value;
      if (!next) return;
      callbacks.delete(next[0]);
      next[1]();
    },
    flush() {
      for (let i = 0; callbacks.size && i < 300; i++) this.step();
      expect(callbacks.size).toBe(0);
    },
  };
}

describe('inline math in playback layouts', () => {
  let idle: ReturnType<typeof callbackQueue>;
  let frames: ReturnType<typeof callbackQueue>;
  beforeEach(() => {
    idle = callbackQueue();
    frames = callbackQueue();
    vi.stubGlobal('requestIdleCallback', idle.request);
    vi.stubGlobal('cancelIdleCallback', idle.cancel);
    vi.stubGlobal('requestAnimationFrame', frames.request);
    vi.stubGlobal('cancelAnimationFrame', frames.cancel);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the first ordinary canvas synchronous when thumbnails precede it', () => {
    const view = render(
      <Layout
        main={slide('main', [ordinary])}
        thumbnails={[0, 1, 2].map((i) => slide(`thumb-${i}`, [heavy]))}
      />,
    );
    expect(count(view.container.querySelector('main')!)).toBe(3);
    idle.flush();
    expect(count(view.container.querySelector('aside')!)).toBe(90);
  });

  it.each(['ordinary', 'heavy'] as const)(
    'prioritizes a newly opened %s canvas over pending thumbnails',
    (kind) => {
      const first = slide('first', [ordinary]);
      const thumbnails = [0, 1, 2].map((i) => slide(`thumb-${i}`, [heavy]));
      const view = render(<Layout main={first} thumbnails={[]} />);
      frames.flush();
      // The near-viewport observer mounts thumbnails after the initial commit.
      view.rerender(<Layout main={first} thumbnails={thumbnails} />);
      frames.flush();
      idle.step();
      const target = kind === 'ordinary' ? ordinary : heavy;
      view.rerender(<Layout main={slide('target', [target])} thumbnails={thumbnails} />);
      const main = view.container.querySelector('main')!;
      const before = count(main);
      if (kind === 'ordinary') expect(before).toBe(3);
      else {
        expect(before).toBeGreaterThan(0);
        expect(before).toBeLessThan(30);
        const sidebarBefore = count(view.container.querySelector('aside')!);
        idle.step();
        expect(count(main)).toBeGreaterThan(before);
        expect(count(view.container.querySelector('aside')!)).toBe(sidebarBefore);
      }
      idle.flush();
      expect(count(main)).toBe(target.length);
    },
  );

  it('rotates mixed roots so ordinary prose does not wait for a heavy root to finish', () => {
    const view = render(
      <SlideCanvas
        slide={slide('mixed', [heavy, ['fresh_x^2', 'fresh_y+1', 'fresh_z']])}
        scale={1}
      />,
    );
    for (let i = 0; i < 2; i++) idle.step();
    const roots = view.container.querySelectorAll('[data-inline-math-root]');
    expect(count(roots[1])).toBe(3);
    expect(count(roots[0])).toBeLessThan(30);
  });

  it('renews the synchronous allowance at a frame without waiting for idle work', () => {
    const dense = slide('dense', [heavy]);
    const content = (extra: boolean) => (
      <>
        <SlideCanvas slide={dense} scale={1} />
        {extra && (
          <main>
            <SlideCanvas slide={slide('later', [ordinary])} scale={1} />
          </main>
        )}
      </>
    );
    const view = render(content(false));
    frames.flush();
    view.rerender(content(true));
    expect(count(view.container.querySelector('main')!)).toBe(3);
    expect(count(view.container.querySelector('[data-inline-math-root]')!)).toBeLessThan(30);
  });

  it('schedules no idle callback for a completed ordinary slide', () => {
    render(<SlideCanvas slide={slide('ordinary', [ordinary])} scale={1} />);
    expect(idle.callbacks.size).toBe(0);
  });

  it('does not replenish the shared allowance when plain prose roots mount between formulas', () => {
    const data = slide(
      'interleaved',
      heavy.slice(0, 8).flatMap((source) => [[source], []]),
    );
    const view = render(<SlideCanvas slide={data} scale={1} />);
    expect(count(view.container)).toBeGreaterThan(0);
    expect(count(view.container)).toBeLessThan(8);
    idle.flush();
    expect(count(view.container)).toBe(8);
  });

  it('reads current DOM when an external caller rewrites unchanged pending prose', () => {
    function Prose({ tick }: { tick: number }) {
      const ref = useRef<HTMLDivElement>(null);
      const html = heavy.map(stored).join('');
      useInlineMath(ref, html);
      return <div ref={ref} data-tick={tick} dangerouslySetInnerHTML={{ __html: html }} />;
    }
    const view = render(<Prose tick={0} />);
    idle.step();
    view.rerender(<Prose tick={1} />);
    idle.flush();
    expect(count(view.container)).toBe(30);
  });

  it('admits cached ordinary formulas that still fit after a large formula was deferred', () => {
    const warm = document.createElement('div');
    warm.innerHTML = ordinary.map(stored).join('');
    renderInlineMath(warm, { complete: true });
    const view = render(<SlideCanvas slide={slide('mixed-cached', [heavy, ordinary])} scale={1} />);
    expect(count(view.container.querySelectorAll('[data-inline-math-root]')[1])).toBe(3);
  });

  it('typesets each uncacheable formula once across rotating roots', () => {
    // Controlled output size isolates cache admission from KaTeX version changes.
    const typeset = vi.spyOn(katex, 'render').mockImplementation((_, host) => {
      host.innerHTML = `<span class="katex">${'x'.repeat(80_000)}</span>`;
    });
    const view = render(
      <SlideCanvas
        scale={1}
        slide={slide(
          'oversized',
          [0, 1, 2].map((i) => [0, 1, 2].map((j) => `oversized_${i}_${j}`)),
        )}
      />,
    );
    idle.flush();
    expect(count(view.container)).toBe(9);
    expect(typeset).toHaveBeenCalledTimes(9);
  });

  it('cleans up the current prose element after an editor replaces the original', () => {
    function Prose({ version }: { version: number }) {
      const ref = useRef<HTMLDivElement>(null);
      const html = heavy.map(stored).join('');
      useInlineMath(ref, html);
      return <div key={version} ref={ref} dangerouslySetInnerHTML={useInnerHtml(html)} />;
    }
    const view = render(<Prose version={0} />);
    view.rerender(<Prose version={1} />);
    view.unmount();
    expect(idle.callbacks.size).toBe(0);
    const next = render(<SlideCanvas slide={slide('next', [ordinary])} scale={1} />);
    expect(count(next.container)).toBe(3);
  });
});
