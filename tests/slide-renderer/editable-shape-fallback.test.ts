// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { PPTShapeElement } from '@openmaic/dsl';
import { ShapeElement } from '@/components/slide-renderer/components/element/ShapeElement';

vi.mock('@/lib/hooks/use-canvas-operations', () => ({
  useCanvasOperations: () => ({ updateElement: vi.fn(), removeElementProps: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-history-snapshot', () => ({
  useHistorySnapshot: () => ({ addHistorySnapshot: vi.fn() }),
}));
vi.mock('@/components/slide-renderer/components/element/ProsemirrorEditor', () => ({
  ProsemirrorEditor: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('legacy Pro editable shape rendering', () => {
  it('recovers a historical bad shape with readable text and can switch to valid geometry', () => {
    const shape: PPTShapeElement = {
      id: 'bad-shape',
      type: 'shape',
      left: 30,
      top: 40,
      width: 200,
      height: 100,
      rotate: 25,
      viewBox: [100, 100],
      path: 'M 0 0 Z 1 1',
      fixedRatio: false,
      fill: '#14243c',
      text: {
        content: '<p>保留的文字</p>',
        defaultColor: '#fff',
        defaultFontName: 'Arial',
        align: 'bottom',
      },
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(ShapeElement, { elementInfo: shape })));
      expect(host.textContent).toContain('保留的文字');
      expect(host.querySelector('svg')).toBeNull();
      const paint = host.querySelector<HTMLElement>('.base-element-text .rotate-wrapper')!;
      expect(paint.style.backgroundColor).toBe('rgb(20, 36, 60)');
      expect(paint.style.transform).toBe('rotate(25deg)');
      expect(paint.style.justifyContent).toBe('flex-end');
      act(() =>
        root.render(
          createElement(ShapeElement, {
            elementInfo: { ...shape, path: 'M 0 0 L 100 0 L 100 100 Z' },
          }),
        ),
      );
      expect(host.querySelector('svg path')).not.toBeNull();
      expect(host.querySelector('[data-shape-geometry-error]')).toBeNull();
      act(() =>
        root.render(createElement(ShapeElement, { elementInfo: { ...shape, text: undefined } })),
      );
      expect(host.innerHTML).toBe('');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
