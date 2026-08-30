import {
  isAssistedCorrectAttempt,
  isEvaluatedStudyAttempt,
  isIncorrectObservation,
  isIndependentCorrectAttempt,
  STUDY_ATTEMPT_CONFLICT_CODE,
  studyAttemptFactsEqual,
  type StudyAttempt,
} from './study-attempt';

export type MasteryState = 'unobserved' | 'needs_observation' | 'weak' | 'developing' | 'stable';

export interface KnowledgeProgress {
  profileId: string;
  subjectId: string;
  knowledgePointId: string;
  state: MasteryState;
  attempts: number;
  independentCorrectCount: number;
  assistedCorrectCount: number;
  incorrectObservationCount: number;
  evidenceAttemptIds: string[];
  lastAttemptAt?: string;
}

export interface DeriveKnowledgeProgressInput {
  profileId: string;
  subjectId: string;
  knowledgePointId: string;
  attempts: readonly StudyAttempt[];
}

function compareAttempts(left: StudyAttempt, right: StudyAttempt): number {
  const timestampOrder = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (timestampOrder !== 0) return timestampOrder;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function relevantAttempts(input: DeriveKnowledgeProgressInput): StudyAttempt[] {
  const unique = new Map<string, StudyAttempt>();
  for (const attempt of input.attempts) {
    const existing = unique.get(attempt.id);
    if (!existing) {
      unique.set(attempt.id, attempt);
    } else if (!studyAttemptFactsEqual(existing, attempt)) {
      throw new Error(STUDY_ATTEMPT_CONFLICT_CODE);
    }
  }
  return [...unique.values()]
    .filter(
      (attempt) =>
        attempt.profileId === input.profileId &&
        attempt.subjectId === input.subjectId &&
        attempt.knowledgePointIds.includes(input.knowledgePointId),
    )
    .toSorted(compareAttempts);
}

function isValidObservation(attempt: StudyAttempt): boolean {
  return (
    isEvaluatedStudyAttempt(attempt) &&
    attempt.studentAttemptedBeforeHelp &&
    attempt.initialOutcome !== 'skipped'
  );
}

export function deriveKnowledgeProgress(input: DeriveKnowledgeProgressInput): KnowledgeProgress {
  const attempts = relevantAttempts(input);
  const evaluatedAttempts = attempts.filter(isEvaluatedStudyAttempt);
  const independentCorrectCount = evaluatedAttempts.filter(isIndependentCorrectAttempt).length;
  const assistedCorrectCount = evaluatedAttempts.filter(isAssistedCorrectAttempt).length;
  const incorrectObservationCount = evaluatedAttempts.filter(isIncorrectObservation).length;
  const recentObservations = evaluatedAttempts.filter(isValidObservation).slice(-3);
  const recentIndependentCorrect = recentObservations.filter(isIndependentCorrectAttempt).length;

  let state: MasteryState;
  if (evaluatedAttempts.length === 0) state = 'unobserved';
  else if (recentIndependentCorrect >= 2) state = 'developing';
  else if (incorrectObservationCount >= 2) state = 'weak';
  else state = 'needs_observation';

  return {
    profileId: input.profileId,
    subjectId: input.subjectId,
    knowledgePointId: input.knowledgePointId,
    state,
    attempts: attempts.length,
    independentCorrectCount,
    assistedCorrectCount,
    incorrectObservationCount,
    evidenceAttemptIds: attempts.map((attempt) => attempt.id),
    ...(attempts.length > 0 ? { lastAttemptAt: attempts.at(-1)!.createdAt } : {}),
  };
}
