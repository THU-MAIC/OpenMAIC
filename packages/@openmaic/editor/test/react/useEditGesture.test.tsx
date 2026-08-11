// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { Slide, PPTElement } from '@openmaic/dsl';

vi.mock('../../src/react/core/snapping', async () => {
  const actual = await vi.importActual<typeof import('../../src/react/core/snapping')>(
    '../../src/react/core/snapping',
  );
  return { ...actual, buildAlignLines: vi.fn(actual.buildAlignLines) };
});

import { buildAlignLines } from '../../src/react/core/snapping';
import { useEditGesture, type UseEditGestureArgs } from '../../src/react/useEditGesture';

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
  const { workingSlide, onElementPointerDown } = useEditGesture(args);
  return (
    <div
      data-testid="hit"
      data-left={workingSlide.elements[0].left}
      onPointerDown={(e) => onElementPointerDown(targetEl, e)}
    />
  );
}

describe('useEditGesture — locked element (defense-in-depth)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('coalesces pointer moves to the latest coordinates once per animation frame', () => {
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frameId += 1;
        frames.set(frameId, callback);
        return frameId;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => frames.delete(id)),
    );

    const slide = makeSlide();
    const { container } = render(
      <Harness
        slide={slide}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        snapping={false}
        onElementsChange={vi.fn()}
        targetEl={slide.elements[0]}
      />,
    );
    const hit = container.querySelector('[data-testid="hit"]') as HTMLElement;

    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 20, clientY: 10 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 30, clientY: 15 });

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(hit.dataset.left).toBe('100');

    const callback = frames.get(1);
    expect(callback).toBeDefined();
    act(() => callback?.(0));
    expect(hit.dataset.left).toBe('130');
  });

  it('builds snapping candidates once at pointer-down and reuses them for the gesture', () => {
    vi.mocked(buildAlignLines).mockClear();
    const slide = makeSlide();
    const el = slide.elements[0];

    const { container, unmount } = render(
      <Harness
        slide={slide}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        snapping
        onElementsChange={vi.fn()}
        targetEl={el}
      />,
    );

    const hit = container.querySelector('[data-testid="hit"]') as HTMLElement;
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 30, clientY: 30 });

    expect(buildAlignLines).toHaveBeenCalledTimes(1);
    unmount();
  });

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

  it('ignores a secondary-button pointer-down so context menus never arm a drag', () => {
    const slide = makeSlide();
    const onElementsChange = vi.fn();
    const onSelectionChange = vi.fn();
    const { container } = render(
      <Harness
        slide={slide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSelectionChange}
        onElementsChange={onElementsChange}
        targetEl={slide.elements[0]}
      />,
    );
    const hit = container.querySelector('[data-testid="hit"]') as HTMLElement;

    fireEvent.pointerDown(hit, { button: 2, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { button: 2, pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(hit, { button: 2, pointerId: 1, clientX: 40, clientY: 40 });

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onElementsChange).not.toHaveBeenCalled();
  });

  it('dragging a not-currently-selected element selects it (on pointer-down) AND emits exactly one element.update', () => {
    // R1: a drag must leave the dragged element selected in the controlled
    // `selection`. Starting from an empty selection, pointer-down selects the
    // element and pointer-up (past the drag threshold) emits its move — one of
    // each, no double-emit.
    const unlockedSlide = makeSlide();
    const el = unlockedSlide.elements[0];
    const onElementsChange = vi.fn();
    const onSelectionChange = vi.fn();

    const { container } = render(
      <Harness
        slide={unlockedSlide}
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

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith({ elementIds: ['a'], primaryId: 'a' });
    expect(onElementsChange).toHaveBeenCalledTimes(1);
    expect(onElementsChange.mock.calls[0][0]).toEqual([
      { type: 'element.update', id: 'a', props: { left: 140, top: 140 } },
    ]);
  });

  it('does NOT re-select an already-sole-primary element on interaction (no redundant emit)', () => {
    // R1: if the element is already the sole/primary selection, pointer-down
    // must not emit a redundant selection change.
    const unlockedSlide = makeSlide();
    const el = unlockedSlide.elements[0];
    const onSelectionChange = vi.fn();

    const { container } = render(
      <Harness
        slide={unlockedSlide}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSelectionChange}
        onElementsChange={vi.fn()}
        targetEl={el}
      />,
    );

    const hit = container.querySelector('[data-testid="hit"]') as HTMLElement;
    // Plain click on the already-selected element: no selection emit.
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 0, clientY: 0 });
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

  it('reports a sub-threshold primary click but not a drag', () => {
    const slide = makeSlide();
    const onElementClick = vi.fn();
    const onElementsChange = vi.fn();
    const { container } = render(
      <Harness
        slide={slide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={vi.fn()}
        onElementsChange={onElementsChange}
        onElementClick={onElementClick}
        targetEl={slide.elements[0]}
      />,
    );
    const hit = container.querySelector('[data-testid="hit"]') as HTMLElement;

    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(hit, { pointerId: 1, clientX: 11, clientY: 10 });
    expect(onElementClick).toHaveBeenCalledWith(slide.elements[0]);

    onElementClick.mockClear();
    fireEvent.pointerDown(hit, { pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(hit, { pointerId: 2, clientX: 30, clientY: 20 });
    expect(onElementClick).not.toHaveBeenCalled();
    expect(onElementsChange).toHaveBeenCalledTimes(1);
  });
});
