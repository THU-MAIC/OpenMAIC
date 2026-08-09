import type { PointerEvent as ReactPointerEvent } from 'react';

import type { ViewportStyles } from '../../hooks/useViewportSize';
import {
  getRotateElementPoints,
  getResizeCursor,
  type PPTBoxElement,
  type ResizeHandle,
} from '../core/resize';

export interface ResizeHandlesProps {
  /** The box element whose resize points are drawn. */
  element: PPTBoxElement;
  /** Which of the eight points to draw (per-kind gate, e.g. text gets two). */
  handles: readonly ResizeHandle[];
  /** SlideCanvas centering offset — handles share the element container's origin. */
  viewportStyles: ViewportStyles;
  /** Canvas → screen scale (`props.scale ?? fitScale`). */
  canvasScale: number;
  /** Arm a resize gesture from a pointer-down on a handle box. */
  onHandlePointerDown: (handle: ResizeHandle, e: ReactPointerEvent) => void;
}

/** Half the handle box size, so `translate(-HALF, -HALF)` centers it on its point. */
const HANDLE_HALF = 5;

/**
 * Presentational 8-point resize handles for a selected box element.
 * Props-driven only: draws a small draggable box centered on each requested
 * point, with a rotation-aware directional cursor.
 *
 * Positions are computed ANALYTICALLY in canvas space via
 * {@link getRotateElementPoints} — the exact rotated location of each frame
 * point — rather than nesting the handles inside a rotated CSS frame. That
 * keeps every handle in plain overlay screen coordinates (like `LineHandles`),
 * so hit-testing, the drag math, and the un-rotated 10px handle boxes all
 * agree: `left = viewportStyles.left + point.left * canvasScale` (same for
 * `top`), matching the element container's origin even when letterboxed.
 * Each box carries `data-resize-handle={handle}` and arms the resize gesture
 * via `onHandlePointerDown`. No `@/` imports.
 */
export function ResizeHandles({
  element,
  handles,
  viewportStyles,
  canvasScale,
  onHandlePointerDown,
}: ResizeHandlesProps) {
  const rotate = element.rotate || 0;
  const points = getRotateElementPoints(
    { left: element.left, top: element.top, width: element.width, height: element.height },
    rotate,
  );

  return (
    <>
      {handles.map((handle) => {
        const point = points[handle];
        return (
          <div
            key={handle}
            data-resize-handle={handle}
            onPointerDown={(e) => onHandlePointerDown(handle, e)}
            style={{
              position: 'absolute',
              left: `${viewportStyles.left + point.left * canvasScale}px`,
              top: `${viewportStyles.top + point.top * canvasScale}px`,
              width: '10px',
              height: '10px',
              transform: `translate(-${HANDLE_HALF}px, -${HANDLE_HALF}px)`,
              border: '1px solid #3b82f6',
              backgroundColor: '#fff',
              boxSizing: 'border-box',
              pointerEvents: 'auto',
              cursor: getResizeCursor(handle, rotate),
              touchAction: 'none',
            }}
          />
        );
      })}
    </>
  );
}
