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
});
