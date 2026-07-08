import type { PPTElement } from '@openmaic/dsl';

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
