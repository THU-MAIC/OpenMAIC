import { describe, expect, test } from 'vitest';
import { intersectClientBoxes } from '@/lib/edit/visible-client-rect';

describe('intersectClientBoxes', () => {
  test('clips a tall card to the host so the top no longer covers a header', () => {
    const card = { left: 100, top: 40, width: 1600, height: 900 };
    const host = { left: 100, top: 120, width: 1600, height: 500 };
    expect(intersectClientBoxes(card, host)).toEqual({
      left: 100,
      top: 120,
      width: 1600,
      height: 500,
    });
  });

  test('returns a zero box when the ranges miss', () => {
    expect(
      intersectClientBoxes(
        { left: 0, top: 0, width: 10, height: 10 },
        { left: 20, top: 20, width: 10, height: 10 },
      ),
    ).toEqual({ left: 20, top: 20, width: 0, height: 0 });
  });
});
