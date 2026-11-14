/**
 * Where the tour's card goes, as pure arithmetic over the lit box, the card's
 * height and the viewport (`WorkspaceTour` measures, this decides).
 *
 * The one promise: the card is always wholly on screen, `TOUR_MARGIN` clear of
 * every edge, whatever the target's size or position and however short the
 * window is. Every candidate position is clamped, and a card taller than the
 * window is capped (`maxHeight`) and scrolls inside rather than running off it.
 */

export type TourRect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

export interface TourCardPlacement {
  readonly x: number;
  readonly y: number;
  /** The tallest the card may be and still fit; it scrolls past this. */
  readonly maxHeight: number;
}

/** Space between the lit box and the card. */
export const TOUR_GAP = 14;
/** Space the card always keeps from the viewport's edges. */
export const TOUR_MARGIN = 12;
export const TOUR_CARD_W = 340;

/**
 * Beside a narrow target (the rail, a card), under a wide one (the composer),
 * above it when there is no room below; when neither side has room (a tall
 * target, a short window), inside the target's bottom edge. Each of those is
 * then clamped on screen.
 */
export function placeTourCard(
  rect: TourRect | null,
  cardH: number,
  vw: number,
  vh: number,
): TourCardPlacement {
  const maxHeight = Math.max(0, vh - TOUR_MARGIN * 2);
  // The card as it will be drawn: never taller than the window allows.
  const h = Math.min(Math.max(0, cardH), maxHeight);
  const clampX = (x: number) => Math.max(TOUR_MARGIN, Math.min(x, vw - TOUR_CARD_W - TOUR_MARGIN));
  const clampY = (y: number) => Math.max(TOUR_MARGIN, Math.min(y, vh - h - TOUR_MARGIN));
  const at = (x: number, y: number): TourCardPlacement => ({
    x: clampX(x),
    y: clampY(y),
    maxHeight,
  });

  if (!rect) return at((vw - TOUR_CARD_W) / 2, (vh - h) / 2);

  const roomRight = vw - (rect.x + rect.w) - TOUR_GAP - TOUR_MARGIN;
  const roomLeft = rect.x - TOUR_GAP - TOUR_MARGIN;
  const narrow = rect.w < vw * 0.4;
  const besideY = rect.y + rect.h / 2 - h / 2;
  if (narrow && roomRight >= TOUR_CARD_W) return at(rect.x + rect.w + TOUR_GAP, besideY);
  if (narrow && roomLeft >= TOUR_CARD_W) return at(rect.x - TOUR_GAP - TOUR_CARD_W, besideY);

  const cx = rect.x + rect.w / 2 - TOUR_CARD_W / 2;
  const below = rect.y + rect.h + TOUR_GAP;
  const above = rect.y - TOUR_GAP - h;
  const roomBelow = vh - TOUR_MARGIN - below;
  const roomAbove = above + h - TOUR_MARGIN;
  if (roomBelow >= h) return at(cx, below);
  if (roomAbove >= h) return at(cx, above);
  // Nothing fits outside a tall target: sit inside its bottom edge, pulled
  // back on screen when that edge is itself off it.
  return at(cx, rect.y + rect.h - h - TOUR_GAP);
}
