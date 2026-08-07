import type { PPTElement, PPTLineElement } from '@openmaic/dsl';
import type { LineHandle } from '../types';

/**
 * Pure, store-free core for dragging a line element's handles. Ported from the
 * app's `useDragLineElement` gesture, but with no React/store/DOM: the caller
 * feeds the ORIGINAL element plus a pointer delta already converted to canvas
 * units, and gets back the re-normalized `left/top/start/end` (plus whichever
 * control field the line actually carries). No `@/` imports.
 *
 * All intermediate math runs in ABSOLUTE canvas coordinates derived from the
 * original element; `start`/`end`/control offsets are LOCAL to `left/top`, so
 * we lift them to absolute, apply the delta + snapping, then re-normalize the
 * bbox back down to a fresh local frame.
 */

/** Snap threshold in canvas units (not screen px). Mirrors the app's `sorptionRange`. */
const SNAP_RANGE = 8;

export interface LineDragInput {
  element: PPTLineElement;
  handle: LineHandle;
  deltaCanvas: { x: number; y: number };
  /** Legacy-compatible sibling anchors an endpoint can adsorb to. */
  snapPoints?: readonly LineSnapPoint[];
}

export interface LineSnapPoint {
  readonly x: number;
  readonly y: number;
}

export interface LineDragResult {
  props: {
    left: number;
    top: number;
    start: [number, number];
    end: [number, number];
  } & Partial<Pick<PPTLineElement, 'broken' | 'broken2' | 'curve' | 'cubic'>>;
}

/**
 * The old editor exposes each unrotated non-line element's corners and edge
 * midpoints as endpoint adsorption candidates. Keep the same order so the
 * first matching target wins consistently.
 */
export function getLineSnapPoints(
  elements: readonly PPTElement[],
  excludeId?: string,
): LineSnapPoint[] {
  const points: LineSnapPoint[] = [];
  for (const element of elements) {
    if (element.id === excludeId || element.type === 'line' || element.rotate) continue;
    const right = element.left + element.width;
    const bottom = element.top + element.height;
    const centerX = element.left + element.width / 2;
    const centerY = element.top + element.height / 2;
    points.push(
      { x: centerX, y: element.top },
      { x: centerX, y: bottom },
      { x: element.left, y: centerY },
      { x: right, y: centerY },
      { x: element.left, y: element.top },
      { x: right, y: element.top },
      { x: element.left, y: bottom },
      { x: right, y: bottom },
    );
  }
  return points;
}

function snapEndpointToSibling(
  x: number,
  y: number,
  points: readonly LineSnapPoint[] | undefined,
): LineSnapPoint | null {
  if (!points) return null;
  return (
    points.find(
      (point) => Math.abs(point.x - x) < SNAP_RANGE && Math.abs(point.y - y) < SNAP_RANGE,
    ) ?? null
  );
}

