import { describe, it, expect, beforeEach, vi } from 'vitest';

const store: Record<string, string> = {};
const localStorageStub = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => {
    store[k] = String(v);
  },
  removeItem: (k: string) => {
    delete store[k];
  },
  clear: () => {
    for (const k of Object.keys(store)) delete store[k];
  },
  key: (i: number) => Object.keys(store)[i] ?? null,
  get length() {
    return Object.keys(store).length;
  },
};

vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

import {
  ANSWERS_KEY_PREFIX,
  ATTEMPT_ID_KEY_PREFIX,
  DRAFT_KEY_PREFIX,
  RESULTS_KEY_PREFIX,
  clearAllForScene,
  clearSubmitted,
  getOrCreateQuizAttemptId,
  readAnswersForSummary,
  readSubmittedState,
  rotateQuizAttemptId,
  writeSubmittedAnswers,
  writeSubmittedResults,
} from '@/lib/quiz/persistence';
import type { QuestionResult } from '@/lib/quiz/grading';

describe('quiz persistence', () => {
  beforeEach(() => {
    localStorageStub.clear();
    vi.stubGlobal('window', { localStorage: localStorageStub });
  });

  it('readSubmittedState returns null when nothing is stored', () => {
    expect(readSubmittedState('s1')).toBeNull();
  });

  it('returns answering state when only answers are stored', () => {
    writeSubmittedAnswers('s1', { q1: 'a' });
    expect(readSubmittedState('s1')).toEqual({ kind: 'answering', answers: { q1: 'a' } });
  });

  it('returns reviewing state when both answers and results are stored', () => {
    const results: QuestionResult[] = [
      { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
    ];
    writeSubmittedAnswers('s1', { q1: 'a' });
    writeSubmittedResults('s1', results);
    expect(readSubmittedState('s1')).toEqual({
      kind: 'reviewing',
      answers: { q1: 'a' },
      results,
    });
  });

  it('returns reviewing when a persisted results array is empty', () => {
    writeSubmittedAnswers('s1', { q1: 'a' });
    writeSubmittedResults('s1', []);
    expect(readSubmittedState('s1')).toEqual({
      kind: 'reviewing',
      answers: { q1: 'a' },
      results: [],
    });
  });

  it('returns null on corrupt answers JSON', () => {
    localStorageStub.setItem(ANSWERS_KEY_PREFIX + 's1', '{invalid');
    expect(readSubmittedState('s1')).toBeNull();
  });

  it('clearSubmitted wipes answers + results but leaves draft intact', () => {
    localStorageStub.setItem(DRAFT_KEY_PREFIX + 's1', JSON.stringify({ q1: 'b' }));
    writeSubmittedAnswers('s1', { q1: 'a' });
    writeSubmittedResults('s1', [
      { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
    ]);

    clearSubmitted('s1');

    expect(readSubmittedState('s1')).toBeNull();
    expect(localStorageStub.getItem(DRAFT_KEY_PREFIX + 's1')).not.toBeNull();
  });

  it('clearAllForScene wipes quiz state and its runtime attempt pointer', async () => {
    localStorageStub.setItem(DRAFT_KEY_PREFIX + 's1', '{}');
    await getOrCreateQuizAttemptId('s1');
    writeSubmittedAnswers('s1', { q1: 'a' });
    writeSubmittedResults('s1', [
      { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
    ]);
    // unrelated scene should not be touched
    writeSubmittedAnswers('s2', { q1: 'z' });

    clearAllForScene('s1');

    expect(localStorageStub.getItem(DRAFT_KEY_PREFIX + 's1')).toBeNull();
    expect(localStorageStub.getItem(ANSWERS_KEY_PREFIX + 's1')).toBeNull();
    expect(localStorageStub.getItem(RESULTS_KEY_PREFIX + 's1')).toBeNull();
    expect(localStorageStub.getItem(ATTEMPT_ID_KEY_PREFIX + 's1')).toBeNull();
    expect(localStorageStub.getItem(ANSWERS_KEY_PREFIX + 's2')).not.toBeNull();
  });

  it('keeps a stable attempt id until retry rotates it', async () => {
    const first = await getOrCreateQuizAttemptId('s1');
    expect(await getOrCreateQuizAttemptId('s1')).toBe(first);

    const second = await rotateQuizAttemptId('s1');
    expect(second).not.toBe(first);
    expect(await getOrCreateQuizAttemptId('s1')).toBe(second);
  });

  it('does not mint an unpersisted attempt id during SSR', async () => {
    vi.stubGlobal('window', undefined);

    expect(await getOrCreateQuizAttemptId('s1')).toBeNull();
    expect(localStorageStub.getItem(ATTEMPT_ID_KEY_PREFIX + 's1')).toBeNull();

    vi.stubGlobal('window', { localStorage: localStorageStub });
    const clientId = await getOrCreateQuizAttemptId('s1');
    expect(clientId).not.toBeNull();
    expect(localStorageStub.getItem(ATTEMPT_ID_KEY_PREFIX + 's1')).toBe(clientId);
  });

  it('serializes concurrent attempt id creation across tabs', async () => {
    let tail = Promise.resolve();
    const request = vi.fn(
      async <T>(_name: string, callback: () => T | PromiseLike<T>): Promise<T> => {
        const prior = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await prior;
        try {
          return await callback();
        } finally {
          release();
        }
      },
    );
    vi.stubGlobal('navigator', { locks: { request } });

    const [first, second] = await Promise.all([
      getOrCreateQuizAttemptId('s1'),
      getOrCreateQuizAttemptId('s1'),
    ]);

    expect(first).toBe(second);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith('maic:quiz-attempt-id:s1', expect.any(Function));
  });

  it('readAnswersForSummary prefers submitted over draft', () => {
    localStorageStub.setItem(DRAFT_KEY_PREFIX + 's1', JSON.stringify({ q1: 'draft' }));
    writeSubmittedAnswers('s1', { q1: 'submitted' });
    expect(readAnswersForSummary('s1')).toEqual({ q1: 'submitted' });
  });

  it('readAnswersForSummary falls back to draft when no submission', () => {
    localStorageStub.setItem(DRAFT_KEY_PREFIX + 's1', JSON.stringify({ q1: 'draft' }));
    expect(readAnswersForSummary('s1')).toEqual({ q1: 'draft' });
  });

  it('readAnswersForSummary returns empty object when nothing is stored', () => {
    expect(readAnswersForSummary('s1')).toEqual({});
  });

  it('tolerates corrupt draft JSON when no submission exists', () => {
    localStorageStub.setItem(DRAFT_KEY_PREFIX + 's1', '{corrupt');
    expect(readAnswersForSummary('s1')).toEqual({});
  });
});
