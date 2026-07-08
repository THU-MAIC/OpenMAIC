import type { PointerEvent as ReactPointerEvent } from 'react';

import type { ViewportStyles } from '../../hooks/useViewportSize';
import { getRotateElementPoints, type PPTBoxElement } from '../core/resize';

export interface RotateHandleProps {
  /** The box element whose rotate handle is drawn. */
  element: PPTBoxElement;
  /** SlideCanvas centering offset — the handle shares the element container's origin. */
  viewportStyles: ViewportStyles;
  /** Canvas → screen scale (`props.scale ?? fitScale`). */
  canvasScale: number;
  /** Arm a rotate gesture from a pointer-down on the handle box. */
  onPointerDown: (e: ReactPointerEvent) => void;
}

/** Half the handle box size, so `translate(-HALF, -HALF)` centers it on its point. */
const HANDLE_HALF = 5;

/**
 * Screen-pixel gap between the element's rotated top edge and the rotate
 * handle, along the element's rotated "up" direction (app parity: the app
 * offsets the handle 25 un-scaled px above the frame inside its rotated
 * operate layer, so the gap is constant on screen at any zoom).
 */
const ROTATE_HANDLE_OFFSET_PX = 25;

/**
 * Presentational rotate handle for a selected box element: a small grab-cursor
 * box floating above the element's rotated top-center point.
 *
 * Position is computed ANALYTICALLY (like `ResizeHandles`): the rotated
 * top-center point comes from {@link getRotateElementPoints}, then the handle
 * is pushed {@link ROTATE_HANDLE_OFFSET_PX} screen px further along the rotated
 * up vector `(sin θ, -cos θ)` — the un-rotated `(0, -1)` turned by the
 * element's angle — so the handle orbits the element as it rotates. The box
 * carries `data-rotate-handle` and arms the rotate gesture via
 * `onPointerDown`. No `@/` imports.
 */
export function RotateHandle({
  element,
  viewportStyles,
  canvasScale,
  onPointerDown,
}: RotateHandleProps) {
  const rotate = element.rotate || 0;
  const rotateRadian = (Math.PI * rotate) / 180;

  const topPoint = getRotateElementPoints(
    { left: element.left, top: element.top, width: element.width, height: element.height },
    rotate,
  ).top;

  const left =
    viewportStyles.left +
    topPoint.left * canvasScale +
    ROTATE_HANDLE_OFFSET_PX * Math.sin(rotateRadian);
  const top =
    viewportStyles.top +
    topPoint.top * canvasScale -
    ROTATE_HANDLE_OFFSET_PX * Math.cos(rotateRadian);

  return (
    <div
      data-rotate-handle=""
      onPointerDown={onPointerDown}
      style={{
        position: 'absolute',
        left: `${left}px`,
        top: `${top}px`,
        width: '10px',
        height: '10px',
        transform: `translate(-${HANDLE_HALF}px, -${HANDLE_HALF}px)`,
        border: '1px solid #3b82f6',
        backgroundColor: '#fff',
        boxSizing: 'border-box',
        pointerEvents: 'auto',
        cursor: 'grab',
        touchAction: 'none',
      }}
    />
  );
}
