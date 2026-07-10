'use client';

import {
  useState,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

import { computeRotate } from './core/rotate';
import { rotateIntent } from './core/intent';
import type { PPTBoxElement } from './core/resize';
import type { ViewportStyles } from '../hooks/useViewportSize';
import type { EditIntent } from './types';

/**
 * Distance (screen px) the pointer must travel between pointer-down and
 * pointer-up before the gesture commits a rotation. Below this a handle click
 * is inert (no `element.update`), mirroring the other gesture hooks.
 */
const DRAG_THRESHOLD_PX = 2;

export interface UseRotateGestureArgs {
  /**
   * The interaction overlay element. Its bounding rect (captured once per
   * gesture, at pointer-down) plus `viewportStyles.left/top` locate the canvas
   * origin on screen, which is what converts absolute pointer positions to
   * canvas coordinates — rotation is computed from the ABSOLUTE pointer
   * position relative to the element center, not from a pointer delta.
   */
  overlayRef: RefObject<HTMLElement | null>;
  /** SlideCanvas centering offset (screen px) inside the overlay. */
  viewportStyles: ViewportStyles;
  /** Canvas → screen scale; the inverse converts pointer positions to canvas units. */
  scale: number;
  onElementsChange?: (intents: EditIntent[]) => void;
}

/** The in-flight rotate drag: which element and the working angle to preview. */
export interface RotateDrag {
  id: string;
  rotate: number;
}

export interface UseRotateGestureResult {
  /** The active rotate drag's working angle (for live preview), else `null`. */
  rotateDrag: RotateDrag | null;
  /** Arm a rotate gesture from a pointer-down on `element`'s rotate handle. */
  onRotateHandlePointerDown: (element: PPTBoxElement, e: ReactPointerEvent) => void;
}

/**
 * Owns one rotate-handle gesture, mirroring {@link useEditGesture} but for the
 * rotate handle above a box's top edge. Pointer-down records the ORIGINAL
 * element (whose center is the rotation pivot for the whole gesture) and the
 * canvas origin's screen position; window pointer-move converts the pointer's
 * absolute position to canvas coordinates, runs the store-free
 * {@link computeRotate} (signed angle, 45° snap), and republishes the angle as
 * a working copy for 60fps preview; pointer-up commits exactly one
 * `element.update` intent when the pointer moved past {@link DRAG_THRESHOLD_PX},
 * a mutation channel exists, and the angle actually changed, then clears the
 * working copy. `pointercancel` reverts without emitting.
 *
 * Single-pointer by design: a second pointer-down while a gesture is in flight
 * is ignored, and window move/up from any other pointerId is dropped. Pure
 * gesture glue: no store, no `@/` imports.
 */
export function useRotateGesture(args: UseRotateGestureArgs): UseRotateGestureResult {
  const { overlayRef, viewportStyles, scale, onElementsChange } = args;

  const [rotateDrag, setRotateDrag] = useState<RotateDrag | null>(null);

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

  const onRotateHandlePointerDown = (element: PPTBoxElement, e: ReactPointerEvent) => {
    // Defense-in-depth: never arm on a locked element (the primary guard skips
    // rendering handles for a locked element in EditableSlideCanvas).
    if (element.lock) return;
    if (activePointerRef.current !== null) return;
    // Rotation needs the canvas origin; without a mounted overlay the pointer
    // position cannot be mapped to canvas coordinates, so don't arm at all.
    const overlay = overlayRef.current;
    if (!overlay) return;
    activePointerRef.current = e.pointerId;

    // A handle drag rotates the element — it must never fall through to the
    // box hit layer beneath (which would start a move or change selection).
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const effectiveScale = scale || 1;

    // Canvas origin in client coordinates, captured once per gesture (the
    // canvas doesn't scroll/zoom mid-gesture; app parity).
    const overlayRect = overlay.getBoundingClientRect();
    const originX = overlayRect.left + viewportStyles.left;
    const originY = overlayRect.top + viewportStyles.top;

    const originRotate = element.rotate || 0;

    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // jsdom / unsupported: pointer capture is a best-effort nicety.
    }

    const compute = (clientX: number, clientY: number) =>
      computeRotate({
        element,
        pointerCanvas: {
          x: (clientX - originX) / effectiveScale,
          y: (clientY - originY) / effectiveScale,
        },
      });

    const handleMove = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerRef.current) return;
      // No mutation channel: a live preview would just follow the pointer and
      // snap back on pointer-up. Skip live movement when nothing can commit.
      if (!onElementsChange) return;
      setRotateDrag({ id: element.id, rotate: compute(ev.clientX, ev.clientY) });
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
        const rotate = compute(ev.clientX, ev.clientY);
        // Snapping can land the pointer back on the original angle; a no-op
        // update would still cost the host an undo entry, so skip it.
        if (rotate !== originRotate) {
          onElementsChange([rotateIntent(element.id, rotate)]);
        }
      }

      setRotateDrag(null);
    };

    const handleCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerRef.current) return;
      removeListeners();
      teardownRef.current = null;
      activePointerRef.current = null;
      setRotateDrag(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    teardownRef.current = removeListeners;
  };

  return { rotateDrag, onRotateHandlePointerDown };
}
