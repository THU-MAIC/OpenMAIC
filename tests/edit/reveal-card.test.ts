import { describe, expect, it } from 'vitest';
import { revealScrollLeft } from '@/components/edit/ActionsBar/reveal-card';

const at = (scrollLeft: number, cardLeft: number, cardWidth = 340, trackWidth = 760) =>
  revealScrollLeft({ scrollLeft, trackLeft: 100, trackWidth, cardLeft, cardWidth });

describe('revealScrollLeft', () => {
  it('leaves a card already in view where it is', () => {
    expect(at(120, 200)).toBe(120);
  });
  it('scrolls forward to a card past the end, with room after it', () => {
    expect(at(0, 900)).toBe(900 - 100 + 340 - 760 + 16);
  });
  it('scrolls back to a card before the start', () => {
    expect(at(500, 40)).toBe(500 - 60 - 16);
  });
  it('shows the start of a card wider than the track', () => {
    expect(at(0, 900, 340, 300)).toBe(800 - 16);
  });
  it('never scrolls past the start', () => {
    expect(at(10, 90)).toBe(0);
  });
});
