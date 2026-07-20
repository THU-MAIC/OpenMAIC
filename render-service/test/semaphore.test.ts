/**
 * The extraction semaphore bounds how many archive expansions run at once, so a
 * burst of admitted jobs can't stack the per-archive RAM ceiling. It must never
 * run more than `permits` tasks concurrently, and must always release (even when
 * a task throws) so it can't wedge.
 */
import { describe, it, expect } from 'vitest';
import { Semaphore } from '../src/semaphore.js';

/** A deferred we can resolve from the test to control task completion timing. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('Semaphore', () => {
  it('never exceeds the permit count concurrently', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred(), deferred()];

    const runs = gates.map((g, i) =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await g.promise;
        active--;
        return i;
      }),
    );

    // Let the first wave schedule, then release tasks one at a time.
    await Promise.resolve();
    expect(active).toBeLessThanOrEqual(2);
    gates.forEach((g) => g.resolve());
    const results = await Promise.all(runs);

    expect(peak).toBe(2); // exactly the permit count, never more
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it('releases the permit when a task throws', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // If the failed task leaked its permit, this would hang; it resolves instead.
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('runs tasks when permits are available without blocking', async () => {
    const sem = new Semaphore(3);
    const results = await Promise.all([
      sem.run(async () => 1),
      sem.run(async () => 2),
      sem.run(async () => 3),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });
});
