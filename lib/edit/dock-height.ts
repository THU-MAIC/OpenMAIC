/** The classroom dock's height, in px, border included. */
export const DOCK_DEFAULT_HEIGHT = 192;
export const DOCK_MIN_HEIGHT = 150;
export const DOCK_MAX_HEIGHT = 480;
/** Folded: the control bar and the border above it, in both modes. */
export const DOCK_FOLDED_HEIGHT = 33;
/** The least the canvas keeps, however tall the dock is asked to be. */
export const DOCK_MIN_CANVAS_HEIGHT = 240;
export const DOCK_KEYBOARD_STEP = 16;

/** A height the dock can take in a host this tall; before it is measured, any it may ever. */
export function clampDockHeight(height: number, hostHeight: number | null): number {
  const room = hostHeight === null ? DOCK_MAX_HEIGHT : hostHeight - DOCK_MIN_CANVAS_HEIGHT;
  return Math.max(DOCK_MIN_HEIGHT, Math.min(height, DOCK_MAX_HEIGHT, room));
}
