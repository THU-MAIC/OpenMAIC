// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { useRef } from 'react';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { Slide } from '@openmaic/dsl';
import { useMarqueeGesture, type UseMarqueeGestureArgs } from '../../src/editing/useMarqueeGesture';

const elA = {
  id: 'a',
  type: 'text',
  left: 100,
  top: 100,
  width: 100,
  height: 60,
  rotate: 0,
  content: 'x',
  defaultFontName: 'f',
  defaultColor: '#000',
  lineHeight: 1,
};
const elB = {
  id: 'b',
  type: 'image',
  left: 300,
  top: 300,
  width: 50,
  height: 50,
  rotate: 0,
  fixedRatio: false,
  src: 'x.png',
};

function makeSlide(elements: unknown[] = [elA, elB]): Slide {
  return {
    id: 's',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    elements,
  } as unknown as Slide;
}

type HarnessArgs = Omit<UseMarqueeGestureArgs, 'overlayRef'>;

/**
 * Mirrors EditableSlideCanvas's overlay: a container ref plus a capture surface
 * wired to `onCanvasPointerDown`. jsdom reports a zero-origin bounding rect, so
 * with `viewportStyles` at 0 the client coordinates map 1:1 to canvas units.
 */
function Harness(args: HarnessArgs) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const { marqueeRect, onCanvasPointerDown } = useMarqueeGesture({ ...args, overlayRef });
  return (
    <div ref={overlayRef} style={{ position: 'relative' }}>
      <div data-testid="surface" onPointerDown={onCanvasPointerDown} />
      {marqueeRect && (
        <div data-testid="live-rect" data-min-x={marqueeRect.minX} data-max-x={marqueeRect.maxX} />
      )}
    </div>
  );
}

const vp = { left: 0, top: 0, width: 1000, height: 562 };

