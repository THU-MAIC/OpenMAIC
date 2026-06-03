import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from '@/lib/utils/concurrency';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    // Later items resolve first, but results must stay aligned with input.
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms, i) => {
      await tick(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it('never runs more than `limit` workers at once', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 9 }, (_, i) => i),
      3,
      async (n) => {
        active += 1;
        peak = Math.max(peak, active);
        await tick();
        active -= 1;
        return n;
      },
    );
    expect(peak).toBe(3); // saturated the pool…
  });

  it('clamps the limit to the item count (no over-spawn)', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2], 100, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(out).toEqual([1, 2]);
  });

  it('stops pulling new items once shouldContinue() turns false', async () => {
    const processed: number[] = [];
    let done = 0;
    await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      1,
      async (n) => {
        processed.push(n);
        done += 1;
        return n;
      },
      { shouldContinue: () => done < 3 },
    );
    // limit 1 + stop after 3 ⇒ items 4–6 are never started.
    expect(processed).toEqual([1, 2, 3]);
  });

  it('handles an empty list without spawning workers', async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
  });
});
