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
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Operation aborted'));
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: undefined as (() => void) | undefined };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          reject(signal.reason ?? new Error('Operation aborted'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      next.resolve();
    } else this.available += 1;
  }
}
