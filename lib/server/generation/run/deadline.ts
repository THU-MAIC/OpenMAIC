/**
 * The time a run gives each provider-calling step: the budget its browser
 * API route had (`maxDuration`), so a hung provider fails the step the way a
 * route timeout failed the browser's request, as a retryable failure.
 */

/** Per call, in milliseconds. */
export const STEP_DEADLINES_MS = {
  /** POST /api/extract-document declares no budget; the platform's default applies. */
  materialAnalysis: 300_000,
  /** POST /api/web-search declares no budget; the platform's default applies. */
  research: 300_000,
  /** POST /api/generate/scene-outlines-stream (its own stream retries included). */
  outline: 300_000,
  /** POST /api/generate/agent-profiles */
  agentProfiles: 120_000,
  /** POST /api/generate/scene-content, per attempt. */
  sceneContent: 300_000,
  /** POST /api/generate/scene-actions, per attempt. */
  sceneActions: 60_000,
  /** POST /api/generate/tts, per clip attempt. */
  narrationClip: 30_000,
} as const;

/** A step ran out of its budget. A gateway timeout to the retries: retried. */
export class StepTimeoutError extends Error {
  readonly statusCode = 504;

  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${ms / 1000} s`);
    this.name = 'StepTimeoutError';
  }
}

/**
 * Run `call` with a signal that aborts when the run's signal does (a lost
 * lease, a deleted course, shutdown) or when `ms` pass. A timeout rejects
 * with {@link StepTimeoutError} even if the call ignores its signal; the
 * run's own abort rejects as an abort.
 */
export async function withDeadline<T>(
  label: string,
  ms: number,
  runSignal: AbortSignal,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), ms);
  const signal = AbortSignal.any([runSignal, timeout.signal]);
  const failure = () =>
    runSignal.aborted
      ? (runSignal.reason ?? new DOMException('Aborted', 'AbortError'))
      : new StepTimeoutError(label, ms);
  try {
    return await new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(failure());
        return;
      }
      signal.addEventListener('abort', () => reject(failure()), { once: true });
      call(signal).then(resolve, (error) => reject(signal.aborted ? failure() : error));
    });
  } finally {
    clearTimeout(timer);
  }
}
