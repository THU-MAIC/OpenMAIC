import type { PPTElement, PPTLineElement } from '@openmaic/dsl';
import type { SnappingOptions } from '../types';
import { resolveSnapping } from './drag';
import { buildAlignLines, snapRange, type Guide } from './snapping';

/**
 * Pure, store-free core for the 8-point box resize gesture. Ported from the
 * app's scale-element gesture, but with no React/store/DOM: the caller feeds
 * the ORIGINAL element plus a pointer delta already converted to canvas units,
 * and gets back the new `left/top/width/height` box plus any alignment guides.
 * No `@/` imports — this module only consumes the DSL element shape, the
 * sibling snapping/drag cores, and plain numbers.
 *
 * Scope note: `computeResize` emits ONLY the box props. Kind-specific content
 * recomputation that must track the box (a shape's `pathFormula`/`viewBox`
 * path, a table's `cellMinHeight`, an image's clip mode) is a host/app concern
 * or a later slice — the host can post-process in response to the intent.
 */

/** A selectable element that carries a box model (`width`/`height`/`rotate`). */
export type PPTBoxElement = Exclude<PPTElement, PPTLineElement>;

/** The eight resize points on a box element's selection frame. */
export type ResizeHandle =
  | 'left-top'
  | 'top'
  | 'right-top'
  | 'left'
  | 'right'
  | 'left-bottom'
  | 'bottom'
  | 'right-bottom';

/** All eight handles, in the app's render order (row-major, top to bottom). */
export const RESIZE_HANDLES: readonly ResizeHandle[] = [
  'left-top',
  'top',
  'right-top',
  'left',
  'right',
  'left-bottom',
  'bottom',
  'right-bottom',
];

/** The diagonally/axially opposite handle — the visually fixed point of a resize. */
export const OPPOSITE_HANDLE: Record<ResizeHandle, ResizeHandle> = {
  'left-top': 'right-bottom',
  top: 'bottom',
  'right-top': 'left-bottom',
  left: 'right',
  right: 'left',
  'left-bottom': 'right-top',
  bottom: 'top',
  'right-bottom': 'left-top',
};

/**
 * Minimum size (canvas units) an element may be resized down to, per type.
 * Mirrors the app's element config so the package clamps identically.
 */
export const ELEMENT_MIN_SIZE: Record<string, number> = {
  text: 40,
  image: 20,
  shape: 20,
  chart: 200,
  table: 30,
  video: 250,
  audio: 20,
  latex: 20,
};

/** Fallback minimum size for element types missing from {@link ELEMENT_MIN_SIZE}. */
const DEFAULT_MIN_SIZE = 20;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Point {
  left: number;
  top: number;
}

/**
 * Positions (canvas units) of the eight resize points of a ROTATED box: each
 * un-rotated frame point rotated about the box center by `angle` (degrees,
 * CSS-clockwise). At `angle === 0` this degenerates to the plain frame points
 * (e.g. `left-top` = `(left, top)`), so it also serves as the single source of
 * truth for handle placement at any rotation.
 */
