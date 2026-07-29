// @vitest-environment jsdom
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { BaseLatexElement } from '../../../src/elements/latex/BaseLatexElement';
import type { PPTLatexElement } from '@openmaic/dsl';

/**
 * KaTeX lays out large delimiters (\left\{ … \begin{cases}) using the metrics of
 * its KaTeX_Size faces, which load asynchronously. The shrink-to-fit measurement
 * in BaseLatexElement must re-run once those fonts settle, or a cold export bakes
 * the stale fallback-metric scale and the brace desyncs from the piecewise body
 * (bug: "大括号后面的分段函数与大括号错位"). These tests drive that re-measure
 * with a fake `document.fonts` and stubbed layout metrics.
 */

// jsdom has no layout, so scrollWidth/scrollHeight are 0. Make them return a
// controllable value that changes after "fonts load" to simulate the metric
// shift a real KaTeX_Size face causes.
let naturalW = 0;
let naturalH = 0;
const origW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
const origH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
  configurable: true,
  get: () => naturalW,
});
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get: () => naturalH,
});

/** A controllable fake of `document.fonts` (FontFaceSet-ish). */
function installFakeFonts() {
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  const listeners = new Map<string, Set<() => void>>();
  const fonts = {
    ready,
    load: vi.fn(() => Promise.resolve([])),
    addEventListener: (type: string, cb: () => void) => {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(cb);
    },
    removeEventListener: (type: string, cb: () => void) => {
      listeners.get(type)?.delete(cb);
    },
  };
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  return {
    resolveReady,
    emitLoadingDone: () => listeners.get('loadingdone')?.forEach((cb) => cb()),
  };
}

function latex(html: string): PPTLatexElement {
  return {
    id: 'l1',
    type: 'latex',
    left: 0,
    top: 0,
    width: 100,
    height: 100,
    rotate: 0,
    html,
  } as unknown as PPTLatexElement;
}

/** Read the scale multiplier off the inner prose div's transform. */
function readScale(container: HTMLElement): number {
  const inner = container.querySelector('.slide-renderer-prose') as HTMLElement | null;
  const m = inner?.style.transform.match(/scale\(([-\d.]+)\)/);
  return m ? Number(m[1]) : NaN;
}

afterEach(() => {
  cleanup();
  naturalW = 0;
  naturalH = 0;
});

describe('BaseLatexElement — fit-scale re-measures after fonts settle', () => {
  it('recomputes scale on document.fonts.ready', async () => {
    const { resolveReady } = installFakeFonts();
    // Cold metrics: fallback font measures the formula as 100×100 → scale 1.
    naturalW = 100;
    naturalH = 100;

    const { container } = render(<BaseLatexElement elementInfo={latex('\\left\\{ x \\right.')} />);
    expect(readScale(container)).toBeCloseTo(1);

    // KaTeX_Size faces load: the real brace is wider (200px) → must shrink to 0.5.
    naturalW = 200;
    await act(async () => {
      resolveReady();
      await Promise.resolve();
    });
    expect(readScale(container)).toBeCloseTo(0.5);
  });

  it('recomputes scale on a loadingdone event too', async () => {
    const { emitLoadingDone } = installFakeFonts();
    naturalW = 100;
    naturalH = 100;
    const { container } = render(<BaseLatexElement elementInfo={latex('E=mc^2')} />);
    expect(readScale(container)).toBeCloseTo(1);

    naturalH = 400; // taller than the box → shrink to 0.25
    await act(async () => {
      emitLoadingDone();
      await Promise.resolve();
    });
    expect(readScale(container)).toBeCloseTo(0.25);
  });

  it('never enlarges past scale 1', async () => {
    const { resolveReady } = installFakeFonts();
    naturalW = 50; // smaller than the 100px box
    naturalH = 50;
    const { container } = render(<BaseLatexElement elementInfo={latex('x')} />);
    await act(async () => {
      resolveReady();
      await Promise.resolve();
    });
    expect(readScale(container)).toBeCloseTo(1);
  });
});

// Restore the prototype descriptors so other suites see real jsdom behavior.
afterAll(() => {
  if (origW) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', origW);
  if (origH) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', origH);
});
