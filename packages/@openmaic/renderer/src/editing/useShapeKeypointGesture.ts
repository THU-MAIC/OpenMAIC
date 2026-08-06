'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PPTShapeElement } from '@openmaic/dsl';

import type { EditIntent } from './types';
import type { ShapeKeypointRelative, ShapePathFormulaMap } from './shape/types';

const DRAG_THRESHOLD_PX = 2;

export interface ShapeKeypointDrag {
  id: string;
  props: { keypoints: number[]; path: string };
}

export interface UseShapeKeypointGestureArgs {
  scale: number;
  shapePathFormulas?: ShapePathFormulaMap;
  onElementsChange?: (intents: EditIntent[]) => void;
}

function deltaForRelative(relative: ShapeKeypointRelative, moveX: number, moveY: number): number {
  switch (relative) {
    case 'center':
      return -moveX * 2;
    case 'left':
    case 'left_bottom':
    case 'top':
    case 'top_right':
      return relative === 'top' || relative === 'top_right' ? moveY : moveX;
    case 'right':
    case 'right_bottom':
    case 'bottom':
    case 'bottom_right':
      return relative === 'bottom' || relative === 'bottom_right' ? -moveY : -moveX;
  }
}

/**
 * Owns a single formula Shape adjustment point. It mirrors the legacy canvas:
 * update a local preview during pointer-move, clamp to the formula range, and
 * emit one document update only after a completed drag.
 */
export function useShapeKeypointGesture({
  scale,
  shapePathFormulas,
  onElementsChange,
}: UseShapeKeypointGestureArgs) {
  const [shapeKeypointDrag, setShapeKeypointDrag] = useState<ShapeKeypointDrag | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const pointerIdRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      pointerIdRef.current = null;
    },
    [],
  );

  const onShapeKeypointPointerDown = (
    element: PPTShapeElement,
    index: number,
    event: ReactPointerEvent,
  ) => {
    if (element.lock || pointerIdRef.current !== null || !element.pathFormula) return;
    const formula = shapePathFormulas?.[element.pathFormula];
    const originKeypoints = element.keypoints;
    const baseSize = formula?.getBaseSize?.[index]?.(element.width, element.height);
    const range = formula?.range?.[index];
    const relative = formula?.relative?.[index] as ShapeKeypointRelative | undefined;
    const originKeypoint = originKeypoints?.[index];
    if (
      !formula?.editable ||
      !originKeypoints ||
      originKeypoint === undefined ||
      !baseSize ||
      !range ||
      !relative
    ) {
      return;
    }

    event.stopPropagation();
    pointerIdRef.current = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const effectiveScale = scale || 1;

    try {
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is best effort in jsdom and older browsers.
    }

    const calculate = (clientX: number, clientY: number): ShapeKeypointDrag => {
      const moveX = (clientX - startX) / effectiveScale;
      const moveY = (clientY - startY) / effectiveScale;
      const [min, max] = range;
      const nextValue = Math.min(
        max,
        Math.max(
          min,
          (originKeypoint * baseSize + deltaForRelative(relative, moveX, moveY)) / baseSize,
        ),
      );
      const keypoints = [...originKeypoints];
      keypoints[index] = nextValue;
      return {
        id: element.id,
        props: {
          keypoints,
          path: formula.formula(element.width, element.height, keypoints),
        },
      };
    };

    const removeListeners = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
    };

    const handleMove = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== pointerIdRef.current) return;
      setShapeKeypointDrag(calculate(nextEvent.clientX, nextEvent.clientY));
    };

    const finish = () => {
      removeListeners();
      cleanupRef.current = null;
      pointerIdRef.current = null;
      setShapeKeypointDrag(null);
    };

    const handleUp = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== pointerIdRef.current) return;
      const moved = Math.hypot(nextEvent.clientX - startX, nextEvent.clientY - startY);
      if (moved > DRAG_THRESHOLD_PX && onElementsChange) {
        const { props } = calculate(nextEvent.clientX, nextEvent.clientY);
        if (props.keypoints[index] !== originKeypoint) {
          onElementsChange([{ type: 'element.update', id: element.id, props }]);
        }
      }
      finish();
    };

    const handleCancel = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== pointerIdRef.current) return;
      finish();
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    cleanupRef.current = removeListeners;
  };

  return { shapeKeypointDrag, onShapeKeypointPointerDown };
}
