// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';

import {
  areElementInteractionTargetPropsEqual,
  type ElementInteractionTargetProps,
} from '../../../src/editing/layers/ElementInteractionLayer';

const element = {
  id: 'a',
  type: 'text',
  left: 10,
  top: 20,
  width: 200,
  height: 80,
  rotate: 0,
} as PPTElement;

function makeProps(): ElementInteractionTargetProps {
  return {
    element,
    isSelected: true,
    interactive: true,
    sourceElements: [element],
    selection: { elementIds: ['a'], primaryId: 'a' },
    viewportLeft: 0,
    viewportTop: 0,
    canvasScale: 1,
    editingTouchAction: 'none',
    onElementPointerDown: vi.fn(),
    onSelectionChange: vi.fn(),
  };
}

describe('ElementInteractionLayer memoization', () => {
  it('reuses an unchanged per-element interaction target', () => {
    const props = makeProps();
    expect(areElementInteractionTargetPropsEqual(props, props)).toBe(true);
  });

  it('updates only the target whose element object changed', () => {
    const previous = makeProps();
    const next = { ...previous, element: { ...element, left: 30 } as PPTElement };
    expect(areElementInteractionTargetPropsEqual(previous, next)).toBe(false);
  });
});
