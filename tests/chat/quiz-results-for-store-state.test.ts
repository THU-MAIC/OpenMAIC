import { beforeEach, describe, expect, it, vi } from 'vitest';

const store: Record<string, string> = {};
const localStorageStub = {
  getItem: (key: string) => (key in store ? store[key] : null),
  setItem: (key: string, value: string) => {
    store[key] = String(value);
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    for (const key of Object.keys(store)) delete store[key];
  },
};

vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

import { buildQuizResultsForStoreState } from '@/lib/chat/quiz-results-for-store-state';
import { writeSubmittedAnswers, writeSubmittedResults } from '@/lib/quiz/persistence';

describe('quiz results for chat store state', () => {
  beforeEach(() => {
    localStorageStub.clear();
  });

  it('omits an explicitly reviewed quiz when the grader returned no results', () => {
    writeSubmittedAnswers('quiz-1', { q1: 'A' });
    writeSubmittedResults('quiz-1', []);

    expect(
      buildQuizResultsForStoreState([{ id: 'quiz-1', type: 'quiz' }], 'quiz-1'),
    ).toBeUndefined();
  });

  it('includes non-empty reviewed results for the active quiz', () => {
    const results = [{ questionId: 'q1', correct: true, status: 'correct' as const, earned: 1 }];
    writeSubmittedAnswers('quiz-1', { q1: 'A' });
    writeSubmittedResults('quiz-1', results);

    expect(buildQuizResultsForStoreState([{ id: 'quiz-1', type: 'quiz' }], 'quiz-1')).toEqual({
      sceneId: 'quiz-1',
      answers: { q1: 'A' },
      results,
    });
  });
});
