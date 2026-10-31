/**
 * The time a run gives each provider-calling step: the budget the step's 1.1.x
 * API route declared, so a hung provider fails the step the way a route
 * timeout failed the browser's request, as a retryable failure.
 */

/** Per call, in milliseconds. */
/**
 * Optional millisecond override from the environment. When the variable is
 * unset or not a positive finite integer, `fallback` is used so a
 * misconfigured deployment keeps the documented default instead of NaN/0.
 * Bracket access (process.env[key]) avoids Next.js build-time inlining so a
 * container-supplied value still takes effect at runtime.
 */
function envMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const STEP_DEADLINES_MS = {
  /**
   * One material's extraction, once a worker runs it (1.1.x declared no
   * budget; the platform's default applied).
   */
  materialAnalysis: 300_000,
  /** Research (1.1.x declared no budget; the platform's default applied). */
  research: 300_000,
  /** The outline, its own stream retries included. */
  outline: 300_000,
  agentProfiles: 120_000,
  /** Per attempt. */
  sceneContent: 300_000,
  /** Per attempt. */
  sceneActions: 60_000,
  /** Per clip attempt (POST /api/generate/tts). */
  narrationClip: envMs('NARRATION_CLIP_DEADLINE_MS', 30_000),
};

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
