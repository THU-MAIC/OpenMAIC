/** Stop awaiting uncooperative work; its continuation must still enforce its write fence. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(signal.reason ?? new Error('Execution aborted.'));
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error('Execution aborted.'));
    signal.addEventListener('abort', aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
