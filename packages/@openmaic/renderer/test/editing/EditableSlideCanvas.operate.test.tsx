// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { Slide } from '@openmaic/dsl';
import { EditableSlideCanvas } from '../../src/editing/EditableSlideCanvas';
import { useViewportSize } from '../../src/hooks/useViewportSize';

// Mock the shared viewport-fit hook (jsdom reports container size 0) so the
// overlay uses a known scale/offset, exactly like the base canvas tests.
vi.mock('../../src/hooks/useViewportSize', () => ({
  useViewportSize: vi.fn(),
}));

const textEl = {
  id: 'txt',
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

const imageEl = {
  id: 'img',
  type: 'image',
  left: 100,
  top: 100,
  width: 200,
  height: 80,
  rotate: 0,
  fixedRatio: false,
  src: 'x.png',
};

const videoEl = {
  id: 'vid',
  type: 'video',
  left: 400,
  top: 100,
  width: 320,
  height: 180,
  rotate: 0,
  src: 'v.mp4',
};

const lineEl = {
  id: 'lin',
  type: 'line',
  left: 100,
  top: 400,
  start: [0, 0],
  end: [100, 0],
  width: 2,
  style: 'solid',
  color: '#333',
  points: ['', ''],
};

function makeSlide(elements: unknown[]): Slide {
  return {
    id: 's',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    elements,
  } as unknown as Slide;
}

function renderCanvas(elements: unknown[], selectedId: string) {
  const onElementsChange = vi.fn();
  const utils = render(
    <EditableSlideCanvas
      slide={makeSlide(elements)}
      scale={1}
      selection={{ elementIds: [selectedId], primaryId: selectedId }}
      onSelectionChange={vi.fn()}
      onElementsChange={onElementsChange}
    />,
  );
  return { ...utils, onElementsChange };
}

const resizeHandlesIn = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-resize-handle]')).map((n) =>
    n.getAttribute('data-resize-handle'),
  );

describe('EditableSlideCanvas — operate handle gates', () => {
  beforeEach(() => {
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
  });

  it('a selected horizontal text element gets left/right handles plus a rotate handle', () => {
    const { container } = renderCanvas([textEl], 'txt');
    expect(resizeHandlesIn(container)).toEqual(['left', 'right']);
    expect(container.querySelector('[data-rotate-handle]')).not.toBeNull();
  });

  it('a selected vertical text element gets top/bottom handles instead', () => {
    const { container } = renderCanvas([{ ...textEl, vertical: true }], 'txt');
    expect(resizeHandlesIn(container)).toEqual(['top', 'bottom']);
  });

  it('a selected image gets all eight handles plus a rotate handle', () => {
    const { container } = renderCanvas([imageEl], 'img');
    expect(resizeHandlesIn(container)).toHaveLength(8);
    expect(container.querySelector('[data-rotate-handle]')).not.toBeNull();
  });

  it('a selected video gets eight resize handles but NO rotate handle', () => {
    const { container } = renderCanvas([videoEl], 'vid');
    expect(resizeHandlesIn(container)).toHaveLength(8);
    expect(container.querySelector('[data-rotate-handle]')).toBeNull();
  });

  it('a selected line gets neither resize nor rotate handles (its chrome is LineHandles)', () => {
    const { container } = renderCanvas([lineEl], 'lin');
    expect(container.querySelector('[data-resize-handle]')).toBeNull();
    expect(container.querySelector('[data-rotate-handle]')).toBeNull();
    expect(container.querySelectorAll('[data-line-handle]').length).toBeGreaterThan(0);
  });

  it('a locked element gets no operate handles at all', () => {
    const { container } = renderCanvas([{ ...imageEl, lock: true }], 'img');
    expect(container.querySelector('[data-resize-handle]')).toBeNull();
    expect(container.querySelector('[data-rotate-handle]')).toBeNull();
  });

  it('an unselected element gets no operate handles', () => {
    const { container } = renderCanvas([imageEl, textEl], 'txt');
    // Only the selected text's two handles — none from the unselected image.
    expect(resizeHandlesIn(container)).toEqual(['left', 'right']);
  });

  it('a select-only mount (no onElementsChange) shows no operate handles', () => {
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide([imageEl])}
        scale={1}
        selection={{ elementIds: ['img'], primaryId: 'img' }}
        onSelectionChange={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-resize-handle]')).toBeNull();
    expect(container.querySelector('[data-rotate-handle]')).toBeNull();
  });

  it('a multi-element selection shows no operate handles (single-element gestures only)', () => {
    // The resize/rotate gestures transform one element; per-element handles on
    // a multi-selection would misread as group scaling, which is a later slice.
    const { container } = render(
      <EditableSlideCanvas
        slide={makeSlide([textEl, imageEl])}
        scale={1}
        selection={{ elementIds: ['txt', 'img'], primaryId: 'txt' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-resize-handle]')).toBeNull();
    expect(container.querySelector('[data-rotate-handle]')).toBeNull();
  });
});

describe('EditableSlideCanvas — operate gestures end-to-end', () => {
  beforeEach(() => {
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
  });

  it('dragging a resize handle emits ONE resize intent (and never a move — no fall-through)', () => {
    const { container, onElementsChange } = renderCanvas([imageEl], 'img');
    const handle = container.querySelector('[data-resize-handle="right-bottom"]') as HTMLElement;

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 300, clientY: 180 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 330, clientY: 200 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 330, clientY: 200 });

    expect(onElementsChange).toHaveBeenCalledTimes(1);
    expect(onElementsChange.mock.calls[0][0]).toEqual([
      {
        type: 'element.update',
        id: 'img',
        props: { left: 100, top: 100, width: 230, height: 100 },
      },
    ]);
  });

  it('dragging the rotate handle emits ONE rotate intent', () => {
    const { container, onElementsChange } = renderCanvas([imageEl], 'img');
    const handle = container.querySelector('[data-rotate-handle]') as HTMLElement;

    // Element center (200, 140); the mocked overlay rect is all-zero in jsdom,
    // so client coordinates are canvas coordinates. End right of center: +90°.
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 200, clientY: 75 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 140 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 300, clientY: 140 });

    expect(onElementsChange).toHaveBeenCalledTimes(1);
    expect(onElementsChange.mock.calls[0][0]).toEqual([
      { type: 'element.update', id: 'img', props: { rotate: 90 } },
    ]);
  });

  it('previews the resize on the working copy during the drag (handles track live)', () => {
    const { container } = renderCanvas([imageEl], 'img');
    const handle = container.querySelector('[data-resize-handle="right-bottom"]') as HTMLElement;

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 300, clientY: 180 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 330, clientY: 200 });

    // Mid-drag, the handle re-renders at the working box's corner (330, 200).
    const live = container.querySelector('[data-resize-handle="right-bottom"]') as HTMLElement;
    expect(parseFloat(live.style.left)).toBeCloseTo(330, 5);
    expect(parseFloat(live.style.top)).toBeCloseTo(200, 5);

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 330, clientY: 200 });
    // After commit the working copy clears; the controlled slide (unchanged
    // here — the host didn't apply the intent) snaps the handle back.
    const settled = container.querySelector('[data-resize-handle="right-bottom"]') as HTMLElement;
    expect(parseFloat(settled.style.left)).toBeCloseTo(300, 5);
  });
});
