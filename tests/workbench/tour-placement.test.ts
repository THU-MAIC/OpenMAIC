/**
 * The tour card is always wholly on screen, a margin clear of every edge,
 * whatever it points at: a tall block at the foot of the rail, a wide target
 * with no room above or below it, a window shorter than the card itself.
 */

import { describe, expect, it } from 'vitest';
import {
  placeTourCard,
  TOUR_CARD_W,
  TOUR_GAP,
  TOUR_MARGIN,
  type TourRect,
} from '@/components/workbench/workspace/tour-placement';

function expectOnScreen(
  rect: TourRect | null,
  cardH: number,
  vw: number,
  vh: number,
): ReturnType<typeof placeTourCard> {
  const card = placeTourCard(rect, cardH, vw, vh);
  const h = Math.min(cardH, card.maxHeight);
  expect(card.x).toBeGreaterThanOrEqual(TOUR_MARGIN);
  expect(card.x + TOUR_CARD_W).toBeLessThanOrEqual(vw - TOUR_MARGIN);
  expect(card.y).toBeGreaterThanOrEqual(TOUR_MARGIN);
  expect(card.y + h).toBeLessThanOrEqual(vh - TOUR_MARGIN);
  return card;
}

describe('placeTourCard', () => {
  it('centres the card when there is nothing to point at', () => {
    expect(placeTourCard(null, 200, 1440, 900)).toEqual({
      x: (1440 - TOUR_CARD_W) / 2,
      y: 350,
      maxHeight: 900 - TOUR_MARGIN * 2,
    });
  });

  it('puts the card beside a narrow target, level with its middle', () => {
    const card = expectOnScreen({ x: 0, y: 300, w: 260, h: 100 }, 200, 1440, 900);
    expect(card.x).toBe(260 + TOUR_GAP);
    expect(card.y).toBe(250);
  });

  it('keeps the card on screen beside a tall block at the foot of the rail', () => {
    // The account block with extra controls above it, flush with the bottom.
    const card = expectOnScreen({ x: 0, y: 560, w: 276, h: 200 }, 230, 1280, 760);
    expect(card.x).toBe(276 + TOUR_GAP);
    expect(card.y).toBe(760 - 230 - TOUR_MARGIN);
  });

  it('puts the card under a wide target, or above it when there is no room below', () => {
    const under = expectOnScreen({ x: 300, y: 100, w: 800, h: 120 }, 200, 1440, 900);
    expect(under.y).toBe(100 + 120 + TOUR_GAP);
    const over = expectOnScreen({ x: 300, y: 600, w: 800, h: 200 }, 200, 1440, 900);
    expect(over.y).toBe(600 - TOUR_GAP - 200);
  });

  it('keeps the card on screen when a wide target leaves no room above or below', () => {
    // Too short for the card on either side: inside the target's bottom edge.
    const card = expectOnScreen({ x: 200, y: 150, w: 900, h: 400 }, 260, 1280, 640);
    expect(card.y).toBe(150 + 400 - 260 - TOUR_GAP);
  });

  it('pulls the card back when the target itself runs off the bottom', () => {
    const card = expectOnScreen({ x: 200, y: 100, w: 900, h: 900 }, 260, 1280, 640);
    expect(card.y).toBe(640 - 260 - TOUR_MARGIN);
  });

  it('caps a card taller than the window so it scrolls on screen', () => {
    const card = expectOnScreen({ x: 0, y: 200, w: 260, h: 80 }, 520, 1024, 400);
    expect(card.maxHeight).toBe(400 - TOUR_MARGIN * 2);
    expect(card.y).toBe(TOUR_MARGIN);
  });

  it('never leaves the screen, for any target in any window', () => {
    // The tour runs from `md` (768px) up, in windows as short as a laptop's
    // with the browser's own chrome, and shorter.
    const widths = [768, 1024, 1280, 1440, 1920];
    const heights = [320, 480, 600, 720, 900, 1200];
    const cards = [120, 200, 320, 480, 700];
    for (const vw of widths) {
      for (const vh of heights) {
        for (const cardH of cards) {
          for (let i = 0; i < 40; i += 1) {
            // Deterministic spread of targets: narrow and wide, short and
            // tall, inside the window and spilling past its edges.
            const w = 20 + ((i * 97) % vw);
            const h = 20 + ((i * 53) % (vh + 200));
            const x = ((i * 131) % (vw + 100)) - 50;
            const y = ((i * 71) % (vh + 100)) - 50;
            expectOnScreen({ x, y, w, h }, cardH, vw, vh);
          }
        }
      }
    }
  });
});
