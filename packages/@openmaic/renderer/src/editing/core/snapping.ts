import type { PPTElement } from '@openmaic/dsl';
import type { SnappingOptions } from '../types';
import {
  getVisualElementRange,
  uniqAlignLines,
  type AlignLine,
  type ElementRange,
} from './geometry';

/**
 * Pure alignment-snapping math for the editing surface. Consumes geometry
 * primitives (`getVisualElementRange`, `uniqAlignLines`, `AlignLine`,
 * `ElementRange`) and the DSL element shape. No React, no store, no `@/` imports
 * — ported (decoupled) from the app's `useDragElement` drag-snap math and
 * `AlignmentLine` guide shape so it can be exercised with plain unit tests and
 * reused by any host.
 */

/** A single alignment guide line to render during a drag/resize gesture. */
export interface Guide {
  type: 'vertical' | 'horizontal';
  /** Top-left render position, in canvas units (matches the app's AlignmentLine div). */
  axis: { x: number; y: number };
  /** Rendered length: height for a vertical guide, width for a horizontal one. */
  length: number;
}

/** Guides are drawn 100 canvas units longer than the strict overlap span (50 past each end). */
const GUIDE_OVERHANG = 50;

/**
 * Build the candidate snap lines for a drag/resize gesture: other elements'
 * edges + centers (`toElements`) and the viewport's left/centerX/right and
 * top/centerY/bottom lines (`toCanvas`). Each axis list is deduplicated by
 * value via `uniqAlignLines`. Element candidates use visual ranges: the
 * conservative editing hull answers "could this be here?" for selection and
 * multi-drag unions, while guides answer "what visibly aligns?" and must not
 * point at Bezier control-hull geometry the user never sees. Does not mutate
 * `others`.
 */
export function buildAlignLines(
  others: PPTElement[],
  viewport: { width: number; height: number },
  opts: SnappingOptions = {},
): { vertical: AlignLine[]; horizontal: AlignLine[] } {
  const vertical: AlignLine[] = [];
  const horizontal: AlignLine[] = [];

  if (opts.toElements) {
    for (const el of others) {
      const { minX, maxX, minY, maxY } = getVisualElementRange(el);
      const centerX = minX + (maxX - minX) / 2;
      const centerY = minY + (maxY - minY) / 2;

      vertical.push(
        { value: minX, range: [minY, maxY] },
        { value: maxX, range: [minY, maxY] },
        { value: centerX, range: [minY, maxY] },
      );
      horizontal.push(
        { value: minY, range: [minX, maxX] },
        { value: maxY, range: [minX, maxX] },
        { value: centerY, range: [minX, maxX] },
      );
    }
  }

  if (opts.toCanvas) {
    const { width, height } = viewport;

    vertical.push(
      { value: 0, range: [0, height] },
      { value: width / 2, range: [0, height] },
      { value: width, range: [0, height] },
    );
    horizontal.push(
      { value: 0, range: [0, width] },
      { value: height / 2, range: [0, width] },
      { value: height, range: [0, width] },
    );
  }

  return {
    vertical: uniqAlignLines(vertical),
    horizontal: uniqAlignLines(horizontal),
  };
}

interface BestMatch {
  delta: number;
  line: AlignLine;
}

/**
 * Scan `lines` against `probes` (a target's min/center/max on one axis) and
 * return the smallest in-range correction, or `null` if none of the probes
 * land within `range` of any line.
 */
function findBestMatch(lines: AlignLine[], probes: number[], range: number): BestMatch | null {
  let best: BestMatch | null = null;
  for (const line of lines) {
    for (const probe of probes) {
      const delta = line.value - probe;
      if (Math.abs(delta) < range && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, line };
      }
    }
  }
  return best;
}

/**
 * Snap a target bounding range against candidate alignment lines: for each
 * axis independently, probe the target's min/center/max edges and pick the
 * nearest in-range line. Returns the winning correction (`dx`/`dy`, 0 when
 * no line is within `range`) plus the guide(s) to display. Does not mutate
 * `target` or `lines`.
 */
export function snapRange(
  target: ElementRange,
  lines: { vertical: AlignLine[]; horizontal: AlignLine[] },
  range: number,
): { dx: number; dy: number; guides: Guide[] } {
  const { minX, maxX, minY, maxY } = target;
  const centerX = minX + (maxX - minX) / 2;
  const centerY = minY + (maxY - minY) / 2;

  const guides: Guide[] = [];
  let dx = 0;
  let dy = 0;

  const bestVertical = findBestMatch(lines.vertical, [minX, centerX, maxX], range);
  if (bestVertical) {
    dx = bestVertical.delta;
    const { line } = bestVertical;
    const spanMin = Math.min(line.range[0], minY, maxY);
    const spanMax = Math.max(line.range[1], minY, maxY);
    guides.push({
      type: 'vertical',
      axis: { x: line.value, y: spanMin - GUIDE_OVERHANG },
      length: spanMax - spanMin + GUIDE_OVERHANG * 2,
    });
  }

  const bestHorizontal = findBestMatch(lines.horizontal, [minY, centerY, maxY], range);
  if (bestHorizontal) {
    dy = bestHorizontal.delta;
    const { line } = bestHorizontal;
    const spanMin = Math.min(line.range[0], minX, maxX);
    const spanMax = Math.max(line.range[1], minX, maxX);
    guides.push({
      type: 'horizontal',
      axis: { x: spanMin - GUIDE_OVERHANG, y: line.value },
      length: spanMax - spanMin + GUIDE_OVERHANG * 2,
    });
  }

  return { dx, dy, guides };
}
