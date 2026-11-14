/** A step's budget: a timeout is a retryable failure; the run's own abort is an abort. */
import { afterEach, describe, expect, it } from 'vitest';
import { isAbortError } from '@openmaic/generation';

import {
  scaledStepDeadlines,
  StepTimeoutError,
  stepDeadlineMultiplier,
  STEP_DEADLINES_MS,
  withDeadline,
} from '@/lib/server/generation/run/deadline';
import { withRouteRetry } from '@/lib/server/generation/run/retry';

describe('step deadline multiplier', () => {
  const original = process.env.OPENMAIC_STEP_DEADLINE_MULTIPLIER;
  afterEach(() => {
    if (original === undefined) delete process.env.OPENMAIC_STEP_DEADLINE_MULTIPLIER;
    else process.env.OPENMAIC_STEP_DEADLINE_MULTIPLIER = original;
  });

  it('is 1 when unset or empty', () => {
    delete process.env.OPENMAIC_STEP_DEADLINE_MULTIPLIER;
    expect(stepDeadlineMultiplier()).toBe(1);
    process.env.OPENMAIC_STEP_DEADLINE_MULTIPLIER = '  ';
    expect(stepDeadlineMultiplier()).toBe(1);
  });

  it('rejects anything outside integer 1-10 at startup', () => {
    for (const raw of ['0', '-1', '11', '2.5', 'abc']) {
      process.env.OPENMAIC_STEP_DEADLINE_MULTIPLIER = raw;
      expect(stepDeadlineMultiplier).toThrowError(
        'OPENMAIC_STEP_DEADLINE_MULTIPLIER must be an integer between 1 and 10.',
      );
    }
  });

  it('scales every budget, keeping their relative shape', () => {
    const scaled = scaledStepDeadlines(3);
    expect(scaled.sceneActions).toBe(180_000);
    expect(scaled.sceneContent).toBe(900_000);
    expect(scaled.narrationClip).toBe(90_000);
    for (const step of Object.keys(STEP_DEADLINES_MS) as (keyof typeof STEP_DEADLINES_MS)[]) {
      expect(scaled[step]).toBe(STEP_DEADLINES_MS[step] * 3);
    }
  });
});

describe('step deadlines', () => {
  it('fails a call that outlives its budget, even one that ignores its signal', async () => {
    const run = new AbortController();
    let seen: AbortSignal | undefined;
    const pending = withDeadline('scene:0:actions', 20, run.signal, (signal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    });
    await expect(pending).rejects.toBeInstanceOf(StepTimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  it("rejects as an abort when the run's own signal aborts", async () => {
    const run = new AbortController();
    const pending = withDeadline(
      'scene:0:content',
      60_000,
      run.signal,
      (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('cancelled'))),
        ),
    );
    run.abort();
    const error = await pending.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
  });

  it('is retried, and the retry reports what failed', async () => {
    const causes: string[] = [];
    let attempts = 0;
    const result = await withRouteRetry(
      () =>
        withDeadline('step', 10, new AbortController().signal, async () => {
          attempts += 1;
          if (attempts === 1) return new Promise<string>(() => undefined);
          return 'ok';
        }),
      {
        label: 'step',
        maxRetries: 2,
        refusalStatus: 500,
        sleep: async () => undefined,
        onRetry: (event) => {
          causes.push(event.cause);
        },
      },
    );
    expect(result).toBe('ok');
    expect(causes).toEqual(['StepTimeoutError: step did not finish within 0.01 s']);
  });
});
