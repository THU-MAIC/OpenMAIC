'use client';

import { useState, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { Slide } from '@openmaic/dsl';

import {
  computeResize,
  type PPTBoxElement,
  type ResizeHandle,
  type ResizeResult,
} from './core/resize';
import { resizeIntent } from './core/intent';
import type { Guide } from './core/snapping';
import type { EditIntent, SnappingOptions } from './types';

/**
 * Distance (screen px) a handle must travel between pointer-down and pointer-up
 * before the gesture commits a resize. Below this a handle click is inert (no
 * `element.update`), mirroring the box drag/click threshold in useEditGesture.
 */
const DRAG_THRESHOLD_PX = 2;

export interface UseResizeGestureArgs {
  /** The controlled slide — supplies snap candidates and the canvas bounds. */
  slide: Slide;
  /** Canvas → screen scale; the inverse converts the pointer delta to canvas units. */
  scale: number;
  snapping?: boolean | SnappingOptions;
  onElementsChange?: (intents: EditIntent[]) => void;
}

/** The in-flight resize drag: which element, the working box, and its guides. */
export interface ResizeDrag {
  id: string;
  props: ResizeResult['props'];
  /** Alignment guides for the active resize (computed; drawn by a later PR). */
  guides: Guide[];
}

export interface UseResizeGestureResult {
  /** The active resize drag's working box (for live preview), else `null`. */
  resizeDrag: ResizeDrag | null;
  /** Arm a resize gesture from a pointer-down on `element`'s `handle`. */
  onResizeHandlePointerDown: (
    element: PPTBoxElement,
    handle: ResizeHandle,
    e: ReactPointerEvent,
  ) => void;
}

/**
 * Owns one 8-point resize gesture, mirroring {@link useEditGesture} but for a
 * dragged resize handle. Pointer-down records the pointer start + the ORIGINAL
 * element + the handle; window pointer-move converts the screen delta to canvas
 * units (`/scale`), reads the aspect-lock modifier (Ctrl/Shift/Meta) off the
 * MOVE event (so holding/releasing it mid-drag re-locks live, app parity), runs
 * the store-free {@link computeResize} against the sibling elements, and
 * republishes the resulting box as a working copy for 60fps preview; pointer-up
 * commits exactly one `element.update` intent when the pointer moved past
 * {@link DRAG_THRESHOLD_PX} and a mutation channel exists, then clears the
 * working copy. `pointercancel` reverts without emitting.
 *
 * Single-pointer by design: a second pointer-down while a gesture is in flight
 * is ignored, and window move/up from any other pointerId is dropped. Pure
 * gesture glue: no store, no `@/` imports.
 */
export function useResizeGesture(args: UseResizeGestureArgs): UseResizeGestureResult {
  const { slide, scale, snapping, onElementsChange } = args;

  const [resizeDrag, setResizeDrag] = useState<ResizeDrag | null>(null);

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

  const onResizeHandlePointerDown = (
    element: PPTBoxElement,
    handle: ResizeHandle,
    e: ReactPointerEvent,
  ) => {
    // Defense-in-depth: never arm on a locked element (the primary guard skips
    // rendering handles for a locked element in EditableSlideCanvas).
    if (element.lock) return;
    if (activePointerRef.current !== null) return;
    activePointerRef.current = e.pointerId;

    // A handle drag resizes the element — it must never fall through to the
    // box hit layer beneath (which would start a move or change selection).
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const effectiveScale = scale || 1;

    const others = slide.elements.filter((o) => o.id !== element.id);
    const viewport = {
      width: slide.viewportSize,
      height: slide.viewportSize * slide.viewportRatio,
    };

    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // jsdom / unsupported: pointer capture is a best-effort nicety.
    }

    const compute = (clientX: number, clientY: number, aspectModifier: boolean) =>
      computeResize({
        element,
        handle,
        others,
        viewport,
        deltaCanvas: {
          x: (clientX - startX) / effectiveScale,
          y: (clientY - startY) / effectiveScale,
        },
        aspectModifier,
        snapping,
      });

    // The aspect-lock modifier is re-read from EVERY pointer event, so the
    // lock engages/disengages live as the user presses/releases the key
    // mid-drag (deltas always re-apply to the ORIGINAL element, so toggling
    // never accumulates error).
    const modifierOf = (ev: PointerEvent) => ev.ctrlKey || ev.shiftKey || ev.metaKey;

    const handleMove = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerRef.current) return;
      // No mutation channel: a live preview would just follow the pointer and
      // snap back on pointer-up. Skip live movement when nothing can commit.
      if (!onElementsChange) return;
      const { props, guides } = compute(ev.clientX, ev.clientY, modifierOf(ev));
      setResizeDrag({ id: element.id, props, guides });
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
        const { props } = compute(ev.clientX, ev.clientY, modifierOf(ev));
        // Snapping can pull the box back to exactly its original geometry; a
        // no-op update would still cost the host an undo entry, so skip it
        // (same guard as the rotate gesture's unchanged-angle case).
        const unchanged =
          props.left === element.left &&
          props.top === element.top &&
          props.width === element.width &&
          props.height === element.height;
        if (!unchanged) onElementsChange([resizeIntent(element.id, props)]);
      }

      setResizeDrag(null);
    };

    const handleCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerRef.current) return;
      removeListeners();
      teardownRef.current = null;
      activePointerRef.current = null;
      setResizeDrag(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    teardownRef.current = removeListeners;
  };

  return { resizeDrag, onResizeHandlePointerDown };
}
