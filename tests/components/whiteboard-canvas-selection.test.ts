// @vitest-environment jsdom
import { act, createElement, createRef, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PPTCodeElement,
  PPTImageElement,
  PPTShapeElement,
  PPTTextElement,
  Whiteboard,
} from '@openmaic/dsl';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
  motion: {
    div: ({
      children,
      className,
      style,
      onPointerDown,
      onDoubleClick,
      id,
    }: React.HTMLAttributes<HTMLDivElement>) =>
      createElement('div', { className, style, onPointerDown, onDoubleClick, id }, children),
  },
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

vi.mock('@/lib/contexts/scene-context', () => ({
  useSceneSelector: () => ({
    slideId: 'slide-1',
    theme: {
      backgroundColor: '#ffffff',
      themeColors: ['#5b9bd5'],
      fontColor: '#333333',
      fontName: 'Microsoft YaHei',
    },
  }),
  useSceneData: () => ({
    sceneId: 'scene-1',
    sceneData: {},
    updateSceneData: () => {},
  }),
}));

vi.mock('shiki', () => ({
  createHighlighter: () => new Promise(() => {}),
}));

import {
  WhiteboardCanvas,
  type WhiteboardCanvasHandle,
} from '@/components/whiteboard/whiteboard-canvas';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = vi.fn();
  }
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  }
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('WhiteboardCanvas selection and interaction contract', () => {
  const textElement: PPTTextElement = {
    id: 'text-el-1',
    type: 'text',
    left: 20,
    top: 20,
    width: 200,
    height: 60,
    rotate: 0,
    content: '<p>Selectable text</p>',
    defaultColor: '#000000',
    defaultFontName: 'Arial',
  };

  const codeElement: PPTCodeElement = {
    id: 'code-el-1',
    type: 'code',
    left: 20,
    top: 100,
    width: 400,
    height: 150,
    rotate: 0,
    language: 'javascript',
    lines: [{ id: 'line-1', content: 'const x = 42;' }],
    showLineNumbers: true,
  };

  const shapeElement: PPTShapeElement = {
    id: 'shape-el-1',
    type: 'shape',
    left: 20,
    top: 280,
    width: 100,
    height: 100,
    rotate: 0,
    viewBox: [100, 100],
    path: 'M 0 0 L 100 0 L 100 100 Z',
    fill: '#ff0000',
    fixedRatio: false,
  };

  const imageElement: PPTImageElement = {
    id: 'image-el-1',
    type: 'image',
    left: 150,
    top: 280,
    width: 100,
    height: 100,
    rotate: 0,
    src: 'data:image/png;base64,AA==',
    fixedRatio: true,
  };

  const whiteboard: Whiteboard = {
    id: 'wb-test',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    elements: [textElement, codeElement, shapeElement, imageElement],
  };

  it('marks text and code elements as selectable with cursor-text while canvas container uses select-none', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(WhiteboardCanvas, { whiteboard }));
    });

    // Canvas container / viewport has select-none
    const viewport = container.querySelector('.select-none');
    expect(viewport).not.toBeNull();
    expect(viewport?.classList.contains('select-none')).toBe(true);

    // Text element wrapper is selectable and has cursor-text
    const textDom = container.querySelector(`[data-maic-element-id="${textElement.id}"]`);
    expect(textDom).not.toBeNull();
    const textSelectableWrapper = textDom?.closest('.select-text');
    expect(textSelectableWrapper).not.toBeNull();
    expect(textSelectableWrapper?.classList.contains('cursor-text')).toBe(true);

    // Code element wrapper and inner body are selectable and have cursor-text
    const codeDom = container.querySelector(`[data-maic-element-id="${codeElement.id}"]`);
    expect(codeDom).not.toBeNull();
    const codeSelectableWrapper = codeDom?.closest('.select-text');
    expect(codeSelectableWrapper).not.toBeNull();
    expect(codeSelectableWrapper?.classList.contains('cursor-text')).toBe(true);

    // The code body itself allows selection instead of drag-scrolling
    const codeBody = codeDom?.querySelector<HTMLElement>('.slide-renderer-code-body');
    expect(codeBody).not.toBeNull();
    expect(codeBody?.style.userSelect).toBe('text');
    // Line numbers in code must remain non-selectable
    const lineNum = [...(codeDom?.querySelectorAll<HTMLElement>('span') ?? [])].find(
      (span) => span.textContent === '1',
    );
    expect(lineNum?.style.userSelect).toBe('none');

    // Shape and Image element wrappers are NOT selectable (inherit select-none from viewport)
    const shapeDom = container.querySelector(`[data-maic-element-id="${shapeElement.id}"]`);
    expect(shapeDom).not.toBeNull();
    const shapeSelectableWrapper = shapeDom?.closest('.select-text');
    expect(shapeSelectableWrapper).toBeNull();

    const imageDom = container.querySelector(`[data-maic-element-id="${imageElement.id}"]`);
    expect(imageDom).not.toBeNull();
    const imageSelectableWrapper = imageDom?.closest('.select-text');
    expect(imageSelectableWrapper).toBeNull();

    // Elements keep the screen-element DOM ids, and the renderer lets only
    // selectable elements take the pointer themselves.
    for (const element of whiteboard.elements) {
      expect(container.querySelector(`#screen-element-${element.id}`)).not.toBeNull();
    }
    const hitTarget = (dom: Element | null | undefined) =>
      dom?.querySelector<HTMLElement>('.slide-element-hit-target')?.style.pointerEvents;
    expect(hitTarget(textDom)).toBe('auto');
    expect(hitTarget(codeDom)).toBe('auto');
    expect(hitTarget(shapeDom)).toBe('');
    expect(hitTarget(imageDom)).toBe('');

    await act(async () => root.unmount());
  });

  it('stops pointerdown and doubleClick propagation on text/code while allowing canvas gestures on other elements', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(WhiteboardCanvas, { whiteboard }));
    });

    const textDom = container.querySelector(`[data-maic-element-id="${textElement.id}"]`);
    const codeDom = container.querySelector(`[data-maic-element-id="${codeElement.id}"]`);
    const shapeDom = container.querySelector(`[data-maic-element-id="${shapeElement.id}"]`);
    const viewport = container.querySelector('.select-none') as HTMLElement;

    expect(textDom).not.toBeNull();
    expect(codeDom).not.toBeNull();
    expect(shapeDom).not.toBeNull();
    expect(viewport).not.toBeNull();

    const textTarget = textDom?.querySelector('.ProseMirror-static') || textDom!;
    const codeTarget = codeDom?.querySelector('.select-text') || codeDom!;

    // Clicking text element does not trigger canvas pan (default is NOT prevented by canvas pan handler)
    const textEvent = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    await act(async () => {
      textTarget.dispatchEvent(textEvent);
    });
    expect(textEvent.defaultPrevented).toBe(false);

    // Clicking code element does not trigger canvas pan
    const codeEvent = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    await act(async () => {
      codeTarget.dispatchEvent(codeEvent);
    });
    expect(codeEvent.defaultPrevented).toBe(false);

    // Clicking shape element triggers canvas pan handler which calls e.preventDefault()
    const shapeEvent = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    await act(async () => {
      shapeDom!.dispatchEvent(shapeEvent);
    });
    expect(shapeEvent.defaultPrevented).toBe(true);

    // Double clicking text element does not trigger canvas reset (default is NOT prevented)
    const textDblClick = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
    await act(async () => {
      textTarget.dispatchEvent(textDblClick);
    });
    expect(textDblClick.defaultPrevented).toBe(false);

    // Double clicking code element does not trigger canvas reset
    const codeDblClick = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
    await act(async () => {
      codeTarget.dispatchEvent(codeDblClick);
    });
    expect(codeDblClick.defaultPrevented).toBe(false);

    // Double clicking shape element triggers canvas reset handler which calls e.preventDefault()
    const shapeDblClick = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
    await act(async () => {
      shapeDom!.dispatchEvent(shapeDblClick);
    });
    expect(shapeDblClick.defaultPrevented).toBe(true);

    await act(async () => root.unmount());
  });

  it('keeps full-canvas motion wrappers pointer-transparent so later siblings do not block text/code hit-testing or drag selection', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    // Multi-element whiteboard where selectable text (index 0) and code (index 1)
    // are followed by later shape and image elements (indices 2 and 3).
    await act(async () => {
      root.render(createElement(WhiteboardCanvas, { whiteboard }));
    });

    const viewport = container.querySelector('.select-none') as HTMLElement;
    expect(viewport).not.toBeNull();

    const textDom = container.querySelector(
      `[data-maic-element-id="${textElement.id}"]`,
    ) as HTMLElement;
    const codeDom = container.querySelector(
      `[data-maic-element-id="${codeElement.id}"]`,
    ) as HTMLElement;
    const shapeDom = container.querySelector(
      `[data-maic-element-id="${shapeElement.id}"]`,
    ) as HTMLElement;

    expect(textDom).not.toBeNull();
    expect(codeDom).not.toBeNull();
    expect(shapeDom).not.toBeNull();

    // 1. Verify every full-canvas motion.div wrapper is explicitly pointer-transparent
    const motionWrappers = container.querySelectorAll('.absolute.inset-0.pointer-events-none');
    expect(motionWrappers.length).toBeGreaterThanOrEqual(whiteboard.elements.length);
    motionWrappers.forEach((wrapper) => {
      expect((wrapper as HTMLElement).style.pointerEvents).toBe('none');
    });

    // 2. Verify element subtrees remain interactive (pointer-events: auto)
    const textSubtree = textDom.closest('.select-text') as HTMLElement;
    const codeSubtree = codeDom.closest('.select-text') as HTMLElement;
    expect(textSubtree.style.pointerEvents).toBe('auto');
    expect(codeSubtree.style.pointerEvents).toBe('auto');

    // 3. Realistic hit-testing simulation:
    // Models browser hit-testing rules:
    // - Elements or ancestors with pointer-events: none are skipped (transparent).
    // - Elements with pointer-events: auto are tested against their bounding boxes.
    // - Later DOM siblings / higher stacking contexts take precedence.
    const boundsMap = new Map<
      HTMLElement,
      { left: number; top: number; right: number; bottom: number }
    >();
    boundsMap.set(textDom, {
      left: textElement.left,
      top: textElement.top,
      right: textElement.left + textElement.width,
      bottom: textElement.top + textElement.height,
    });
    boundsMap.set(codeDom, {
      left: codeElement.left,
      top: codeElement.top,
      right: codeElement.left + codeElement.width,
      bottom: codeElement.top + codeElement.height,
    });
    boundsMap.set(shapeDom, {
      left: shapeElement.left,
      top: shapeElement.top,
      right: shapeElement.left + shapeElement.width,
      bottom: shapeElement.top + shapeElement.height,
    });

    const isPointerInteractive = (el: HTMLElement): boolean => {
      let curr: HTMLElement | null = el;
      let effectivePointerEvents = 'auto';
      while (curr && curr !== container) {
        if (curr.style.pointerEvents === 'none' || curr.classList.contains('pointer-events-none')) {
          effectivePointerEvents = 'none';
          break;
        }
        if (curr.style.pointerEvents === 'auto' || curr.classList.contains('pointer-events-auto')) {
          effectivePointerEvents = 'auto';
          break;
        }
        curr = curr.parentElement;
      }
      return effectivePointerEvents !== 'none';
    };

    const realisticHitTest = (x: number, y: number): HTMLElement => {
      // Check elements in reverse DOM order (later siblings stacked on top)
      const allElements = [shapeDom, codeDom, textDom];
      for (const el of allElements) {
        const bounds = boundsMap.get(el);
        if (
          bounds &&
          x >= bounds.left &&
          x <= bounds.right &&
          y >= bounds.top &&
          y <= bounds.bottom
        ) {
          if (isPointerInteractive(el)) {
            // Find target child
            const targetChild =
              el.querySelector('.select-text') || el.querySelector('.element-content') || el;
            return targetChild as HTMLElement;
          }
        }
      }
      return viewport;
    };

    // Test A: Hit test at text coordinates (x: 50, y: 50)
    // Even though shapeElement comes later in DOM order, its full-canvas wrapper is
    // pointer-transparent, so hit testing must resolve to textElement.
    const textHitTarget = realisticHitTest(50, 50);
    expect(textDom.contains(textHitTarget)).toBe(true);
    expect(shapeDom.contains(textHitTarget)).toBe(false);

    // Mouse drag over text: pointerdown -> pointermove -> selection
    const textPointerDown = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 50,
      clientY: 50,
    });
    await act(async () => {
      textHitTarget.dispatchEvent(textPointerDown);
    });
    // Canvas pan must NOT intercept (defaultPrevented is false)
    expect(textPointerDown.defaultPrevented).toBe(false);

    const textPointerMove = new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 50,
    });
    await act(async () => {
      textHitTarget.dispatchEvent(textPointerMove);
    });
    expect(textPointerMove.defaultPrevented).toBe(false);

    // Verify text selection & copy contract
    const textNode = textDom.querySelector('.ProseMirror-static p') || textDom;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString()).toContain('Selectable text');

    const textCopyEvent = new Event('copy', { bubbles: true, cancelable: true });
    await act(async () => {
      textHitTarget.dispatchEvent(textCopyEvent);
    });
    expect(textCopyEvent.defaultPrevented).toBe(false);

    // Test B: Hit test at code coordinates (x: 50, y: 150)
    const codeHitTarget = realisticHitTest(50, 150);
    expect(codeDom.contains(codeHitTarget)).toBe(true);
    expect(shapeDom.contains(codeHitTarget)).toBe(false);

    const codePointerDown = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 50,
      clientY: 150,
    });
    await act(async () => {
      codeHitTarget.dispatchEvent(codePointerDown);
    });
    expect(codePointerDown.defaultPrevented).toBe(false);

    const codeRow = codeDom.querySelector('.select-text') || codeDom;
    const codeRange = document.createRange();
    codeRange.selectNodeContents(codeRow);
    selection?.removeAllRanges();
    selection?.addRange(codeRange);
    expect(selection?.toString()).toContain('const x = 42;');

    const codeCopyEvent = new Event('copy', { bubbles: true, cancelable: true });
    await act(async () => {
      codeHitTarget.dispatchEvent(codeCopyEvent);
    });
    expect(codeCopyEvent.defaultPrevented).toBe(false);

    // Test C: Hit test at shape coordinates (x: 50, y: 300)
    // Later shape element must remain interactive and trigger canvas panning
    const shapeHitTarget = realisticHitTest(50, 300);
    expect(shapeDom.contains(shapeHitTarget)).toBe(true);

    const shapePointerDown = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 50,
      clientY: 300,
    });
    await act(async () => {
      shapeHitTarget.dispatchEvent(shapePointerDown);
    });
    // Canvas pan was triggered on viewport, preventing default
    expect(shapePointerDown.defaultPrevented).toBe(true);
    expect(selection?.toString()).toBe('');

    // Test D: Hit test on empty canvas space (x: 500, y: 400)
    const emptyCanvasHitTarget = realisticHitTest(500, 400);
    expect(emptyCanvasHitTarget).toBe(viewport);
    selection?.addRange(codeRange);
    expect(selection?.toString()).toContain('const x = 42;');

    const canvasPointerDown = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 500,
      clientY: 400,
    });
    await act(async () => {
      emptyCanvasHitTarget.dispatchEvent(canvasPointerDown);
    });
    expect(canvasPointerDown.defaultPrevented).toBe(true);
    expect(selection?.toString()).toBe('');

    await act(async () => root.unmount());
  });

  it.each(['buttons', 'pinch', 'resize'] as const)(
    'keeps the board within pan bounds after a %s change',
    async (method) => {
      const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
      const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const board = createRef<WhiteboardCanvasHandle>();
      let resize: ResizeObserverCallback | undefined;
      globalThis.ResizeObserver = class extends FakeResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          super();
          resize = callback;
        }
      } as unknown as typeof ResizeObserver;
      try {
        await act(async () =>
          root.render(createElement(WhiteboardCanvas, { ref: board, whiteboard })),
        );
        await act(async () => board.current!.setZoom(0.2));
        const viewport = container.querySelector<HTMLElement>('.select-none')!;
        const pointer = async (type: string, pointerId: number, x: number, y: number) => {
          await act(async () =>
            viewport.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                button: 0,
                pointerId,
                clientX: x,
                clientY: y,
              }),
            ),
          );
        };
        await pointer('pointerdown', 1, 0, 0);
        await pointer('pointermove', 1, 300, 240);
        await pointer('pointerup', 1, 300, 240);
        if (method === 'buttons') {
          await act(async () => board.current!.setZoom(1));
        } else if (method === 'resize') {
          await act(async () =>
            resize!(
              [{ contentRect: { width: 900, height: 200 } } as ResizeObserverEntry],
              {} as ResizeObserver,
            ),
          );
        } else {
          await pointer('pointerdown', 2, 0, 0);
          await pointer('pointerdown', 3, 100, 0);
          await pointer('pointermove', 3, 500, 0);
        }
        const sheet = viewport.querySelector<HTMLElement>(':scope > .absolute')!;
        const transform = sheet.style.transform.match(
          /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/,
        )!;
        expect(transform).not.toBeNull();
        const [x, y, scale] = transform.slice(1).map(Number);
        expect(scale).toBeCloseTo(method === 'resize' ? (200 / 562.5) * 0.2 : 0.6);
        expect(x).toBeLessThanOrEqual(method === 'resize' ? 900.0001 : 600.0001);
        expect(y).toBeLessThanOrEqual(method === 'resize' ? 200.0001 : 400.0001);
        expect(x + 1000 * scale).toBeGreaterThanOrEqual(0);
        expect(y + 562.5 * scale).toBeGreaterThanOrEqual(0);
      } finally {
        await act(async () => root.unmount());
        container.remove();
        width.mockRestore();
        height.mockRestore();
        globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
      }
    },
  );
});
