/**
 * The browser's per-request retries, applied to a step called in process.
 *
 * The browser retries a scene request (`fetchSceneContent`, `fetchSceneActions`,
 * `generateAndStoreTTS`) with `withGenerationRetry`, classifying a failure by
 * the HTTP status its API route answered. A run calls the step directly, so
 * the failure is classified by the status that route would have answered: a
 * provider's own HTTP status, else 500 (retried); a step's refusal is the
 * route's 500 for content and actions (retried) and its 400 for narration
 * (not retried).
 */
import { isAbortError, withGenerationRetry, type GenerationRetryEvent } from '@openmaic/generation';

import { StepRefusal } from '@/lib/server/generation/steps/context';
import { upstreamHttpStatus } from '@/lib/server/llm-error-response';

/** The browser's retries for the first scene (FOREGROUND_SCENE_RETRY_OPTIONS). */
export const FIRST_SCENE_MAX_RETRIES = 2;
/** The browser's retries for every later scene (the withGenerationRetry default). */
export const SCENE_MAX_RETRIES = 5;

/** A failure carrying the status the step's route would have answered, for classification. */
class RouteStatusError extends Error {
  constructor(
    readonly original: unknown,
    readonly statusCode: number,
  ) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'RouteStatusError';
  }
}

function routeStatus(error: unknown, refusalStatus: number): number {
  if (error instanceof StepRefusal) return refusalStatus;
  const own = (error as { httpStatus?: unknown } | null)?.httpStatus;
  if (typeof own === 'number' && own >= 400 && own <= 599) return own;
  return upstreamHttpStatus(error) ?? 500;
}

export interface RouteRetryOptions {
  label: string;
  maxRetries: number;
  /** The status the route answers a StepRefusal with. */
  refusalStatus: 400 | 500;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onRetry?: (event: GenerationRetryEvent) => Promise<void> | void;
}

/** Run `operation`, retried as the browser retries the route it replaces; throws the last failure. */
export async function withRouteRetry<T>(
  operation: () => Promise<T>,
  options: RouteRetryOptions,
): Promise<T> {
  try {
    return await withGenerationRetry(
      async () => {
        try {
          return await operation();
        } catch (error) {
          if (isAbortError(error)) throw error;
          throw new RouteStatusError(error, routeStatus(error, options.refusalStatus));
        }
      },
      {
        label: options.label,
        maxRetries: options.maxRetries,
        sleep: options.sleep,
        signal: options.signal,
        onRetry: options.onRetry,
      },
    );
  } catch (error) {
    throw error instanceof RouteStatusError ? error.original : error;
  }
}
