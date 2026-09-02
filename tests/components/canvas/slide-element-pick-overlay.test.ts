// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import type { Scene } from '@/lib/types/stage';

const translations: Record<string, string> = {
  'chat.elementReference.instruction': 'Click a slide element · Esc to exit',
  'chat.elementReference.fallback': 'Other slide elements ({{count}})',
  'chat.elementReference.summary.noText': 'No text',
  'chat.elementReference.summary.emptyContent': 'No content',
  'chat.elementReference.summary.code': 'Code',
  'chat.elementReference.summary.line': 'Line',
  'chat.elementReference.summary.imageMetadata': 'Image (metadata only)',
  'chat.elementReference.summary.videoMetadata': 'Video (metadata only)',
  'chat.elementReference.summary.audioMetadata': 'Audio (metadata only)',
  'edit.element.text': 'Text',
  'edit.element.image': 'Image',
  'edit.element.shape': 'Shape',
  'edit.element.line': 'Line',
  'edit.element.chart': 'Chart',
  'edit.element.table': 'Table',
  'edit.element.latex': 'Formula',
  'edit.element.video': 'Video',
  'edit.element.audio': 'Audio',
  'edit.element.code': 'Code',
};

const translate = (key: string, options?: Record<string, unknown>) =>
  (translations[key] ?? key).replace('{{count}}', String(options?.count ?? ''));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: translate,
  }),
}));

import {
  getSlideElementPresentation,
  SlideElementPickOverlay,
} from '@/components/canvas/slide-element-pick-overlay';

const scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  title: 'Slide',
  order: 0,
  type: 'slide',
  content: {
    type: 'slide',
    canvas: {
      elements: [
        {
          id: 'text-1',
          type: 'text',
          content: '<p>First</p>',
          defaultFontName: 'Arial',
          defaultColor: '#000',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
        },
        {
          id: 'shape-1',
          type: 'shape',
          viewBox: [100, 100],
          path: 'M0 0',
          fixedRatio: false,
          fill: '#fff',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
        },
        {
          id: 'audio-1',
          type: 'audio',
          fixedRatio: true,
          color: '#000',
          loop: false,
          autoplay: false,
          src: 'opaque-audio',
          left: 0,
          top: 0,
          width: 40,
          height: 40,
          rotate: 0,
        },
      ],
    },
  },
} as Extract<Scene, { type: 'slide' }>;

const shapeElement = scene.content.canvas.elements[1] as Extract<PPTElement, { type: 'shape' }>;

describe('slide element reference presentation', () => {
  it('uses Shape text, then name, then the localized no-text fallback', () => {
    const withText = getSlideElementPresentation(
      {
        ...shapeElement,
        name: 'Card background',
        text: {
          content: '<p>Immersion</p>',
          defaultFontName: 'Arial',
          defaultColor: '#000',
          align: 'middle',
        },
      },
      translate,
    );
    const withName = getSlideElementPresentation(
      { ...shapeElement, name: '  Card background  ' },
      translate,
    );
    const withoutTextOrName = getSlideElementPresentation(shapeElement, translate);

    expect(withText).toEqual({ typeLabel: 'Shape', displaySummary: 'Immersion' });
    expect(withName).toEqual({ typeLabel: 'Shape', displaySummary: 'Card background' });
    expect(withoutTextOrName).toEqual({ typeLabel: 'Shape', displaySummary: 'No text' });
  });

  it('never falls back to a bare canonical type for empty content', () => {
    const textElement = scene.content.canvas.elements[0] as Extract<PPTElement, { type: 'text' }>;

    expect(getSlideElementPresentation({ ...textElement, content: '<p> </p>' }, translate)).toEqual(
      { typeLabel: 'Text', displaySummary: 'No content' },
    );
  });

  it('uses the empty-content fallback for a renderer-tolerated Chart without data', () => {
    const legacyChart = {
      id: 'legacy-chart',
      type: 'chart',
      chartType: 'line',
      themeColors: [],
      left: 0,
      top: 0,
      width: 100,
      height: 40,
      rotate: 0,
    } as unknown as PPTElement;

    expect(getSlideElementPresentation(legacyChart, translate)).toEqual({
      typeLabel: 'Chart',
      displaySummary: 'No content',
    });
  });
});

type Rect = { left: number; top: number; width: number; height: number };

function domRect({ left, top, width, height }: Rect): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function newRendererHost(elementId: string, paintKey = elementId): ReactNode {
  return createElement(
    'div',
    {
      id: `screen-element-${elementId}`,
      'data-rect-key': `host-${elementId}`,
      style: { position: 'absolute', inset: 0, pointerEvents: 'none' },
    },
    createElement(
      'div',
      { className: 'slide-element-hit-target' },
      createElement('div', {
        className: `base-element-${elementId.split('-')[0]}`,
        'data-rect-key': paintKey,
      }),
    ),
  );
}

function legacyRendererHost(elementId: string, paintKey = elementId): ReactNode {
  return createElement(
    'div',
    { id: `screen-element-${elementId}`, 'data-rect-key': `host-${elementId}` },
    createElement('div', {
      className: `base-element-${elementId.split('-')[0]} absolute`,
      'data-rect-key': paintKey,
    }),
  );
}

