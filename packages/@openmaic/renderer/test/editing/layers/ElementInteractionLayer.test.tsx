// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { PPTElement } from '@openmaic/dsl';

import {
  areElementInteractionTargetPropsEqual,
  ElementInteractionLayer,
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
    movable: true,
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

describe('ElementInteractionLayer context target ids', () => {
  it('uses the element body for selection and the selected border for movement', () => {
    const { container } = render(
      <ElementInteractionLayer
        elements={[element]}
        sourceElements={[element]}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        interactive
        movable
        viewportLeft={0}
        viewportTop={0}
        canvasScale={1}
        editingTouchAction="none"
        onElementPointerDown={vi.fn()}
        onSelectionChange={vi.fn()}
      />,
    );

    const body = container.querySelector('[data-select-element-id="a"]') as HTMLElement;
    const border = container.querySelector('[data-element-id="a"]') as SVGElement;
    expect(body.style.cursor).toBe('text');
    expect(border.style.cursor).toBe('move');
  });

  it('does not expose a movement target before the element is selected', () => {
    const { container } = render(
      <ElementInteractionLayer
        elements={[element]}
        sourceElements={[element]}
        selection={{ elementIds: [] }}
        interactive
        movable
        viewportLeft={0}
        viewportTop={0}
        canvasScale={1}
        editingTouchAction="none"
        onElementPointerDown={vi.fn()}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-select-element-id="a"]')).not.toBeNull();
    expect(container.querySelector('[data-element-id="a"]')).toBeNull();
  });

  it('keeps only the active text border interactive while editing', () => {
    const other = { ...element, id: 'b' } as PPTElement;
    const { container } = render(
      <ElementInteractionLayer
        elements={[element, other]}
        sourceElements={[element, other]}
        selection={{ elementIds: ['a'], primaryId: 'a', editingId: 'a' }}
        interactive
        movable
        viewportLeft={0}
        viewportTop={0}
        canvasScale={1}
        editingTouchAction="none"
        onElementPointerDown={vi.fn()}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-select-element-id]')).toBeNull();
    expect(container.querySelectorAll('[data-element-id]')).toHaveLength(1);
    expect(container.querySelector('[data-element-id="a"]')).not.toBeNull();
  });

  it('marks locked box blockers with their element id', () => {
    const locked = { ...element, lock: true } as PPTElement;
    const { container } = render(
      <ElementInteractionLayer
        elements={[locked]}
        sourceElements={[locked]}
        selection={{ elementIds: [] }}
        interactive
        movable
        viewportLeft={0}
        viewportTop={0}
        canvasScale={1}
        editingTouchAction="none"
        onElementPointerDown={vi.fn()}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(
      container.querySelector('[data-hit-kind="blocker"]')?.getAttribute('data-context-element-id'),
    ).toBe('a');
  });

  it('marks line stroke targets with their element id', () => {
    const line = {
      id: 'line-1',
      type: 'line',
      left: 0,
      top: 0,
      start: [0, 0],
      end: [100, 50],
      width: 2,
      style: 'solid',
      color: '#111111',
      points: ['', ''],
    } as PPTElement;
    const { container } = render(
      <ElementInteractionLayer
        elements={[line]}
        sourceElements={[line]}
        selection={{ elementIds: [] }}
        interactive
        movable
        viewportLeft={0}
        viewportTop={0}
        canvasScale={1}
        editingTouchAction="none"
        onElementPointerDown={vi.fn()}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(
      container.querySelector('[data-hit-kind="line"]')?.getAttribute('data-context-element-id'),
    ).toBe('line-1');
  });
});
