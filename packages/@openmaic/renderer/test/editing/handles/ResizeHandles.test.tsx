// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { ResizeHandles } from '../../../src/editing/handles/ResizeHandles';
import { RotateHandle } from '../../../src/editing/handles/RotateHandle';
import { RESIZE_HANDLES, type PPTBoxElement } from '../../../src/editing/core/resize';

const element = {
  id: 'a',
  type: 'image',
  left: 100,
  top: 100,
  width: 200,
  height: 80,
  rotate: 0,
  fixedRatio: false,
  src: 'x.png',
} as unknown as PPTBoxElement;

const viewportStyles = { left: 0, top: 0, width: 1000, height: 562.5 };

describe('ResizeHandles', () => {
  it('renders one box per requested handle at the un-rotated frame points', () => {
    const { container } = render(
      <ResizeHandles
        element={element}
        handles={RESIZE_HANDLES}
        viewportStyles={viewportStyles}
        canvasScale={1}
        onHandlePointerDown={vi.fn()}
      />,
    );
    const boxes = container.querySelectorAll('[data-resize-handle]');
    expect(boxes).toHaveLength(8);

    const at = (h: string) => container.querySelector(`[data-resize-handle="${h}"]`) as HTMLElement;
    expect(at('left-top').style.left).toBe('100px');
    expect(at('left-top').style.top).toBe('100px');
    expect(at('top').style.left).toBe('200px');
    expect(at('top').style.top).toBe('100px');
    expect(at('right').style.left).toBe('300px');
    expect(at('right').style.top).toBe('140px');
    expect(at('right-bottom').style.left).toBe('300px');
    expect(at('right-bottom').style.top).toBe('180px');
  });

  it('renders only the requested subset (text-style two handles)', () => {
    const { container } = render(
      <ResizeHandles
        element={element}
        handles={['left', 'right']}
        viewportStyles={viewportStyles}
        canvasScale={1}
        onHandlePointerDown={vi.fn()}
      />,
    );
    const boxes = container.querySelectorAll('[data-resize-handle]');
    expect(boxes).toHaveLength(2);
  });

  it('positions handles at the ROTATED frame points (not the axis-aligned box)', () => {
    // 100x50 box at (100, 100) rotated 90°: center (150, 125), the rotated
    // top-center point sits at (175, 125).
    const rotated = { ...element, left: 100, top: 100, width: 100, height: 50, rotate: 90 };
    const { container } = render(
      <ResizeHandles
        element={rotated as PPTBoxElement}
        handles={RESIZE_HANDLES}
        viewportStyles={viewportStyles}
        canvasScale={1}
        onHandlePointerDown={vi.fn()}
      />,
    );
    const top = container.querySelector('[data-resize-handle="top"]') as HTMLElement;
    expect(parseFloat(top.style.left)).toBeCloseTo(175, 5);
    expect(parseFloat(top.style.top)).toBeCloseTo(125, 5);
    const leftTop = container.querySelector('[data-resize-handle="left-top"]') as HTMLElement;
    expect(parseFloat(leftTop.style.left)).toBeCloseTo(175, 5);
    expect(parseFloat(leftTop.style.top)).toBeCloseTo(75, 5);
  });

  it('applies the centering offset and canvas scale like the other overlays', () => {
    const { container } = render(
      <ResizeHandles
        element={element}
        handles={['left-top']}
        viewportStyles={{ ...viewportStyles, left: 160 }}
        canvasScale={0.5}
        onHandlePointerDown={vi.fn()}
      />,
    );
    const lt = container.querySelector('[data-resize-handle="left-top"]') as HTMLElement;
    expect(lt.style.left).toBe('210px'); // 160 + 100 * 0.5
    expect(lt.style.top).toBe('50px'); // 0 + 100 * 0.5
  });

  it('carries a rotation-aware directional cursor', () => {
    const { container: c0 } = render(
      <ResizeHandles
        element={element}
        handles={['left-top']}
        viewportStyles={viewportStyles}
        canvasScale={1}
        onHandlePointerDown={vi.fn()}
      />,
    );
    expect((c0.querySelector('[data-resize-handle="left-top"]') as HTMLElement).style.cursor).toBe(
      'nwse-resize',
    );

    const { container: c45 } = render(
      <ResizeHandles
        element={{ ...element, rotate: 45 } as PPTBoxElement}
        handles={['left-top']}
        viewportStyles={viewportStyles}
        canvasScale={1}
        onHandlePointerDown={vi.fn()}
      />,
    );
    expect((c45.querySelector('[data-resize-handle="left-top"]') as HTMLElement).style.cursor).toBe(
      'ns-resize',
    );
  });

  it('reports the pressed handle through onHandlePointerDown', () => {
    const onDown = vi.fn();
    const { container } = render(
      <ResizeHandles
        element={element}
        handles={RESIZE_HANDLES}
        viewportStyles={viewportStyles}
        canvasScale={1}
        onHandlePointerDown={onDown}
      />,
    );
    fireEvent.pointerDown(
      container.querySelector('[data-resize-handle="left-bottom"]') as HTMLElement,
      { pointerId: 1 },
    );
    expect(onDown).toHaveBeenCalledTimes(1);
    expect(onDown.mock.calls[0][0]).toBe('left-bottom');
  });
});

describe('RotateHandle', () => {
  it('floats 25 screen px above the top-center point at rotation 0', () => {
    const { container } = render(
      <RotateHandle
        element={element}
        viewportStyles={viewportStyles}
        canvasScale={1}
        onPointerDown={vi.fn()}
      />,
    );
    const handle = container.querySelector('[data-rotate-handle]') as HTMLElement;
    // Top-center (200, 100), pushed 25px along (0, -1).
    expect(parseFloat(handle.style.left)).toBeCloseTo(200, 5);
    expect(parseFloat(handle.style.top)).toBeCloseTo(75, 5);
    expect(handle.style.cursor).toBe('grab');
  });

  it('orbits with the element: at 90° it sits 25px to the right of the rotated top point', () => {
    const rotated = { ...element, left: 100, top: 100, width: 100, height: 50, rotate: 90 };
    const { container } = render(
      <RotateHandle
        element={rotated as PPTBoxElement}
        viewportStyles={viewportStyles}
        canvasScale={1}
        onPointerDown={vi.fn()}
      />,
    );
    const handle = container.querySelector('[data-rotate-handle]') as HTMLElement;
    // Rotated top point (175, 125), up vector (sin 90, -cos 90) = (1, 0).
    expect(parseFloat(handle.style.left)).toBeCloseTo(200, 5);
    expect(parseFloat(handle.style.top)).toBeCloseTo(125, 5);
  });

  it('keeps the 25px gap constant on screen regardless of canvas scale', () => {
    const { container } = render(
      <RotateHandle
        element={element}
        viewportStyles={viewportStyles}
        canvasScale={0.5}
        onPointerDown={vi.fn()}
      />,
    );
    const handle = container.querySelector('[data-rotate-handle]') as HTMLElement;
    // Top-center (200, 100) * 0.5 = (100, 50), minus the un-scaled 25px gap.
    expect(parseFloat(handle.style.left)).toBeCloseTo(100, 5);
    expect(parseFloat(handle.style.top)).toBeCloseTo(25, 5);
  });
});
