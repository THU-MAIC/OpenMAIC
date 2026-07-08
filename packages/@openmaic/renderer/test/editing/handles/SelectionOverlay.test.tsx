// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { PPTElement } from '@openmaic/dsl';
import { SelectionOverlay } from '../../../src/editing/handles/SelectionOverlay';

const el = (o: Partial<PPTElement>) =>
  ({
    id: 'a',
    type: 'text',
    left: 100,
    top: 50,
    width: 200,
    height: 80,
    rotate: 0,
    ...o,
  }) as unknown as PPTElement;

describe('SelectionOverlay', () => {
  it('renders nothing when selection is empty', () => {
    const { container } = render(
      <SelectionOverlay elements={[el({})]} selection={{ elementIds: [] }} scale={1} />,
    );
    expect(container.querySelector('[data-selection-border]')).toBeNull();
  });
  it('renders a border for the selected element scaled by canvasScale', () => {
    const { container } = render(
      <SelectionOverlay
        elements={[el({})]}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        scale={0.5}
      />,
    );
    const border = container.querySelector('[data-selection-border]') as HTMLElement;
    expect(border).not.toBeNull();
    expect(border.style.left).toBe('50px'); // 100 * 0.5
    expect(border.style.width).toBe('100px'); // 200 * 0.5
  });
  it('skips line elements: a selected line gets no bbox border (handles are its chrome)', () => {
    // A selected line's chrome is now its draggable endpoint/control handles
    // (LineHandles), not an approximate bbox border. SelectionOverlay only
    // borders box elements, so a mixed selection renders exactly ONE border
    // (the box), not two.
    const line = {
      id: 'ln',
      type: 'line',
      left: 10,
      top: 10,
      start: [0, 0],
      end: [50, 50],
    } as unknown as PPTElement;
    const { container } = render(
      <SelectionOverlay
        elements={[el({}), line]}
        selection={{ elementIds: ['a', 'ln'], primaryId: 'ln' }}
        scale={1}
      />,
    );
    const borders = container.querySelectorAll('[data-selection-border]');
    expect(borders).toHaveLength(1);
    // The single border is the box 'a', at its box-model geometry.
    const border = borders[0] as HTMLElement;
    expect(border.style.left).toBe('100px');
    expect(border.style.width).toBe('200px');
  });
  it('renders nothing when only a line is selected', () => {
    const line = {
      id: 'ln',
      type: 'line',
      left: 0,
      top: 0,
      start: [0, 0],
      end: [100, 0],
      curve: [50, 80],
    } as unknown as PPTElement;
    const { container } = render(
      <SelectionOverlay
        elements={[line]}
        selection={{ elementIds: ['ln'], primaryId: 'ln' }}
        scale={0.5}
      />,
    );
    // No box element in the selection -> no border at all.
    expect(container.querySelector('[data-selection-border]')).toBeNull();
  });
});
