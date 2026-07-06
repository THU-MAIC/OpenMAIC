'use client';

import { useState, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { PPTElement, Slide } from '@openmaic/dsl';

import { computeDragMove } from './core/drag';
import { moveIntent } from './core/intent';
import type { Guide } from './core/snapping';
import type { EditIntent, Selection, SnappingOptions } from './types';

/**
 * Distance (in screen pixels) the pointer must travel between pointer-down and
 * pointer-up before a gesture counts as a drag rather than a click. Below this,
 * the gesture is treated as a selection click and emits no `element.update`.
 */
const DRAG_THRESHOLD_PX = 2;

export interface UseEditGestureArgs {
  slide: Slide;
  scale: number;
  selection: Selection;
  snapping?: boolean | SnappingOptions;
  onSelectionChange?: (next: Selection) => void;
  onElementsChange?: (intents: EditIntent[]) => void;
}

export interface UseEditGestureResult {
  /** The slide to render: the in-gesture working copy while dragging, else `slide`. */
  workingSlide: Slide;
  /** Alignment guides for the active drag (computed; drawn by a later PR). */
  guides: Guide[];
  /** Arm a move/click gesture for `el` from a pointer-down on its hit target. */
  onElementPointerDown: (el: PPTElement, e: ReactPointerEvent) => void;
}

interface Working {
  id: string;
  /** Live slide with the dragged element's `left`/`top` updated for 60fps feedback. */
  live: Slide;
  guides: Guide[];
}

/**
 * Owns one drag/click gesture for a single element. Pointer-down arms the
 * gesture and records the pointer start + the base slide/element; window
 * pointer-move (converted screen→canvas via `scale`) runs `computeDragMove`
 * against the *other* elements and republishes a working copy for live
 * feedback; pointer-up commits exactly one `element.update` intent when the
 * pointer moved past `DRAG_THRESHOLD_PX`, otherwise reports a selection click.
 * Emits one intent per completed gesture — never per frame — and clears the
 * working copy so the host's controlled `slide` takes over again.
 *
 * `onElementPointerDown` closes over the current render's props, so each gesture
 * captures a consistent snapshot of the controlled slide at pointer-down.
 *
 * Pure gesture glue: no store, no `@/` imports.
 */
export function useEditGesture(args: UseEditGestureArgs): UseEditGestureResult {
  const { slide, scale, snapping, onSelectionChange, onElementsChange } = args;

  const [working, setWorking] = useState<Working | null>(null);

  // Teardown for the currently-armed gesture's window listeners. Single-pointer:
  // each pointer-down re-arms and overwrites this with its own teardown, and
  // pointer-up clears it. Held here (not in the closure) so the unmount effect
  // can remove any listeners still live when the component unmounts mid-drag —
  // otherwise a later pointer-move/up would `setWorking` on an unmounted host.
  const teardownRef = useRef<(() => void) | null>(null);

  // The pointerId owning the in-flight gesture. Single-pointer by design: while
  // one gesture is active, further pointer-downs are ignored and window
  // move/up events from any *other* pointerId are dropped, so a second finger
  // can't overwrite the teardown ref or drag the first element.
  const activePointerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      teardownRef.current?.();
      teardownRef.current = null;
      activePointerRef.current = null;
    },
    [],
  );

  const onElementPointerDown = (el: PPTElement, e: ReactPointerEvent) => {
    // Ignore additional pointer-downs while a gesture is already in flight.
    if (activePointerRef.current !== null) return;
    activePointerRef.current = e.pointerId;

    const startX = e.clientX;
    const startY = e.clientY;
    const others = slide.elements.filter((o) => o.id !== el.id);
    const viewport = {
      width: slide.viewportSize,
      height: slide.viewportSize * slide.viewportRatio,
    };
    const effectiveScale = scale || 1;

    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // jsdom / unsupported: pointer capture is a best-effort nicety.
    }

    const compute = (clientX: number, clientY: number) =>
      computeDragMove({
        element: el,
        others,
        viewport,
        deltaCanvas: {
          x: (clientX - startX) / effectiveScale,
          y: (clientY - startY) / effectiveScale,
        },
        snapping,
      });

    const handleMove = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerRef.current) return;
      const { props, guides } = compute(ev.clientX, ev.clientY);
      const live: Slide = {
        ...slide,
        elements: slide.elements.map((o) =>
          o.id === el.id ? ({ ...o, ...props } as PPTElement) : o,
        ),
      };
      setWorking({ id: el.id, live, guides });
    };

    const removeListeners = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };

    const handleUp = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerRef.current) return;
      removeListeners();
      teardownRef.current = null;
      activePointerRef.current = null;

      // Combined (Euclidean) distance: a diagonal move past the threshold on
      // both axes must classify as a drag even if neither axis alone exceeds it.
      const movedPast = Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_THRESHOLD_PX;

      if (movedPast) {
        const { props } = compute(ev.clientX, ev.clientY);
        onElementsChange?.([moveIntent(el.id, props)]);
      } else {
        onSelectionChange?.({ elementIds: [el.id], primaryId: el.id });
      }

      setWorking(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    teardownRef.current = removeListeners;
  };

  return {
    workingSlide: working?.live ?? slide,
    guides: working?.guides ?? [],
    onElementPointerDown,
  };
}
