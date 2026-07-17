import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PPTLineElement } from '@openmaic/dsl';

import type { ViewportStyles } from '../../hooks/useViewportSize';
import type { LineHandle } from '../types';

export interface LineHandlesProps {
  /** The line whose endpoint/control handles are drawn. */
  element: PPTLineElement;
  /** SlideCanvas centering offset — handles share the element container's origin. */
  viewportStyles: ViewportStyles;
  /** Canvas → screen scale (`props.scale ?? fitScale`). */
  canvasScale: number;
  /** Arm a handle-reshape gesture from a pointer-down on a handle box. */
  onHandlePointerDown: (handle: LineHandle, e: ReactPointerEvent) => void;
}

/** Half the handle box size, so `translate(-HALF, -HALF)` centers it on its point. */
const HANDLE_HALF = 5;

/**
 * Presentational endpoint/control handles for a selected line. Props-driven
 * only: resolves the line's `start`/`end` (always) plus the single quadratic
 * control point (`ctrl` ← `broken`/`broken2`/`curve`) or the two cubic control
 * points (`ctrl1`/`ctrl2` ← `cubic`) when present, and draws a small draggable
 * box centered on each in screen space.
 *
 * Screen position mirrors the v1 line hit layer / element container:
 * `left = viewportStyles.left + (el.left + point[0]) * canvasScale` (same for
 * `top`), so a handle sits exactly on the rendered endpoint even when the
 * container is letterboxed. Each box carries `data-line-handle={handle}` and
 * arms the reshape gesture via `onHandlePointerDown`. No `@/` imports.
 */
export function LineHandles({
  element,
  viewportStyles,
  canvasScale,
  onHandlePointerDown,
}: LineHandlesProps) {
  const points: Array<{ handle: LineHandle; point: [number, number] }> = [
    { handle: 'start', point: element.start },
    { handle: 'end', point: element.end },
  ];

  // Field precedence MUST match `computeLineDrag` (core/line-drag.ts), which
  // resolves the single control point as `broken || broken2 || curve`, so the
  // rendered handle sits exactly where the drag math reads/writes it.
  const ctrl = element.broken || element.broken2 || element.curve;
  if (ctrl) {
    points.push({ handle: 'ctrl', point: ctrl });
  } else if (element.cubic) {
    points.push({ handle: 'ctrl1', point: element.cubic[0] });
    points.push({ handle: 'ctrl2', point: element.cubic[1] });
  }

  return (
    <>
      {points.map(({ handle, point }) => (
        <div
          key={handle}
          data-line-handle={handle}
          onPointerDown={(e) => onHandlePointerDown(handle, e)}
          style={{
            position: 'absolute',
            left: `${viewportStyles.left + (element.left + point[0]) * canvasScale}px`,
            top: `${viewportStyles.top + (element.top + point[1]) * canvasScale}px`,
            width: '10px',
            height: '10px',
            transform: `translate(-${HANDLE_HALF}px, -${HANDLE_HALF}px)`,
            border: '1px solid #3b82f6',
            backgroundColor: '#fff',
            boxSizing: 'border-box',
            pointerEvents: 'auto',
            cursor: 'pointer',
            touchAction: 'none',
          }}
        />
      ))}
    </>
  );
}
