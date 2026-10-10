// @vitest-environment jsdom
/**
 * Snapshot paths typeset every inline formula before capture, prose root by
 * prose root, so each text box keeps its own hard cap as on the live slide.
 */
import type { PPTTextElement, Slide } from '@openmaic/dsl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ counts: [] as number[][] }));

/** Per-root typeset formula counts in the tree being captured. */
function rootCounts(target: Element): number[] {
  return [...target.querySelectorAll('[data-inline-math-root]')].map(
    (root) => root.querySelectorAll('.katex[data-inline-math]').length,
  );
}

vi.mock('html-to-image', () => ({
  getFontEmbedCSS: async () => '',
  toPng: async (target: Element) => {
    captured.counts.push(rootCounts(target));
    return 'data:image/png;base64,';
  },
  toBlob: async (target: Element) => {
    captured.counts.push(rootCounts(target));
    return new Blob();
  },
}));
vi.mock('html2canvas-pro', () => ({
  default: async (target: Element) => {
    captured.counts.push(rootCounts(target));
    return document.createElement('canvas');
  },
}));

import { measureSlideElementGeometry, slideToPng } from '../../src/snapshot';

const PER_ROOT = 600;

function textBox(id: string, prefix: string, top: number): PPTTextElement {
  const formulas = Array.from(
    { length: PER_ROOT },
    (_, index) => `<span data-inline-math="${prefix}_{${index}}">${prefix}_{${index}}</span>`,
  ).join(' ');
  return {
    id,
    type: 'text',
    left: 0,
    top,
    width: 900,
    height: 200,
    rotate: 0,
    content: `<p>${formulas}</p>`,
    defaultFontName: 'Arial',
    defaultColor: '#111111',
  };
}

const slide: Slide = {
  id: 'slide-math',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  // Together over the per-root formula cap, each well under it.
  elements: [textBox('a', 'a', 0), textBox('b', 'b', 250)],
  theme: {
    fontName: 'Arial',
    fontColor: '#111111',
    backgroundColor: '#ffffff',
    themeColors: ['#111111'],
  },
  background: { type: 'solid', color: '#ffffff' },
};

beforeEach(() => {
  // Idle time never comes, so only the snapshot's own completion can typeset
  // what the live elements' budgets left over.
  vi.stubGlobal('requestIdleCallback', () => 0);
  vi.stubGlobal('cancelIdleCallback', () => undefined);
});

afterEach(() => {
  captured.counts = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('snapshots typeset inline math per prose root', () => {
  it('slideToPng captures every formula of every root', async () => {
    // jsdom's getComputedStyle is slow on thousands of KaTeX nodes; the font
    // checks it feeds are not under test here.
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      fontFamily: '',
      fontStyle: 'normal',
      fontWeight: '400',
    } as CSSStyleDeclaration);
    await slideToPng(slide, { format: 'dataUrl', timeoutMs: 50 });
    expect(captured.counts).toEqual([[PER_ROOT, PER_ROOT]]);
  });

  it('measureSlideElementGeometry measures every formula of every root typeset', async () => {
    let counts: number[] | null = null;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      counts ??= rootCounts(document.body);
      return new DOMRect();
    });
    await measureSlideElementGeometry(slide, ['a', 'b'], { timeoutMs: 50 });
    expect(counts).toEqual([PER_ROOT, PER_ROOT]);
  });
});
