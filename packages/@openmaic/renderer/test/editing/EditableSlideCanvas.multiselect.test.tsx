// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { Slide } from '@openmaic/dsl';
import { EditableSlideCanvas } from '../../src/editing/EditableSlideCanvas';
import type { EditIntent, Selection } from '../../src/editing/types';
import { useViewportSize } from '../../src/hooks/useViewportSize';

// Mock the viewport-fit hook (jsdom reports a zero-size container) so the
// overlay uses a known scale/offset, exactly like the other canvas tests.
vi.mock('../../src/hooks/useViewportSize', () => ({
  useViewportSize: vi.fn(),
}));

const textEl = {
  id: 'a',
  type: 'text',
  left: 100,
  top: 100,
  width: 200,
  height: 80,
  rotate: 0,
  content: 'x',
  defaultFontName: 'f',
  defaultColor: '#000',
  lineHeight: 1,
};
const imageEl = {
  id: 'b',
  type: 'image',
  left: 400,
  top: 100,
  width: 320,
  height: 180,
  rotate: 0,
  fixedRatio: false,
  src: 'x.png',
};

function makeSlide(elements: unknown[] = [textEl, imageEl]): Slide {
  return {
    id: 's',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    elements,
  } as unknown as Slide;
}

const lockedEl = {
  id: 'locked1',
  type: 'text',
  left: 600,
  top: 300,
  width: 100,
  height: 50,
  rotate: 0,
  content: 'z',
  defaultFontName: 'f',
  defaultColor: '#000',
  lineHeight: 1,
  lock: true,
};
const lineEl = {
  id: 'line1',
  type: 'line',
  left: 400,
  top: 300,
  start: [0, 0],
  end: [80, 40],
  width: 2,
  style: 'solid',
  color: '#333',
  points: ['', ''],
};
const groupEl = (id: string, left: number) => ({
  id,
  type: 'text',
  left,
  top: 100,
  width: 100,
  height: 60,
  rotate: 0,
  content: 'g',
  defaultFontName: 'f',
  defaultColor: '#000',
  lineHeight: 1,
  groupId: 'G',
});

const hit = (c: HTMLElement, id: string) =>
  c.querySelector(`[data-element-id="${id}"]`) as HTMLElement;
const surface = (c: HTMLElement) => c.querySelector('[data-marquee-surface]') as HTMLElement;
const lineBlocker = (c: HTMLElement) => c.querySelector('[data-hit-kind="line"]') as Element;

describe('EditableSlideCanvas — marquee', () => {
  beforeEach(() => {
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
  });

  it('renders a blank-canvas capture surface with touch suppression when the mount is editable', () => {
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    const s = surface(container);
    expect(s).not.toBeNull();
    expect(s.style.touchAction).toBe('none');
  });

  it('a select-only mount renders a capture surface without disabling native touch pan', () => {
    // Select-only hosts need blank clear and mouse/pen marquee, but should keep
    // native touch scrolling because they have no mutation channel for a touch
    // driven editing gesture.
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={vi.fn()}
      />,
    );
    const s = surface(container);
    expect(s).not.toBeNull();
    expect(s.style.touchAction).toBe('');
    // Element hit targets are still present for tap-select.
    expect(hit(container, 'a')).not.toBeNull();
  });

  it('a select-only mount can marquee-select and blank-clear through the capture surface', () => {
    const onSel = vi.fn();
    const { container, rerender } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
      />,
    );
    let s = surface(container);
    fireEvent.pointerDown(s, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(s, { pointerId: 1, clientX: 350, clientY: 250 });
    fireEvent.pointerUp(s, { pointerId: 1, clientX: 350, clientY: 250 });
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenLastCalledWith({ elementIds: ['a'], primaryId: 'a' });

    rerender(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
      />,
    );
    s = surface(container);
    fireEvent.pointerDown(s, { pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(s, { pointerId: 2, clientX: 11, clientY: 11 });
    expect(onSel).toHaveBeenCalledTimes(2);
    expect(onSel).toHaveBeenLastCalledWith({ elementIds: [] });
  });

  it('a marquee past threshold REPLACES the selection with what it contains', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        onElementsChange={vi.fn()}
      />,
    );
    const s = surface(container);
    // (0,0)→(350,250) wholly contains 'a' ([100,300]×[100,180]); 'b' is outside.
    fireEvent.pointerDown(s, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(s, { pointerId: 1, clientX: 350, clientY: 250 });
    // The live marquee box is drawn mid-drag.
    expect(container.querySelector('[data-marquee-box]')).not.toBeNull();
    fireEvent.pointerUp(s, { pointerId: 1, clientX: 350, clientY: 250 });
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith({ elementIds: ['a'], primaryId: 'a' });
    // Box removed after release.
    expect(container.querySelector('[data-marquee-box]')).toBeNull();
  });

  it('a sub-threshold blank click clears the selection', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={vi.fn()}
      />,
    );
    const s = surface(container);
    fireEvent.pointerDown(s, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(s, { pointerId: 1, clientX: 11, clientY: 11 });
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith({ elementIds: [] });
  });
});

