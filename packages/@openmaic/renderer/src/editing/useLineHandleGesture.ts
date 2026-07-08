'use client';

import { useState, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { PPTLineElement } from '@openmaic/dsl';

import { computeLineDrag, type LineDragResult } from './core/line-drag';
import type { EditIntent, LineHandle } from './types';

/**
 * Distance (screen px) a handle must travel between pointer-down and pointer-up
 * before the gesture commits a reshape. Below this a handle click is inert (no
 * `element.update`), mirroring the box drag/click threshold in useEditGesture.
 */
const DRAG_THRESHOLD_PX = 2;

export interface UseLineHandleGestureArgs {
  /** Canvas → screen scale; the inverse converts the pointer delta to canvas units. */
  scale: number;
  onElementsChange?: (intents: EditIntent[]) => void;
}

/** The in-flight handle drag: which line, and the working props to preview. */
export interface LineHandleDrag {
  id: string;
  props: LineDragResult['props'];
}

export interface UseLineHandleGestureResult {
  /** The active handle drag's working props (for live preview), else `null`. */
  lineDrag: LineHandleDrag | null;
  /** Arm a reshape gesture from a pointer-down on `element`'s `handle`. */
  onHandlePointerDown: (element: PPTLineElement, handle: LineHandle, e: ReactPointerEvent) => void;
}

/**
 * Owns one line-handle reshape gesture, mirroring {@link useEditGesture} but for
 * a single dragged endpoint/control point. Pointer-down records the pointer
 * start + the ORIGINAL line + the handle; window pointer-move converts the
 * screen delta to canvas units (`/scale`), runs the store-free
 * {@link computeLineDrag}, and republishes the resulting props as a working copy
 * for 60fps preview; pointer-up commits exactly one `element.update` intent when
 * the pointer moved past {@link DRAG_THRESHOLD_PX} and a mutation channel exists,
 * then clears the working copy. `pointercancel` reverts without emitting.
 *
 * Single-pointer by design: a second pointer-down while a gesture is in flight
 * is ignored, and window move/up from any other pointerId is dropped. Pure
 * gesture glue: no store, no `@/` imports.
 */
export function useLineHandleGesture(args: UseLineHandleGestureArgs): UseLineHandleGestureResult {
  const { scale, onElementsChange } = args;

  const [lineDrag, setLineDrag] = useState<LineHandleDrag | null>(null);

  // Teardown for the currently-armed gesture's window listeners; the unmount
  // effect removes any listeners still live so a late move/up can't setState on
  // an unmounted host.
  const teardownRef = useRef<(() => void) | null>(null);
  // The pointerId owning the in-flight gesture (single-pointer guard).
  const activePointerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      teardownRef.current?.();
      teardownRef.current = null;
      activePointerRef.current = null;
    },
    [],
  );

  const onHandlePointerDown = (
    element: PPTLineElement,
    handle: LineHandle,
    e: ReactPointerEvent,
  ) => {
    // Defense-in-depth: never arm on a locked line (the primary guard skips
    // rendering handles for a locked line in EditableSlideCanvas).
    if (element.lock) return;
    if (activePointerRef.current !== null) return;
    activePointerRef.current = e.pointerId;

    // A handle drag reshapes the line — it must never fall through to the box/
    // line hit layer beneath (which would start a move or change selection).
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const effectiveScale = scale || 1;

    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // jsdom / unsupported: pointer capture is a best-effort nicety.
    }

    const compute = (clientX: number, clientY: number) =>
      computeLineDrag({
        element,
        handle,
        deltaCanvas: {
          x: (clientX - startX) / effectiveScale,
          y: (clientY - startY) / effectiveScale,
        },
      });

    const handleMove = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerRef.current) return;
      // No mutation channel: a live preview would just follow the pointer and
      // snap back on pointer-up. Skip live movement when nothing can commit.
      if (!onElementsChange) return;
      const { props } = compute(ev.clientX, ev.clientY);
      setLineDrag({ id: element.id, props });
    };

    const removeListeners = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
    };

    const handleUp = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerRef.current) return;
      removeListeners();
      teardownRef.current = null;
      activePointerRef.current = null;

      const movedPast = Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_THRESHOLD_PX;
      if (movedPast && onElementsChange) {
        const { props } = compute(ev.clientX, ev.clientY);
        onElementsChange([{ type: 'element.update', id: element.id, props }]);
      }

      setLineDrag(null);
    };

    const handleCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerRef.current) return;
      removeListeners();
      teardownRef.current = null;
      activePointerRef.current = null;
      setLineDrag(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    teardownRef.current = removeListeners;
  };

  return { lineDrag, onHandlePointerDown };
}
