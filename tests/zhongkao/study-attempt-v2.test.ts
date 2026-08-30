import { describe, expect, it } from 'vitest';

import {
  isAssistedCorrectAttempt,
  isEvaluatedStudyAttempt,
  isIncorrectObservation,
  isIndependentCorrectAttempt,
  studyAttemptFactsEqual,
  validateStudyAttempt,
} from '@/lib/zhongkao/study-attempt';

import { evaluatedStudyAttemptV2, studyAttempt, unassessedStudyAttemptV2 } from './fixtures';

function withoutField(value: object, field: string): Record<string, unknown> {
  const copy = { ...value } as Record<string, unknown>;
  delete copy[field];
  return copy;
}

describe('StudyAttempt v2 contract', () => {
  it('accepts evaluated and unassessed closed variants while preserving v1', () => {
    expect(validateStudyAttempt(studyAttempt())).toEqual({ valid: true });
    expect(validateStudyAttempt(evaluatedStudyAttemptV2())).toEqual({ valid: true });
    expect(validateStudyAttempt(unassessedStudyAttemptV2())).toEqual({ valid: true });
  });

  it('requires a bounded, trimmed coach session id only on v2', () => {
    const evaluated = evaluatedStudyAttemptV2();
    expect(validateStudyAttempt(withoutField(evaluated, 'coachSessionId')).valid).toBe(false);
    expect(validateStudyAttempt({ ...evaluated, coachSessionId: '' }).valid).toBe(false);
    expect(validateStudyAttempt({ ...evaluated, coachSessionId: ' untrimmed' }).valid).toBe(false);
    expect(validateStudyAttempt({ ...evaluated, coachSessionId: 'x'.repeat(129) }).valid).toBe(
      false,
    );
    expect(
      validateStudyAttempt({ ...studyAttempt(), coachSessionId: 'coach-session-alpha' }).valid,
    ).toBe(false);
  });

  it('requires both outcomes and forbids an unassessed reason on evaluated v2', () => {
    const evaluated = evaluatedStudyAttemptV2();
    expect(validateStudyAttempt(withoutField(evaluated, 'initialOutcome')).valid).toBe(false);
    expect(validateStudyAttempt(withoutField(evaluated, 'finalOutcome')).valid).toBe(false);
    expect(
      validateStudyAttempt({
        ...evaluated,
        unassessedReason: 'unsupported_question_type',
      }).valid,
    ).toBe(false);
    expect(validateStudyAttempt({ ...evaluated, unassessedReason: undefined }).valid).toBe(false);
  });

  it('requires the closed reason and forbids outcomes on unassessed v2', () => {
    const unassessed = unassessedStudyAttemptV2();
    expect(validateStudyAttempt(withoutField(unassessed, 'unassessedReason')).valid).toBe(false);
    expect(
      validateStudyAttempt({ ...unassessed, unassessedReason: 'temporary_failure' }).valid,
    ).toBe(false);
    expect(validateStudyAttempt({ ...unassessed, initialOutcome: 'incorrect' }).valid).toBe(false);
    expect(validateStudyAttempt({ ...unassessed, finalOutcome: 'incorrect' }).valid).toBe(false);
    expect(validateStudyAttempt({ ...unassessed, initialOutcome: undefined }).valid).toBe(false);
  });

  it('restricts unassessed v2 to initial attempts', () => {
    const unassessed = unassessedStudyAttemptV2();
    expect(validateStudyAttempt({ ...unassessed, attemptKind: 'transfer' }).valid).toBe(false);
    expect(validateStudyAttempt({ ...unassessed, attemptKind: 'review' }).valid).toBe(false);
  });

  it('rejects unsupported versions, extra fields, and non-objects', () => {
    expect(validateStudyAttempt({ ...evaluatedStudyAttemptV2(), schemaVersion: 3 }).valid).toBe(
      false,
    );
    expect(validateStudyAttempt({ ...evaluatedStudyAttemptV2(), extra: true }).valid).toBe(false);
    expect(validateStudyAttempt(null).valid).toBe(false);
    expect(validateStudyAttempt([]).valid).toBe(false);
    expect(validateStudyAttempt('attempt').valid).toBe(false);
  });

  it('treats v1 and evaluated v2 as evaluated but every unassessed fact as non-correctness', () => {
    const v1 = studyAttempt();
    const evaluated = evaluatedStudyAttemptV2();
    const unassessed = unassessedStudyAttemptV2();

    expect(isEvaluatedStudyAttempt(v1)).toBe(true);
    expect(isEvaluatedStudyAttempt(evaluated)).toBe(true);
    expect(isEvaluatedStudyAttempt(unassessed)).toBe(false);
    expect(isIndependentCorrectAttempt(unassessed)).toBe(false);
    expect(isAssistedCorrectAttempt(unassessed)).toBe(false);
    expect(isIncorrectObservation(unassessed)).toBe(false);
  });

  it('compares every variant fact without weakening v1 equality', () => {
    const v1 = studyAttempt();
    const evaluated = evaluatedStudyAttemptV2();
    const unassessed = unassessedStudyAttemptV2({ id: evaluated.id });

    expect(studyAttemptFactsEqual(v1, { ...v1 })).toBe(true);
    expect(studyAttemptFactsEqual(evaluated, { ...evaluated })).toBe(true);
    expect(
      studyAttemptFactsEqual(evaluated, {
        ...evaluated,
        coachSessionId: 'coach-session-beta',
      }),
    ).toBe(false);
    expect(studyAttemptFactsEqual(evaluated, unassessed)).toBe(false);
    expect(studyAttemptFactsEqual(unassessed, { ...unassessed })).toBe(true);
  });
});