describe('SlideElementPickOverlay renderer DOM differential', () => {
  let container: HTMLDivElement;
  let root: Root;
  let rects: Map<string, Rect>;
  let nextFrame: FrameRequestCallback | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    rects = new Map([
      ['overlay', { left: 0, top: 0, width: 800, height: 450 }],
      ['host-text-1', { left: 0, top: 0, width: 800, height: 450 }],
      ['host-shape-1', { left: 0, top: 0, width: 0, height: 0 }],
      ['text-1', { left: 40, top: 30, width: 100, height: 40 }],
      ['shape-1', { left: 60, top: 40, width: 100, height: 40 }],
    ]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const key =
        this.dataset.testid === 'slide-element-pick-overlay' ? 'overlay' : this.dataset.rectKey;
      return domRect((key && rects.get(key)) || { left: 0, top: 0, width: 0, height: 0 });
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        nextFrame = callback;
        return 1;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('geometry hit testing must not call elementsFromPoint');
      }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render(ui: ReactNode) {
    act(() => root.render(ui));
    flushAnimationFrame();
  }

  function flushAnimationFrame() {
    const callback = nextFrame;
    nextFrame = undefined;
    act(() => callback?.(0));
  }

  function click(element: Element, clientX = 70, clientY = 50) {
    act(() => {
      element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY }),
      );
    });
  }

  function buttonContaining(text: string): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes(text),
    );
    if (!button) throw new Error(`button not found: ${text}`);
    return button;
  }

  it('uses the New renderer hit-target paint subtree instead of its full-slide host', () => {
    const onPick = vi.fn();
    render(
      createElement(
        'div',
        null,
        newRendererHost('text-1'),
        createElement(SlideElementPickOverlay, { scene, onPick, onCancel: vi.fn() }),
      ),
    );

    const outline = container.querySelector('.border-violet-400\\/70') as HTMLElement;
    expect(outline.style.cssText).toContain('left: 40px');
    expect(outline.style.cssText).toContain('width: 100px');

    click(container.querySelector('[data-testid="slide-element-pick-overlay"]')!, 50, 40);

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'text-1' }));
    expect(document.elementsFromPoint).not.toHaveBeenCalled();
  });

  it('uses the positioned direct child of a zero-geometry Legacy renderer host', () => {
    const onPick = vi.fn();
    render(
      createElement(
        'div',
        null,
        legacyRendererHost('shape-1'),
        createElement(SlideElementPickOverlay, { scene, onPick, onCancel: vi.fn() }),
      ),
    );

    click(container.querySelector('[data-testid="slide-element-pick-overlay"]')!, 70, 50);

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'shape-1' }));
  });

  it('orders localized overlapping candidates by Scene stacking and keeps no-text Shape selectable', () => {
    const onPick = vi.fn();
    render(
      createElement(
        'div',
        null,
        newRendererHost('text-1'),
        legacyRendererHost('shape-1'),
        createElement(SlideElementPickOverlay, {
          scene,
          onPick,
          onCancel: vi.fn(),
        }),
      ),
    );

    click(container.querySelector('[data-testid="slide-element-pick-overlay"]')!, 70, 50);

    const items = container.querySelectorAll('[role="menuitem"]');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe('Shape·No text');
    expect(items[1].textContent).toBe('Text·First');

    click(items[0]);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'shape-1' }));
  });

  it('falls back only for canonical elements without a measurable paint node', () => {
    const onPick = vi.fn();
    render(
      createElement(
        'div',
        null,
        newRendererHost('text-1'),
        legacyRendererHost('shape-1'),
        createElement(SlideElementPickOverlay, { scene, onPick, onCancel: vi.fn() }),
      ),
    );

    const fallback = buttonContaining('Other slide elements (1)');
    click(fallback);
    click(buttonContaining('Audio (metadata only)'));

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'audio-1' }));
  });

  it('re-measures transformed paint geometry for outlines and every click', () => {
    const onPick = vi.fn();
    render(
      createElement(
        'div',
        null,
        newRendererHost('text-1'),
        createElement(SlideElementPickOverlay, { scene, onPick, onCancel: vi.fn() }),
      ),
    );
    rects.set('text-1', { left: 300, top: 200, width: 150, height: 60 });
    flushAnimationFrame();

    const outline = container.querySelector('.border-violet-400\\/70') as HTMLElement;
    expect(outline.style.cssText).toContain('left: 300px');
    expect(outline.style.cssText).toContain('width: 150px');

    const overlay = container.querySelector('[data-testid="slide-element-pick-overlay"]')!;
    click(overlay, 50, 40);
    expect(onPick).not.toHaveBeenCalled();
    click(overlay, 320, 220);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'text-1' }));
  });

  it('exits on Escape without selecting', () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    render(createElement(SlideElementPickOverlay, { scene, onPick, onCancel }));

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onPick).not.toHaveBeenCalled();
  });
});
