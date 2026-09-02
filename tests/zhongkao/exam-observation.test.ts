import { describe, expect, it } from 'vitest';

import {
  confirmedExamObservationFactsEqual,
  deriveConfirmedExamObservationId,
  deriveExamObservationOccasionId,
  serializeConfirmedExamObservation,
  validateConfirmedExamObservation,
  type ConfirmedExamObservationV1,
} from '@/lib/zhongkao/exam-observation';

const MAPPING_FINGERPRINT = 'a'.repeat(64);
const ASSESSMENT_FINGERPRINT = 'b'.repeat(64);

function observation(
  overrides: Partial<ConfirmedExamObservationV1> = {},
): ConfirmedExamObservationV1 {
  const examSessionId = overrides.examSessionId ?? 'exam-session-1';
  const confirmedQuestionId = overrides.confirmedQuestionId ?? 'confirmed-question-1';
  return {
    schemaVersion: 1,
    observationId: deriveConfirmedExamObservationId({
      examSessionId,
      confirmedQuestionId,
      mappingFingerprint: MAPPING_FINGERPRINT,
      assessmentFingerprint: ASSESSMENT_FINGERPRINT,
    }),
    profileId: 'student-alpha',
    examSessionId,
    confirmedQuestionId,
    subjectId: 'math',
    knowledgePointIds: ['linear-equations'],
    occasionId: deriveExamObservationOccasionId(examSessionId),
    observedAt: '2026-08-28T08:00:00.000Z',
    mappingSource: 'owner_confirmed_manual_mapping',
    assessmentStatus: 'evaluated',
    outcome: 'incorrect',
    ...overrides,
  } as ConfirmedExamObservationV1;
}

describe('ConfirmedExamObservationV1', () => {
  it('accepts closed evaluated and unassessed variants', () => {
    expect(validateConfirmedExamObservation(observation())).toEqual({ valid: true });
    const evaluated = observation();
    const unassessed: ConfirmedExamObservationV1 = {
      ...evaluated,
      assessmentStatus: 'unassessed',
      reason: 'unsupported_question_type',
    };
    delete (unassessed as Partial<{ outcome: string }>).outcome;
    expect(validateConfirmedExamObservation(unassessed)).toEqual({ valid: true });
  });

  it.each([
    ['unknown field', { privateAnswer: 'A' }],
    ['unknown outcome', { outcome: 'partial' }],
    ['unknown mapping source', { mappingSource: 'model_inferred' }],
    ['bad timestamp', { observedAt: 'today' }],
    ['empty knowledge points', { knowledgePointIds: [] }],
    ['duplicate knowledge points', { knowledgePointIds: ['linear-equations', 'linear-equations'] }],
    ['forged occasion', { occasionId: 'exam-occasion:v1:forged' }],
  ])('rejects %s', (_label, overrides) => {
    expect(validateConfirmedExamObservation({ ...observation(), ...overrides })).toMatchObject({
      valid: false,
    });
  });

  it('rejects evaluated-only fields on unassessed observations and vice versa', () => {
    expect(
      validateConfirmedExamObservation({
        ...observation(),
        assessmentStatus: 'unassessed',
        reason: 'unsupported_question_type',
      }).valid,
    ).toBe(false);
    expect(
      validateConfirmedExamObservation({ ...observation(), reason: 'unsupported_question_type' })
        .valid,
    ).toBe(false);
  });

  it('derives stable, source-bound observation and Exam occasion identities', () => {
    const identity = {
      examSessionId: 'exam-session-1',
      confirmedQuestionId: 'confirmed-question-1',
      mappingFingerprint: MAPPING_FINGERPRINT,
      assessmentFingerprint: ASSESSMENT_FINGERPRINT,
    };
    const id = deriveConfirmedExamObservationId(identity);
    expect(deriveConfirmedExamObservationId(identity)).toBe(id);
    expect(
      deriveConfirmedExamObservationId({
        ...identity,
        confirmedQuestionId: 'confirmed-question-2',
      }),
    ).not.toBe(id);
    expect(
      deriveConfirmedExamObservationId({ ...identity, mappingFingerprint: 'c'.repeat(64) }),
    ).not.toBe(id);
    expect(
      deriveConfirmedExamObservationId({ ...identity, assessmentFingerprint: 'd'.repeat(64) }),
    ).not.toBe(id);
    expect(deriveExamObservationOccasionId('exam-session-1')).toBe(
      deriveExamObservationOccasionId('exam-session-1'),
    );
    expect(deriveExamObservationOccasionId('exam-session-1')).not.toBe(
      deriveExamObservationOccasionId('exam-session-2'),
    );
  });

  it('canonicalizes knowledge-point order and compares semantic facts', () => {
    const first = observation({ knowledgePointIds: ['linear-equations', 'fractions'] });
    const reordered = observation({ knowledgePointIds: ['fractions', 'linear-equations'] });
    expect(
      serializeConfirmedExamObservation(first).equals(serializeConfirmedExamObservation(reordered)),
    ).toBe(true);
    expect(confirmedExamObservationFactsEqual(first, reordered)).toBe(true);
    expect(
      confirmedExamObservationFactsEqual(first, {
        ...reordered,
        observedAt: '2026-08-29T08:00:00.000Z',
      }),
    ).toBe(false);
  });
});
