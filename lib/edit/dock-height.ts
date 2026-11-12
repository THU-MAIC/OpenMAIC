/** The classroom dock's height, in px, border included. */
export const DOCK_DEFAULT_HEIGHT = 192;
export const DOCK_MIN_HEIGHT = 150;
export const DOCK_MAX_HEIGHT = 480;
/** Folded: the control bar and the border above it, in both modes. */
export const DOCK_FOLDED_HEIGHT = 33;
/**
 * Dragging the dock's edge down until its unclamped height is below this folds it,
 * mid-drag; 50px past the minimum, so a drag to the minimum never folds by accident.
 */
export const DOCK_COLLAPSE_BELOW = 100;
/** The least the canvas keeps, however tall the dock is asked to be. */
export const DOCK_MIN_CANVAS_HEIGHT = 240;
export const DOCK_KEYBOARD_STEP = 16;

/** A height the dock can take in a host this tall; before it is measured, any it may ever. */
export function clampDockHeight(height: number, hostHeight: number | null): number {
  const room = hostHeight === null ? DOCK_MAX_HEIGHT : hostHeight - DOCK_MIN_CANVAS_HEIGHT;
  return Math.max(DOCK_MIN_HEIGHT, Math.min(height, DOCK_MAX_HEIGHT, room));
}

/** What the dock keeps around its speech bubble: the control bar and the padding. */
const BUBBLE_INSET = 82;
const BUBBLE_MIN_MAX_HEIGHT = 40;
/** The bubble at the default height, sized to a sentence or two. */
const BUBBLE_WIDTH = 420;
/** Wide enough for a long script, short enough to keep the eye on the line. */
const BUBBLE_READING_WIDTH = 720;
/** From here on the bubble is the reading surface: as tall as the dock lets it be. */
const BUBBLE_FULL_AT = 300;

/**
 * The bubble's box in a dock this tall. At the default height and below it hugs its
 * text; pulled taller it grows by degrees until it fills the dock, so no pixel of a
 * drag makes it jump.
 */
export function dockBubbleBox(dockHeight: number) {
  const maxHeight = Math.max(dockHeight - BUBBLE_INSET, BUBBLE_MIN_MAX_HEIGHT);
  const grown = Math.min(
    Math.max((dockHeight - DOCK_DEFAULT_HEIGHT) / (BUBBLE_FULL_AT - DOCK_DEFAULT_HEIGHT), 0),
    1,
  );
  return {
    maxHeight,
    minHeight: Math.round(maxHeight * grown),
    width: Math.round(BUBBLE_WIDTH + (BUBBLE_READING_WIDTH - BUBBLE_WIDTH) * grown),
  };
}

/** The same box as custom properties on the dock, for the bubble's own classes to read. */
export function dockBubbleVars(dockHeight: number): Record<`--${string}`, string> {
  const { maxHeight, minHeight, width } = dockBubbleBox(dockHeight);
  return {
    '--dock-bubble-max': `${maxHeight}px`,
    '--dock-bubble-min': `${minHeight}px`,
    '--dock-bubble-width': `${width}px`,
  };
}
