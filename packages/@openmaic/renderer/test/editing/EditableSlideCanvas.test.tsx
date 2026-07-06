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

  it('auto-fits when scale is omitted: overlay positions use fitScale', () => {
    // scale omitted -> canvasScale falls back to the hook's fitScale (0.5 here).
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 0.5,
    });
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    const hit = findHit(container);
    // el.left=100 at fitScale 0.5 -> 50px; el.width=200 -> 100px.
    expect(hit.style.left).toBe('50px');
    expect(hit.style.width).toBe('100px');
  });

  it('is inert without callbacks: no interactive hit node is rendered', () => {
    const { container } = render(<EditableSlideCanvas slide={slide} scale={1} />);
    expect(container.querySelector('[data-element-id]')).toBeNull();
  });

  it('defers line elements: no hit node or selection border for a line', () => {
    const lineSlide = {
      ...slide,
      elements: [
        ...(slide as unknown as { elements: unknown[] }).elements,
        {
          id: 'line1',
          type: 'line',
          left: 10,
          top: 10,
          start: [0, 0],
          end: [50, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lineSlide}
        scale={1}
        selection={{ elementIds: ['a', 'line1'], primaryId: 'line1' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    // Box element still hit-testable; line element has no hit node.
    expect(container.querySelector('[data-element-id="a"]')).not.toBeNull();
    expect(container.querySelector('[data-element-id="line1"]')).toBeNull();
    // Only the box element gets a selection border (one, not two).
    expect(container.querySelectorAll('[data-selection-border]')).toHaveLength(1);
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

  it('a diagonal move past the threshold on both axes commits a drag (Euclidean)', () => {
    // dx=dy=1.9 -> neither axis exceeds 2 (old per-axis check would misclassify
    // as a click), but hypot ≈ 2.69 > 2 so it must commit a drag intent.
    const onSel = vi.fn();
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { clientX: 1.9, clientY: 1.9 });
    fireEvent.pointerUp(hit, { clientX: 1.9, clientY: 1.9 });
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh).toHaveBeenCalledWith([
      { type: 'element.update', id: 'a', props: { left: 101.9, top: 101.9 } },
    ]);
    expect(onSel).not.toHaveBeenCalled();
  });

  it('fills its container: outer wrapper is width/height 100% (style can override)', () => {
    const { container } = render(
      <EditableSlideCanvas slide={slide} scale={1} onSelectionChange={vi.fn()} />,
    );
    const outer = container.firstChild as HTMLElement;
    expect(outer.style.width).toBe('100%');
    expect(outer.style.height).toBe('100%');

    // A consumer `style` still wins (merged AFTER the fill defaults).
    const { container: c2 } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        onSelectionChange={vi.fn()}
        style={{ height: '400px' }}
      />,
    );
    expect((c2.firstChild as HTMLElement).style.height).toBe('400px');
    expect((c2.firstChild as HTMLElement).style.width).toBe('100%');
  });

  it('with only onSelectionChange, a >2px drag still selects and emits no update', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        snapping={false}
      />,
    );
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { clientX: 30, clientY: 20 });
    fireEvent.pointerUp(hit, { clientX: 30, clientY: 20 });
    // No mutation callback -> a drag-classified gesture falls back to selection.
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith(
      expect.objectContaining({ elementIds: ['a'], primaryId: 'a' }),
    );
  });

  it('pointercancel reverts the working copy and leaves the hook ready for a new gesture', () => {
    const onSel = vi.fn();
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { clientX: 30, clientY: 0 });
    expect(findHit(container).style.left).toBe('130px'); // live drag moved it
    fireEvent.pointerCancel(hit, { clientX: 30, clientY: 0 });
    // Cancelled: working copy reverts, no intent, no selection change.
    expect(findHit(container).style.left).toBe('100px');
    expect(onCh).not.toHaveBeenCalled();
    expect(onSel).not.toHaveBeenCalled();

    // The hook is ready again: a fresh gesture is NOT ignored.
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { clientX: 40, clientY: 0 });
    fireEvent.pointerUp(hit, { clientX: 40, clientY: 0 });
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh).toHaveBeenCalledWith([
      { type: 'element.update', id: 'a', props: { left: 140, top: 100 } },
    ]);
  });

  it('locked element: no interactive move hit target is rendered', () => {
    const lockedSlide = {
      ...slide,
      elements: [
        (slide as unknown as { elements: unknown[] }).elements[0],
        {
          id: 'locked1',
          type: 'text',
          left: 300,
          top: 300,
          width: 100,
          height: 50,
          rotate: 0,
          content: 'y',
          defaultFontName: 'a',
          defaultColor: '#000',
          lineHeight: 1,
          lock: true,
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lockedSlide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    // Unlocked element still hit-testable; locked element has no hit node.
    expect(container.querySelector('[data-element-id="a"]')).not.toBeNull();
    expect(container.querySelector('[data-element-id="locked1"]')).toBeNull();
  });

  it('a locked element overlapping an unlocked one blocks the pointer instead of falling through', () => {
    // Regression for cr-fix-4 (round-4 cross-review P2): a locked element
    // used to be skipped entirely from the hit layer, so a pointer-down over
    // its (visually on-top) area fell through to whatever unlocked element's
    // hit target happened to occupy the same region underneath — moving/
    // selecting the WRONG element. The locked element now gets an inert
    // blocker at the same stacking position (same map order) so it consumes
    // the pointer instead.
    const onSel = vi.fn();
    const onCh = vi.fn();
    const overlappingLockedSlide = {
      ...slide,
      elements: [
        (slide as unknown as { elements: unknown[] }).elements[0], // 'a': left 100 top 100 w200 h80
        {
          id: 'locked1',
          type: 'text',
          left: 100,
          top: 100,
          width: 200,
          height: 80,
          rotate: 0,
          content: 'y',
          defaultFontName: 'a',
          defaultColor: '#000',
          lineHeight: 1,
          lock: true,
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={overlappingLockedSlide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );

    // Both elements share identical screen geometry. `locked1` is later in
    // the elements array, so it is later in DOM/stacking order too — mirror
    // real overlapping-sibling hit-testing by dispatching to whichever hit
    // node currently ends up on top there. Pre-fix that's still `a`'s own hit
    // div (the locked element renders no hit node at all); post-fix it's the
    // locked blocker.
    const hitLayerNodes = container.querySelectorAll(
      '[data-element-id], [data-hit-kind="blocker"]',
    );
    const topmost = hitLayerNodes[hitLayerNodes.length - 1] as HTMLElement;

    fireEvent.pointerDown(topmost, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(topmost, { clientX: 30, clientY: 20 });
    fireEvent.pointerUp(topmost, { clientX: 30, clientY: 20 });

    // The locked blocker must consume the gesture: the unlocked element `a`
    // beneath it is neither moved (no `element.update`) nor selected.
    expect(onCh).not.toHaveBeenCalled();
    expect(onSel).not.toHaveBeenCalled();
  });

  it('ignores a foreign pointerId; only the active pointer drives the gesture', () => {
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
        snapping={false}
      />,
    );
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    // A second pointer's move must be ignored (no cross-contamination).
    fireEvent.pointerMove(hit, { pointerId: 2, clientX: 50, clientY: 50 });
    expect(findHit(container).style.left).toBe('100px'); // unmoved
    // The active pointer still drives the working copy.
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 30, clientY: 0 });
    expect(findHit(container).style.left).toBe('130px');
  });
});
