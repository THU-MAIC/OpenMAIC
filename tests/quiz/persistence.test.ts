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

import {
  ANSWERS_KEY_PREFIX,
  ATTEMPT_ID_KEY_PREFIX,
  DRAFT_KEY_PREFIX,
  RESULTS_KEY_PREFIX,
  clearAllForScene,
  clearDraftRecovery,
  hasLegacyQuizState,
  readDraftState,
  readSubmittedState,
  writeDraftRecovery,
} from '@/lib/quiz/persistence';
import type { QuestionResult } from '@/lib/quiz/grading';

describe('legacy quiz persistence compatibility', () => {
  beforeEach(() => {
    localStorageStub.clear();
    vi.stubGlobal('window', { localStorage: localStorageStub });
  });

  it('parses legacy answers and reviewed results, including an empty result list', () => {
    const results: QuestionResult[] = [
      { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
    ];
    localStorageStub.setItem(ANSWERS_KEY_PREFIX + 's1', JSON.stringify({ q1: 'a' }));
    localStorageStub.setItem(RESULTS_KEY_PREFIX + 's1', JSON.stringify(results));
    expect(readSubmittedState('s1')).toEqual({
      kind: 'reviewing',
      answers: { q1: 'a' },
      results,
    });

    localStorageStub.setItem(RESULTS_KEY_PREFIX + 's1', '[]');
    expect(readSubmittedState('s1')).toEqual({
      kind: 'reviewing',
      answers: { q1: 'a' },
      results: [],
    });
  });

  it('parses a legacy draft and rejects corrupt JSON', () => {
    localStorageStub.setItem(DRAFT_KEY_PREFIX + 's1', JSON.stringify({ q1: 'draft' }));
    expect(readDraftState('s1')).toEqual({ q1: 'draft' });

    localStorageStub.setItem(DRAFT_KEY_PREFIX + 's1', '{corrupt');
    expect(readDraftState('s1')).toBeNull();
  });

  it('keeps a synchronous draft recovery until the matching runtime write commits', () => {
    writeDraftRecovery('s1', 'attempt-1', { q1: 'latest' });

    expect(readDraftState('s1')).toEqual({ q1: 'latest' });
    expect(localStorageStub.getItem(ATTEMPT_ID_KEY_PREFIX + 's1')).toBe('attempt-1');

    clearDraftRecovery('s1', 'attempt-1', { q1: 'older' });
    expect(readDraftState('s1')).toEqual({ q1: 'latest' });

    clearDraftRecovery('s1', 'attempt-1', { q1: 'latest' });
    expect(readDraftState('s1')).toBeNull();
    expect(localStorageStub.getItem(ATTEMPT_ID_KEY_PREFIX + 's1')).toBeNull();
  });

  it('detects an unscoped legacy attempt pointer even without answers', () => {
    localStorageStub.setItem(ATTEMPT_ID_KEY_PREFIX + 's1', 'legacy-attempt');
    expect(hasLegacyQuizState('s1')).toBe(true);
    expect(hasLegacyQuizState('s2')).toBe(false);
  });

  it('clears all legacy keys for only the requested scene', () => {
    for (const prefix of [
      DRAFT_KEY_PREFIX,
      ANSWERS_KEY_PREFIX,
      RESULTS_KEY_PREFIX,
      ATTEMPT_ID_KEY_PREFIX,
    ]) {
      localStorageStub.setItem(prefix + 's1', '{}');
      localStorageStub.setItem(prefix + 's2', '{}');
    }

    clearAllForScene('s1');

    expect(hasLegacyQuizState('s1')).toBe(false);
    expect(hasLegacyQuizState('s2')).toBe(true);
  });

  it('is SSR-safe', () => {
    vi.stubGlobal('window', undefined);
    expect(readSubmittedState('s1')).toBeNull();
    expect(readDraftState('s1')).toBeNull();
    expect(hasLegacyQuizState('s1')).toBe(false);
  });
});
