/**
 * The time a run gives each provider-calling step: the budget the step's 1.1.x
 * API route declared, so a hung provider fails the step the way a route
 * timeout failed the browser's request, as a retryable failure.
 */

/**
 * The defaults below were sized for ordinary completion models. A deployment
 * behind a slow provider — a thinking model whose non-streaming completion
 * only lands after its whole chain of thought (observed: scene content at
 * 300+ s, scene actions at 100+ s, against 300 s / 60 s budgets) — fails every
 * step as a timeout while the provider is still working. Rather than raise
 * the defaults for everyone, `OPENMAIC_STEP_DEADLINE_MULTIPLIER` scales them
 * for that deployment: every budget keeps its relative shape, only its size
 * changes. Read once at startup; restart after changing it. A malformed value
 * fails startup, like the other operator budgets.
 */
const DEFAULT_STEP_DEADLINES_MS = {
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

type StepDeadlines = { [K in keyof typeof DEFAULT_STEP_DEADLINES_MS]: number };

/** Integer 1–10; unset or empty means 1. Anything else fails startup. */
export function stepDeadlineMultiplier(): number {
  const raw = process.env.OPENMAIC_STEP_DEADLINE_MULTIPLIER?.trim();
  if (raw === undefined || raw === '') return 1;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new Error('OPENMAIC_STEP_DEADLINE_MULTIPLIER must be an integer between 1 and 10.');
  }
  return value;
}

/** The default table scaled by `multiplier` (defaults to the env multiplier). */
export function scaledStepDeadlines(multiplier: number = stepDeadlineMultiplier()): StepDeadlines {
  const scaled: Record<string, number> = {};
  for (const [step, ms] of Object.entries(DEFAULT_STEP_DEADLINES_MS)) {
    scaled[step] = ms * multiplier;
  }
  return scaled as StepDeadlines;
}

/** Per call, in milliseconds, after the operator multiplier. */
export const STEP_DEADLINES_MS: StepDeadlines = scaledStepDeadlines();

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