describe('useMarqueeGesture', () => {
  it('a marquee past threshold REPLACES the selection (contain)', () => {
    const onSel = vi.fn();
    const { container } = render(
      <Harness
        slide={makeSlide()}
        scale={1}
        viewportStyles={vp}
        selection={{ elementIds: ['b'], primaryId: 'b' }}
        onSelectionChange={onSel}
      />,
    );
    const surface = container.querySelector('[data-testid="surface"]') as HTMLElement;
    // Box (0,0)→(250,250) wholly contains 'a' ([100,200]×[100,160]); 'b' is out.
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 250, clientY: 250 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 250, clientY: 250 });
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith({ elementIds: ['a'], primaryId: 'a' });
  });

  it('a modifier marquee uses intersection (Ctrl keeps a straddled element)', () => {
    const onSel = vi.fn();
    const { container } = render(
      <Harness
        slide={makeSlide()}
        scale={1}
        viewportStyles={vp}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
      />,
    );
    const surface = container.querySelector('[data-testid="surface"]') as HTMLElement;
    // Box (0,0)→(150,150) only OVERLAPS 'a' (maxX 200 > 150): contain rejects,
    // intersect keeps. Ctrl at release selects intersect mode.
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 150, clientY: 150 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 150, clientY: 150, ctrlKey: true });
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith({ elementIds: ['a'], primaryId: 'a' });
  });

  it('the same box with NO modifier (contain) selects nothing and clears', () => {
    const onSel = vi.fn();
    const { container } = render(
      <Harness
        slide={makeSlide()}
        scale={1}
        viewportStyles={vp}
        selection={{ elementIds: ['b'], primaryId: 'b' }}
        onSelectionChange={onSel}
      />,
    );
    const surface = container.querySelector('[data-testid="surface"]') as HTMLElement;
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 150, clientY: 150 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 150, clientY: 150 });
    // Contain covers nothing → clears the previous selection.
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith({ elementIds: [] });
  });

  it('a sub-threshold blank click clears a non-empty selection', () => {
    const onSel = vi.fn();
    const { container } = render(
      <Harness
        slide={makeSlide()}
        scale={1}
        viewportStyles={vp}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
      />,
    );
    const surface = container.querySelector('[data-testid="surface"]') as HTMLElement;
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 12, clientY: 12 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 12, clientY: 12 });
    // Below the 5-unit both-axes threshold → blank click → clear.
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith({ elementIds: [] });
  });

  it('a sub-threshold blank click on an already-empty selection emits nothing', () => {
    const onSel = vi.fn();
    const { container } = render(
      <Harness
        slide={makeSlide()}
        scale={1}
        viewportStyles={vp}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
      />,
    );
    const surface = container.querySelector('[data-testid="surface"]') as HTMLElement;
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 11, clientY: 11 });
    // Idempotent: already empty → no redundant selection change.
    expect(onSel).not.toHaveBeenCalled();
  });

  it('shows the live rect only once past the both-axes threshold', () => {
    const { container } = render(
      <Harness
        slide={makeSlide()}
        scale={1}
        viewportStyles={vp}
        selection={{ elementIds: [] }}
        onSelectionChange={vi.fn()}
      />,
    );
    const surface = container.querySelector('[data-testid="surface"]') as HTMLElement;
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 0, clientY: 0 });
    // Sub-threshold move: no box yet.
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 3, clientY: 3 });
    expect(container.querySelector('[data-testid="live-rect"]')).toBeNull();
    // Past threshold on both axes: the box appears, normalized.
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 40, clientY: 30 });
    const rect = container.querySelector('[data-testid="live-rect"]') as HTMLElement;
    expect(rect).not.toBeNull();
    expect(rect.getAttribute('data-min-x')).toBe('0');
    expect(rect.getAttribute('data-max-x')).toBe('40');
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 40, clientY: 30 });
    // Cleared after release.
    expect(container.querySelector('[data-testid="live-rect"]')).toBeNull();
  });

  it('pointercancel reverts without emitting and leaves the hook ready', () => {
    const onSel = vi.fn();
    const { container } = render(
      <Harness
        slide={makeSlide()}
        scale={1}
        viewportStyles={vp}
        selection={{ elementIds: ['b'], primaryId: 'b' }}
        onSelectionChange={onSel}
      />,
    );
    const surface = container.querySelector('[data-testid="surface"]') as HTMLElement;
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 250, clientY: 250 });
    fireEvent.pointerCancel(surface, { pointerId: 1, clientX: 250, clientY: 250 });
    // Cancelled: live box gone, no selection change.
    expect(container.querySelector('[data-testid="live-rect"]')).toBeNull();
    expect(onSel).not.toHaveBeenCalled();
    // Ready again: a fresh marquee still fires.
    fireEvent.pointerDown(surface, { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 250, clientY: 250 });
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 250, clientY: 250 });
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith({ elementIds: ['a'], primaryId: 'a' });
  });

  it('a non-main-button press neither arms a marquee nor clears the selection', () => {
    const onSel = vi.fn();
    const { container } = render(
      <Harness
        slide={makeSlide()}
        scale={1}
        viewportStyles={vp}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
      />,
    );
    const surface = container.querySelector('[data-testid="surface"]') as HTMLElement;
    // Secondary (right) button: pointer-down must not arm, so the matching
    // pointer-up is not a blank click and the selection survives.
    fireEvent.pointerDown(surface, { pointerId: 1, button: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(surface, { pointerId: 1, button: 2, clientX: 10, clientY: 10 });
    expect(onSel).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="live-rect"]')).toBeNull();
    // The hook stayed unarmed: a fresh MAIN-button marquee still works.
    fireEvent.pointerDown(surface, { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 250, clientY: 250 });
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 250, clientY: 250 });
    expect(onSel).toHaveBeenCalledTimes(1);
  });

  it('release decisions read the LIVE selection, not the pointer-down closure', () => {
    const onSel = vi.fn();
    const { container, rerender } = render(
      <Harness
        slide={makeSlide()}
        scale={1}
        viewportStyles={vp}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
      />,
    );
    const surface = container.querySelector('[data-testid="surface"]') as HTMLElement;
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 10, clientY: 10 });
    // The host updates the controlled selection mid-gesture (e.g. programmatic
    // select). The blank-click decision on release must see this live value.
    rerender(
      <Harness
        slide={makeSlide()}
        scale={1}
        viewportStyles={vp}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
      />,
    );
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 11, clientY: 11 });
    // Sub-threshold blank click over a now-NON-empty selection must clear it;
    // the stale pointer-down-time empty selection would have skipped the emit.
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith({ elementIds: [] });
  });

  it('drops window move/up from a foreign pointerId', () => {
    const onSel = vi.fn();
    const { container } = render(
      <Harness
        slide={makeSlide()}
        scale={1}
        viewportStyles={vp}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
      />,
    );
    const surface = container.querySelector('[data-testid="surface"]') as HTMLElement;
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 0, clientY: 0 });
    // A second pointer's move/up must not drive or end the gesture.
    fireEvent.pointerMove(surface, { pointerId: 9, clientX: 250, clientY: 250 });
    fireEvent.pointerUp(surface, { pointerId: 9, clientX: 250, clientY: 250 });
    expect(onSel).not.toHaveBeenCalled();
    // The active pointer still completes it.
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 250, clientY: 250 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 250, clientY: 250 });
    expect(onSel).toHaveBeenCalledTimes(1);
  });
});
