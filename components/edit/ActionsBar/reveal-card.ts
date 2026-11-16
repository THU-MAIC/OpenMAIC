/** The least room left around a card brought into view. */
const REVEAL_MARGIN_PX = 16;

/**
 * Where to scroll the track so a card is in view: nowhere if it already is, otherwise
 * the near edge with a little room, or its start when it is wider than the track.
 */
export function revealScrollLeft({
  scrollLeft,
  trackLeft,
  trackWidth,
  cardLeft,
  cardWidth,
}: {
  scrollLeft: number;
  trackLeft: number;
  trackWidth: number;
  cardLeft: number;
  cardWidth: number;
}): number {
  const start = cardLeft - trackLeft;
  const end = start + cardWidth;
  if (start >= 0 && end <= trackWidth) return scrollLeft;
  if (start < 0 || cardWidth + REVEAL_MARGIN_PX * 2 > trackWidth) {
    return Math.max(0, scrollLeft + start - REVEAL_MARGIN_PX);
  }
  return scrollLeft + end - trackWidth + REVEAL_MARGIN_PX;
}
