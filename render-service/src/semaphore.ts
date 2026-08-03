/**
 * A minimal counting semaphore for bounding concurrency of an async section.
 *
 * Used to cap how many archive extractions run at once: extraction holds the
 * expanded archive in memory, so without a bound a burst of admitted jobs would
 * multiply the per-archive RAM ceiling. `run()` acquires a permit, runs the
 * task, and always releases — FIFO, so callers don't starve.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }
}