describe('EditableSlideCanvas — click modifiers', () => {
  beforeEach(() => {
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
  });

  it('a plain click on an unselected element selects only it', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={vi.fn()}
      />,
    );
    fireEvent.pointerDown(hit(container, 'b'), { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(hit(container, 'b'), { pointerId: 1, clientX: 0, clientY: 0 });
    expect(onSel).toHaveBeenCalledWith({ elementIds: ['b'], primaryId: 'b' });
  });

  it('a Ctrl-click on an unselected element ADDS it to the selection (uniq)', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={vi.fn()}
      />,
    );
    fireEvent.pointerDown(hit(container, 'b'), {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      ctrlKey: true,
    });
    fireEvent.pointerUp(hit(container, 'b'), {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      ctrlKey: true,
    });
    expect(onSel).toHaveBeenCalledWith({ elementIds: ['a', 'b'], primaryId: 'b' });
  });

  it('a Shift-click on a selected element REMOVES it', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: ['a', 'b'], primaryId: 'b' }}
        onSelectionChange={onSel}
        onElementsChange={vi.fn()}
      />,
    );
    fireEvent.pointerDown(hit(container, 'b'), {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      shiftKey: true,
    });
    fireEvent.pointerUp(hit(container, 'b'), {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      shiftKey: true,
    });
    expect(onSel).toHaveBeenCalledWith({ elementIds: ['a'], primaryId: 'a' });
  });

  it('a Ctrl-click that would empty the selection is a guarded no-op', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={vi.fn()}
      />,
    );
    fireEvent.pointerDown(hit(container, 'a'), {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      ctrlKey: true,
    });
    fireEvent.pointerUp(hit(container, 'a'), {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      ctrlKey: true,
    });
    // Removing the last element would empty the selection → no emit.
    expect(onSel).not.toHaveBeenCalled();
  });
});

