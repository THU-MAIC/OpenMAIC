'use client';

import { useState, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { PPTElement, Slide } from '@openmaic/dsl';

import { computeDragMove, computeMultiDragMove } from './core/drag';
import { moveIntent, moveManyIntent } from './core/intent';
import { isSelectionModifier, resolveClickSelection } from './core/selection';
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
 * Owns one drag/click gesture. Pointer-down resolves the selection per the
 * modifier table in {@link resolveClickSelection} (group-cohesive: a click on a
 * grouped element applies to its whole group), then — for the cases that start
 * a move — arms a drag and records the pointer start + the base slide; window
 * pointer-move (converted screen→canvas via `scale`) republishes a working copy
 * for live feedback; pointer-up commits the move as ONE intent when the pointer
 * moved past `DRAG_THRESHOLD_PX`, otherwise reports a selection click. Emits one
 * intent per completed gesture — never per frame — and clears the working copy
 * so the host's controlled `slide` takes over again.
 *
 * Locked elements in a multi-selection are never translated: they may stay in
 * the controlled selection for feedback, but the drag set excludes them and they
 * remain snap candidates. Holding Shift while the drag is in flight locks the
 * translation to the dominant axis (Shift at pointer-down is a selection
 * modifier and never arms a drag).
 *
 * A single-element move commits `element.update` (backward compat with hosts);
 * a multi-element move commits ONE `element.updateMany` = one host undo entry.
 *
 * `onElementPointerDown` closes over the current render's props, so each gesture
 * captures a consistent snapshot of the controlled slide at pointer-down.
 *
 * Pure gesture glue: no store, no `@/` imports.
 */
export function useEditGesture(args: UseEditGestureArgs): UseEditGestureResult {
  const { slide, scale, selection, snapping, onSelectionChange, onElementsChange } = args;

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
    // Defense-in-depth: never arm a gesture for a locked element, even if a
    // move hit target somehow reached it (the primary guard lives in
    // EditableSlideCanvas, which skips rendering a hit target for `el.lock`).
    if (el.lock) return;
    // Ignore additional pointer-downs while a gesture is already in flight.
    if (activePointerRef.current !== null) return;

    // Resolve selection on pointer-down per the shared modifier table
    // ({@link resolveClickSelection} — group-cohesive). `armDrag` decides
    // whether this gesture becomes a move; `dragIds` is the set the move
    // translates (the whole selection for a multi-drag).
    const { next, armDrag, dragIds } = resolveClickSelection({
      element: el,
      elements: slide.elements,
      selection,
      modifier: isSelectionModifier(e),
    });
    if (next) onSelectionChange?.(next);

    // A pure selection action (modifier add/remove): no move gesture is armed,
    // so DON'T claim the active pointer — leave the hook ready for the next one.
    if (!armDrag) return;
    activePointerRef.current = e.pointerId;

    const startX = e.clientX;
    const startY = e.clientY;
    // Base snapshots captured at pointer-down. `selectedElements` is the rigid
    // set the drag translates; `others` are the snap candidates (everything
    // NOT being dragged). Locked elements never move: even when selected they
    // are excluded from the translated set (selection keeps them for feedback)
    // and stay in `others` as snap candidates. A 1-mover drag routes through
    // `computeDragMove` for exact backward compatibility; N > 1 routes through
    // the multi core.
    const selectedSet = new Set(dragIds);
    const isMover = (o: PPTElement) => selectedSet.has(o.id) && !o.lock;
    const selectedElements = slide.elements.filter(isMover);
    const others = slide.elements.filter((o) => !isMover(o));
    const isMulti = selectedElements.length > 1;
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

    // Normalize both cores to a list of per-element `{id, props}` updates so the
    // working-copy and commit paths are identical regardless of selection size.
    // `shiftKey` is read off the LIVE pointermove/pointerup event: holding Shift
    // while the drag is in flight locks the translation to the dominant axis
    // (the axis with the larger absolute delta) — Shift at pointer-down is a
    // selection modifier and never arms a drag in the first place.
    const compute = (
      clientX: number,
      clientY: number,
      shiftKey: boolean,
    ): {
      updates: Array<{ id: string; props: { left: number; top: number } }>;
      guides: Guide[];
    } => {
      const deltaCanvas = {
        x: (clientX - startX) / effectiveScale,
        y: (clientY - startY) / effectiveScale,
      };
      const axisLock: 'x' | 'y' | undefined = shiftKey
        ? Math.abs(deltaCanvas.x) >= Math.abs(deltaCanvas.y)
          ? 'x'
          : 'y'
        : undefined;
      if (isMulti) {
        return computeMultiDragMove({
          handleElement: el,
          selected: selectedElements,
          others,
          viewport,
          deltaCanvas,
          axisLock,
          snapping,
        });
      }
      const { props, guides } = computeDragMove({
        element: el,
        others,
        viewport,
        deltaCanvas,
        axisLock,
        snapping,
      });
      return { updates: [{ id: el.id, props }], guides };
    };

    const handleMove = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerRef.current) return;
      // Select-only / read-only-ish hosts (no `onElementsChange`) can't commit a
      // move, so a live working copy would just visibly follow the pointer and
      // snap back on pointer-up. Skip live movement entirely when there's no
      // mutation channel — the gesture only ends up selecting (see handleUp).
      if (!onElementsChange) return;
      const { updates, guides } = compute(ev.clientX, ev.clientY, ev.shiftKey);
      const patch = new Map(updates.map((u) => [u.id, u.props]));
      const live: Slide = {
        ...slide,
        elements: slide.elements.map((o) => {
          const props = patch.get(o.id);
          return props ? ({ ...o, ...props } as PPTElement) : o;
        }),
      };
      setWorking({ id: el.id, live, guides });
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

      // Combined (Euclidean) distance: a diagonal move past the threshold on
      // both axes must classify as a drag even if neither axis alone exceeds it.
      const movedPast = Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_THRESHOLD_PX;

      // A move intent is only meaningful when the host can mutate. When it moved
      // past the threshold and there's a mutation channel, emit exactly one move
      // intent — `element.update` for a lone element (backward compat), a single
      // `element.updateMany` for a multi-drag (one host undo entry). Otherwise (a
      // click, or a drag on a select-only host) there is nothing extra to emit:
      // the element was already selected on pointer-down.
      if (movedPast && onElementsChange) {
        const { updates } = compute(ev.clientX, ev.clientY, ev.shiftKey);
        const intent = isMulti
          ? moveManyIntent(updates)
          : moveIntent(updates[0].id, updates[0].props);
        onElementsChange([intent]);
      }

      setWorking(null);
    };

    // Browser-initiated cancel (touch interruption, OS gesture takeover): tear
    // down and revert the working copy WITHOUT emitting any intent or selection
    // change, then leave the hook ready for a fresh gesture.
    const handleCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerRef.current) return;
      removeListeners();
      teardownRef.current = null;
      activePointerRef.current = null;
      setWorking(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    teardownRef.current = removeListeners;
  };

  return {
    workingSlide: working?.live ?? slide,
    guides: working?.guides ?? [],
    onElementPointerDown,
  };
}
