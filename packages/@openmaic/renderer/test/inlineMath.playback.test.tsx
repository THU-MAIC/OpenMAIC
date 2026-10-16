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

function Thumbnails({ slides }: { slides: Slide[] }) {
  return slides.map((item) => (
    <div key={item.id} data-testid={item.id}>
      <SlideCanvas
        slide={item}
        scale={0.2}
        mathPriority="background"
        // SlideThumbnail supplies fresh media callbacks on each store update.
        renderImage={() => null}
        renderVideo={() => null}
      />
    </div>
  ));
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

describe('inline math in playback layouts', { timeout: 30_000 }, () => {
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
    frames.flush();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the first ordinary canvas synchronous when thumbnails precede it', async () => {
    const view = render(
      <Layout
        main={slide('main', [ordinary])}
        thumbnails={[0, 1, 2].map((i) => slide(`thumb-${i}`, [heavy]))}
      />,
    );
    expect(count(view.container.querySelector('main')!)).toBe(3);
    await Promise.resolve();
    idle.flush();
    expect(count(view.container.querySelector('aside')!)).toBe(90);
  });

  it.each(['ordinary', 'heavy'] as const)(
    'prioritizes a newly opened %s canvas over pending thumbnails',
    async (kind) => {
      const first = slide('first', [ordinary]);
      const thumbnails = [0, 1, 2].map((i) => slide(`thumb-${i}`, [heavy]));
      const view = render(<Layout main={first} thumbnails={[]} />);
      frames.flush();
      // The near-viewport observer mounts thumbnails after the initial commit.
      view.rerender(<Layout main={first} thumbnails={thumbnails} />);
      await Promise.resolve();
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

  it('uses the remaining allowance for ordinary thumbnails before paint, including edits', async () => {
    const thumbnails = (sources: string[]) =>
      [0, 1, 2, 3, 4, 5].map((i) => slide(`thumb-${i}`, [sources]));
    const main = slide('main', [ordinary]);
    const view = render(<Layout main={main} thumbnails={thumbnails(ordinary)} />);
    expect(count(view.container.querySelector('main')!)).toBe(3);
    // A commit's microtasks run before its first paint; no idle callback runs here.
    await Promise.resolve();
    expect(count(view.container.querySelector('aside')!)).toBe(18);
    expect(idle.callbacks.size).toBe(0);

    frames.flush();
    view.rerender(<Layout main={main} thumbnails={thumbnails(['edited_x^3'])} />);
    await Promise.resolve();
    expect(count(view.container.querySelector('aside')!)).toBe(6);
    expect(idle.callbacks.size).toBe(0);
  });

  it('keeps the foreground allowance ahead of heavy thumbnails in the same commit', async () => {
    const view = render(
      <Layout main={slide('main', [ordinary])} thumbnails={[slide('thumb', [heavy])]} />,
    );
    expect(count(view.container.querySelector('main')!)).toBe(3);
    await Promise.resolve();
    const before = count(view.container.querySelector('aside')!);
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(30);
    // A second commit in the same frame must not grant thumbnails a new batch.
    view.rerender(
      <Layout main={slide('main', [ordinary])} thumbnails={[slide('thumb', [heavy])]} />,
    );
    await Promise.resolve();
    expect(count(view.container.querySelector('aside')!)).toBe(before);
    idle.flush();
    expect(count(view.container.querySelector('aside')!)).toBe(30);
  });

  it('does not schedule idle work when completed thumbnails rerender', async () => {
    const data = slide('thumbnail', [ordinary]);
    const thumbnail = () => (
      <SlideCanvas slide={data} scale={0.2} mathPriority="background" renderImage={() => null} />
    );
    const view = render(thumbnail());
    await Promise.resolve();
    idle.flush();
    for (let i = 0; i < 3; i++) {
      frames.flush();
      view.rerender(thumbnail());
      await Promise.resolve();
      expect(count(view.container)).toBe(3);
      expect(idle.callbacks.size).toBe(0);
    }
  });

  it('keeps pending heavy thumbnails in idle time during mixed streaming rerenders', async () => {
    const slides = Array.from({ length: 7 }, (_, i) =>
      slide(`thumb-${i}`, [i % 2 ? heavy : ordinary]),
    );
    const view = render(<Thumbnails slides={slides} />);
    await Promise.resolve();
    expect(count(view.getByTestId('thumb-0'))).toBe(3);
    const heavyCount = () =>
      [1, 3, 5].reduce((total, i) => total + count(view.getByTestId(`thumb-${i}`)), 0);
    const before = heavyCount();
    expect(before).toBeLessThan(90);

    for (let tick = 0; tick < 30; tick++) {
      frames.flush();
      view.rerender(<Thumbnails slides={slides} />);
      await Promise.resolve();
      // Unrelated updates must not move existing idle work ahead of paint.
      expect(heavyCount()).toBe(before);
    }
    idle.flush();
    expect(heavyCount()).toBe(90);
    expect(count(view.container)).toBe(102);
  });

  it('renders an edited ordinary thumbnail before paint behind pending heavy thumbnails', async () => {
    const small = slide('small', [ordinary]);
    const dense = [0, 1, 2].map((i) => slide(`dense-${i}`, [heavy]));
    const view = render(<Thumbnails slides={[small]} />);
    await Promise.resolve();
    expect(count(view.getByTestId('small'))).toBe(3);

    frames.flush();
    view.rerender(<Thumbnails slides={[...dense, small]} />);
    await Promise.resolve();
    const heavyCount = () =>
      dense.reduce((total, item) => total + count(view.getByTestId(item.id)), 0);
    const before = heavyCount();
    expect(before).toBeLessThan(90);

    frames.flush();
    view.rerender(
      <Thumbnails
        slides={[...dense, slide('small', [['edited_p^3', 'edited_q+2', 'edited_r']])]}
      />,
    );
    await Promise.resolve();
    expect(count(view.getByTestId('small'))).toBe(3);
    expect(heavyCount()).toBe(before);
    idle.flush();
    expect(count(view.container)).toBe(93);
  });

  it('preserves foreground priority when a thumbnail is promoted before its microtask', async () => {
    const thumbnail = slide('thumbnail', [heavy]);
    const target = slide('target', [heavy]);
    const content = (priority: 'normal' | 'background') => (
      <>
        <aside>
          <SlideCanvas slide={thumbnail} scale={0.2} mathPriority="background" />
        </aside>
        <main>
          <SlideCanvas slide={target} scale={1} mathPriority={priority} />
        </main>
      </>
    );
    const view = render(content('background'));
    view.rerender(content('normal'));
    const main = view.container.querySelector('main')!;
    const before = count(main);
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(30);
    await Promise.resolve();
    const sidebarBefore = count(view.container.querySelector('aside')!);
    idle.step();
    expect(count(main)).toBeGreaterThan(before);
    expect(count(view.container.querySelector('aside')!)).toBe(sidebarBefore);
    idle.flush();
    expect(count(view.container)).toBe(60);
  });

  it('retypesets stored KaTeX markup in thumbnails before paint', async () => {
    const data = slide('stored', [[]]);
    (data.elements[0] as PPTTextElement).content =
      '<span class="katex" data-inline-math="x^2">stale-render</span>';
    const view = render(<SlideCanvas slide={data} scale={0.2} mathPriority="background" />);
    await Promise.resolve();
    expect(view.container.textContent).not.toContain('stale-render');
    expect(count(view.container)).toBe(1);
    expect(idle.callbacks.size).toBe(0);
  });

  it('preserves the shared allowance when completed prose nodes are replaced together', () => {
    function Prose({ version, source }: { version: number; source: string }) {
      const ref = useRef<HTMLDivElement>(null);
      const html = stored(source);
      useInlineMath(ref, html);
      return <div key={version} ref={ref} dangerouslySetInnerHTML={useInnerHtml(html)} />;
    }
    const content = (version: number) =>
      heavy.slice(0, 8).map((source) => <Prose key={source} source={source} version={version} />);
    const view = render(content(0));
    expect(count(view.container)).toBeLessThan(8);
    idle.flush();
    frames.flush();
    expect(count(view.container)).toBe(8);

    view.rerender(content(1));
    expect(count(view.container)).toBeGreaterThan(0);
    expect(count(view.container)).toBeLessThan(8);
    idle.flush();
    expect(count(view.container)).toBe(8);
  });

  it('finishes queued math when only the request half of the frame API is available', () => {
    vi.stubGlobal('cancelAnimationFrame', undefined);
    const view = render(<SlideCanvas slide={slide('partial-frame-api', [heavy])} scale={1} />);
    expect(count(view.container)).toBeLessThan(30);
    idle.flush();
    expect(count(view.container)).toBe(30);
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
    frames.flush();
    const next = render(<SlideCanvas slide={slide('next', [ordinary])} scale={1} />);
    expect(count(next.container)).toBe(3);
  });
});
