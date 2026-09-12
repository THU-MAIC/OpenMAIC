export type RetryDecision = 'retry' | 'fail';

export type RetryOptions = {
  maxRetries?: number;
  signal?: AbortSignal;
  baseDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function abortError(): Error {
  return typeof DOMException !== 'undefined'
    ? new DOMException('Aborted', 'AbortError')
    : Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 300);
  const shouldRetry = options.shouldRetry ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;
  while (true) {
    throwIfAborted(options.signal);
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetry(error, attempt)) throw error;
      attempt += 1;
      await sleep(baseDelayMs * 2 ** (attempt - 1), options.signal);
    }
  }
}
