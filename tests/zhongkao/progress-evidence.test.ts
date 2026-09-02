import { describe, expect, it } from 'vitest';

import {
  deriveConfirmedExamObservationId,
  deriveExamObservationOccasionId,
  type ConfirmedExamObservationV1,
} from '@/lib/zhongkao/exam-observation';
import {
  deriveKnowledgeProgress,
  deriveKnowledgeProgressFromEvidence,
  type ProgressEvidence,
} from '@/lib/zhongkao/progress';

import { evaluatedStudyAttemptV2, NOW, studyAttempt, unassessedStudyAttemptV2 } from './fixtures';

const input = {
  profileId: 'student-alpha',
  subjectId: 'math',
  knowledgePointId: 'linear-equations',
};

interface ObservationOptions {
  examSessionId?: string;
  confirmedQuestionId?: string;
  observedAt?: string;
  knowledgePointIds?: string[];
  profileId?: string;
  subjectId?: string;
  result?: 'correct' | 'incorrect' | 'unassessed';
}

function observation(options: ObservationOptions = {}): ConfirmedExamObservationV1 {
  const examSessionId = options.examSessionId ?? 'exam-session-1';
  const confirmedQuestionId = options.confirmedQuestionId ?? 'confirmed-question-1';
  const common = {
    schemaVersion: 1 as const,
    observationId: deriveConfirmedExamObservationId({
      examSessionId,
      confirmedQuestionId,
      mappingFingerprint: 'a'.repeat(64),
      assessmentFingerprint: 'b'.repeat(64),
    }),
    profileId: options.profileId ?? input.profileId,
    examSessionId,
    confirmedQuestionId,
    subjectId: options.subjectId ?? input.subjectId,
    knowledgePointIds: options.knowledgePointIds ?? [input.knowledgePointId],
    occasionId: deriveExamObservationOccasionId(examSessionId),
    observedAt: options.observedAt ?? NOW,
    mappingSource: 'owner_confirmed_manual_mapping' as const,
  };
  return options.result === 'unassessed'
    ? {
        ...common,
        assessmentStatus: 'unassessed',
        reason: 'unsupported_question_type',
      }
    : {
        ...common,
        assessmentStatus: 'evaluated',
        outcome: options.result ?? 'incorrect',
      };
}

function examEvidence(...observations: ConfirmedExamObservationV1[]): ProgressEvidence[] {
  return observations.map((item) => ({ sourceKind: 'exam_observation', observation: item }));
}

function attemptEvidence(
  ...attempts: Parameters<typeof deriveKnowledgeProgress>[0]['attempts']
): ProgressEvidence[] {
  return attempts.map((attempt) => ({ sourceKind: 'study_attempt', attempt }));
}

