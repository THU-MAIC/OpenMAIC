'use client';

import { useState, type PointerEvent as ReactPointerEvent } from 'react';
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

  const onElementPointerDown = (el: PPTElement, e: ReactPointerEvent) => {
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
      const { props, guides } = compute(ev.clientX, ev.clientY);
      const live: Slide = {
        ...slide,
        elements: slide.elements.map((o) =>
          o.id === el.id ? ({ ...o, ...props } as PPTElement) : o,
        ),
      };
      setWorking({ id: el.id, live, guides });
    };

    const handleUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);

      const movedPast =
        Math.abs(ev.clientX - startX) > DRAG_THRESHOLD_PX ||
        Math.abs(ev.clientY - startY) > DRAG_THRESHOLD_PX;

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
  };

  return {
    workingSlide: working?.live ?? slide,
    guides: working?.guides ?? [],
    onElementPointerDown,
  };
}
