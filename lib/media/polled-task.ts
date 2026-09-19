export type TerminalResult<T> =
  | { status: 'done'; result: T }
  | { status: 'failed'; message: string };

export type SubmitResult<T> = { status: 'submitted'; taskId: string } | TerminalResult<T>;

export type PollResult<T> = { status: 'pending'; detail?: string } | TerminalResult<T>;

export interface PolledTaskTimeoutContext {
  label: string;
  taskId: string;
  attempts: number;
  intervalMs: number;
  elapsedMs: number;
  lastPendingDetail?: string;
}

export interface RunPolledTaskOptions<T> {
  submit: () => Promise<SubmitResult<T>>;
  poll: (taskId: string) => Promise<PollResult<T>>;
  intervalMs: number;
  maxAttempts: number;
  label: string;
  formatTimeout?: (context: PolledTaskTimeoutContext) => string;
  /**
   * Cancels the wait between polls. Without it a cancelled generation still
   * sleeps out its full interval before noticing, so an abort can take a whole
   * poll period to take effect.
   */
  signal?: AbortSignal;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runPolledTask<T>({
  submit,
  poll,
  intervalMs,
  maxAttempts,
  label,
  formatTimeout,
  signal,
}: RunPolledTaskOptions<T>): Promise<T> {
  const submitted = await submit();
  if (submitted.status === 'done') return submitted.result;
  if (submitted.status === 'failed') throw new Error(submitted.message);

  let attempts = 0;
  let lastPendingDetail: string | undefined;

  while (attempts < maxAttempts) {
    await delay(intervalMs, signal);
    const result = await poll(submitted.taskId);
    attempts++;

    if (result.status === 'done') return result.result;
    if (result.status === 'failed') throw new Error(result.message);
    lastPendingDetail = result.detail;
  }

  const timeoutContext: PolledTaskTimeoutContext = {
    label,
    taskId: submitted.taskId,
    attempts,
    intervalMs,
    elapsedMs: attempts * intervalMs,
    lastPendingDetail,
  };
  const message = formatTimeout
    ? formatTimeout(timeoutContext)
    : `${label} timed out after ${attempts} polls`;
  throw new Error(message);
}
