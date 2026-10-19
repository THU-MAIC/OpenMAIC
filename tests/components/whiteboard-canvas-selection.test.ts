// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react';
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
    fontColor: '#333333',
    fontName: 'Microsoft YaHei',
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

import { WhiteboardCanvas } from '@/components/whiteboard/whiteboard-canvas';
import { BaseCodeElement } from '@/components/slide-renderer/components/element/CodeElement/BaseCodeElement';
import { ScreenElement } from '@/components/slide-renderer/Editor/ScreenElement';

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

    const codeBody = codeDom?.querySelector('.select-text');
    expect(codeBody).not.toBeNull();
    // Line numbers in code must remain non-selectable
    const lineNum = codeDom?.querySelector('.select-none');
    expect(lineNum).not.toBeNull();

    // Shape and Image element wrappers are NOT selectable (inherit select-none from viewport)
    const shapeDom = container.querySelector(`[data-maic-element-id="${shapeElement.id}"]`);
    expect(shapeDom).not.toBeNull();
    const shapeSelectableWrapper = shapeDom?.closest('.select-text');
    expect(shapeSelectableWrapper).toBeNull();

    const imageDom = container.querySelector(`[data-maic-element-id="${imageElement.id}"]`);
    expect(imageDom).not.toBeNull();
    const imageSelectableWrapper = imageDom?.closest('.select-text');
    expect(imageSelectableWrapper).toBeNull();

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

  it('preserves non-whiteboard drag-to-scroll and userSelect none for slide callers', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const setPointerCaptureSpy = vi.fn();
    const releasePointerCaptureSpy = vi.fn();
    HTMLElement.prototype.setPointerCapture = setPointerCaptureSpy;
    HTMLElement.prototype.releasePointerCapture = releasePointerCaptureSpy;
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);

    await act(async () => {
      // Default / slide playback caller (without selectable prop)
      root.render(
        createElement(BaseCodeElement, {
          elementInfo: codeElement,
        }),
      );
    });

    const codeWrapper = container.querySelector('.base-element-code');
    expect(codeWrapper).not.toBeNull();

    // Code body must NOT have select-text or cursor-text
    const codeBody = codeWrapper?.querySelector('.overflow-auto') as HTMLElement;
    expect(codeBody).not.toBeNull();
    expect(codeBody.classList.contains('select-text')).toBe(false);
    expect(codeBody.classList.contains('cursor-text')).toBe(false);

    // Code body must have userSelect: none and touchAction: none
    expect(codeBody.style.userSelect).toBe('none');
    expect(codeBody.style.touchAction).toBe('none');
    expect(codeBody.style.cursor).toBe('grab');

    // Trigger drag-to-scroll interaction
    codeBody.scrollLeft = 0;
    codeBody.scrollTop = 0;

    const pointerDownEvent = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 42,
    });
    await act(async () => {
      codeBody.dispatchEvent(pointerDownEvent);
    });

    expect(setPointerCaptureSpy).toHaveBeenCalledWith(42);
    expect(codeBody.style.cursor).toBe('grabbing');

    // Pointer move updates scroll position
    const pointerMoveEvent = new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: 80,
      clientY: 70,
      pointerId: 42,
    });
    await act(async () => {
      codeBody.dispatchEvent(pointerMoveEvent);
    });

    // scrollLeft was 0 - (80 - 100) = 20
    expect(codeBody.scrollLeft).toBe(20);
    // scrollTop was 0 - (70 - 100) = 30
    expect(codeBody.scrollTop).toBe(30);

    // Pointer up ends drag
    const pointerUpEvent = new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      clientX: 80,
      clientY: 70,
      pointerId: 42,
    });
    await act(async () => {
      codeBody.dispatchEvent(pointerUpEvent);
    });

    expect(releasePointerCaptureSpy).toHaveBeenCalledWith(42);
    expect(codeBody.style.cursor).toBe('grab');

    await act(async () => root.unmount());
  });

  it('disables drag-to-scroll and enables text selection when selectable is passed', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const setPointerCaptureSpy = vi.fn();
    HTMLElement.prototype.setPointerCapture = setPointerCaptureSpy;

    await act(async () => {
      // Whiteboard caller (with selectable = true)
      root.render(
        createElement(BaseCodeElement, {
          elementInfo: codeElement,
          selectable: true,
        }),
      );
    });

    const codeWrapper = container.querySelector('.base-element-code');
    const codeBody = codeWrapper?.querySelector('.overflow-auto') as HTMLElement;
    expect(codeBody).not.toBeNull();

    // Has selectable classes
    expect(codeBody.classList.contains('select-text')).toBe(true);
    expect(codeBody.classList.contains('cursor-text')).toBe(true);

    // Does not have userSelect: none or touchAction: none
    expect(codeBody.style.userSelect).not.toBe('none');
    expect(codeBody.style.touchAction).not.toBe('none');
    expect(codeBody.style.cursor).not.toBe('grab');

    // Pointer down should NOT start drag or capture pointer
    const pointerDownEvent = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 42,
    });
    await act(async () => {
      codeBody.dispatchEvent(pointerDownEvent);
    });

    expect(setPointerCaptureSpy).not.toHaveBeenCalled();
    expect(codeBody.style.cursor).not.toBe('grabbing');

    await act(async () => root.unmount());
  });

  it('ScreenElement passes selectable prop to element components when requested', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    // 1. Without selectable
    await act(async () => {
      root.render(
        createElement(ScreenElement, {
          elementInfo: codeElement,
          elementIndex: 1,
        }),
      );
    });
    let codeBody = container.querySelector('.base-element-code .overflow-auto') as HTMLElement;
    expect(codeBody.classList.contains('select-text')).toBe(false);
    expect(codeBody.style.userSelect).toBe('none');

    // 2. With selectable
    await act(async () => {
      root.render(
        createElement(ScreenElement, {
          elementInfo: codeElement,
          elementIndex: 1,
          selectable: true,
        }),
      );
    });
    codeBody = container.querySelector('.base-element-code .overflow-auto') as HTMLElement;
    expect(codeBody.classList.contains('select-text')).toBe(true);
    expect(codeBody.style.userSelect).not.toBe('none');

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

    // Test D: Hit test on empty canvas space (x: 500, y: 400)
    const emptyCanvasHitTarget = realisticHitTest(500, 400);
    expect(emptyCanvasHitTarget).toBe(viewport);

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

    await act(async () => root.unmount());
  });
});
