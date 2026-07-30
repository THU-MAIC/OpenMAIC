/** A FIFO counting semaphore: at most `size` `run()` callbacks execute at once. */
function createSemaphore(size: number) {
  const max = Math.max(1, Math.floor(size));
  let active = 0;
  const queue: Array<() => void> = [];

  const pump = () => {
    while (active < max && queue.length > 0) {
      active += 1;
      const start = queue.shift()!;
      start();
    }
  };

  return {
    run<R>(fn: () => Promise<R>): Promise<R> {
      return new Promise<R>((resolve, reject) => {
        queue.push(() => {
          fn()
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              pump();
            });
        });
        pump();
      });
    },
  };
}

/**
 * Start `fn` over every item with at most `limit` calls in flight at once, and
 * return one promise per item **immediately**, in input order — without awaiting
 * them. Each item acquires a `limit`-sized semaphore slot before `fn` runs, so
 * all the promises exist up front but only `limit` execute concurrently.
 *
 * This is the no-barrier primitive: the caller can `await` the promises in any
 * order (e.g. sequentially) and each resolves as soon as *its* work is done,
 * while later items keep running in the background. `shouldContinue` is checked
 * when an item reaches the front of the queue; once it returns false, the
 * remaining items resolve to `undefined` without running `fn`.
 *
 * `limit` is clamped to `[1, items.length]`, so a raw/too-large concurrency is
 * safe to pass.
 */
export function lazyBoundedMap<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options?: { shouldContinue?: () => boolean },
): Array<Promise<R | undefined>> {
  const shouldContinue = options?.shouldContinue ?? (() => true);
  const semaphore = createSemaphore(Math.min(Math.floor(limit), items.length || 1));
  return items.map((item, index) =>
    semaphore.run(async () => (shouldContinue() ? fn(item, index) : undefined)),
  );
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight at once and await
 * them all (a barrier). Results are returned in input order; a slot is
 * `undefined` if its item was skipped because `shouldContinue` turned false.
 *
 * Prefer {@link lazyBoundedMap} when you can consume results incrementally —
 * this wrapper waits for every item before returning.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options?: { shouldContinue?: () => boolean },
): Promise<Array<R | undefined>> {
  return Promise.all(lazyBoundedMap(items, limit, fn, options));
}

/** Resolve after `ms`, or reject with an AbortError if `signal` fires first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryOptions {
  /** Additional attempts after the first (total attempts = retries + 1). */
  retries?: number;
  /** Backoff base in ms; nominal delay = baseDelayMs * 2 ** attempt. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff delay. */
  maxDelayMs?: number;
  /** Abort the whole retry loop (e.g. user cancelled or unmounted). */
  signal?: AbortSignal;
  /** Return false to stop retrying a particular error (default: always retry). */
  shouldRetry?: (err: unknown) => boolean;
  /** Observe each retry, e.g. for logging. */
  onRetry?: (err: unknown, attempt: number) => void;
}

/**
 * Run `fn`, retrying on rejection with exponential backoff + jitter. The
 * attempt index (0-based) is passed to `fn`. Honors an AbortSignal between
 * attempts and during backoff sleeps.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    retries = 2,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    signal,
    shouldRetry = () => true,
    onRetry,
  } = options;

  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      onRetry?.(err, attempt);
      const nominal = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      // Half fixed, half random jitter — spreads retries to avoid storms.
      const delay = nominal / 2 + Math.random() * (nominal / 2);
      await sleep(delay, signal);
      attempt += 1;
    }
  }
}