export function getRotateElementPoints(element: Box, angle: number): Record<ResizeHandle, Point> {
  const { left, top, width, height } = element;

  const radius = Math.sqrt(Math.pow(width, 2) + Math.pow(height, 2)) / 2;
  const auxiliaryAngle = (Math.atan(height / width) * 180) / Math.PI;

  const tlbraRadian = ((180 - angle - auxiliaryAngle) * Math.PI) / 180;
  const trblaRadian = ((auxiliaryAngle - angle) * Math.PI) / 180;
  const taRadian = ((90 - angle) * Math.PI) / 180;
  const raRadian = (angle * Math.PI) / 180;

  const halfWidth = width / 2;
  const halfHeight = height / 2;

  const middleLeft = left + halfWidth;
  const middleTop = top + halfHeight;

  return {
    'left-top': {
      left: middleLeft + radius * Math.cos(tlbraRadian),
      top: middleTop - radius * Math.sin(tlbraRadian),
    },
    top: {
      left: middleLeft + halfHeight * Math.cos(taRadian),
      top: middleTop - halfHeight * Math.sin(taRadian),
    },
    'right-top': {
      left: middleLeft + radius * Math.cos(trblaRadian),
      top: middleTop - radius * Math.sin(trblaRadian),
    },
    right: {
      left: middleLeft + halfWidth * Math.cos(raRadian),
      top: middleTop + halfWidth * Math.sin(raRadian),
    },
    'right-bottom': {
      left: middleLeft - radius * Math.cos(tlbraRadian),
      top: middleTop + radius * Math.sin(tlbraRadian),
    },
    bottom: {
      left: middleLeft - halfHeight * Math.sin(raRadian),
      top: middleTop + halfHeight * Math.cos(raRadian),
    },
    'left-bottom': {
      left: middleLeft - radius * Math.cos(trblaRadian),
      top: middleTop + radius * Math.sin(trblaRadian),
    },
    left: {
      left: middleLeft - halfWidth * Math.cos(raRadian),
      top: middleTop - halfWidth * Math.sin(raRadian),
    },
  };
}

/**
 * The point opposite the operated handle on a rotated box — the base point
 * that must stay visually fixed while the box resizes (e.g. dragging
 * `right-bottom` keeps the rotated `left-top` corner in place).
 */
function getOppositePoint(handle: ResizeHandle, points: Record<ResizeHandle, Point>): Point {
  return points[OPPOSITE_HANDLE[handle]];
}

export type ResizeCursor = 'nwse-resize' | 'ns-resize' | 'nesw-resize' | 'ew-resize';

/**
 * The visual cursor cycle a handle's cursor advances through as the element
 * rotates: every +45deg of rotation shifts a handle's on-screen direction one
 * step clockwise (nwse -> ns -> nesw -> ew -> nwse ...).
 */
const CURSOR_CYCLE: readonly ResizeCursor[] = [
  'nwse-resize',
  'ns-resize',
  'nesw-resize',
  'ew-resize',
];

/** Each handle's cursor at rotation 0 as an index into {@link CURSOR_CYCLE}. */
const CURSOR_BASE_INDEX: Record<ResizeHandle, number> = {
  'left-top': 0,
  'right-bottom': 0,
  top: 1,
  bottom: 1,
  'right-top': 2,
  'left-bottom': 2,
  left: 3,
  right: 3,
};

/**
 * Rotation-aware resize cursor for a handle: bucket `rotate` to the nearest of
 * 0/45/90/135 (mod 180, +-22.5deg thresholds, negatives wrap the same way),
 * then advance the handle's rotation-0 cursor one {@link CURSOR_CYCLE} step per
 * 45deg bucket. Reproduces the app's full handle x bucket cursor table.
 */
export function getResizeCursor(handle: ResizeHandle, rotate: number): ResizeCursor {
  let bucket: 0 | 45 | 90 | 135;
  if (rotate > -22.5 && rotate <= 22.5) bucket = 0;
  else if (rotate > 22.5 && rotate <= 67.5) bucket = 45;
  else if (rotate > 67.5 && rotate <= 112.5) bucket = 90;
  else if (rotate > 112.5 && rotate <= 157.5) bucket = 135;
  else if (rotate > 157.5 || rotate <= -157.5) bucket = 0;
  else if (rotate > -157.5 && rotate <= -112.5) bucket = 45;
  else if (rotate > -112.5 && rotate <= -67.5) bucket = 90;
  else bucket = 135; // (-67.5, -22.5]

  return CURSOR_CYCLE[(CURSOR_BASE_INDEX[handle] + bucket / 45) % 4];
}

/**
 * Which resize handles a box element exposes, by kind (app parity):
 * - `code`: none — the app renders no resize points for code blocks.
 * - `text`: only the width axis, since text height follows content — `left`/
 *   `right`, or `top`/`bottom` when the text is vertical.
 * - everything else: all eight points.
 * Line elements never reach here (they have endpoint handles, not a box).
 */
