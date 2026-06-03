/**
 * Run `fn` over `items` with at most `limit` calls in flight at once.
 *
 * Workers pull from a shared cursor, so a slow item never blocks the others —
 * wall-clock is the slowest single chain, not the sum. Results are returned in
 * input order; a slot is `undefined` if its worker was never started because
 * `shouldContinue` turned false first (in-flight work still settles).
 *
 * `limit` is clamped to `[1, items.length]`, so callers can pass a raw,
 * possibly-too-large concurrency without over-spawning.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options?: { shouldContinue?: () => boolean },
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length);
  const shouldContinue = options?.shouldContinue ?? (() => true);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length && shouldContinue()) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };

  if (items.length === 0) return results;
  const poolSize = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}
