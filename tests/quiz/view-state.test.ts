import { describe, expect, it, vi } from 'vitest';
import {
  createQuizViewLifetime,
  isQuizRuntimeReady,
  persistQuizReview,
  persistQuizRetry,
  persistQuizSubmission,
  quizViewStateFromAttempt,
  runQuizPersistenceTransition,
} from '@/lib/quiz/view-state';

describe('quiz view runtime hydration', () => {
  it('hydrates a draft or submission back into answering', () => {
    expect(
      quizViewStateFromAttempt({
        sessionId: 'attempt-1',
        status: 'active',
        phase: 'draft',
        answers: { q1: 'A' },
      }),
    ).toEqual({ phase: 'answering', answers: { q1: 'A' }, results: [] });
  });

  it('hydrates reviewed empty results into reviewing', () => {
    expect(
      quizViewStateFromAttempt({
        sessionId: 'attempt-1',
        status: 'completed',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results: [],
      }),
    ).toEqual({ phase: 'reviewing', answers: { q1: 'A' }, results: [] });
  });

  it('uses a clean cover when no attempt exists', () => {
    expect(quizViewStateFromAttempt(undefined)).toEqual({
      phase: 'not_started',
      answers: {},
      results: [],
    });
  });

  it('uses the cover for a persisted empty retry marker', () => {
    expect(
      quizViewStateFromAttempt({
        sessionId: 'attempt-1:retry:1',
        status: 'active',
        phase: 'draft',
        answers: {},
      }),
    ).toEqual({ phase: 'not_started', answers: {}, results: [] });
  });

  it('keeps the quiz blocked when runtime hydration fails', () => {
    expect(isQuizRuntimeReady({ status: 'loading' })).toBe(false);
    expect(isQuizRuntimeReady({ status: 'error' })).toBe(false);
    expect(isQuizRuntimeReady({ status: 'ready', attemptId: 'attempt-1' })).toBe(true);
  });

  it('persists a clean draft before completing retry', async () => {
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: unknown[] = [];
    const retry = persistQuizRetry(
      { stageId: 'stage-1', sceneId: 'scene-1', attemptId: 'attempt-1' },
      {
        recordPhase: async (input) => {
          calls.push(input);
          await persisted;
        },
      },
    );

    let settled = false;
    void retry.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(calls).toEqual([
      {
        stageId: 'stage-1',
        sceneId: 'scene-1',
        attemptId: 'attempt-1',
        phase: 'draft',
        answers: {},
        startNewAttempt: true,
      },
    ]);
    expect(settled).toBe(false);

    release();
    await retry;
    expect(settled).toBe(true);
  });

  it('does not complete submit or review transitions before runtime persistence', async () => {
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: unknown[] = [];
    const writer = {
      recordPhase: async (input: unknown) => {
        calls.push(input);
        await persisted;
      },
    };
    const base = {
      stageId: 'stage-1',
      sceneId: 'scene-1',
      attemptId: 'attempt-1',
      answers: { q1: 'A' },
    };

    const submitting = persistQuizSubmission(base, writer);
    const reviewing = persistQuizReview({ ...base, results: [] }, writer);
    let settled = false;
    void Promise.all([submitting, reviewing]).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(calls).toEqual([
      { ...base, phase: 'submitted' },
      { ...base, phase: 'reviewed', results: [] },
    ]);
    expect(settled).toBe(false);

    release();
    await Promise.all([submitting, reviewing]);
    expect(settled).toBe(true);
  });

  it('does not update an unmounted view after an async persistence transition', async () => {
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifetime = createQuizViewLifetime();
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const running = runQuizPersistenceTransition(() => persisted, lifetime, onSuccess, onError);
    lifetime.invalidate();
    release();
    await running;

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes persistence failures to the recoverable error transition', async () => {
    const lifetime = createQuizViewLifetime();
    const error = new Error('storage unavailable');
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await runQuizPersistenceTransition(
      async () => Promise.reject(error),
      lifetime,
      onSuccess,
      onError,
    );

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });
});
