import type { QuestionResult } from '@/lib/quiz/grading';

/**
 * Quiz state persistence in localStorage, keyed per scene.
 *
 * Three keys coexist with distinct lifecycles:
 *
 *   quizDraft:<sceneId>    — in-progress answers (debounced via useDraftCache),
 *                            cleared at submit time.
 *   quizAnswers:<sceneId>  — answers written once at submit, cleared on retry.
 *   quizResults:<sceneId>  — graded results written once at reviewing, cleared on retry.
 *
 * Both quiz-view (to rehydrate its own state) and the classroom-complete page
 * (to compute aggregate scores) read through this module so the storage
 * schema is a single source of truth.
 */

export const DRAFT_KEY_PREFIX = 'quizDraft:';
export const ANSWERS_KEY_PREFIX = 'quizAnswers:';
export const RESULTS_KEY_PREFIX = 'quizResults:';

/** Build the draft cache key for a scene. Use this everywhere that needs the
 *  in-progress quiz answers (e.g. `useDraftCache`) so the prefix stays in
 *  sync with the readers/clearers below. */
export const draftKey = (sceneId: string): string => DRAFT_KEY_PREFIX + sceneId;

export type QuizAnswers = Record<string, string | string[]>;

export type SubmittedState =
  | { kind: 'reviewing'; answers: QuizAnswers; results: QuestionResult[] }
  | { kind: 'answering'; answers: QuizAnswers }
  | null;

function safeGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore quota / disabled storage
  }
}

function safeRemove(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Read quiz-view's post-submit state: answers + optional graded results. */
export function readSubmittedState(sceneId: string): SubmittedState {
  const rawA = safeGet(ANSWERS_KEY_PREFIX + sceneId);
  if (!rawA) return null;
  try {
    const answers = JSON.parse(rawA) as QuizAnswers;
    const rawR = safeGet(RESULTS_KEY_PREFIX + sceneId);
    if (rawR) {
      const results = JSON.parse(rawR) as QuestionResult[];
      if (Array.isArray(results) && results.length > 0) {
        return { kind: 'reviewing', answers, results };
      }
    }
    return { kind: 'answering', answers };
  } catch {
    return null;
  }
}

/**
 * Convenience reader for the classroom-complete page: returns the submitted
 * answers if present, else falls back to the in-progress draft so a partial
 * attempt still contributes to the aggregate instead of showing 0/N.
 */
export function readAnswersForSummary(sceneId: string): QuizAnswers {
  const rawA = safeGet(ANSWERS_KEY_PREFIX + sceneId);
  if (rawA) {
    try {
      return JSON.parse(rawA) as QuizAnswers;
    } catch {
      /* fall through */
    }
  }
  const rawD = safeGet(DRAFT_KEY_PREFIX + sceneId);
  if (rawD) {
    try {
      return JSON.parse(rawD) as QuizAnswers;
    } catch {
      /* fall through */
    }
  }
  return {};
}

/** Called by quiz-view at submit time. */
export function writeSubmittedAnswers(sceneId: string, answers: QuizAnswers): void {
  safeSet(ANSWERS_KEY_PREFIX + sceneId, JSON.stringify(answers));
}

/** Called by quiz-view when grading transitions to reviewing. */
export function writeSubmittedResults(sceneId: string, results: QuestionResult[]): void {
  safeSet(RESULTS_KEY_PREFIX + sceneId, JSON.stringify(results));
}

/** Called by quiz-view on retry: wipes submitted answers + results but keeps draft lifecycle. */
export function clearSubmitted(sceneId: string): void {
  safeRemove(ANSWERS_KEY_PREFIX + sceneId);
  safeRemove(RESULTS_KEY_PREFIX + sceneId);
}

/** Called by the stage-delete flow: wipes all three keys for a single scene. */
export function clearAllForScene(sceneId: string): void {
  safeRemove(DRAFT_KEY_PREFIX + sceneId);
  safeRemove(ANSWERS_KEY_PREFIX + sceneId);
  safeRemove(RESULTS_KEY_PREFIX + sceneId);
}
