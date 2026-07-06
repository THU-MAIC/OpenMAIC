// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { Slide } from '@openmaic/dsl';
import { EditableSlideCanvas } from '../../src/editing/EditableSlideCanvas';
import { useViewportSize } from '../../src/hooks/useViewportSize';

// Mock the shared viewport-fit hook so we can force a non-zero centering
// offset. In jsdom the real hook reports container size 0 -> offset 0, which
// is why the scale-1 gesture tests below cannot catch letterboxing bugs.
vi.mock('../../src/hooks/useViewportSize', () => ({
  useViewportSize: vi.fn(),
}));

const slide = {
  id: 's',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  elements: [
    {
      id: 'a',
      type: 'text',
      left: 100,
      top: 100,
      width: 200,
      height: 80,
      rotate: 0,
      content: 'x',
      defaultFontName: 'a',
      defaultColor: '#000',
      lineHeight: 1,
    },
  ],
} as unknown as Slide;

function findHit(container: HTMLElement) {
  return container.querySelector('[data-element-id="a"]') as HTMLElement;
}

describe('EditableSlideCanvas', () => {
  beforeEach(() => {
    // Default: no centering offset (matches jsdom's zero-size container), so
    // the existing gesture tests run exactly as before.
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
  });

  it('offsets the interaction overlay by SlideCanvas centering offset', () => {
    // Letterboxed container: slide is centered with a 160px left gutter, so
    // an element rendered by SlideCanvas sits at left = 160 + el.left*scale.
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 160, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );

    // Hit target must include the +160 centering offset (el.left=100 -> 260px),
    // otherwise pointer-down hit-testing misses the rendered element.
    const hit = findHit(container);
    expect(hit.style.left).toBe('260px');

    // SelectionOverlay is unchanged; its border sits inside a positioning
    // container that carries the centering offset (left: 160px).
    const border = container.querySelector('[data-selection-border]') as HTMLElement;
    expect(border.parentElement?.style.left).toBe('160px');
  });

  it('a click (no move) emits onSelectionChange only', () => {
    const onSel = vi.fn();
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
      />,
    );
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(hit, { clientX: 0, clientY: 0 });
    expect(onSel).toHaveBeenCalledWith(
      expect.objectContaining({ elementIds: ['a'], primaryId: 'a' }),
    );
    expect(onCh).not.toHaveBeenCalled();
  });

  it('a drag emits exactly one element.update intent on pointer-up', () => {
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { clientX: 30, clientY: 20 });
    fireEvent.pointerUp(hit, { clientX: 30, clientY: 20 });
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh).toHaveBeenCalledWith([
      { type: 'element.update', id: 'a', props: { left: 130, top: 120 } },
    ]);
  });
});
