/**
 * The time a run gives each provider-calling step: the budget the step's 1.1.x
 * API route declared, so a hung provider fails the step the way a route
 * timeout failed the browser's request, as a retryable failure.
 */

/** Below this, an operator override is ignored and the default is used. */
const MIN_CONFIGURABLE_DEADLINE_MS = 60_000;

/**
 * Read a millisecond budget from the environment at call time.
 * Unset, empty, and non-numeric values, and anything under
 * {@link MIN_CONFIGURABLE_DEADLINE_MS}, keep `defaultMs`.
 */
export function readDeadlineMs(envName: string, defaultMs: number): number {
  const raw = Number.parseInt(process.env[envName] ?? '', 10);
  return Number.isFinite(raw) && raw >= MIN_CONFIGURABLE_DEADLINE_MS ? raw : defaultMs;
}

/**
 * Budget for one image or video in a generation run.
 *
 * A cold local checkpoint (ComfyUI loading SDXL, for example) can take several
 * minutes before the first image, so the default is 12 minutes. `MEDIA_DEADLINE_MS`
 * overrides it at runtime.
 */
export const DEFAULT_MEDIA_DEADLINE_MS = 720_000;

export function mediaDeadlineMs(): number {
  return readDeadlineMs('MEDIA_DEADLINE_MS', DEFAULT_MEDIA_DEADLINE_MS);
}

/** Per call, in milliseconds. */
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
