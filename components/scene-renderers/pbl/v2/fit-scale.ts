/**
 * PBL v2 — fit-to-container scale math.
 *
 * The PBL Hero (and other poster-style PBL pages) render as ordinary DOM
 * inside the stage's fixed 16:9 box, which is `overflow-hidden` and does not
 * scroll. A slide deck stays fully visible at any browser zoom because it is
 * painted at a fixed design size and scaled to fit its box; a flowed DOM page
 * instead clips its bottom (e.g. the launch button) once the box gets shorter
 * than the content's natural height.
 *
 * This returns the uniform scale that shrinks `content` to fit inside
 * `container`, matching that slide behaviour. It only ever scales DOWN — a
 * page that already fits is left at its natural size (never blown up).
 *
 * Pure (no DOM) so the fit decision is unit-testable; the component supplies
 * the measured dimensions.
 */
export function computeFitScale(args: {
  containerWidth: number;
  containerHeight: number;
  contentWidth: number;
  contentHeight: number;
}): number {
  const { containerWidth, containerHeight, contentWidth, contentHeight } = args;
  // Unmeasured / degenerate dimensions (initial render, hidden node): render
  // at natural size rather than collapsing to 0.
  if (
    !Number.isFinite(containerWidth) ||
    !Number.isFinite(containerHeight) ||
    !Number.isFinite(contentWidth) ||
    !Number.isFinite(contentHeight) ||
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    contentWidth <= 0 ||
    contentHeight <= 0
  ) {
    return 1;
  }
  return Math.min(1, containerWidth / contentWidth, containerHeight / contentHeight);
}
