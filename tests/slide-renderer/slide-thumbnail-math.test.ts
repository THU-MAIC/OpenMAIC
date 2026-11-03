// @vitest-environment jsdom
import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import { SlideCanvas } from '@openmaic/renderer';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { useNearViewport } from '@/lib/hooks/use-near-viewport';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

afterEach(() => vi.unstubAllGlobals());

it.each(['ordinary', 'heavy'] as const)(
  'prioritizes the %s canvas after near-viewport sidebar thumbnails mount',
  async (kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const observers: IntersectionObserverCallback[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    const callbacks = new Map<number, () => void>();
    let next = 0;
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      callbacks.set(++next, callback);
      return next;
    });
    vi.stubGlobal('cancelIdleCallback', (handle: number) => callbacks.delete(handle));

    const slide = (id: string, sources: string[]): Slide =>
      ({
        id,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [
          {
            id: `${id}-text`,
            type: 'text',
            left: 0,
            top: 0,
            width: 900,
            height: 500,
            rotate: 0,
            defaultFontName: 'Arial',
            defaultColor: '#000',
            content: sources
              .map((source) => {
                const span = document.createElement('span');
                span.setAttribute('data-inline-math', source);
                span.textContent = source;
                return span.outerHTML;
              })
              .join(' '),
          },
        ],
      }) as Slide;
    const heavy = slide(
      'heavy',
      Array.from(
        { length: 30 },
        (_, i) =>
          `\\begin{pmatrix}${Array.from({ length: 40 }, (_, j) => `a_{${i * 50 + j}}`).join('&')}\\end{pmatrix}`,
      ),
    );
    const first = slide('first', ['p^2']);
    const target =
      kind === 'ordinary'
        ? slide('target', ['x^2', 'y+1', '\\frac{a}{b}'])
        : { ...heavy, id: 'target' };
    function LazyThumbnail() {
      const ref = useRef<HTMLDivElement>(null);
      const visible = useNearViewport(ref);
      return createElement(
        'div',
        // React forwards the ref; createElement does not read ref.current.
        // eslint-disable-next-line react-hooks/refs
        { ref },
        createElement(SlideThumbnail, { slide: heavy, visible, viewportRatio: 0.5625 }),
      );
    }
    function Layout({ main }: { main: Slide }) {
      return createElement(
        'div',
        null,
        createElement(
          'aside',
          null,
          ...[0, 1, 2].map((key) => createElement(LazyThumbnail, { key })),
        ),
        createElement(
          'main',
          null,
          createElement(SlideCanvas, { key: main.id, slide: main, scale: 1 }),
        ),
      );
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(Layout, { main: first })));
      await act(async () => {
        for (const callback of observers)
          callback(
            [{ isIntersecting: true }] as IntersectionObserverEntry[],
            {} as IntersectionObserver,
          );
      });
      expect(host.querySelectorAll('aside [data-inline-math-root]')).toHaveLength(3);
      const [handle, callback] = callbacks.entries().next().value!;
      callbacks.delete(handle);
      await act(async () => callback());
      await act(async () => root.render(createElement(Layout, { main: target })));
      const count = (area: string) =>
        host.querySelectorAll(`${area} .katex[data-inline-math]`).length;
      if (kind === 'ordinary') expect(count('main')).toBe(3);
      else {
        const mainBefore = count('main');
        const sidebarBefore = count('aside');
        const [handle, callback] = callbacks.entries().next().value!;
        callbacks.delete(handle);
        await act(async () => callback());
        expect(count('main')).toBeGreaterThan(mainBefore);
        expect(count('aside')).toBe(sidebarBefore);
      }
      expect(host.querySelectorAll('aside .katex[data-inline-math]').length).toBeLessThan(90);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
    expect(callbacks.size).toBe(0);
  },
);
