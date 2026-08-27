/**
 * Whiteboard viewport geometry.
 *
 * `viewportRatio` is the sheet's height/width: the canonical 16:9 landscape
 * board (1000 x 562.5) is `9 / 16` (0.5625), never `16 / 9`. Every writer in
 * the repo emits height/width, so a persisted value > 1 is an inverted
 * (width/height) 16:9 ratio written by the old stage API and must be repaired
 * wherever the data is consumed.
 */

/** Plausible height/width band for a whiteboard sheet: landscape to square. */
export const MIN_WHITEBOARD_VIEWPORT_RATIO = 0.4;
export const MAX_WHITEBOARD_VIEWPORT_RATIO = 1;

/**
 * Normalize a height/width viewport ratio into the plausible band:
 * an inverted value (> 1, i.e. width/height such as 16/9) is reciprocated,
 * and an implausibly small value is clamped up. Non-finite persisted values
 * fall back to the canonical 16:9 ratio. Shared by the runtime importers,
 * validators, and the canvas consumption site.
 */
export function normalizeWhiteboardViewportRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 9 / 16;
  const repaired = ratio > 1 ? 1 / ratio : ratio;
  return Math.min(Math.max(repaired, MIN_WHITEBOARD_VIEWPORT_RATIO), MAX_WHITEBOARD_VIEWPORT_RATIO);
}
