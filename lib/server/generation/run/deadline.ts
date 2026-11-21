/**
 * The time a run gives each provider-calling step: the budget the step's 1.1.x
 * API route declared, so a hung provider fails the step the way a route
 * timeout failed the browser's request, as a retryable failure.
 */

/** Per call, in milliseconds. */
export const STEP_DEADLINES_MS = {
  /**
   * One material's extraction, once a worker runs it (1.1.x declared no
   * budget; the platform's default applied). Raised to tolerate slow
   * server-managed models on content-heavy courses.
   */
  materialAnalysis: 600_000,
  /** Research (1.1.x declared no budget; the platform's default applied). */
  research: 600_000,
  /** The outline, its own stream retries included. */
  outline: 600_000,
  agentProfiles: 120_000,
  /**
   * Per attempt. Raised from 300s: content generation for a single scene can
   * exceed 5 min with a slower chat model (e.g. qwen3.8-max), which otherwise
   * aborts the whole run with a StepTimeoutError.
   */
  sceneContent: 900_000,
  /**
   * Per attempt. Interactive scenes emit the longest output (code + state for
   * the demo widget), so a slow chat model is most likely to time out there.
   * Give them a larger budget than the other content types; the slot's
   * fallback model still covers the connection-drop case.
   */
  sceneContentInteractive: 1800_000,
  /** Per attempt. */
  sceneActions: 180_000,
  /** Per clip attempt (POST /api/generate/tts). */
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
