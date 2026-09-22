import type { PPTElement } from '@openmaic/dsl';

// Reuse the renderer's single source of truth for element bounds instead of a
// local re-implementation. `getElementRange` there is line-aware (derives
// bounds from endpoints and active control points) and rotation-aware, so
// alignment guides built over a slide containing a line no longer produce NaN.
import { getElementRange } from '@openmaic/renderer';

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

type Point = [number, number];

function quadraticAt(p0: number, c: number, p2: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * c + t * t * p2;
}

function cubicAt(p0: number, c1: number, c2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * c1 + 3 * mt * t * t * c2 + t * t * t * p3;
}

function pushQuadraticExtrema(values: number[], p0: number, c: number, p2: number): void {
  const denominator = p0 - 2 * c + p2;
  if (denominator === 0) return;
  const t = (p0 - c) / denominator;
  if (t > 0 && t < 1) values.push(quadraticAt(p0, c, p2, t));
}

function pushCubicRoot(
  values: number[],
  p0: number,
  c1: number,
  c2: number,
  p3: number,
  t: number,
): void {
  if (t > 0 && t < 1) values.push(cubicAt(p0, c1, c2, p3, t));
}

function pushCubicExtrema(values: number[], p0: number, c1: number, c2: number, p3: number): void {
  const a = -p0 + 3 * c1 - 3 * c2 + p3;
  const b = 3 * p0 - 6 * c1 + 3 * c2;
  const c = -3 * p0 + 3 * c1;
  const derivativeA = 3 * a;
  const derivativeB = 2 * b;
  const derivativeC = c;

  if (derivativeA === 0) {
    if (derivativeB !== 0) pushCubicRoot(values, p0, c1, c2, p3, -derivativeC / derivativeB);
    return;
  }

  const discriminant = derivativeB * derivativeB - 4 * derivativeA * derivativeC;
  if (discriminant < 0) return;

  const root = Math.sqrt(discriminant);
  pushCubicRoot(values, p0, c1, c2, p3, (-derivativeB - root) / (2 * derivativeA));
  if (root !== 0) pushCubicRoot(values, p0, c1, c2, p3, (-derivativeB + root) / (2 * derivativeA));
}

/** Shared conservative bounds for marquee hit-testing and multi-drag unions. */
export const getEditingElementRange = getElementRange;

/**
 * Visual element range for alignment guides. Non-line elements share their
 * normal range; line elements use the exact rendered path bounds so guides
 * answer "what does the user see aligned?" and never point at invisible
 * Bezier control-hull geometry.
 */
export function getVisualElementRange(el: PPTElement): ElementRange {
  if (el.type !== 'line' || el.broken || el.broken2) return getElementRange(el);

  const xs = [el.start[0], el.end[0]];
  const ys = [el.start[1], el.end[1]];
  const start: Point = el.start;
  const end: Point = el.end;

  if (el.curve) {
    pushQuadraticExtrema(xs, start[0], el.curve[0], end[0]);
    pushQuadraticExtrema(ys, start[1], el.curve[1], end[1]);
  } else if (el.cubic) {
    const [c1, c2] = el.cubic;
    pushCubicExtrema(xs, start[0], c1[0], c2[0], end[0]);
    pushCubicExtrema(ys, start[1], c1[1], c2[1], end[1]);
  }

  return {
    minX: el.left + Math.min(...xs),
    maxX: el.left + Math.max(...xs),
    minY: el.top + Math.min(...ys),
    maxY: el.top + Math.max(...ys),
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
