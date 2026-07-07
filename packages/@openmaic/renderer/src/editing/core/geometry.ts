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

// Numeric tolerance below which a Bézier leading coefficient is treated as
// zero (degenerate to a lower-degree curve). Coordinates here are canvas units
// (tens–hundreds), so 1e-9 is safely below any meaningful geometry.
const EPS = 1e-9;

/** Evaluate a quadratic Bézier on one axis at parameter `t` (Bernstein form). */
function quadraticAt(p0: number, p1: number, p2: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
}

/**
 * Tight `[min, max]` extent of a quadratic Bézier on ONE axis: the two
 * endpoints plus the single interior extremum, if any. The control point `p1`
 * itself is deliberately NOT included — it can lie outside the drawn curve.
 *
 * The extremum is where `B'(t) = 0`, i.e. `t* = (p0 - p1) / (p0 - 2p1 + p2)`.
 * When the denominator is ≈ 0 the curve is linear on this axis (control on the
 * chord line), so the endpoints already bound it.
 */
export function quadraticBounds(p0: number, p1: number, p2: number): [number, number] {
  let lo = Math.min(p0, p2);
  let hi = Math.max(p0, p2);
  const denom = p0 - 2 * p1 + p2;
  if (Math.abs(denom) > EPS) {
    const t = (p0 - p1) / denom;
    if (t > 0 && t < 1) {
      const v = quadraticAt(p0, p1, p2, t);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  return [lo, hi];
}

/** Evaluate a cubic Bézier on one axis at parameter `t` (Bernstein form). */
function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/**
 * Tight `[min, max]` extent of a cubic Bézier on ONE axis: the two endpoints
 * plus every interior extremum. The control points `p1`/`p2` are deliberately
 * NOT included — they can lie outside the drawn curve.
 *
 * Extrema are the roots of `B'(t) = 0`, a quadratic `a t² + b t + c = 0` where
 * (differentiating the cubic Bernstein form):
 *   a = -p0 + 3p1 - 3p2 + p3
 *   b = 2(p0 - 2p1 + p2)
 *   c = -p0 + p1
 * The `a ≈ 0` case degenerates to the linear `b t + c = 0`.
 */
export function cubicBounds(p0: number, p1: number, p2: number, p3: number): [number, number] {
  let lo = Math.min(p0, p3);
  let hi = Math.max(p0, p3);

  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = -p0 + p1;

  const roots: number[] = [];
  if (Math.abs(a) < EPS) {
    // Linear derivative: a single root (or none if the curve is flat on axis).
    if (Math.abs(b) > EPS) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      roots.push((-b + s) / (2 * a));
      roots.push((-b - s) / (2 * a));
    }
  }

  for (const t of roots) {
    if (t > 0 && t < 1) {
      const v = cubicAt(p0, p1, p2, p3, t);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  return [lo, hi];
}

/**
 * Tight axis-aligned bounding box of an SVG path string composed of absolute
 * `M`/`L`/`Q`/`C` commands (the only ones {@link getLineElementPath} emits).
 * Returns `null` for an empty/degenerate path (no coordinates).
 *
 * Each segment contributes its EXACT drawn extent — for `Q`/`C` that means the
 * Bézier extrema (via {@link quadraticBounds}/{@link cubicBounds}), not the raw
 * control points, which can bulge outside the curve. The SVG "current point" is
 * tracked across commands so `Q`/`C` know their start point `P0`. Implicit
 * command repetition (a coordinate run after `L`/`Q`/`C` with no new letter) is
 * supported, which is why `broken2`'s trailing `… 100,0` pair is bounded.
 */
export function getPathBounds(d: string): ElementRange | null {
  // Number pattern accepts an optional sign, a fractional part, and an
  // exponent — `getLineElementPath` can stringify tiny/large coordinates in
  // exponent form (e.g. a rotated imported line yields `7.1e-15`), which a
  // plain `-?\d+(?:\.\d+)?` would mis-split into `7.1` and `-15`.
  const tokens = d.match(/[MLQC]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (!tokens) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const includeX = (v: number) => {
    if (v < minX) minX = v;
    if (v > maxX) maxX = v;
  };
  const includeY = (v: number) => {
    if (v < minY) minY = v;
    if (v > maxY) maxY = v;
  };

  let cmd = '';
  let cx = 0;
  let cy = 0;
  let i = 0;
  const num = () => Number(tokens[i++]);

  while (i < tokens.length) {
    if (/^[MLQC]$/.test(tokens[i])) cmd = tokens[i++];

    if (cmd === 'M' || cmd === 'L') {
      const x = num();
      const y = num();
      includeX(x);
      includeY(y);
      cx = x;
      cy = y;
    } else if (cmd === 'Q') {
      const x1 = num();
      const y1 = num();
      const x = num();
      const y = num();
      const [xlo, xhi] = quadraticBounds(cx, x1, x);
      const [ylo, yhi] = quadraticBounds(cy, y1, y);
      includeX(xlo);
      includeX(xhi);
      includeY(ylo);
      includeY(yhi);
      cx = x;
      cy = y;
    } else if (cmd === 'C') {
      const x1 = num();
      const y1 = num();
      const x2 = num();
      const y2 = num();
      const x = num();
      const y = num();
      const [xlo, xhi] = cubicBounds(cx, x1, x2, x);
      const [ylo, yhi] = cubicBounds(cy, y1, y2, y);
      includeX(xlo);
      includeX(xhi);
      includeY(ylo);
      includeY(yhi);
      cx = x;
      cy = y;
    } else {
      // No active command (malformed leading token): skip one token to avoid
      // an infinite loop.
      i++;
    }
  }

  if (!Number.isFinite(minX)) return null;
  return { minX, maxX, minY, maxY };
}

/**
 * Tight axis-aligned bounds of a line's actual drawn path, in canvas units.
 *
 * Unlike {@link getElementRange} (which only bounds `start`/`end`, i.e. the
 * chord), this bounds the EXACT path the renderer draws, so the selection
 * border wraps the visible stroke for every line shape. We derive it from
 * {@link getLineElementPath} — the single source of truth for the rendered
 * `<path d>` — via {@link getPathBounds}, then offset by the element's
 * `left`/`top`.
 *
 * Crucially, the raw control points are NOT taken as bbox points:
 *   - `broken2` renders as an L-shaped connector using only `broken2[0]` (for
 *     horizontal lines) or `broken2[1]` (for vertical), so a horizontal
 *     `broken2=[50,80]` line draws flat at y=0 — its true maxY is 0, not 80.
 *   - `curve` (quadratic Q) / `cubic` (C) put control points that can bulge
 *     outside the drawn stroke; we take the true Bézier extrema instead, so a
 *     `curve=[50,80]` line yields maxY=40 (the peak at t=0.5), not 80.
 *
 * Falls back to the element origin (a zero-size box at `left`/`top`) when the
 * path yields no points, so the bounds stay finite.
 */
export function getLineBounds(line: PPTLineElement): ElementRange {
  const { left, top } = line;
  const bounds = getPathBounds(getLineElementPath(line));
  if (!bounds) {
    return { minX: left, maxX: left, minY: top, maxY: top };
  }
  return {
    minX: bounds.minX + left,
    maxX: bounds.maxX + left,
    minY: bounds.minY + top,
    maxY: bounds.maxY + top,
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
