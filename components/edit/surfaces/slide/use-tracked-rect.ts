'use client';

import { useEffect, useState } from 'react';

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

/**
 * Tracks the on-screen rect of a rendered slide element.
 *
 * `#editable-element-{id}` is only a zero-size `absolute` wrapper (it carries
 * just a z-index); the geometry lives on its inner `.editable-element-{type}`
 * content root (text, image, shape, …), which has the real left/top/width/
 * height and inherits the viewport scale. So we resolve the
 * wrapper by id, then measure that child — measuring the wrapper itself would
 * collapse to a 0x0 rect at the canvas origin.
 *
 * A requestAnimationFrame loop re-measures via getBoundingClientRect — that
 * one call already resolves canvas scale, viewport offset and page scroll, so
 * the anchored bar follows the element through every gesture (drag, resize,
 * zoom) without separate store subscriptions or listeners. The loop starts
 * after mount, so on first selection the bar appears one frame late — an
 * imperceptible delay. Returns null while `elementId` is "" or unmounted.
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
    const measure = () => {
      const wrapper = document.getElementById(`editable-element-${elementId}`);
      // Every element type renders an `.editable-element-{type}` content root.
      const node = wrapper?.querySelector<HTMLElement>('[class*="editable-element-"]') ?? null;
      let next: TrackedRect | null = null;
      if (node) {
        const r = node.getBoundingClientRect();
        next = { left: r.left, top: r.top, width: r.width, height: r.height };
      }
      if (!sameRect(current, next)) {
        current = next;
        setRect(next);
      }
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [elementId]);

  return rect;
}
