// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { Slide, PPTElement } from '@openmaic/dsl';
import { useEditGesture, type UseEditGestureArgs } from '../../src/editing/useEditGesture';

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
 * Minimal harness: wires a single element's `onElementPointerDown` to a real
 * DOM node so `fireEvent.pointer*` (which dispatches real PointerEvents that
 * bubble to `window`, exactly like the production hit-target div) exercises
 * `useEditGesture` exactly as `EditableSlideCanvas` does — but directly, so a
 * pointer-down can be armed on a locked element even without a rendered hit
 * target (defense-in-depth: the hook must refuse on its own).
 */
function Harness(props: UseEditGestureArgs & { targetEl: PPTElement }) {
  const { targetEl, ...args } = props;
  const { onElementPointerDown } = useEditGesture(args);
  return <div data-testid="hit" onPointerDown={(e) => onElementPointerDown(targetEl, e)} />;
}

describe('useEditGesture — locked element (defense-in-depth)', () => {
  it('onElementPointerDown ignores a pointer-down on a locked element: no gesture arms', () => {
    const lockedSlide = makeSlide({ lock: true });
    const el = lockedSlide.elements[0];
    const onElementsChange = vi.fn();
    const onSelectionChange = vi.fn();

    const { container } = render(
      <Harness
        slide={lockedSlide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSelectionChange}
        onElementsChange={onElementsChange}
        targetEl={el}
      />,
    );

    const hit = container.querySelector('[data-testid="hit"]') as HTMLElement;
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 40, clientY: 40 });

    // No gesture ever armed, so pointer-up (even past the drag threshold)
    // must emit neither a mutation nor a selection change.
    expect(onElementsChange).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('control: an unlocked element still arms normally (same inputs, no lock)', () => {
    const unlockedSlide = makeSlide();
    const el = unlockedSlide.elements[0];
    const onElementsChange = vi.fn();

    const { container } = render(
      <Harness
        slide={unlockedSlide}
        scale={1}
        selection={{ elementIds: [] }}
        onElementsChange={onElementsChange}
        targetEl={el}
      />,
    );

    const hit = container.querySelector('[data-testid="hit"]') as HTMLElement;
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 40, clientY: 40 });

    expect(onElementsChange).toHaveBeenCalledTimes(1);
  });
});
