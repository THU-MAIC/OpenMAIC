import type { PPTElement } from '@openmaic/dsl';
import { getEditingElementRange, type ElementRange } from './geometry';

/**
 * Pure marquee (rubber-band / drag-select) math for the editing surface. Ported
 * from the app's `useMouseSelection`, but store-free and normalized: the caller
 * feeds a rectangle already in canvas units plus the slide elements, and gets
 * back the ids the marquee selects. No React, no store, no `@/` imports — this
 * module only consumes the DSL element shape and plain numbers, so it can be
 * exercised with plain unit tests and reused by any host.
 *
 * The app stores the marquee as start + |magnitude| + quadrant and branches the
 * containment test four ways (one per drag direction). Here the rectangle is
 * NORMALIZED to `{minX,minY,maxX,maxY}` at the source ({@link marqueeRect}), so
 * containment/intersection each collapse to a single predicate regardless of
 * drag direction — which also sidesteps the app's stale-closure quadrant bug.
 */

/** A pointer position in canvas units (viewportSize space). */
export interface MarqueePoint {
  x: number;
  y: number;
}

/** A normalized marquee rectangle in canvas units (min/max on each axis). */
export type MarqueeRect = ElementRange;

/**
 * How an element's bounds must relate to the marquee rectangle to be selected:
 * - `contain`: the element's AABB is wholly inside the rectangle (no modifier).
 * - `intersect`: the element's AABB overlaps the rectangle at all (Ctrl/Shift).
 */
export type MarqueeMode = 'contain' | 'intersect';

export interface MarqueeSelectionOptions {
  mode: MarqueeMode;
  /** Ids the marquee must never select (e.g. host-hidden elements). */
  excludeIds?: readonly string[];
}

/**
 * Normalize a start + current pointer pair (canvas units) into a rectangle with
 * min/max on each axis, so the four drag directions all produce the same
 * `{minX,minY,maxX,maxY}` and containment is a single predicate.
 */
export function marqueeRect(start: MarqueePoint, current: MarqueePoint): MarqueeRect {
  return {
    minX: Math.min(start.x, current.x),
    minY: Math.min(start.y, current.y),
    maxX: Math.max(start.x, current.x),
    maxY: Math.max(start.y, current.y),
  };
}

/**
 * Whether an element's bounding range hits the marquee per `mode`. `contain` is
 * inclusive of a boundary-touching edge (`>=`/`<=`); `intersect` requires a
 * strictly-positive overlap (`>`/`<`) so edge-to-edge touching does not count.
 */
function hitsMarquee(range: ElementRange, rect: MarqueeRect, mode: MarqueeMode): boolean {
  if (mode === 'contain') {
    return (
      range.minX >= rect.minX &&
      range.maxX <= rect.maxX &&
      range.minY >= rect.minY &&
      range.maxY <= rect.maxY
    );
  }
  return (
    range.minX < rect.maxX &&
    range.maxX > rect.minX &&
    range.minY < rect.maxY &&
    range.maxY > rect.minY
  );
}

/**
 * The ids the marquee `rect` selects from `elements`, in element (z-)order.
 *
 * Rules, ported from the app:
 * - Non-line elements are tested by their rotation-aware AABB
 *   ({@link getEditingElementRange}), so a rotated element uses its enclosing box.
 * - Line elements are tested by a control-point-aware conservative AABB
 *   ({@link getEditingElementRange}), so a bent line's bow is still hit-testable.
 * - Locked elements (and any `excludeIds`) are never selected.
 * - Group cohesion is all-or-nothing: a matched element that carries a
 *   `groupId` survives only if EVERY member of that group also matched — so a
 *   partial box over a group never splits it.
 *
 * The result REPLACES the selection (the caller decides how to publish it).
 */
export function computeMarqueeSelection(
  rect: MarqueeRect,
  elements: readonly PPTElement[],
  options: MarqueeSelectionOptions,
): string[] {
  const { mode, excludeIds } = options;
  const excluded = excludeIds && excludeIds.length ? new Set(excludeIds) : null;

  const matched: PPTElement[] = [];
  for (const el of elements) {
    if (el.lock) continue;
    if (excluded?.has(el.id)) continue;
    const range = getEditingElementRange(el);
    if (hitsMarquee(range, rect, mode)) matched.push(el);
  }

  const matchedIds = new Set(matched.map((el) => el.id));
  const cohesive = matched.filter((el) => {
    if (!el.groupId) return true;
    // A grouped element stays only if every sibling in its group also matched.
    return elements
      .filter((o) => o.groupId === el.groupId)
      .every((member) => matchedIds.has(member.id));
  });

  return cohesive.map((el) => el.id);
}
