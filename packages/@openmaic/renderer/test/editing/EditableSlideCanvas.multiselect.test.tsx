// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { Slide } from '@openmaic/dsl';
import { EditableSlideCanvas } from '../../src/editing/EditableSlideCanvas';
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

const hit = (c: HTMLElement, id: string) =>
  c.querySelector(`[data-element-id="${id}"]`) as HTMLElement;
const surface = (c: HTMLElement) => c.querySelector('[data-marquee-surface]') as HTMLElement;

describe('EditableSlideCanvas — marquee', () => {
  beforeEach(() => {
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
  });

  it('renders a blank-canvas capture surface only when onSelectionChange is provided', () => {
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={vi.fn()}
      />,
    );
    expect(surface(container)).not.toBeNull();

    // Mutation-only mount (no onSelectionChange): no marquee surface.
    const { container: c2 } = render(
      <EditableSlideCanvas slide={makeSlide()} scale={1} onElementsChange={vi.fn()} />,
    );
    expect(surface(c2)).toBeNull();
  });

  it('a marquee past threshold REPLACES the selection with what it contains', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide()}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
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
});
