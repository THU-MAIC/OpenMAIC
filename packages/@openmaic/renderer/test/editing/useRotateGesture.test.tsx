// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { useRef } from 'react';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { useRotateGesture, type UseRotateGestureArgs } from '../../src/editing/useRotateGesture';
import type { PPTBoxElement } from '../../src/editing/core/resize';

// Box 200x80 at (100, 100): center (200, 140). In jsdom the overlay's
// getBoundingClientRect() is all-zero, so with viewportStyles offset 0 and
// scale 1 the client coordinates fired below ARE canvas coordinates.
const element = {
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
} as unknown as PPTBoxElement;

const viewportStyles = { left: 0, top: 0, width: 1000, height: 562.5 };

/**
 * Minimal harness: mounts a real overlay node (the rect source) and wires the
 * rotate handle's pointer-down to a hit node, exercising `useRotateGesture`
 * exactly as `EditableSlideCanvas` does.
 */
function Harness(props: Omit<UseRotateGestureArgs, 'overlayRef'> & { targetEl: PPTBoxElement }) {
  const { targetEl, ...args } = props;
  const overlayRef = useRef<HTMLDivElement>(null);
  const { onRotateHandlePointerDown } = useRotateGesture({ ...args, overlayRef });
  return (
    <div ref={overlayRef}>
      <div data-testid="hit" onPointerDown={(e) => onRotateHandlePointerDown(targetEl, e)} />
    </div>
  );
}

function setup(targetEl: PPTBoxElement = element) {
  const onElementsChange = vi.fn();
  const { container } = render(
    <Harness
      viewportStyles={viewportStyles}
      scale={1}
      onElementsChange={onElementsChange}
      targetEl={targetEl}
    />,
  );
  const hit = container.querySelector('[data-testid="hit"]') as HTMLElement;
  return { hit, onElementsChange };
}

describe('useRotateGesture', () => {
  it('commits exactly one element.update with the signed angle on pointer-up', () => {
    const { hit, onElementsChange } = setup();
    // Start above the center, drag to the right of it: +90°.
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 200, clientY: 40 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 260, clientY: 70 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 300, clientY: 140 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 300, clientY: 140 });

    expect(onElementsChange).toHaveBeenCalledTimes(1);
    expect(onElementsChange.mock.calls[0][0]).toEqual([
      { type: 'element.update', id: 'a', props: { rotate: 90 } },
    ]);
  });

  it('keeps the angle signed for counter-clockwise drags (-90, not 270)', () => {
    const { hit, onElementsChange } = setup();
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 200, clientY: 40 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 100, clientY: 140 });

    expect(onElementsChange.mock.calls[0][0]).toEqual([
      { type: 'element.update', id: 'a', props: { rotate: -90 } },
    ]);
  });

  it('snaps to 45-degree multiples within the snap range', () => {
    const { hit, onElementsChange } = setup();
    const rad = (43 * Math.PI) / 180;
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 200, clientY: 40 });
    fireEvent.pointerUp(hit, {
      pointerId: 1,
      clientX: 200 + 100 * Math.sin(rad),
      clientY: 140 - 100 * Math.cos(rad),
    });

    expect(onElementsChange.mock.calls[0][0]).toEqual([
      { type: 'element.update', id: 'a', props: { rotate: 45 } },
    ]);
  });

  it('a handle click below the drag threshold emits nothing', () => {
    const { hit, onElementsChange } = setup();
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 200, clientY: 40 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 201, clientY: 40 });
    expect(onElementsChange).not.toHaveBeenCalled();
  });

  it('skips the emit when the drag lands back on the original angle', () => {
    // Element already at 90; dragging (past the threshold) to a point that
    // computes 90 again must not emit a no-op update.
    const rotated = { ...element, rotate: 90 } as PPTBoxElement;
    const { hit, onElementsChange } = setup(rotated);
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 200, clientY: 40 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 300, clientY: 140 });
    expect(onElementsChange).not.toHaveBeenCalled();
  });

  it('pointercancel reverts without emitting', () => {
    const { hit, onElementsChange } = setup();
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 200, clientY: 40 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 300, clientY: 140 });
    fireEvent.pointerCancel(hit, { pointerId: 1 });
    expect(onElementsChange).not.toHaveBeenCalled();
  });

  it('refuses to arm on a locked element (defense-in-depth)', () => {
    const locked = { ...element, lock: true } as PPTBoxElement;
    const { hit, onElementsChange } = setup(locked);
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 200, clientY: 40 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 300, clientY: 140 });
    expect(onElementsChange).not.toHaveBeenCalled();
  });
});
