'use client';

import { useEffect, useState } from 'react';
import { useCanvasStore } from '@/lib/store/canvas';

export interface TrackedRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function sameRect(a: TrackedRect | null, b: TrackedRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

// A degenerate element — a horizontal/vertical LineElement whose content box
// collapses to 0 in one axis — would otherwise yield a 0-thickness anchor that
// Radix can't position against reliably. Clamp each axis to a usable minimum.
const MIN_ANCHOR_PX = 1;

// Frames the rect must hold steady (no pointer press) before the rAF loop
// parks itself. Re-armed by ResizeObserver / scroll / resize / pointer press.
const STABLE_FRAMES_BEFORE_IDLE = 20;

/**
 * Tracks the on-screen rect of a rendered slide element.
 *
 * `#editable-element-{id}` is only a zero-size `absolute` wrapper (it carries
 * just a z-index); the geometry lives on its inner `.editable-element-{type}`
 * content root (text, image, shape, …), which has the real left/top/width/
 * height and inherits the viewport scale. So we resolve the wrapper by id, then
 * measure that child — measuring the wrapper itself would collapse to a 0x0
 * rect at the canvas origin.
 *
 * Measurement is via getBoundingClientRect (one call already resolves canvas
 * scale, viewport offset and page scroll). A requestAnimationFrame loop drives
 * it, but it parks itself once the rect holds steady, so an idle selection
 * doesn't spin at 60fps. It re-arms on the events that move the element's
 * screen rect:
 *  - a pointer press (drag-move / resize-handle — the loop stays live for the
 *    whole press and follows frame-by-frame),
 *  - a ResizeObserver callback (the element's own box resized),
 *  - window scroll / resize,
 *  - and canvas-zoom transforms (`canvasScale` / `zoomTarget` in the canvas
 *    store). The zoom is a CSS `transform: scale(...)` on an ancestor, which a
 *    ResizeObserver on the element node does NOT observe — so without this the
 *    bar would detach after the loop parks. `zoomTarget` is an animated 700ms
 *    transform, so the loop is kept alive (like a pointer press) while it is
 *    set, not merely re-armed once.
 * The loop starts after mount, so on first selection the bar appears one frame
 * late — imperceptible. Returns null while `elementId` is "" or unmounted.
 */
export function useTrackedRect(elementId: string): TrackedRect | null {
  const [rect, setRect] = useState<TrackedRect | null>(null);

  useEffect(() => {
    // No element to track: leave the last rect in place. The consumer gates on
    // `editingElementId !== ''` anyway, so a stale rect behind a closed popover
    // is inert — and not calling setState here keeps the effect render-clean.
    if (!elementId) return;

    let raf = 0;
    let current: TrackedRect | null = null;
    let stableFrames = 0;
    let pointerDown = false;
    // A canvas zoom is an animated ancestor transform; keep the loop live for
    // its whole duration (a ResizeObserver on the element node can't see it).
    let zoomActive = useCanvasStore.getState().zoomTarget !== null;

    const read = (): TrackedRect | null => {
      const wrapper = document.getElementById(`editable-element-${elementId}`);
      // Every element type renders an `.editable-element-{type}` content root.
      const node = wrapper?.querySelector<HTMLElement>('[class*="editable-element-"]') ?? null;
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        width: Math.max(r.width, MIN_ANCHOR_PX),
        height: Math.max(r.height, MIN_ANCHOR_PX),
      };
    };

    const measure = () => {
      const next = read();
      if (!sameRect(current, next)) {
        current = next;
        setRect(next);
        stableFrames = 0;
      } else {
        stableFrames += 1;
      }
      // Keep following for the whole pointer press / zoom animation; otherwise
      // park once the rect has settled. Scroll/resize/RO/pointer/zoom re-arm
      // via `arm`.
      if (!pointerDown && !zoomActive && stableFrames >= STABLE_FRAMES_BEFORE_IDLE) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(measure);
    };

    const arm = () => {
      stableFrames = 0;
      if (!raf) raf = requestAnimationFrame(measure);
    };

    const onPointerDown = () => {
      pointerDown = true;
      arm();
    };
    const onPointerUp = () => {
      // Let the loop run a little longer to catch the gesture's settle, then it
      // parks itself via the stable-frames check.
      pointerDown = false;
    };

    arm();

    const wrapper = document.getElementById(`editable-element-${elementId}`);
    const node = wrapper?.querySelector<HTMLElement>('[class*="editable-element-"]') ?? null;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(arm) : null;
    if (ro && node) ro.observe(node);
    window.addEventListener('scroll', arm, true);
    window.addEventListener('resize', arm);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    // Canvas zoom changes the element's screen rect via an ancestor transform
    // that the ResizeObserver can't see; re-arm (and keep alive while a
    // zoom-to animation is running) on the relevant store fields.
    const unsubscribeZoom = useCanvasStore.subscribe((state, prev) => {
      if (state.canvasScale !== prev.canvasScale || state.zoomTarget !== prev.zoomTarget) {
        zoomActive = state.zoomTarget !== null;
        arm();
      }
    });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      unsubscribeZoom();
      window.removeEventListener('scroll', arm, true);
      window.removeEventListener('resize', arm);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [elementId]);

  return rect;
}
