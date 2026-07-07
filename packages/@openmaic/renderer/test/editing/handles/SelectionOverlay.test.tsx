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
  it('renders a border for a selected line element at its bounding box (no rotation)', () => {
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
    // Both the box element and the line now get a selection border.
    const borders = container.querySelectorAll('[data-selection-border]');
    expect(borders).toHaveLength(2);
    // The line border sits at its getElementRange bbox (no box-model width/
    // height): minX=10, minY=10, width = (left+max(start.x,end.x)) - minX = 50,
    // height = 50; no rotation for a line.
    const lineBorder = Array.from(borders).find(
      (b) => (b as HTMLElement).style.left === '10px',
    ) as HTMLElement;
    expect(lineBorder).toBeTruthy();
    expect(lineBorder.style.top).toBe('10px');
    expect(lineBorder.style.width).toBe('50px');
    expect(lineBorder.style.height).toBe('50px');
    expect(lineBorder.style.transform).toBe('');
  });
  it('encloses a curve control point that leaves the start/end chord', () => {
    // start=[0,0], end=[100,0] is a zero-height chord; the curve control point
    // at y=80 must be enclosed so the border spans the actual drawn path.
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
    const border = container.querySelector('[data-selection-border]') as HTMLElement;
    expect(border).not.toBeNull();
    // width = (100-0)*0.5 = 50; height = (80-0)*0.5 = 40 (encloses the control point).
    expect(border.style.left).toBe('0px');
    expect(border.style.top).toBe('0px');
    expect(border.style.width).toBe('50px');
    expect(border.style.height).toBe('40px');
    expect(border.style.transform).toBe('');
  });
});
