import type { PPTElement } from '@openmaic/dsl';
import type { SnappingOptions } from '../types';
import { getElementRange, getEditingElementListRange } from './geometry';
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
 * Shared by the drag and resize cores so both gestures interpret the
 * `snapping` prop identically.
 */
export function resolveSnapping(
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

/**
 * Multi-element drag input for one gesture-commit tick: the pointer's grab
 * element (`handleElement`, always a member of `selected`), the whole selected
 * set to translate rigidly (`selected`, INCLUDING the handle), the snap
 * candidates (`others` — the caller has already excluded every selected
 * element), the viewport, the pointer delta already converted to canvas units,
 * an optional single-axis lock, and the snapping config.
 */
export interface MultiDragInput {
  handleElement: PPTElement;
  selected: PPTElement[];
  others: PPTElement[];
  viewport: { width: number; height: number };
  deltaCanvas: { x: number; y: number };
  axisLock?: 'x' | 'y';
  snapping?: boolean | SnappingOptions;
}

/** Every selected element's new position plus the guides to render, if any. */
export interface MultiDragResult {
  updates: Array<{ id: string; props: { left: number; top: number } }>;
  guides: Guide[];
}

/**
 * Apply a drag delta to a MULTI-element selection as one rigid translation.
 * Composition mirrors {@link computeDragMove} but snaps the whole set together:
 * shift every selected element by `deltaCanvas` → take the editing UNION
 * bounding box of the shifted set (`getEditingElementListRange`) → snap that union against
 * `others`/the canvas → apply the SAME corrected delta to every selected
 * element's origin. The snap is computed once on the union (not per element), so
 * the set never deforms — spacing between selected elements is preserved.
 *
 * `handleElement` is declared for the caller's clarity (it identifies the
 * pointer's grab element within `selected`); the correction is identical for
 * every member, so it is applied uniformly rather than relative to the handle.
 * Lines carried inside the selection are translated too (they own `left`/`top`),
 * unlike the single-element {@link computeDragMove} which leaves a lone line put.
 *
 * With a single selected element this reduces EXACTLY to {@link computeDragMove}'s
 * position math (same union == that element's range, same snap correction), so
 * the hook can route N == 1 through either and get identical results.
 * No React, no store, no `@/` imports.
 */
export function computeMultiDragMove(input: MultiDragInput): MultiDragResult {
  const { selected, others, viewport, deltaCanvas, axisLock, snapping } = input;

  // Exported-API hardening: an empty set has no union bbox (a min/max over
  // nothing degenerates to ±Infinity), so there is nothing to move or snap.
  if (selected.length === 0) return { updates: [], guides: [] };

  const dx0 = axisLock === 'y' ? 0 : deltaCanvas.x;
  const dy0 = axisLock === 'x' ? 0 : deltaCanvas.y;

  let dx = 0;
  let dy = 0;
  let guides: Guide[] = [];

  const resolved = resolveSnapping(snapping);
  if (resolved) {
    const shifted = selected.map(
      (el) => ({ ...el, left: el.left + dx0, top: el.top + dy0 }) as PPTElement,
    );
    const targetRange = getEditingElementListRange(shifted);
    const lines = buildAlignLines(others, viewport, resolved.opts);
    const snapped = snapRange(targetRange, lines, resolved.range);
    dx = snapped.dx;
    dy = snapped.dy;
    guides = snapped.guides;
  }

  const totalX = dx0 + dx;
  const totalY = dy0 + dy;

  const updates = selected.map((el) => ({
    id: el.id,
    props: { left: el.left + totalX, top: el.top + totalY },
  }));

  return { updates, guides };
}
