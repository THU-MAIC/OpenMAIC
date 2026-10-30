import type { SendEvent } from './types';

/** Stop waiting for delivery on cancellation, and reject any later dispatch. */
export function createAbortableSend(send: SendEvent, signal: AbortSignal): SendEvent {
  return async (event) => {
    signal.throwIfAborted();
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        // The sender may finish after cancellation. Its result is observed, but
        // callers must not resume the remaining action batch or normal teardown.
        Promise.resolve(send(event)).then(resolve, reject);
      });
      signal.throwIfAborted();
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
}
