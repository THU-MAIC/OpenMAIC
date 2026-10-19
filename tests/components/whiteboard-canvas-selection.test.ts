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
});
