import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import type { PPTShapeElement } from '@openmaic/dsl';
import { BaseShapeElement as WhiteboardShape } from '@/components/slide-renderer/components/element/ShapeElement/BaseShapeElement';
import { BaseShapeElement as SDKShape } from '@openmaic/renderer/elements';

const base: PPTShapeElement = {
  id: 'custom',
  type: 'shape',
  left: 100,
  top: 100,
  width: 240,
  height: 180,
  rotate: -36.86989765,
  path: 'M 0 0 L 4 0 L 0 3 Z',
  viewBox: [4, 3],
  fill: '#5b9bd5',
  fixedRatio: false,
};
describe('current whiteboard and shared SDK shape rendering', () => {
  it.each([
    base,
    { ...base, path: 'M0 0 L4 0 L4 2 L2 3 L0 2 Z' },
    {
      ...base,
      path: 'M0 1 C1 0 2 0 3 1',
      viewBox: [3, 1] as [number, number],
      rotate: 12.5,
      fill: 'transparent',
      outline: { color: '#333333', width: 2, style: 'dashed' as const },
    },
  ])('renders path $path with identical scaling, rotation, fill and stroke', (element) => {
    const current = renderToStaticMarkup(createElement(WhiteboardShape, { elementInfo: element }));
    expect(current).toBe(renderToStaticMarkup(createElement(SDKShape, { elementInfo: element })));
    const { document } = parseHTML(current);
    expect(document.querySelector('.rotate-wrapper')?.getAttribute('style')).toContain(
      `rotate(${element.rotate}deg)`,
    );
    const group = document.querySelector('svg g')!;
    expect(group.getAttribute('transform')).toContain(
      `scale(${element.width / element.viewBox[0]}, ${element.height / element.viewBox[1]})`,
    );
    const path = document.querySelector('svg path')!;
    expect(path.getAttribute('d')).toBe(element.path);
    expect(path.getAttribute('fill')).toBe(element.fill);
    expect(path.getAttribute('stroke-width')).toBe(String(element.outline?.width ?? 0));
    if (element.outline) {
      expect(path.getAttribute('stroke')).toBe(element.outline.color);
      expect(path.getAttribute('stroke-dasharray')).toBe('9 4');
    }
    expect(current).not.toContain('data-shape-geometry-error');
  });
});
