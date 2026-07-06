import type { PPTElement } from '@openmaic/dsl';
import type { SnappingOptions } from '../types';
import { getElementRange } from './geometry';
import { buildAlignLines, snapRange, type Guide } from './snapping';

/**
 * Single-element drag input for one gesture-commit tick: the element being
 * dragged, its siblings (`others`, snap candidates), the viewport (canvas
 * bounds for `toCanvas` snapping), the pointer delta already converted to
 * canvas units, an optional single-axis lock, and the snapping config.
 */
export interface DragInput {
  element: PPTElement;
  others: PPTElement[];
  viewport: { width: number; height: number };
  deltaCanvas: { x: number; y: number };
  axisLock?: 'x' | 'y';
  snapping?: boolean | SnappingOptions;
}

/** The dragged element's new position plus the guides to render, if any. */
export interface DragResult {
  props: { left: number; top: number };
  guides: Guide[];
}

const DEFAULT_SNAP_RANGE = 5;

/**
 * Resolve the `snapping` prop into concrete `buildAlignLines` options plus the
 * snap `range`: `true` enables both element- and canvas-snapping at the
 * default range; `false`/absent disables snapping entirely (`null`); an
 * explicit `SnappingOptions` object is used as-is, with `range` defaulted.
 */
function resolveSnapping(
  snapping: boolean | SnappingOptions | undefined,
): { opts: SnappingOptions; range: number } | null {
  if (snapping === true) {
    return { opts: { toElements: true, toCanvas: true }, range: DEFAULT_SNAP_RANGE };
  }
  if (!snapping) {
    return null;
  }
  return { opts: snapping, range: snapping.range ?? DEFAULT_SNAP_RANGE };
}

/**
 * Apply a drag delta to a single element (respecting an optional axis lock),
 * then snap the moved position against `others`/the canvas per `snapping`.
 * Composition: shift the element's `left/top` by `deltaCanvas` → derive the
 * shifted element's `ElementRange` via `getElementRange` → build candidate
 * align lines via `buildAlignLines` → correct the shift via `snapRange`
 * (`dx`/`dy`) → return the corrected `left/top` plus the guides to render.
 * No React, no store, no `@/` imports.
 */
export function computeDragMove(input: DragInput): DragResult {
  const { element, others, viewport, deltaCanvas, axisLock, snapping } = input;

  // Lines are filtered from dragging upstream (they carry `start`/`end`, not a
  // `width`/`height` box, so the box-model drag intent can't represent them).
  // If one still reaches here, return its current position unchanged rather than
  // reading `undefined` box fields off the union.
  if (element.type === 'line') {
    return { props: { left: element.left, top: element.top }, guides: [] };
  }

  // `element` is now narrowed to the non-line box variants, so `left/top/width/
  // height/rotate` are directly available without any cast.
  const { left, top, width, height, rotate } = element;

  const dx0 = axisLock === 'y' ? 0 : deltaCanvas.x;
  const dy0 = axisLock === 'x' ? 0 : deltaCanvas.y;

  const shiftedLeft = left + dx0;
  const shiftedTop = top + dy0;

  const resolved = resolveSnapping(snapping);
  if (!resolved) {
    return { props: { left: shiftedLeft, top: shiftedTop }, guides: [] };
  }

  const shiftedElement = {
    ...element,
    left: shiftedLeft,
    top: shiftedTop,
    width,
    height,
    rotate,
  } as PPTElement;
  const targetRange = getElementRange(shiftedElement);

  const lines = buildAlignLines(others, viewport, resolved.opts);
  const { dx, dy, guides } = snapRange(targetRange, lines, resolved.range);

  return {
    props: { left: shiftedLeft + dx, top: shiftedTop + dy },
    guides,
  };
}