export function computeLineDrag(input: LineDragInput): LineDragResult {
  const { element, handle, deltaCanvas, snapPoints } = input;
  const { left, top } = element;
  const dx = deltaCanvas.x;
  const dy = deltaCanvas.y;

  // Lift endpoints + control points into absolute canvas coordinates.
  let startX = left + element.start[0];
  let startY = top + element.start[1];
  let endX = left + element.end[0];
  let endY = top + element.end[1];

  const mid = element.broken || element.broken2 || element.curve || [0, 0];
  let midX = left + mid[0];
  let midY = top + mid[1];

  const [c1, c2] = element.cubic || [
    [0, 0],
    [0, 0],
  ];
  let c1X = left + c1[0];
  let c1Y = top + c1[1];
  let c2X = left + c2[0];
  let c2Y = top + c2[1];

  // Apply the delta to the dragged handle in absolute space, with axis and
  // legacy-compatible sibling-anchor snapping.
  if (handle === 'start') {
    startX += dx;
    startY += dy;
    if (Math.abs(startX - endX) < SNAP_RANGE) startX = endX;
    if (Math.abs(startY - endY) < SNAP_RANGE) startY = endY;
    const snap = snapEndpointToSibling(startX, startY, snapPoints);
    if (snap) {
      startX = snap.x;
      startY = snap.y;
    }
  } else if (handle === 'end') {
    endX += dx;
    endY += dy;
    if (Math.abs(startX - endX) < SNAP_RANGE) endX = startX;
    if (Math.abs(startY - endY) < SNAP_RANGE) endY = startY;
    const snap = snapEndpointToSibling(endX, endY, snapPoints);
    if (snap) {
      endX = snap.x;
      endY = snap.y;
    }
  } else if (handle === 'ctrl') {
    midX += dx;
    midY += dy;
    if (Math.abs(midX - startX) < SNAP_RANGE) midX = startX;
    if (Math.abs(midY - startY) < SNAP_RANGE) midY = startY;
    if (Math.abs(midX - endX) < SNAP_RANGE) midX = endX;
    if (Math.abs(midY - endY) < SNAP_RANGE) midY = endY;
    if (
      Math.abs(midX - (startX + endX) / 2) < SNAP_RANGE &&
      Math.abs(midY - (startY + endY) / 2) < SNAP_RANGE
    ) {
      midX = (startX + endX) / 2;
      midY = (startY + endY) / 2;
    }
  } else if (handle === 'ctrl1') {
    c1X += dx;
    c1Y += dy;
    if (Math.abs(c1X - startX) < SNAP_RANGE) c1X = startX;
    if (Math.abs(c1Y - startY) < SNAP_RANGE) c1Y = startY;
    if (Math.abs(c1X - endX) < SNAP_RANGE) c1X = endX;
    if (Math.abs(c1Y - endY) < SNAP_RANGE) c1Y = endY;
  } else if (handle === 'ctrl2') {
    c2X += dx;
    c2Y += dy;
    if (Math.abs(c2X - startX) < SNAP_RANGE) c2X = startX;
    if (Math.abs(c2Y - startY) < SNAP_RANGE) c2Y = startY;
    if (Math.abs(c2X - endX) < SNAP_RANGE) c2X = endX;
    if (Math.abs(c2Y - endY) < SNAP_RANGE) c2Y = endY;
  }

  // Re-normalize the bbox: new local frame origin = (minX, minY).
  const minX = Math.min(startX, endX);
  const minY = Math.min(startY, endY);
  const maxX = Math.max(startX, endX);
  const maxY = Math.max(startY, endY);

  const start: [number, number] = [0, 0];
  const end: [number, number] = [maxX - minX, maxY - minY];
  if (startX > endX) {
    start[0] = maxX - minX;
    end[0] = 0;
  }
  if (startY > endY) {
    start[1] = maxY - minY;
    end[1] = 0;
  }

  const props: LineDragResult['props'] = {
    left: minX,
    top: minY,
    start,
    end,
  };

  const localMidpoint: [number, number] = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];

  if (handle === 'start' || handle === 'end') {
    // Endpoint moved: reset the present control(s) to the new local midpoint so
    // the curve/broken stays visually centered on the re-normalized segment.
    // deferred: Ctrl/Shift would keep control point in place.
    if (element.broken) props.broken = [localMidpoint[0], localMidpoint[1]];
    if (element.curve) props.curve = [localMidpoint[0], localMidpoint[1]];
    if (element.cubic)
      props.cubic = [
        [localMidpoint[0], localMidpoint[1]],
        [localMidpoint[0], localMidpoint[1]],
      ];
    // broken2 is always reset to the midpoint on an endpoint drag.
    if (element.broken2) props.broken2 = [localMidpoint[0], localMidpoint[1]];
  } else if (handle === 'ctrl') {
    // Single control point dragged: recompute its local offset from the new origin.
    if (element.broken) props.broken = [midX - minX, midY - minY];
    if (element.curve) props.curve = [midX - minX, midY - minY];
    if (element.broken2) {
      // broken2 tracks only the dominant axis; the other axis keeps its offset.
      if (maxX - minX >= maxY - minY) {
        props.broken2 = [midX - minX, element.broken2[1]];
      } else {
        props.broken2 = [element.broken2[0], midY - minY];
      }
    }
  } else if (handle === 'ctrl1' || handle === 'ctrl2') {
    if (element.cubic) {
      props.cubic = [
        [c1X - minX, c1Y - minY],
        [c2X - minX, c2Y - minY],
      ];
    }
  }

  return { props };
}