export function getResizeHandles(element: PPTBoxElement): readonly ResizeHandle[] {
  if (element.type === 'code') return [];
  if (element.type === 'text') {
    return element.vertical ? ['top', 'bottom'] : ['left', 'right'];
  }
  return RESIZE_HANDLES;
}

/**
 * Single-element resize input for one gesture tick: the ORIGINAL element (as
 * captured at pointer-down — deltas always apply to the origin, never to a
 * previous tick's output), the operated handle, its siblings (`others`, snap
 * candidates), the viewport (canvas bounds for `toCanvas` snapping), the
 * pointer delta already converted to canvas units, whether the aspect-lock
 * modifier (Ctrl/Shift/Meta) is held at THIS tick, and the snapping config.
 */
export interface ResizeInput {
  element: PPTBoxElement;
  handle: ResizeHandle;
  others: PPTElement[];
  viewport: { width: number; height: number };
  deltaCanvas: { x: number; y: number };
  aspectModifier?: boolean;
  snapping?: boolean | SnappingOptions;
}

/** The resized element's new box plus the guides to render, if any. */
export interface ResizeResult {
  props: { left: number; top: number; width: number; height: number };
  guides: Guide[];
}

/**
 * Apply a resize delta to a single box element. Composition, per the app:
 *
 * - **Un-rotated**: the moving edge(s) follow the pointer delta directly; the
 *   moving corner/edge position is snapped against `others`/the canvas BEFORE
 *   min-size clamping (aspect lock recomputes the other axis from whichever
 *   axis snapped); resizing from a left/top edge shifts `left`/`top` so the
 *   opposite edge stays put. Rotated siblings and lines are excluded from the
 *   snap candidates (their axis-aligned bboxes are not meaningful snap edges).
 * - **Rotated**: the pointer delta is first rotated into the element's local
 *   axes; the same per-handle size math applies; then the position is
 *   corrected so the point OPPOSITE the operated handle stays visually fixed
 *   (resizing changes where the rotated opposite corner lands, so `left`/`top`
 *   must compensate). No snapping for rotated elements (app parity).
 *
 * Aspect lock (`aspectModifier` held, or the element's own `fixedRatio`) only
 * affects the four CORNER handles: the vertical delta is recomputed from the
 * horizontal one at the origin's aspect ratio. Edge handles ignore it.
 *
 * Min-size clamping uses the per-type {@link ELEMENT_MIN_SIZE}; under aspect
 * lock the limit is scaled so both axes reach their minimum together.
 */