describe('EditableSlideCanvas — multi-drag', () => {
  beforeEach(() => {
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
  });

  it('dragging a selected element in a multi-selection moves ALL and emits ONE updateMany', () => {
    const onSel = vi.fn();
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: ['a', 'b'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    // 'a' is already the primary; a plain drag keeps the whole selection.
    fireEvent.pointerDown(hit(container, 'a'), { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit(container, 'a'), { pointerId: 1, clientX: 30, clientY: 20 });
    fireEvent.pointerUp(hit(container, 'a'), { pointerId: 1, clientX: 30, clientY: 20 });

    // Exactly one intent — a single element.updateMany = one host undo entry.
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh.mock.calls[0][0]).toEqual([
      {
        type: 'element.updateMany',
        updates: [
          { id: 'a', props: { left: 130, top: 120 } },
          { id: 'b', props: { left: 430, top: 120 } },
        ],
      },
    ]);
    // No re-selection: 'a' was already primary.
    expect(onSel).not.toHaveBeenCalled();
  });

  it('a multi-selection shows no operate handles (single-element gestures only)', () => {
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: ['a', 'b'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-resize-handle]')).toBeNull();
    expect(container.querySelector('[data-rotate-handle]')).toBeNull();
  });

  it('a single-element drag still emits element.update (backward compat)', () => {
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    fireEvent.pointerDown(hit(container, 'a'), { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit(container, 'a'), { pointerId: 1, clientX: 30, clientY: 20 });
    fireEvent.pointerUp(hit(container, 'a'), { pointerId: 1, clientX: 30, clientY: 20 });
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh.mock.calls[0][0]).toEqual([
      { type: 'element.update', id: 'a', props: { left: 130, top: 120 } },
    ]);
  });

  it('a locked element in the selection never moves: the drag set excludes it (single mover → element.update)', () => {
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide([textEl, lockedEl])}
        scale={1}
        selection={{ elementIds: ['locked1', 'a'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    fireEvent.pointerDown(hit(container, 'a'), { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit(container, 'a'), { pointerId: 1, clientX: 30, clientY: 20 });
    // Working copy: the locked element's blocker stays put while 'a' follows.
    expect(hit(container, 'a').style.left).toBe('130px');
    const blocker = container.querySelector('[data-hit-kind="blocker"]') as HTMLElement;
    expect(blocker.style.left).toBe('600px');
    expect(blocker.style.top).toBe('300px');
    fireEvent.pointerUp(hit(container, 'a'), { pointerId: 1, clientX: 30, clientY: 20 });
    // Only ONE mover remains → single element.update, and NO entry for locked1.
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh.mock.calls[0][0]).toEqual([
      { type: 'element.update', id: 'a', props: { left: 130, top: 120 } },
    ]);
  });

  it('a locked element in a 3-element selection is absent from the updateMany', () => {
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide([textEl, imageEl, lockedEl])}
        scale={1}
        selection={{ elementIds: ['a', 'b', 'locked1'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    fireEvent.pointerDown(hit(container, 'a'), { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit(container, 'a'), { pointerId: 1, clientX: 30, clientY: 20 });
    fireEvent.pointerUp(hit(container, 'a'), { pointerId: 1, clientX: 30, clientY: 20 });
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh.mock.calls[0][0]).toEqual([
      {
        type: 'element.updateMany',
        updates: [
          { id: 'a', props: { left: 130, top: 120 } },
          { id: 'b', props: { left: 430, top: 120 } },
        ],
      },
    ]);
  });

  it('multi-drag pointercancel reverts the working copy without emitting', () => {
    const onSel = vi.fn();
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: ['a', 'b'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    fireEvent.pointerDown(hit(container, 'a'), { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit(container, 'a'), { pointerId: 1, clientX: 30, clientY: 20 });
    // Live: BOTH selected elements followed the pointer.
    expect(hit(container, 'a').style.left).toBe('130px');
    expect(hit(container, 'b').style.left).toBe('430px');
    fireEvent.pointerCancel(hit(container, 'a'), { pointerId: 1, clientX: 30, clientY: 20 });
    // Reverted, and no intent/selection emitted.
    expect(hit(container, 'a').style.left).toBe('100px');
    expect(hit(container, 'b').style.left).toBe('400px');
    expect(onCh).not.toHaveBeenCalled();
    expect(onSel).not.toHaveBeenCalled();
  });

  it('after a modifier click (no drag armed), a plain drag with a NEW pointerId still works', () => {
    // A pure selection click never claims the active pointer, so a subsequent
    // gesture from a different pointerId must arm normally.
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    // Modifier click on 'b': selection action only, pointer 1 never claimed.
    fireEvent.pointerDown(hit(container, 'b'), {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      ctrlKey: true,
    });
    fireEvent.pointerUp(hit(container, 'b'), {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      ctrlKey: true,
    });
    // Plain drag on 'a' with a NEW pointerId commits a move.
    fireEvent.pointerDown(hit(container, 'a'), { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit(container, 'a'), { pointerId: 2, clientX: 30, clientY: 20 });
    fireEvent.pointerUp(hit(container, 'a'), { pointerId: 2, clientX: 30, clientY: 20 });
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh.mock.calls[0][0]).toEqual([
      { type: 'element.update', id: 'a', props: { left: 130, top: 120 } },
    ]);
  });
});

describe('EditableSlideCanvas — shift axis lock (mid-drag)', () => {
  beforeEach(() => {
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
  });

  it('holding shift during a SINGLE drag locks to the dominant axis', () => {
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    // Plain pointer-down (shift here would be a selection modifier, no drag);
    // shift is engaged on the MOVE. |dx|=30 > |dy|=10 → x is dominant.
    fireEvent.pointerDown(hit(container, 'a'), { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit(container, 'a'), {
      pointerId: 1,
      clientX: 30,
      clientY: 10,
      shiftKey: true,
    });
    // Live working copy already reflects the lock: y stays put.
    expect(hit(container, 'a').style.left).toBe('130px');
    expect(hit(container, 'a').style.top).toBe('100px');
    fireEvent.pointerUp(hit(container, 'a'), {
      pointerId: 1,
      clientX: 30,
      clientY: 10,
      shiftKey: true,
    });
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh.mock.calls[0][0]).toEqual([
      { type: 'element.update', id: 'a', props: { left: 130, top: 100 } },
    ]);
  });

  it('holding shift during a MULTI drag locks the whole set to the dominant axis', () => {
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: ['a', 'b'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    // |dy|=25 > |dx|=10 → y is dominant; x deltas are dropped for BOTH.
    fireEvent.pointerDown(hit(container, 'a'), { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit(container, 'a'), {
      pointerId: 1,
      clientX: 10,
      clientY: 25,
      shiftKey: true,
    });
    fireEvent.pointerUp(hit(container, 'a'), {
      pointerId: 1,
      clientX: 10,
      clientY: 25,
      shiftKey: true,
    });
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh.mock.calls[0][0]).toEqual([
      {
        type: 'element.updateMany',
        updates: [
          { id: 'a', props: { left: 100, top: 125 } },
          { id: 'b', props: { left: 400, top: 125 } },
        ],
      },
    ]);
  });
});

describe('EditableSlideCanvas — line selection modifiers', () => {
  beforeEach(() => {
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
  });

  it('a Ctrl-click on a line ADDS it to the selection', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide([textEl, lineEl])}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={vi.fn()}
        snapping={false}
      />,
    );
    fireEvent.pointerDown(lineBlocker(container), { clientX: 0, clientY: 0, ctrlKey: true });
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith({ elementIds: ['a', 'line1'], primaryId: 'line1' });
  });

  it('a Ctrl-click on a selected line REMOVES it without destroying the selection', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide([textEl, lineEl])}
        scale={1}
        selection={{ elementIds: ['a', 'line1'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={vi.fn()}
        snapping={false}
      />,
    );
    fireEvent.pointerDown(lineBlocker(container), { clientX: 0, clientY: 0, ctrlKey: true });
    expect(onSel).toHaveBeenCalledTimes(1);
    // The rest of the selection survives, and the surviving primary is kept.
    expect(onSel).toHaveBeenCalledWith({ elementIds: ['a'], primaryId: 'a' });
  });
});

describe('EditableSlideCanvas — group cohesion on click', () => {
  beforeEach(() => {
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
  });

  const g1 = groupEl('g1', 100);
  const g2 = groupEl('g2', 400);

  it('a plain click on a grouped element selects ALL group members (primary = clicked)', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide([g1, g2, textEl])}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        onElementsChange={vi.fn()}
        snapping={false}
      />,
    );
    fireEvent.pointerDown(hit(container, 'g2'), { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(hit(container, 'g2'), { pointerId: 1, clientX: 0, clientY: 0 });
    expect(onSel).toHaveBeenCalledWith({ elementIds: ['g1', 'g2'], primaryId: 'g2' });
  });

  it('a modifier-add on a grouped element adds the WHOLE group (uniq)', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide([g1, g2, textEl])}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={vi.fn()}
        snapping={false}
      />,
    );
    fireEvent.pointerDown(hit(container, 'g1'), {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      ctrlKey: true,
    });
    expect(onSel).toHaveBeenCalledWith({ elementIds: ['a', 'g1', 'g2'], primaryId: 'g1' });
  });

  it('a modifier-remove on a grouped element removes the WHOLE group', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide([g1, g2, textEl])}
        scale={1}
        selection={{ elementIds: ['a', 'g1', 'g2'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={vi.fn()}
        snapping={false}
      />,
    );
    fireEvent.pointerDown(hit(container, 'g2'), {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      ctrlKey: true,
    });
    // Both members removed; the surviving primary 'a' is preserved.
    expect(onSel).toHaveBeenCalledWith({ elementIds: ['a'], primaryId: 'a' });
  });

  it('dragging a group member moves the WHOLE group (one updateMany)', () => {
    const onSel = vi.fn();
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide([g1, g2, textEl])}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    fireEvent.pointerDown(hit(container, 'g1'), { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit(container, 'g1'), { pointerId: 1, clientX: 30, clientY: 20 });
    fireEvent.pointerUp(hit(container, 'g1'), { pointerId: 1, clientX: 30, clientY: 20 });
    // Selection landed on the whole group at pointer-down…
    expect(onSel).toHaveBeenCalledWith({ elementIds: ['g1', 'g2'], primaryId: 'g1' });
    // …and the drag translated every member as ONE updateMany.
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh.mock.calls[0][0]).toEqual([
      {
        type: 'element.updateMany',
        updates: [
          { id: 'g1', props: { left: 130, top: 120 } },
          { id: 'g2', props: { left: 430, top: 120 } },
        ],
      },
    ]);
  });
});

