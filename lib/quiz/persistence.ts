import type { QuestionResult } from '@/lib/quiz/grading';

/**
 * One-time compatibility reader for quiz state written before RuntimeStore.
 *
 * Four legacy keys may coexist:
 *
 *   quizDraft:<sceneId>
 *   quizAnswers:<sceneId>
 *   quizResults:<sceneId>
 *   quizAttemptId:<sceneId>
 *
 * RuntimeStore is the only live read source. The draft key also acts as a
 * synchronous crash-recovery journal while an async RuntimeStore write is in
 * flight; `loadQuizAttemptState` consumes it, commits the strongest valid state
 * to the current learner partition, then deletes all four keys.
 */

export const DRAFT_KEY_PREFIX = 'quizDraft:';
export const ANSWERS_KEY_PREFIX = 'quizAnswers:';
export const RESULTS_KEY_PREFIX = 'quizResults:';
export const ATTEMPT_ID_KEY_PREFIX = 'quizAttemptId:';

export type QuizAnswers = Record<string, string | string[]>;

export type SubmittedState =
  | { kind: 'reviewing'; answers: QuizAnswers; results: QuestionResult[] }
  | { kind: 'answering'; answers: QuizAnswers }
  | null;

export interface LegacyQuizStateSnapshot {
  hasState: boolean;
  draft: QuizAnswers | null;
  submitted: SubmittedState;
  attemptId: string | null;
  rawDraft: string | null;
  rawAnswers: string | null;
  rawResults: string | null;
  rawAttemptId: string | null;
}

function isQuizAnswers(value: unknown): value is QuizAnswers {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (answer) =>
        typeof answer === 'string' ||
        (Array.isArray(answer) && answer.every((item) => typeof item === 'string')),
    )
  );
}

export function hasLegacyQuizState(sceneId: string): boolean {
  return [DRAFT_KEY_PREFIX, ANSWERS_KEY_PREFIX, RESULTS_KEY_PREFIX, ATTEMPT_ID_KEY_PREFIX].some(
    (prefix) => safeGet(prefix + sceneId) !== null,
  );
}

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
    // Best-effort recovery journal; RuntimeStore remains the authority.
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

/** Parse legacy post-submit state: answers + optional graded results. */
export function readSubmittedState(sceneId: string): SubmittedState {
  const rawA = safeGet(ANSWERS_KEY_PREFIX + sceneId);
  const rawR = safeGet(RESULTS_KEY_PREFIX + sceneId);
  return parseSubmittedState(rawA, rawR);
}

function parseSubmittedState(rawA: string | null, rawR: string | null): SubmittedState {
  if (!rawA) return null;
  try {
    const answers = JSON.parse(rawA) as unknown;
    if (!isQuizAnswers(answers)) return null;
    if (rawR) {
      const results = JSON.parse(rawR) as QuestionResult[];
      if (Array.isArray(results)) {
        return { kind: 'reviewing', answers, results };
      }
    }
    return { kind: 'answering', answers };
  } catch {
    return null;
  }
}

export function readDraftState(sceneId: string): QuizAnswers | null {
  const raw = safeGet(DRAFT_KEY_PREFIX + sceneId);
  return parseDraftState(raw);
}

function parseDraftState(raw: string | null): QuizAnswers | null {
  if (!raw) return null;
  try {
    const answers = JSON.parse(raw) as unknown;
    return isQuizAnswers(answers) ? answers : null;
  } catch {
    return null;
  }
}

/** Read the legacy attempt pointer only to order one-time migration snapshots. */
export function readLegacyAttemptId(sceneId: string): string | null {
  const attemptId = safeGet(ATTEMPT_ID_KEY_PREFIX + sceneId);
  return attemptId && attemptId.trim().length > 0 ? attemptId : null;
}

/** Capture one coherent cleanup token for a one-time legacy migration. */
export function readLegacyQuizStateSnapshot(sceneId: string): LegacyQuizStateSnapshot {
  const rawDraft = safeGet(DRAFT_KEY_PREFIX + sceneId);
  const rawAnswers = safeGet(ANSWERS_KEY_PREFIX + sceneId);
  const rawResults = safeGet(RESULTS_KEY_PREFIX + sceneId);
  const rawAttemptId = safeGet(ATTEMPT_ID_KEY_PREFIX + sceneId);
  return {
    hasState: [rawDraft, rawAnswers, rawResults, rawAttemptId].some((value) => value !== null),
    draft: parseDraftState(rawDraft),
    submitted: parseSubmittedState(rawAnswers, rawResults),
    attemptId: rawAttemptId && rawAttemptId.trim().length > 0 ? rawAttemptId : null,
    rawDraft,
    rawAnswers,
    rawResults,
    rawAttemptId,
  };
}

/** Synchronously journal the latest draft before its async RuntimeStore write. */
export function writeDraftRecovery(sceneId: string, attemptId: string, answers: QuizAnswers): void {
  safeSet(DRAFT_KEY_PREFIX + sceneId, JSON.stringify(answers));
  safeSet(ATTEMPT_ID_KEY_PREFIX + sceneId, attemptId);
}

/** Retire only the recovery snapshot proven durable by this exact write. */
export function clearDraftRecovery(sceneId: string, attemptId: string, answers: QuizAnswers): void {
  if (safeGet(ATTEMPT_ID_KEY_PREFIX + sceneId) !== attemptId) return;
  if (safeGet(DRAFT_KEY_PREFIX + sceneId) !== JSON.stringify(answers)) return;
  safeRemove(DRAFT_KEY_PREFIX + sceneId);
  safeRemove(ATTEMPT_ID_KEY_PREFIX + sceneId);
}

/** Retire only the legacy values captured by one completed migration. */
export function clearLegacyQuizStateSnapshot(
  sceneId: string,
  snapshot: LegacyQuizStateSnapshot,
): void {
  const draftKey = DRAFT_KEY_PREFIX + sceneId;
  const attemptKey = ATTEMPT_ID_KEY_PREFIX + sceneId;
  if (safeGet(draftKey) === snapshot.rawDraft && safeGet(attemptKey) === snapshot.rawAttemptId) {
    safeRemove(draftKey);
    safeRemove(attemptKey);
  }

  const answersKey = ANSWERS_KEY_PREFIX + sceneId;
  const resultsKey = RESULTS_KEY_PREFIX + sceneId;
  if (safeGet(answersKey) === snapshot.rawAnswers && safeGet(resultsKey) === snapshot.rawResults) {
    safeRemove(answersKey);
    safeRemove(resultsKey);
  }
}

/** Retire every legacy key after migration or during stage deletion. */
export function clearAllForScene(sceneId: string): void {
  safeRemove(DRAFT_KEY_PREFIX + sceneId);
  safeRemove(ANSWERS_KEY_PREFIX + sceneId);
  safeRemove(RESULTS_KEY_PREFIX + sceneId);
  safeRemove(ATTEMPT_ID_KEY_PREFIX + sceneId);
}
