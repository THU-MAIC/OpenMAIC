// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PPTCodeElement } from '@openmaic/dsl';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
  motion: { div: ({ children }: { children?: ReactNode }) => children },
}));
vi.mock('shiki', () => ({
  createHighlighter: () => new Promise(() => {}),
}));

import { BaseCodeElement } from '../../../src/elements/code/BaseCodeElement';
import { SlideElement } from '../../../src/SlideElement';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const code: PPTCodeElement = {
  id: 'code-1',
  type: 'code',
  left: 0,
  top: 0,
  width: 400,
  height: 150,
  rotate: 0,
  language: 'javascript',
  lines: [
    { id: 'line-1', content: 'const x = 42;' },
    { id: 'line-2', content: 'console.log(x);' },
  ],
  showLineNumbers: true,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const body = () => container.querySelector<HTMLElement>('.slide-renderer-code-body')!;

const pointer = (type: string, x: number, y: number) =>
  act(async () => {
    body().dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: x,
        clientY: y,
        pointerId: 7,
      }),
    );
  });

describe('BaseCodeElement pointer behavior', () => {
  it('drag-scrolls the code body and blocks text selection by default', async () => {
    await act(async () => root.render(createElement(BaseCodeElement, { elementInfo: code })));

    expect(body().style.userSelect).toBe('none');
    expect(body().style.touchAction).toBe('none');
    expect(body().style.cursor).toBe('grab');

    await pointer('pointerdown', 100, 100);
    expect(HTMLElement.prototype.setPointerCapture).toHaveBeenCalledWith(7);
    expect(body().style.cursor).toBe('grabbing');

    await pointer('pointermove', 80, 70);
    expect(body().scrollLeft).toBe(20);
    expect(body().scrollTop).toBe(30);

    await pointer('pointerup', 80, 70);
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(body().style.cursor).toBe('grab');
  });

  it('lets the pointer select code instead of drag-scrolling when selectable', async () => {
    await act(async () =>
      root.render(createElement(BaseCodeElement, { elementInfo: code, selectable: true })),
    );

    expect(body().style.userSelect).toBe('text');
    expect(body().style.touchAction).toBe('');
    expect(body().style.cursor).toBe('text');

    await pointer('pointerdown', 100, 100);
    expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();
    expect(body().style.cursor).toBe('text');
  });

  it('is passed through SlideElement, which then takes pointer input', async () => {
    await act(async () =>
      root.render(createElement(SlideElement, { elementInfo: code, elementIndex: 0 })),
    );
    const hitTarget = () => container.querySelector<HTMLElement>('.slide-element-hit-target')!;
    expect(hitTarget().style.pointerEvents).toBe('');
    expect(body().style.userSelect).toBe('none');

    await act(async () =>
      root.render(
        createElement(SlideElement, { elementInfo: code, elementIndex: 0, selectable: true }),
      ),
    );
    expect(hitTarget().style.pointerEvents).toBe('auto');
    expect(body().style.userSelect).toBe('text');
  });
});

describe('BaseCodeElement line animation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('types the first line at once and holds later lines back on the first render', async () => {
    await act(async () =>
      root.render(createElement(BaseCodeElement, { elementInfo: code, animate: true })),
    );
    expect(container.textContent).toContain('const x = 42;');
    expect(container.textContent).not.toContain('console.log(x);');
  });

  it('mounts held-back lines when equal lines replace them mid-animation', async () => {
    await act(async () =>
      root.render(createElement(BaseCodeElement, { elementInfo: code, animate: true })),
    );
    await act(async () =>
      root.render(
        createElement(BaseCodeElement, {
          elementInfo: { ...code, lines: code.lines.map((line) => ({ ...line })) },
          animate: true,
        }),
      ),
    );
    await act(async () => vi.advanceTimersByTime(0));
    await act(async () => vi.advanceTimersByTime(0));
    expect(container.textContent).toContain('console.log(x);');
  });
});
