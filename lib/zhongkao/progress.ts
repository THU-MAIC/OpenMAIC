import {
  isAssistedCorrectAttempt,
  isEvaluatedStudyAttempt,
  isIncorrectObservation,
  isIndependentCorrectAttempt,
  STUDY_ATTEMPT_CONFLICT_CODE,
  studyAttemptFactsEqual,
  type StudyAttempt,
} from './study-attempt';
import {
  assertConfirmedExamObservation,
  CONFIRMED_EXAM_OBSERVATION_CONFLICT_CODE,
  confirmedExamObservationFactsEqual,
  type ConfirmedExamObservationV1,
} from './exam-observation';

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
  examObservationCount?: number;
  examOccasionCount?: number;
  evidenceObservationIds?: string[];
  lastEvidenceAt?: string;
}

export interface DeriveKnowledgeProgressInput {
  profileId: string;
  subjectId: string;
  knowledgePointId: string;
  attempts: readonly StudyAttempt[];
}

export type ProgressEvidence =
  | { sourceKind: 'study_attempt'; attempt: StudyAttempt }
  | { sourceKind: 'exam_observation'; observation: ConfirmedExamObservationV1 };

export interface DeriveKnowledgeProgressFromEvidenceInput {
  profileId: string;
  subjectId: string;
  knowledgePointId: string;
  evidence: readonly ProgressEvidence[];
}

