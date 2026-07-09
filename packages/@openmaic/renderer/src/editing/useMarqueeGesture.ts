'use client';

import {
  useState,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { Slide } from '@openmaic/dsl';

import { computeMarqueeSelection, marqueeRect, type MarqueeRect } from './core/marquee';
import type { ViewportStyles } from '../hooks/useViewportSize';
import { EMPTY_SELECTION, type Selection } from './types';

/**
 * Minimum size (canvas units) the marquee must reach on BOTH axes before it
 * counts as a drag-select rather than a blank click. Below this the gesture is a
 * blank click that clears the selection; at/above it the box replaces the
 * selection with whatever it covers. App parity (`minSelectionRange = 5`).
 */
const MARQUEE_THRESHOLD_CANVAS = 5;

export interface UseMarqueeGestureArgs {
  slide: Slide;
  scale: number;
  /**
   * The interaction overlay element. Its bounding rect (captured once per
   * gesture, at pointer-down) plus `viewportStyles.left/top` locate the canvas
   * origin on screen, which converts absolute pointer positions to canvas
   * coordinates — the marquee rectangle lives in canvas units.
   */
  overlayRef: RefObject<HTMLElement | null>;
  /** SlideCanvas centering offset (screen px) inside the overlay. */
  viewportStyles: ViewportStyles;
  selection: Selection;
  onSelectionChange?: (next: Selection) => void;
}

export interface UseMarqueeGestureResult {
  /** The live marquee rectangle (canvas units) while past-threshold, else `null`. */
  marqueeRect: MarqueeRect | null;
  /** Arm a marquee gesture from a pointer-down on the blank-canvas capture surface. */
  onCanvasPointerDown: (e: ReactPointerEvent) => void;
}

/**
 * Owns one blank-canvas marquee (rubber-band) gesture, mirroring the other
 * gesture hooks. Pointer-down on the capture surface records the canvas origin
 * and the start point; window pointer-move converts the pointer to canvas
 * coordinates and, once the box passes {@link MARQUEE_THRESHOLD_CANVAS} on BOTH
 * axes, republishes a normalized rectangle for a live preview; pointer-up
 * computes the selection ({@link computeMarqueeSelection}) and REPLACES the
 * controlled selection via `onSelectionChange`. A sub-threshold gesture is a
 * blank click: it clears the selection (a no-op when already empty). The mode is
 * chosen from the modifier held at release — plain drag = `contain`, Ctrl/Shift/
 * Meta = `intersect`.
 *
 * Single-pointer by design (one active pointer at a time; window move/up from
 * any other pointerId are dropped) and `pointercancel`-safe (revert, no emit).
 * Pure gesture glue: no store, no `@/` imports.
 */
export function useMarqueeGesture(args: UseMarqueeGestureArgs): UseMarqueeGestureResult {
  const { slide, scale, overlayRef, viewportStyles, selection, onSelectionChange } = args;

  const [liveRect, setLiveRect] = useState<MarqueeRect | null>(null);

  // Teardown for the currently-armed gesture's window listeners; the unmount
  // effect removes any listeners still live so a late move/up can't setState on
  // an unmounted host.
  const teardownRef = useRef<(() => void) | null>(null);
  // The pointerId owning the in-flight gesture (single-pointer guard).
  const activePointerRef = useRef<number | null>(null);

  // The LIVE controlled selection, refreshed on every committed render. The
  // window handlers below are created at pointer-down and would otherwise
  // close over the selection as of that render; the host may update it
  // mid-gesture, and the empty-skip/clear decisions on release must use the
  // current value.
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(
    () => () => {
      teardownRef.current?.();
      teardownRef.current = null;
      activePointerRef.current = null;
    },
    [],
  );

  const onCanvasPointerDown = (e: ReactPointerEvent) => {
    // Only the main button arms a marquee: a secondary/middle-button press on
    // blank canvas must neither rubber-band nor clear the selection.
    if (e.button !== 0) return;
    // A marquee only exists as a selection action; with no selection channel
    // there is nothing to publish, so don't arm at all.
    if (!onSelectionChange) return;
    if (activePointerRef.current !== null) return;
    // The marquee rectangle is in canvas units; without a mounted overlay the
    // pointer position cannot be mapped to canvas coordinates, so don't arm.
    const overlay = overlayRef.current;
    if (!overlay) return;
    activePointerRef.current = e.pointerId;

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const effectiveScale = scale || 1;

    // Canvas origin in client coordinates, captured once per gesture (the
    // canvas doesn't scroll/zoom mid-gesture; app parity).
    const overlayRectBox = overlay.getBoundingClientRect();
    const originX = overlayRectBox.left + viewportStyles.left;
    const originY = overlayRectBox.top + viewportStyles.top;

    const toCanvas = (clientX: number, clientY: number) => ({
      x: (clientX - originX) / effectiveScale,
      y: (clientY - originY) / effectiveScale,
    });
    const start = toCanvas(startClientX, startClientY);

    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // jsdom / unsupported: pointer capture is a best-effort nicety.
    }

    // Whether the marquee has passed the both-axes threshold this gesture. Only
    // a past-threshold box is drawn and only a past-threshold release replaces
    // the selection; a sub-threshold release is a blank click (clear).
    const rectPastThreshold = (rect: MarqueeRect): boolean =>
      rect.maxX - rect.minX >= MARQUEE_THRESHOLD_CANVAS &&
      rect.maxY - rect.minY >= MARQUEE_THRESHOLD_CANVAS;

    const handleMove = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerRef.current) return;
      const rect = marqueeRect(start, toCanvas(ev.clientX, ev.clientY));
      // Only show the box once it is a real drag-select on both axes; below the
      // threshold keep it hidden (matches the app, which never paints a tiny box).
      setLiveRect(rectPastThreshold(rect) ? rect : null);
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
      setLiveRect(null);

      const rect = marqueeRect(start, toCanvas(ev.clientX, ev.clientY));

      // Sub-threshold: a blank click. Clear the selection, but skip the emit
      // when it is already empty (idempotent — no redundant selection change).
      // Read through `selectionRef` (not the pointer-down closure) so a
      // selection the host updated mid-gesture is judged by its live value.
      if (!rectPastThreshold(rect)) {
        if (selectionRef.current.elementIds.length > 0) onSelectionChange(EMPTY_SELECTION);
        return;
      }

      // Modifier at release picks the containment rule: plain = full containment,
      // Ctrl/Shift/Meta = intersection. Meta is included for mac parity with the
      // resize aspect modifier — a deliberate superset of the app's Ctrl/Shift.
      const mode = ev.ctrlKey || ev.shiftKey || ev.metaKey ? 'intersect' : 'contain';
      const ids = computeMarqueeSelection(rect, slide.elements, { mode });

      // The marquee REPLACES the selection. An empty result clears it (skip the
      // emit only when it was already empty). The top-most matched element (last
      // in z-order) becomes the primary/handle for a subsequent multi-drag.
      if (ids.length === 0) {
        if (selectionRef.current.elementIds.length > 0) onSelectionChange(EMPTY_SELECTION);
        return;
      }
      onSelectionChange({ elementIds: ids, primaryId: ids[ids.length - 1] });
    };

    // Browser-initiated cancel: tear down and drop the live box WITHOUT emitting
    // any selection change, then leave the hook ready for a fresh gesture.
    const handleCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerRef.current) return;
      removeListeners();
      teardownRef.current = null;
      activePointerRef.current = null;
      setLiveRect(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    teardownRef.current = removeListeners;
  };

  return { marqueeRect: liveRect, onCanvasPointerDown };
}
