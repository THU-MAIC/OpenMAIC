import { describe, expect, it } from 'vitest';

import { lazyBoundedMap, mapWithConcurrency } from '@/lib/utils/concurrency';

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
    expect(peak).toBeLessThanOrEqual(3); // never exceeds the pool
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

describe('lazyBoundedMap', () => {
  it('returns promises immediately and resolves them without a barrier', async () => {
    const started: number[] = [];
    const promises = lazyBoundedMap([0, 1, 2], 1, async (n) => {
      started.push(n);
      await tick();
      return n * 10;
    });
    expect(promises).toHaveLength(3); // the array of promises exists synchronously
    expect(await promises[0]).toBe(0); // the first resolves on its own…
    expect(started.length).toBeLessThan(3); // …without forcing the last item to run (no barrier)
    expect(await Promise.all(promises)).toEqual([0, 10, 20]); // order + values preserved
  });

  it('caps in-flight work at `limit`', async () => {
    let active = 0;
    let peak = 0;
    await Promise.all(
      lazyBoundedMap(
        Array.from({ length: 8 }, (_, i) => i),
        3,
        async (n) => {
          active += 1;
          peak = Math.max(peak, active);
          await tick();
          active -= 1;
          return n;
        },
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('skips items via shouldContinue without running fn', async () => {
    const ran: number[] = [];
    let done = 0;
    const out = await Promise.all(
      lazyBoundedMap(
        [1, 2, 3, 4, 5],
        1,
        async (n) => {
          ran.push(n);
          done += 1;
          return n;
        },
        { shouldContinue: () => done < 2 },
      ),
    );
    expect(ran).toEqual([1, 2]); // fn ran only twice
    expect(out).toEqual([1, 2, undefined, undefined, undefined]); // skipped → undefined
  });
});
