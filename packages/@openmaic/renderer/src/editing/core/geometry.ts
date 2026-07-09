import type { PPTElement, PPTLineElement } from '@openmaic/dsl';

// Reuse the renderer's single source of truth for element bounds instead of a
// local re-implementation. `getElementRange` there is line-aware (derives
// bounds from `start`/`end` for `PPTLineElement`) and rotation-aware, so
// alignment guides built over a slide containing a line no longer produce NaN.
import { getElementRange } from '../../utils/element';

/**
 * Pure geometry/bounds math for the editing surface (gesture engine, snapping,
 * alignment guides). No React, no store, no `@/` imports — this module only
 * consumes the DSL element shape and plain numbers, so it can be exercised with
 * plain unit tests and reused by any host.
 */

// Re-exported so `snapping.ts`/`drag.ts` keep importing `getElementRange` from
// `./geometry` unchanged, while the implementation lives in `utils/element`.
export { getElementRange };

/** A single alignment/snap guide line: a fixed axis value plus the span it covers. */
export type AlignLine = {
  value: number;
  range: [number, number];
};

/** Axis-aligned bounding box, in canvas units. */
export interface ElementRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Conservative editing AABB for a line element's rendered path, in canvas
 * units: the box over `start`, `end`, and every present path control point
 * (`broken`, `broken2`, `curve`, `cubic`), offset by the element origin.
 *
 * Straight/broken/broken2 polylines draw through these vertices directly, and
 * quadratic/cubic Beziers stay inside the convex hull of their control points,
 * so this range never misses a visible bend. It is intentionally conservative:
 * a Bezier rarely reaches the control point itself, but editing hit-testing and
 * snap math prefer extra coverage over a false miss.
 */
function getLineEditingRange(el: PPTLineElement): ElementRange {
  const xs = [el.start[0], el.end[0]];
  const ys = [el.start[1], el.end[1]];
  if (el.broken) {
    xs.push(el.broken[0]);
    ys.push(el.broken[1]);
  }
  if (el.broken2) {
    xs.push(el.broken2[0]);
    ys.push(el.broken2[1]);
  }
  if (el.curve) {
    xs.push(el.curve[0]);
    ys.push(el.curve[1]);
  }
  if (el.cubic) {
    for (const [cx, cy] of el.cubic) {
      xs.push(cx);
      ys.push(cy);
    }
  }
  return {
    minX: el.left + Math.min(...xs),
    maxX: el.left + Math.max(...xs),
    minY: el.top + Math.min(...ys),
    maxY: el.top + Math.max(...ys),
  };
}

/**
 * Editing-side element range. Non-line elements delegate to the renderer's
 * shared range helper; line elements use the control-point-aware path AABB so
 * marquee hit-testing, multi-drag union snapping, and snap candidate lines all
 * reason about the same bent-line geometry.
 */
export function getEditingElementRange(el: PPTElement): ElementRange {
  return el.type === 'line' ? getLineEditingRange(el) : getElementRange(el);
}

/** Union bbox of a list of elements, in canvas units. */
export function getElementListRange(els: PPTElement[]): ElementRange {
  const leftValues: number[] = [];
  const topValues: number[] = [];
  const rightValues: number[] = [];
  const bottomValues: number[] = [];

  for (const el of els) {
    const { minX, maxX, minY, maxY } = getElementRange(el);
    leftValues.push(minX);
    topValues.push(minY);
    rightValues.push(maxX);
    bottomValues.push(maxY);
  }

  return {
    minX: Math.min(...leftValues),
    maxX: Math.max(...rightValues),
    minY: Math.min(...topValues),
    maxY: Math.max(...bottomValues),
  };
}

/** Union bbox of a list of elements using editing-side ranges. */
export function getEditingElementListRange(els: PPTElement[]): ElementRange {
  const leftValues: number[] = [];
  const topValues: number[] = [];
  const rightValues: number[] = [];
  const bottomValues: number[] = [];

  for (const el of els) {
    const { minX, maxX, minY, maxY } = getEditingElementRange(el);
    leftValues.push(minX);
    topValues.push(minY);
    rightValues.push(maxX);
    bottomValues.push(maxY);
  }

  return {
    minX: Math.min(...leftValues),
    maxX: Math.max(...rightValues),
    minY: Math.min(...topValues),
    maxY: Math.max(...bottomValues),
  };
}

/**
 * Dedup a list of alignment guide lines by `value`: for equal `value`, merges
 * `range` by taking the min of range starts and max of range ends.
 */
export function uniqAlignLines(lines: AlignLine[]): AlignLine[] {
  const uniqLines: AlignLine[] = [];
  for (const line of lines) {
    const index = uniqLines.findIndex((_line) => _line.value === line.value);
    if (index === -1) {
      uniqLines.push(line);
    } else {
      const uniqLine = uniqLines[index];
      const rangeMin = Math.min(uniqLine.range[0], line.range[0]);
      const rangeMax = Math.max(uniqLine.range[1], line.range[1]);
      uniqLines[index] = { value: line.value, range: [rangeMin, rangeMax] };
    }
  }
  return uniqLines;
}

/** Convert a screen-pixel delta to canvas units at the given zoom `scale`. */
export function pxToCanvas(px: number, scale: number): number {
  return px / scale;
}

/** Convert a canvas-unit delta to screen pixels at the given zoom `scale`. */
export function canvasToPx(u: number, scale: number): number {
  return u * scale;
}