export function computeResize(input: ResizeInput): ResizeResult {
  const { element, handle, others, viewport, deltaCanvas, aspectModifier, snapping } = input;

  const originLeft = element.left;
  const originTop = element.top;
  const originWidth = element.width;
  const originHeight = element.height;

  const rotate = element.rotate || 0;
  const rotateRadian = (Math.PI * rotate) / 180;

  const fixedRatio =
    Boolean(aspectModifier) || ('fixedRatio' in element && Boolean(element.fixedRatio));
  const aspectRatio = originWidth / originHeight;

  const minSize = ELEMENT_MIN_SIZE[element.type] ?? DEFAULT_MIN_SIZE;
  // Clamp a candidate size to the per-type minimum. Under aspect lock the
  // shorter axis governs: scale the limits so width and height hit their
  // minimums at the same aspect-locked step (app parity).
  const getSizeWithinRange = (size: number, axis: 'width' | 'height'): number => {
    if (!fixedRatio) return size < minSize ? minSize : size;

    let minWidth = minSize;
    let minHeight = minSize;
    const ratio = originWidth / originHeight;
    if (ratio < 1) minHeight = minSize / ratio;
    if (ratio > 1) minWidth = minSize * ratio;

    if (axis === 'width') return size < minWidth ? minWidth : size;
    return size < minHeight ? minHeight : size;
  };

  let left = originLeft;
  let top = originTop;
  let width = originWidth;
  let height = originHeight;
  let guides: Guide[] = [];

  // ROTATED path: rotate the pointer delta into element-local axes, apply the
  // per-handle size math, then correct the position so the opposite point
  // stays fixed. No alignment snapping for rotated elements (app parity —
  // axis-aligned snap lines are meaningless against a rotated frame).
  if (rotate) {
    const revisedX =
      Math.cos(rotateRadian) * deltaCanvas.x + Math.sin(rotateRadian) * deltaCanvas.y;
    let revisedY = Math.cos(rotateRadian) * deltaCanvas.y - Math.sin(rotateRadian) * deltaCanvas.x;

    // Aspect lock (corners only): derive the local vertical delta from the
    // horizontal one so the box scales at the origin's ratio.
    if (fixedRatio) {
      if (handle === 'right-bottom' || handle === 'left-top') revisedY = revisedX / aspectRatio;
      if (handle === 'left-bottom' || handle === 'right-top') revisedY = -revisedX / aspectRatio;
    }

    // Per-handle size/position math in the local frame. The position computed
    // here still needs the opposite-point correction below: resizing a rotated
    // box moves where its rotated opposite point lands, and only a `left`/`top`
    // shift keeps it visually fixed. The SIZE needs no correction — the delta
    // was already rotated into local axes above.
    if (handle === 'right-bottom') {
      width = getSizeWithinRange(originWidth + revisedX, 'width');
      height = getSizeWithinRange(originHeight + revisedY, 'height');
    } else if (handle === 'left-bottom') {
      width = getSizeWithinRange(originWidth - revisedX, 'width');
      height = getSizeWithinRange(originHeight + revisedY, 'height');
      left = originLeft - (width - originWidth);
    } else if (handle === 'left-top') {
      width = getSizeWithinRange(originWidth - revisedX, 'width');
      height = getSizeWithinRange(originHeight - revisedY, 'height');
      left = originLeft - (width - originWidth);
      top = originTop - (height - originHeight);
    } else if (handle === 'right-top') {
      width = getSizeWithinRange(originWidth + revisedX, 'width');
      height = getSizeWithinRange(originHeight - revisedY, 'height');
      top = originTop - (height - originHeight);
    } else if (handle === 'top') {
      height = getSizeWithinRange(originHeight - revisedY, 'height');
      top = originTop - (height - originHeight);
    } else if (handle === 'bottom') {
      height = getSizeWithinRange(originHeight + revisedY, 'height');
    } else if (handle === 'left') {
      width = getSizeWithinRange(originWidth - revisedX, 'width');
      left = originLeft - (width - originWidth);
    } else if (handle === 'right') {
      width = getSizeWithinRange(originWidth + revisedX, 'width');
    }

    // Opposite-point correction: capture where the opposite point sat on the
    // ORIGINAL box, recompute it on the resized box, and shift `left`/`top`
    // back by the drift so the opposite handle stays visually fixed.
    const basePoint = getOppositePoint(
      handle,
      getRotateElementPoints(
        { left: originLeft, top: originTop, width: originWidth, height: originHeight },
        rotate,
      ),
    );
    const currentPoint = getOppositePoint(
      handle,
      getRotateElementPoints({ left, top, width, height }, rotate),
    );

    left -= currentPoint.left - basePoint.left;
    top -= currentPoint.top - basePoint.top;

    return { props: { left, top, width, height }, guides };
  }

  // UN-ROTATED path: the pointer delta applies directly, with alignment
  // snapping of the moving corner/edge and simple left/top shifts.
  let moveX = deltaCanvas.x;
  let moveY = deltaCanvas.y;

  // Aspect lock (corners only), pre-snap: same derivation as the rotated path.
  if (fixedRatio) {
    if (handle === 'right-bottom' || handle === 'left-top') moveY = moveX / aspectRatio;
    if (handle === 'left-bottom' || handle === 'right-top') moveY = -moveX / aspectRatio;
  }

  const resolved = resolveSnapping(snapping);
  const lines = resolved
    ? buildAlignLines(
        // Rotated siblings and lines are excluded from resize snap candidates
        // (app parity): a rotated element's axis-aligned bbox edges are not
        // where anything visually aligns, and a line has no box to align to.
        others.filter((o) => o.type !== 'line' && !(o.rotate ?? 0)),
        viewport,
        resolved.opts,
      )
    : null;

  // Snap the MOVING point (the operated corner, or the moving edge on one
  // axis) against the candidate lines, BEFORE clamping. A degenerate
  // single-point range makes `snapRange` probe exactly that point; edge
  // handles suppress the non-moving axis by passing it no candidate lines.
  const snapPoint = (
    probeX: number,
    probeY: number,
    axes: 'both' | 'x' | 'y',
  ): { dx: number; dy: number } => {
    if (!lines || !resolved) return { dx: 0, dy: 0 };
    const {
      dx,
      dy,
      guides: g,
    } = snapRange(
      { minX: probeX, maxX: probeX, minY: probeY, maxY: probeY },
      {
        vertical: axes === 'y' ? [] : lines.vertical,
        horizontal: axes === 'x' ? [] : lines.horizontal,
      },
      resolved.range,
    );
    guides = g;
    return { dx, dy };
  };

  // Post-snap aspect re-lock (corners): if the vertical axis snapped, it wins
  // and the horizontal delta is recomputed from it; otherwise the horizontal
  // delta drives, exactly as in the pre-snap derivation.
  const relockAspect = (dy: number, sign: 1 | -1) => {
    if (!fixedRatio) return;
    if (dy !== 0) moveX = sign * moveY * aspectRatio;
    else moveY = (sign * moveX) / aspectRatio;
  };

  if (handle === 'right-bottom') {
    const { dx, dy } = snapPoint(
      originLeft + originWidth + moveX,
      originTop + originHeight + moveY,
      'both',
    );
    moveX += dx;
    moveY += dy;
    relockAspect(dy, 1);
    width = getSizeWithinRange(originWidth + moveX, 'width');
    height = getSizeWithinRange(originHeight + moveY, 'height');
  } else if (handle === 'left-bottom') {
    const { dx, dy } = snapPoint(originLeft + moveX, originTop + originHeight + moveY, 'both');
    moveX += dx;
    moveY += dy;
    relockAspect(dy, -1);
    width = getSizeWithinRange(originWidth - moveX, 'width');
    height = getSizeWithinRange(originHeight + moveY, 'height');
    left = originLeft - (width - originWidth);
  } else if (handle === 'left-top') {
    const { dx, dy } = snapPoint(originLeft + moveX, originTop + moveY, 'both');
    moveX += dx;
    moveY += dy;
    relockAspect(dy, 1);
    width = getSizeWithinRange(originWidth - moveX, 'width');
    height = getSizeWithinRange(originHeight - moveY, 'height');
    left = originLeft - (width - originWidth);
    top = originTop - (height - originHeight);
  } else if (handle === 'right-top') {
    const { dx, dy } = snapPoint(originLeft + originWidth + moveX, originTop + moveY, 'both');
    moveX += dx;
    moveY += dy;
    relockAspect(dy, -1);
    width = getSizeWithinRange(originWidth + moveX, 'width');
    height = getSizeWithinRange(originHeight - moveY, 'height');
    top = originTop - (height - originHeight);
  } else if (handle === 'left') {
    const { dx } = snapPoint(originLeft + moveX, originTop, 'x');
    moveX += dx;
    width = getSizeWithinRange(originWidth - moveX, 'width');
    left = originLeft - (width - originWidth);
  } else if (handle === 'right') {
    const { dx } = snapPoint(originLeft + originWidth + moveX, originTop, 'x');
    moveX += dx;
    width = getSizeWithinRange(originWidth + moveX, 'width');
  } else if (handle === 'top') {
    const { dy } = snapPoint(originLeft, originTop + moveY, 'y');
    moveY += dy;
    height = getSizeWithinRange(originHeight - moveY, 'height');
    top = originTop - (height - originHeight);
  } else if (handle === 'bottom') {
    const { dy } = snapPoint(originLeft, originTop + originHeight + moveY, 'y');
    moveY += dy;
    height = getSizeWithinRange(originHeight + moveY, 'height');
  }

  return { props: { left, top, width, height }, guides };
}
