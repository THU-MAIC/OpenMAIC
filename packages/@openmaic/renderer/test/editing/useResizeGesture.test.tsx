// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { Slide } from '@openmaic/dsl';
import { useResizeGesture, type UseResizeGestureArgs } from '../../src/editing/useResizeGesture';
import type { PPTBoxElement, ResizeHandle } from '../../src/editing/core/resize';

const baseElement = {
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
};

function makeSlide(overrides: Record<string, unknown> = {}): Slide {
  return {
    id: 's',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    elements: [{ ...baseElement, ...overrides }],
  } as unknown as Slide;
}

/**
 * Minimal harness: wires a single handle's `onResizeHandlePointerDown` to a
 * real DOM node so `fireEvent.pointer*` (real PointerEvents bubbling to
 * `window`, exactly like the production handle div) exercises
 * `useResizeGesture` exactly as `EditableSlideCanvas` does — but directly, so
 * a pointer-down can be armed on a locked element even without a rendered
 * handle (defense-in-depth: the hook must refuse on its own).
 */
function Harness(props: UseResizeGestureArgs & { targetEl: PPTBoxElement; handle: ResizeHandle }) {
  const { targetEl, handle, ...args } = props;
  const { onResizeHandlePointerDown } = useResizeGesture(args);
  return (
    <div data-testid="hit" onPointerDown={(e) => onResizeHandlePointerDown(targetEl, handle, e)} />
  );
}

function setup(handle: ResizeHandle, elementOverrides: Record<string, unknown> = {}) {
  const slide = makeSlide(elementOverrides);
  const el = slide.elements[0] as PPTBoxElement;
  const onElementsChange = vi.fn();
  const { container } = render(
    <Harness
      slide={slide}
      scale={1}
      onElementsChange={onElementsChange}
      targetEl={el}
      handle={handle}
    />,
  );
  const hit = container.querySelector('[data-testid="hit"]') as HTMLElement;
  return { hit, onElementsChange };
}

describe('useResizeGesture', () => {
  it('commits exactly one element.update with the resized box on pointer-up', () => {
    const { hit, onElementsChange } = setup('right-bottom');
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 10, clientY: 5 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 30, clientY: 20 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 30, clientY: 20 });

    // Two moves, ONE intent: per completed gesture, never per frame.
    expect(onElementsChange).toHaveBeenCalledTimes(1);
    expect(onElementsChange.mock.calls[0][0]).toEqual([
      {
        type: 'element.update',
        id: 'a',
        props: { left: 100, top: 100, width: 230, height: 100 },
      },
    ]);
  });

  it('a drag whose snap returns the box to its origin emits nothing (no no-op undo entry)', () => {
    // Sibling left edge sits exactly at the target's original right edge
    // (100 + 200 = 300). A +3px drag on the `right` handle moves past the 2px
    // threshold, but snapping (range 5) pulls the moving edge back to 300 —
    // the computed box equals the origin, so no intent may be emitted.
    const sibling = { ...baseElement, id: 'b', left: 300, top: 300 };
    const slide = {
      id: 's',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [baseElement, sibling],
    } as unknown as Slide;
    const el = slide.elements[0] as PPTBoxElement;
    const onElementsChange = vi.fn();
    const { container } = render(
      <Harness
        slide={slide}
        scale={1}
        snapping={true}
        onElementsChange={onElementsChange}
        targetEl={el}
        handle="right"
      />,
    );
    const hit = container.querySelector('[data-testid="hit"]') as HTMLElement;
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 3, clientY: 0 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 3, clientY: 0 });
    expect(onElementsChange).not.toHaveBeenCalled();
  });

  it('converts the screen delta to canvas units through scale', () => {
    const slide = makeSlide();
    const el = slide.elements[0] as PPTBoxElement;
    const onElementsChange = vi.fn();
    const { container } = render(
      <Harness
        slide={slide}
        scale={0.5}
        onElementsChange={onElementsChange}
        targetEl={el}
        handle="right"
      />,
    );
    const hit = container.querySelector('[data-testid="hit"]') as HTMLElement;
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 25, clientY: 0 });

    // 25 screen px at scale 0.5 → 50 canvas units → width 250.
    expect(onElementsChange.mock.calls[0][0]).toEqual([
      { type: 'element.update', id: 'a', props: { left: 100, top: 100, width: 250, height: 80 } },
    ]);
  });

  it('reads the aspect-lock modifier off the pointer event at commit time', () => {
    const { hit, onElementsChange } = setup('right-bottom');
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 50, clientY: 0, shiftKey: true });

    // ratio 2.5: moveY = 50 / 2.5 = 20 → height 100.
    expect(onElementsChange.mock.calls[0][0]).toEqual([
      { type: 'element.update', id: 'a', props: { left: 100, top: 100, width: 250, height: 100 } },
    ]);
  });

  it('a handle click below the drag threshold emits nothing', () => {
    const { hit, onElementsChange } = setup('right-bottom');
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 1, clientY: 1 });
    expect(onElementsChange).not.toHaveBeenCalled();
  });

  it('pointercancel reverts without emitting, and a fresh gesture can re-arm', () => {
    const { hit, onElementsChange } = setup('right-bottom');
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 30, clientY: 20 });
    fireEvent.pointerCancel(hit, { pointerId: 1 });
    expect(onElementsChange).not.toHaveBeenCalled();

    // The hook must be ready for the next gesture after a cancel.
    fireEvent.pointerDown(hit, { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(hit, { pointerId: 2, clientX: 10, clientY: 0 });
    expect(onElementsChange).toHaveBeenCalledTimes(1);
  });

  it('refuses to arm on a locked element (defense-in-depth)', () => {
    const { hit, onElementsChange } = setup('right-bottom', { lock: true });
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 30, clientY: 20 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 30, clientY: 20 });
    expect(onElementsChange).not.toHaveBeenCalled();
  });

  it('ignores window move/up from a different pointerId (single-pointer guard)', () => {
    const { hit, onElementsChange } = setup('right-bottom');
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    // A second pointer's up must not commit the first pointer's gesture.
    fireEvent.pointerUp(hit, { pointerId: 2, clientX: 100, clientY: 100 });
    expect(onElementsChange).not.toHaveBeenCalled();
    // The owning pointer still completes normally.
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 30, clientY: 20 });
    expect(onElementsChange).toHaveBeenCalledTimes(1);
  });
});
