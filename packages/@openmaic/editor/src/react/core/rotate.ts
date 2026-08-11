import type { PPTElement } from '@openmaic/dsl';

/**
 * Pure, store-free core for the rotate gesture. Ported from the app's
 * rotate-element gesture, but with no React/store/DOM: the caller feeds the
 * ORIGINAL element's box plus the pointer position already converted to canvas
 * units, and gets back the new signed rotation angle. No `@/` imports — this
 * module only consumes the DSL element shape and plain numbers.
 */

/** Snap threshold (degrees) around the 45deg multiples. Mirrors the app. */
export const ROTATE_SNAP_RANGE = 5;

/**
 * Element kinds that expose a rotate handle (app parity): the app's operate
 * layer renders no rotate handle for charts, video, or audio (and lines have
 * no `rotate` at all; code blocks render no operate handles whatsoever).
 */
const ROTATABLE_TYPES: ReadonlySet<PPTElement['type']> = new Set([
  'text',
  'image',
  'shape',
  'table',
  'latex',
]);

/** Whether an element kind supports the rotate gesture. */
export function canRotate(element: PPTElement): boolean {
  return ROTATABLE_TYPES.has(element.type);
}

/**
 * Angle (degrees) of the ray from the origin to `(x, y)`, measured CLOCKWISE
 * from straight up — matching CSS `rotate()` — via `atan2(x, y)` (note the
 * argument order: x first). Range `(-180, 180]`.
 */
function getAngleFromCoordinate(x: number, y: number): number {
  const radian = Math.atan2(x, y);
  return (180 / Math.PI) * radian;
}

/**
 * Rotate input for one gesture tick: the ORIGINAL element's box (the rotation
 * center is its center and never moves during the gesture) and the pointer
 * position in canvas units.
 */
export interface RotateInput {
  element: { left: number; top: number; width: number; height: number };
  pointerCanvas: { x: number; y: number };
}

/**
 * The new rotation for a box whose rotate handle is dragged to `pointerCanvas`:
 * the CSS-clockwise angle of center->pointer measured from straight up, snapped
 * to the nearest multiple of 45deg when within {@link ROTATE_SNAP_RANGE}. The
 * result is SIGNED in `(-180, 180]` (never normalized to `[0, 360)`), matching
 * how the app stores `rotate`.
 */
export function computeRotate(input: RotateInput): number {
  const { element, pointerCanvas } = input;

  const centerX = element.left + element.width / 2;
  const centerY = element.top + element.height / 2;

  // Screen-y grows downward, so invert the vertical component to measure the
  // angle in the y-up frame `getAngleFromCoordinate` expects.
  const x = pointerCanvas.x - centerX;
  const y = centerY - pointerCanvas.y;

  let angle = getAngleFromCoordinate(x, y);

  // Snap to multiples of 45deg when close (0, +-45, +-90, +-135, +-180).
  if (Math.abs(angle) <= ROTATE_SNAP_RANGE) angle = 0;
  else if (angle > 0 && Math.abs(angle - 45) <= ROTATE_SNAP_RANGE) angle = 45;
  else if (angle < 0 && Math.abs(angle + 45) <= ROTATE_SNAP_RANGE) angle = -45;
  else if (angle > 0 && Math.abs(angle - 90) <= ROTATE_SNAP_RANGE) angle = 90;
  else if (angle < 0 && Math.abs(angle + 90) <= ROTATE_SNAP_RANGE) angle = -90;
  else if (angle > 0 && Math.abs(angle - 135) <= ROTATE_SNAP_RANGE) angle = 135;
  else if (angle < 0 && Math.abs(angle + 135) <= ROTATE_SNAP_RANGE) angle = -135;
  else if (angle > 0 && Math.abs(angle - 180) <= ROTATE_SNAP_RANGE) angle = 180;
  else if (angle < 0 && Math.abs(angle + 180) <= ROTATE_SNAP_RANGE) angle = -180;

  return angle;
}
