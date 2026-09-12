/**
 * Poll `fn` every ~5ms (bounded at 100 attempts) until it returns a non-null
 * value. Shared by the route tests' job-status polling and the coordinator
 * tests' settle checks so both fail with a descriptive timeout message
 * instead of a bare assertion.
 */
export async function waitUntil<T>(
  fn: () => T | null | undefined | Promise<T | null | undefined>,
  what: string,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await fn();
    if (value != null) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
