import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PPTShapeElement } from '@openmaic/dsl';

import type { ViewportStyles } from '@openmaic/renderer';
import type { ShapeKeypointRelative, ShapePathFormulaMap } from '../shape/types';

interface Point {
  left: number;
  top: number;
}

export interface ShapeKeypointHandlesProps {
  element: PPTShapeElement;
  shapePathFormulas?: ShapePathFormulaMap;
  viewportStyles: ViewportStyles;
  canvasScale: number;
  onPointerDown: (index: number, event: ReactPointerEvent) => void;
}

function pointForRelative(
  relative: ShapeKeypointRelative,
  position: number,
  element: PPTShapeElement,
): Point {
  switch (relative) {
    case 'left':
      return { left: position, top: 0 };
    case 'right':
      return { left: element.width - position, top: 0 };
    case 'center':
      return { left: (element.width - position) / 2, top: 0 };
    case 'top':
      return { left: 0, top: position };
    case 'bottom':
      return { left: 0, top: element.height - position };
    case 'left_bottom':
      return { left: position, top: element.height };
    case 'right_bottom':
      return { left: element.width - position, top: element.height };
    case 'top_right':
      return { left: element.width, top: position };
    case 'bottom_right':
      return { left: element.width, top: element.height - position };
  }
}

/** Presentational adjustment handles for a selected formula Shape. */
export function ShapeKeypointHandles({
  element,
  shapePathFormulas,
  viewportStyles,
  canvasScale,
  onPointerDown,
}: ShapeKeypointHandlesProps) {
  if (element.lock || !element.pathFormula || !element.keypoints) return null;
  const formula = shapePathFormulas?.[element.pathFormula];
  if (!formula?.editable || !formula.getBaseSize || !formula.relative) return null;

  const width = element.width * canvasScale;
  const height = element.height * canvasScale;
  const handles = element.keypoints.flatMap((keypoint, index) => {
    const baseSize = formula.getBaseSize?.[index]?.(element.width, element.height);
    const relative = formula.relative?.[index] as ShapeKeypointRelative | undefined;
    if (!baseSize || !relative) return [];
    return [{ index, point: pointForRelative(relative, baseSize * keypoint, element) }];
  });

  return (
    <div
      style={{
        position: 'absolute',
        left: `${viewportStyles.left + element.left * canvasScale}px`,
        top: `${viewportStyles.top + element.top * canvasScale}px`,
        width: `${width}px`,
        height: `${height}px`,
        transform: `rotate(${element.rotate}deg)`,
        transformOrigin: 'center',
        pointerEvents: 'none',
      }}
    >
      {handles.map(({ index, point }) => (
        <div
          key={index}
          data-shape-keypoint={`${element.id}:${index}`}
          onPointerDown={(event) => onPointerDown(index, event)}
          style={{
            position: 'absolute',
            left: `${point.left * canvasScale}px`,
            top: `${point.top * canvasScale}px`,
            width: '10px',
            height: '10px',
            transform: 'translate(-5px, -5px)',
            border: '1px solid #3b82f6',
            backgroundColor: '#ffe873',
            boxSizing: 'border-box',
            cursor: 'move',
            pointerEvents: 'auto',
            touchAction: 'none',
          }}
        />
      ))}
    </div>
  );
}
