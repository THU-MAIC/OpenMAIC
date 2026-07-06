import type { PPTElement } from '@openmaic/dsl';

/**
 * Pure geometry/bounds math for the editing surface (gesture engine, snapping,
 * alignment guides). No React, no store, no `@/` imports — this module only
 * consumes the DSL element shape (`left/top/width/height/rotate`) and plain
 * numbers, so it can be exercised with plain unit tests and reused by any host.
 */

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

interface RotatedRect {
  left: number;
  top: number;
  width: number;
  height: number;
  rotate: number;
}

/**
 * Rotated bounding range of a `left/top/width/height/rotate` rect: rotates the
 * four corners about the rect's center and returns the axis-aligned range that
 * encloses them. Ported from the app's `getRectRotatedRange`.
 */
function getRectRotatedRange(rect: RotatedRect): {
  xRange: [number, number];
  yRange: [number, number];
} {
  const { left, top, width, height, rotate = 0 } = rect;

  const radius = Math.sqrt(Math.pow(width, 2) + Math.pow(height, 2)) / 2;
  const auxiliaryAngle = (Math.atan(height / width) * 180) / Math.PI;

  const tlbraRadian = ((180 - rotate - auxiliaryAngle) * Math.PI) / 180;
  const trblaRadian = ((auxiliaryAngle - rotate) * Math.PI) / 180;

  const middleLeft = left + width / 2;
  const middleTop = top + height / 2;

  const xAxis = [
    middleLeft + radius * Math.cos(tlbraRadian),
    middleLeft + radius * Math.cos(trblaRadian),
    middleLeft - radius * Math.cos(tlbraRadian),
    middleLeft - radius * Math.cos(trblaRadian),
  ];
  const yAxis = [
    middleTop - radius * Math.sin(tlbraRadian),
    middleTop - radius * Math.sin(trblaRadian),
    middleTop + radius * Math.sin(tlbraRadian),
    middleTop + radius * Math.sin(trblaRadian),
  ];

  return {
    xRange: [Math.min(...xAxis), Math.max(...xAxis)],
    yRange: [Math.min(...yAxis), Math.max(...yAxis)],
  };
}

/**
 * Axis-aligned bbox for a single element, in canvas units. Rotated elements
 * return the rotated bounding range (the box that encloses the rotated shape),
 * not the unrotated box.
 *
 * Line elements (`start`/`end` tuples, no `width`/`rotate`) are out of scope for
 * this port — the callers this task serves (selection bbox, alignment guides)
 * only operate over box elements. A line's bbox can be derived from its
 * `start`/`end` points if a future task needs it here.
 */
export function getElementRange(el: PPTElement): ElementRange {
  const { left, top, width, height } = el as unknown as {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  const rotate = (el as unknown as { rotate?: number }).rotate ?? 0;

  if (rotate) {
    const { xRange, yRange } = getRectRotatedRange({ left, top, width, height, rotate });
    return { minX: xRange[0], maxX: xRange[1], minY: yRange[0], maxY: yRange[1] };
  }

  return {
    minX: left,
    maxX: left + width,
    minY: top,
    maxY: top + height,
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