describe('EditableSlideCanvas — marquee + multi-drag integration', () => {
  beforeEach(() => {
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
  });

  /** Controlled host: routes onSelectionChange back into the selection prop. */
  function ControlledCanvas({
    slide,
    onElementsChange,
  }: {
    slide: Slide;
    onElementsChange: (intents: EditIntent[]) => void;
  }) {
    const [sel, setSel] = useState<Selection>({ elementIds: [] });
    return (
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={sel}
        onSelectionChange={setSel}
        onElementsChange={onElementsChange}
        snapping={false}
      />
    );
  }

  it('marquee-selects a line + a box, then dragging the box carries the line in the updateMany', () => {
    const onCh = vi.fn();
    const { container } = render(
      <ControlledCanvas slide={makeSlide([textEl, lineEl])} onElementsChange={onCh} />,
    );
    // Marquee (50,50)→(700,500) contains both the box ([100,300]×[100,180])
    // and the line's bounds ([400,480]×[300,340]).
    const s = surface(container);
    fireEvent.pointerDown(s, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(s, { pointerId: 1, clientX: 700, clientY: 500 });
    fireEvent.pointerUp(s, { pointerId: 1, clientX: 700, clientY: 500 });

    // Now drag the box: the whole marquee selection (box + line) translates.
    fireEvent.pointerDown(hit(container, 'a'), { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit(container, 'a'), { pointerId: 2, clientX: 30, clientY: 20 });
    fireEvent.pointerUp(hit(container, 'a'), { pointerId: 2, clientX: 30, clientY: 20 });

    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh.mock.calls[0][0]).toEqual([
      {
        type: 'element.updateMany',
        updates: [
          { id: 'a', props: { left: 130, top: 120 } },
          { id: 'line1', props: { left: 430, top: 320 } },
        ],
      },
    ]);
  });
});
