/**
 * The provider's own final answer for a task: it failed (or finished without
 * a result). Waiting on the task again cannot change it; every other failure
 * of a wait (a poll that timed out or errored) leaves the task as it was.
 */
export class ProviderTaskFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderTaskFailedError';
  }
}

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

/** How a caller follows a provider task it may have to wait on again later. */
export interface PolledTaskControl {
  /**
   * Told the provider's task id once the task is submitted, before the first
   * wait, so a caller can record it and resume the wait elsewhere. A
   * submission that is already terminal (done or failed) has nothing to wait
   * on or resume, so this is not called for it. When this rejects, the wait
   * is abandoned with that error although the provider task was submitted.
   */
  onSubmitted?: (taskId: string) => void | Promise<void>;
  /**
   * Wait on this task, submitted earlier, instead of submitting a new one.
   * The resumed wait gets a fresh poll budget (`maxAttempts`), not what was
   * left of the original one. An empty id is an error, never a new task.
   */
  resumeTaskId?: string;
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
  control?: PolledTaskControl;
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
  control,
}: RunPolledTaskOptions<T>): Promise<T> {
  let taskId = control?.resumeTaskId;
  if (taskId !== undefined && !taskId.trim()) {
    throw new Error(`${label}: cannot resume a task without an id`);
  }
  if (taskId === undefined) {
    const submitted = await submit();
    if (submitted.status === 'done') return submitted.result;
    if (submitted.status === 'failed') throw new ProviderTaskFailedError(submitted.message);
    taskId = submitted.taskId;
    await control?.onSubmitted?.(taskId);
  }

  let attempts = 0;
  let lastPendingDetail: string | undefined;

  while (attempts < maxAttempts) {
    await delay(intervalMs, signal);
    const result = await poll(taskId);
    attempts++;

    if (result.status === 'done') return result.result;
    if (result.status === 'failed') throw new ProviderTaskFailedError(result.message);
    lastPendingDetail = result.detail;
  }

  const timeoutContext: PolledTaskTimeoutContext = {
    label,
    taskId,
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