describe('KnowledgeProgress merged evidence derivation', () => {
  it('keeps StudyAttempt-only output exactly equal to the compatibility entry point', () => {
    const corpus = [
      studyAttempt(),
      studyAttempt({
        id: 'partial',
        createdAt: '2026-08-29T08:00:00.000Z',
        initialOutcome: 'partial',
        finalOutcome: 'partial',
        errorType: 'method',
      }),
      studyAttempt({
        id: 'skipped',
        createdAt: '2026-08-30T08:00:00.000Z',
        initialOutcome: 'skipped',
        finalOutcome: 'correct',
        attemptKind: 'review',
      }),
      evaluatedStudyAttemptV2({
        id: 'assisted-v2',
        createdAt: '2026-08-31T08:00:00.000Z',
        hintsUsed: 1,
      }),
      unassessedStudyAttemptV2({
        id: 'unassessed-v2',
        createdAt: '2026-09-01T08:00:00.000Z',
      }),
    ];
    const existing = deriveKnowledgeProgress({ ...input, attempts: corpus });
    const merged = deriveKnowledgeProgressFromEvidence({
      ...input,
      evidence: attemptEvidence(...corpus),
    });
    expect(merged).toEqual(existing);
    expect(merged).not.toHaveProperty('examObservationCount');
    expect(merged).not.toHaveProperty('lastEvidenceAt');
  });

  it('counts one or five incorrect questions in the same Exam as one negative occasion', () => {
    const one = deriveKnowledgeProgressFromEvidence({
      ...input,
      evidence: examEvidence(observation()),
    });
    const five = deriveKnowledgeProgressFromEvidence({
      ...input,
      evidence: examEvidence(
        ...Array.from({ length: 5 }, (_, index) =>
          observation({ confirmedQuestionId: `confirmed-question-${index + 1}` }),
        ),
      ),
    });
    expect(one).toMatchObject({
      state: 'needs_observation',
      incorrectObservationCount: 1,
      examObservationCount: 1,
      examOccasionCount: 1,
    });
    expect(five).toMatchObject({
      state: 'needs_observation',
      incorrectObservationCount: 1,
      examObservationCount: 5,
      examOccasionCount: 1,
    });
  });

  it('counts separate Exams as separate negative occasions and can derive weak', () => {
    const result = deriveKnowledgeProgressFromEvidence({
      ...input,
      evidence: examEvidence(
        observation({ examSessionId: 'exam-session-1' }),
        observation({
          examSessionId: 'exam-session-2',
          observedAt: '2026-08-29T08:00:00.000Z',
        }),
      ),
    });
    expect(result.state).toBe('weak');
    expect(result.incorrectObservationCount).toBe(2);
    expect(result.examOccasionCount).toBe(2);
  });

  it('combines an Exam error and a real StudyAttempt error as two occasions', () => {
    const result = deriveKnowledgeProgressFromEvidence({
      ...input,
      evidence: [
        ...examEvidence(observation()),
        ...attemptEvidence(studyAttempt({ id: 'real-attempt-error' })),
      ],
    });
    expect(result.state).toBe('weak');
    expect(result.incorrectObservationCount).toBe(2);
  });

  it('never treats Exam correct observations as independent or assisted correct', () => {
    const result = deriveKnowledgeProgressFromEvidence({
      ...input,
      evidence: examEvidence(
        observation({ examSessionId: 'exam-1', result: 'correct' }),
        observation({
          examSessionId: 'exam-2',
          confirmedQuestionId: 'confirmed-question-2',
          result: 'correct',
          observedAt: '2026-08-29T08:00:00.000Z',
        }),
      ),
    });
    expect(result).toMatchObject({
      state: 'needs_observation',
      independentCorrectCount: 0,
      assistedCorrectCount: 0,
      incorrectObservationCount: 0,
    });
    expect(result.state).not.toBe('developing');
    expect(result.state).not.toBe('stable');
  });

  it('retains a negative occasion when the same Exam and knowledge point also has a correct answer', () => {
    const result = deriveKnowledgeProgressFromEvidence({
      ...input,
      evidence: examEvidence(
        observation({ confirmedQuestionId: 'question-correct', result: 'correct' }),
        observation({ confirmedQuestionId: 'question-incorrect', result: 'incorrect' }),
      ),
    });
    expect(result.incorrectObservationCount).toBe(1);
    expect(result.examOccasionCount).toBe(1);
    expect(result.state).toBe('needs_observation');
  });

  it('lets two recent independent Coach occasions recover weak evidence to developing', () => {
    const result = deriveKnowledgeProgressFromEvidence({
      ...input,
      evidence: [
        ...examEvidence(
          observation({ examSessionId: 'exam-1', observedAt: '2026-08-27T08:00:00.000Z' }),
          observation({ examSessionId: 'exam-2', observedAt: '2026-08-28T08:00:00.000Z' }),
        ),
        ...attemptEvidence(
          evaluatedStudyAttemptV2({
            id: 'independent-transfer',
            createdAt: '2026-08-29T08:00:00.000Z',
          }),
          evaluatedStudyAttemptV2({
            id: 'independent-review',
            attemptKind: 'review',
            createdAt: '2026-08-30T08:00:00.000Z',
          }),
        ),
      ],
    });
    expect(result.incorrectObservationCount).toBe(2);
    expect(result.independentCorrectCount).toBe(2);
    expect(result.state).toBe('developing');
  });

  it('does not let later Exam occasions evict the independent Coach recovery window', () => {
    const result = deriveKnowledgeProgressFromEvidence({
      ...input,
      evidence: [
        ...attemptEvidence(
          evaluatedStudyAttemptV2({
            id: 'independent-transfer-before-exams',
            createdAt: '2026-08-27T08:00:00.000Z',
          }),
          evaluatedStudyAttemptV2({
            id: 'independent-review-before-exams',
            attemptKind: 'review',
            createdAt: '2026-08-28T08:00:00.000Z',
          }),
        ),
        ...examEvidence(
          observation({ examSessionId: 'exam-after-1', observedAt: '2026-08-29T08:00:00.000Z' }),
          observation({ examSessionId: 'exam-after-2', observedAt: '2026-08-30T08:00:00.000Z' }),
          observation({ examSessionId: 'exam-after-3', observedAt: '2026-08-31T08:00:00.000Z' }),
        ),
      ],
    });
    expect(result.incorrectObservationCount).toBe(3);
    expect(result.independentCorrectCount).toBe(2);
    expect(result.state).toBe('developing');
  });

  it('keeps mapped unassessed Exam facts without deriving correctness or mastery', () => {
    const result = deriveKnowledgeProgressFromEvidence({
      ...input,
      evidence: examEvidence(observation({ result: 'unassessed' })),
    });
    expect(result).toMatchObject({
      state: 'unobserved',
      incorrectObservationCount: 0,
      independentCorrectCount: 0,
      assistedCorrectCount: 0,
      examObservationCount: 1,
      examOccasionCount: 1,
    });
  });

  it('applies multi-KP observations once per target KP and filters other partitions', () => {
    const shared = observation({ knowledgePointIds: ['linear-equations', 'fractions'] });
    const otherProfile = observation({
      examSessionId: 'exam-other-profile',
      profileId: 'student-beta',
    });
    const evidence = examEvidence(shared, otherProfile);
    const linear = deriveKnowledgeProgressFromEvidence({ ...input, evidence });
    const fractions = deriveKnowledgeProgressFromEvidence({
      ...input,
      knowledgePointId: 'fractions',
      evidence,
    });
    expect(linear.incorrectObservationCount).toBe(1);
    expect(fractions.incorrectObservationCount).toBe(1);
    expect(linear.examObservationCount).toBe(1);
    expect(fractions.examObservationCount).toBe(1);
  });

  it('deduplicates identical observations and rejects conflicting duplicate facts', () => {
    const first = observation();
    if (first.assessmentStatus !== 'evaluated') throw new Error('expected evaluated fixture');
    const duplicate = { ...first, knowledgePointIds: [...first.knowledgePointIds].reverse() };
    const conflicting: ConfirmedExamObservationV1 = { ...first, outcome: 'correct' };
    expect(
      deriveKnowledgeProgressFromEvidence({
        ...input,
        evidence: examEvidence(first, duplicate),
      }),
    ).toMatchObject({ examObservationCount: 1, incorrectObservationCount: 1 });
    expect(() =>
      deriveKnowledgeProgressFromEvidence({
        ...input,
        evidence: examEvidence(first, conflicting),
      }),
    ).toThrow('ZHONGKAO_CONFIRMED_EXAM_OBSERVATION_CONFLICT');
  });

  it('sorts observation trace deterministically and reports the latest evidence time', () => {
    const laterAttempt = studyAttempt({
      id: 'attempt-later',
      createdAt: '2026-08-31T08:00:00.000Z',
    });
    const result = deriveKnowledgeProgressFromEvidence({
      ...input,
      evidence: [
        ...examEvidence(
          observation({
            examSessionId: 'exam-later',
            confirmedQuestionId: 'question-later',
            observedAt: '2026-08-30T08:00:00.000Z',
          }),
          observation({
            examSessionId: 'exam-earlier',
            confirmedQuestionId: 'question-earlier',
            observedAt: '2026-08-29T08:00:00.000Z',
          }),
        ),
        ...attemptEvidence(laterAttempt),
      ],
    });
    expect(result.evidenceObservationIds).toEqual([
      observation({
        examSessionId: 'exam-earlier',
        confirmedQuestionId: 'question-earlier',
        observedAt: '2026-08-29T08:00:00.000Z',
      }).observationId,
      observation({
        examSessionId: 'exam-later',
        confirmedQuestionId: 'question-later',
        observedAt: '2026-08-30T08:00:00.000Z',
      }).observationId,
    ]);
    expect(result.lastAttemptAt).toBe(laterAttempt.createdAt);
    expect(result.lastEvidenceAt).toBe(laterAttempt.createdAt);
  });
});
