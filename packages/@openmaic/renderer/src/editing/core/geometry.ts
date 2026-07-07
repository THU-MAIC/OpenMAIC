import type { PPTElement, PPTLineElement } from '@openmaic/dsl';

// Reuse the renderer's single source of truth for element bounds instead of a
// local re-implementation. `getElementRange` there is line-aware (derives
// bounds from `start`/`end` for `PPTLineElement`) and rotation-aware, so
// alignment guides built over a slide containing a line no longer produce NaN.
import { getElementRange, getLineElementPath } from '../../utils/element';

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
 * Tight axis-aligned bounds of a line's actual drawn path, in canvas units.
 *
 * Unlike {@link getElementRange} (which only bounds `start`/`end`, i.e. the
 * chord), this bounds the EXACT path the renderer draws, so the selection
 * border wraps the visible stroke for every line shape. We derive it by
 * re-using {@link getLineElementPath} — the single source of truth for the
 * rendered `<path d>` — and taking min/max over its coordinates, then offset by
 * the element's `left`/`top`.
 *
 * This matters because the raw control points are NOT all drawn as points:
 *   - `broken2` renders as an L-shaped connector that uses only `broken2[0]`
 *     (horizontal lines) or only `broken2[1]` (vertical lines), so a horizontal
 *     `broken2=[50,80]` line draws flat at y=0 — bounding the raw `[50,80]`
 *     control point would report maxY=80 and paint an oversized border.
 *   - `curve` (quadratic Q) and `cubic` (C) put their control points directly
 *     in the path, so the bounds still enclose a control point that leaves the
 *     chord (e.g. `curve=[50,80]` → height 80), matching the rendered stroke.
 *
 * The path string only contains pair-wise `x,y` coordinates after the command
 * letters (M/L/Q/C), so we extract every number in order and pair them into
 * `(x,y)`. Guard against an empty/odd match list (degenerate path) by falling
 * back to the element origin so the bounds stay finite.
 */
export function getLineBounds(line: PPTLineElement): ElementRange {
  const { left, top } = line;
  const nums = getLineElementPath(line).match(/-?\d+(?:\.\d+)?/g);

  const xs: number[] = [];
  const ys: number[] = [];
  if (nums) {
    // Pair numbers as (x, y); a trailing unpaired number (odd count) is ignored.
    for (let i = 0; i + 1 < nums.length; i += 2) {
      xs.push(left + Number(nums[i]));
      ys.push(top + Number(nums[i + 1]));
    }
  }

  if (xs.length === 0) {
    return { minX: left, maxX: left, minY: top, maxY: top };
  }

  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
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