interface KnowledgeEvidenceOccasion {
  observedAt: string;
  orderId: string;
  evaluated: boolean;
  incorrectObservation: boolean;
  independentCorrect: boolean;
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

function compareOccasions(
  left: KnowledgeEvidenceOccasion,
  right: KnowledgeEvidenceOccasion,
): number {
  const timestampOrder = Date.parse(left.observedAt) - Date.parse(right.observedAt);
  if (timestampOrder !== 0) return timestampOrder;
  if (left.orderId < right.orderId) return -1;
  if (left.orderId > right.orderId) return 1;
  return 0;
}

function studyAttemptObservations(attempts: readonly StudyAttempt[]): KnowledgeEvidenceOccasion[] {
  return attempts.filter(isValidObservation).map((attempt) => ({
    observedAt: attempt.createdAt,
    orderId: `study_attempt:${attempt.id}`,
    evaluated: true,
    incorrectObservation: isIncorrectObservation(attempt),
    independentCorrect: isIndependentCorrectAttempt(attempt),
  }));
}

function deriveState(input: {
  hasEvaluatedEvidence: boolean;
  incorrectObservationCount: number;
  recentObservations: readonly KnowledgeEvidenceOccasion[];
}): MasteryState {
  if (!input.hasEvaluatedEvidence) return 'unobserved';
  if (input.recentObservations.slice(-3).filter((item) => item.independentCorrect).length >= 2) {
    return 'developing';
  }
  if (input.incorrectObservationCount >= 2) return 'weak';
  return 'needs_observation';
}

export function deriveKnowledgeProgress(input: DeriveKnowledgeProgressInput): KnowledgeProgress {
  const attempts = relevantAttempts(input);
  const evaluatedAttempts = attempts.filter(isEvaluatedStudyAttempt);
  const independentCorrectCount = evaluatedAttempts.filter(isIndependentCorrectAttempt).length;
  const assistedCorrectCount = evaluatedAttempts.filter(isAssistedCorrectAttempt).length;
  const incorrectObservationCount = evaluatedAttempts.filter(isIncorrectObservation).length;
  const state = deriveState({
    hasEvaluatedEvidence: evaluatedAttempts.length > 0,
    incorrectObservationCount,
    recentObservations: studyAttemptObservations(evaluatedAttempts),
  });

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

function relevantExamObservations(
  input: DeriveKnowledgeProgressFromEvidenceInput,
): ConfirmedExamObservationV1[] {
  const unique = new Map<string, ConfirmedExamObservationV1>();
  for (const evidence of input.evidence) {
    if (evidence.sourceKind !== 'exam_observation') continue;
    assertConfirmedExamObservation(evidence.observation);
    const existing = unique.get(evidence.observation.observationId);
    if (!existing) {
      unique.set(evidence.observation.observationId, evidence.observation);
    } else if (!confirmedExamObservationFactsEqual(existing, evidence.observation)) {
      throw new Error(CONFIRMED_EXAM_OBSERVATION_CONFLICT_CODE);
    }
  }
  return [...unique.values()]
    .filter(
      (observation) =>
        observation.profileId === input.profileId &&
        observation.subjectId === input.subjectId &&
        observation.knowledgePointIds.includes(input.knowledgePointId),
    )
    .toSorted((left, right) => {
      const timestampOrder = Date.parse(left.observedAt) - Date.parse(right.observedAt);
      if (timestampOrder !== 0) return timestampOrder;
      if (left.observationId < right.observationId) return -1;
      if (left.observationId > right.observationId) return 1;
      return 0;
    });
}

function examObservationOccasions(
  observations: readonly ConfirmedExamObservationV1[],
): KnowledgeEvidenceOccasion[] {
  const grouped = new Map<
    string,
    KnowledgeEvidenceOccasion & { examSessionId: string; profileId: string; subjectId: string }
  >();
  for (const observation of observations) {
    const existing = grouped.get(observation.occasionId);
    if (
      existing &&
      (existing.examSessionId !== observation.examSessionId ||
        existing.profileId !== observation.profileId ||
        existing.subjectId !== observation.subjectId ||
        existing.observedAt !== observation.observedAt)
    ) {
      throw new Error(CONFIRMED_EXAM_OBSERVATION_CONFLICT_CODE);
    }
    const evaluated = observation.assessmentStatus === 'evaluated';
    const incorrect = evaluated && observation.outcome === 'incorrect';
    grouped.set(observation.occasionId, {
      examSessionId: observation.examSessionId,
      profileId: observation.profileId,
      subjectId: observation.subjectId,
      observedAt: observation.observedAt,
      orderId: `exam_observation:${observation.occasionId}`,
      evaluated: (existing?.evaluated ?? false) || evaluated,
      incorrectObservation: (existing?.incorrectObservation ?? false) || incorrect,
      independentCorrect: false,
    });
  }
  return [...grouped.values()].toSorted(compareOccasions);
}

export function deriveKnowledgeProgressFromEvidence(
  input: DeriveKnowledgeProgressFromEvidenceInput,
): KnowledgeProgress {
  const attempts = input.evidence
    .filter(
      (evidence): evidence is Extract<ProgressEvidence, { sourceKind: 'study_attempt' }> =>
        evidence.sourceKind === 'study_attempt',
    )
    .map((evidence) => evidence.attempt);
  const base = deriveKnowledgeProgress({
    profileId: input.profileId,
    subjectId: input.subjectId,
    knowledgePointId: input.knowledgePointId,
    attempts,
  });
  const relevantAttemptsForState = relevantAttempts({
    profileId: input.profileId,
    subjectId: input.subjectId,
    knowledgePointId: input.knowledgePointId,
    attempts,
  });
  const evaluatedAttempts = relevantAttemptsForState.filter(isEvaluatedStudyAttempt);
  const observations = relevantExamObservations(input);
  if (observations.length === 0) return base;

  const examOccasions = examObservationOccasions(observations);
  const incorrectObservationCount =
    base.incorrectObservationCount +
    examOccasions.filter((occasion) => occasion.incorrectObservation).length;
  // The M1 recovery window is a Coach lifecycle fact. Exam observations can
  // add negative occasions, but cannot displace independent Coach successes
  // from that window or impersonate a recovery attempt.
  const recoveryObservations = studyAttemptObservations(evaluatedAttempts);
  const timeline = [
    ...relevantAttemptsForState.map((attempt) => ({
      observedAt: attempt.createdAt,
      orderId: `study_attempt:${attempt.id}`,
    })),
    ...observations.map((observation) => ({
      observedAt: observation.observedAt,
      orderId: `exam_observation:${observation.observationId}`,
    })),
  ].toSorted((left, right) => {
    const timestampOrder = Date.parse(left.observedAt) - Date.parse(right.observedAt);
    if (timestampOrder !== 0) return timestampOrder;
    return left.orderId < right.orderId ? -1 : left.orderId > right.orderId ? 1 : 0;
  });

  return {
    ...base,
    state: deriveState({
      hasEvaluatedEvidence:
        evaluatedAttempts.length > 0 || examOccasions.some((occasion) => occasion.evaluated),
      incorrectObservationCount,
      recentObservations: recoveryObservations,
    }),
    incorrectObservationCount,
    examObservationCount: observations.length,
    examOccasionCount: examOccasions.length,
    evidenceObservationIds: observations.map((observation) => observation.observationId),
    lastEvidenceAt: timeline.at(-1)!.observedAt,
  };
}
