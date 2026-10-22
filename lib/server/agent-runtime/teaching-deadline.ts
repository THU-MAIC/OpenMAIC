/** Teaching turns may span several model/tool calls. Bound inactivity, not normal progress. */
export function teachingDeadline(signal: AbortSignal, expire: (error: Error) => void) {
  const idleMs = 120_000;
  const maxMs = 600_000;
  const started = Date.now();
  let phase = 'setup';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const dispose = () => {
    disposed = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', dispose);
  };
  const activity = (nextPhase = phase) => {
    if (disposed || signal.aborted) return;
    phase = nextPhase;
    clearTimeout(timer);
    const remaining = maxMs - (Date.now() - started);
    timer = setTimeout(
      () => {
        dispose();
        expire(
          new Error(
            remaining <= idleMs
              ? 'Teaching turn timed out at the 600 second safety limit.'
              : `Teaching turn timed out after 120 seconds without progress (${phase}).`,
          ),
        );
      },
      Math.max(0, Math.min(idleMs, remaining)),
    );
    timer.unref?.();
  };
  signal.addEventListener('abort', dispose, { once: true });
  activity();
  return { activity, dispose };
}
