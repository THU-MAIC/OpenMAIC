import { describe, expect, it } from 'vitest';

import {
  isAssistedCorrectAttempt,
  isIndependentCorrectAttempt,
  validateStudyAttempt,
  type StudyAttempt,
} from '@/lib/zhongkao/study-attempt';

import { studyAttempt } from './fixtures';

describe('StudyAttempt contract', () => {
  it('accepts a fictional typed attempt with the required facts', () => {
    const attempt = studyAttempt({
      id: 'attempt-valid',
      initialOutcome: 'incorrect',
      finalOutcome: 'correct',
      errorType: 'method',
      durationSeconds: 42.5,
    });
    expect(validateStudyAttempt(attempt)).toEqual({ valid: true });
  });

  it('requires a material id for material questions', () => {
    const result = validateStudyAttempt(studyAttempt({ questionSourceType: 'material' }));
    expect(result).toMatchObject({ valid: false });
    if (!result.valid)
      expect(result.errors.map((error) => error.path)).toContain('/sourceMaterialId');
  });

  it('rejects empty and duplicate knowledge point ids', () => {
    expect(validateStudyAttempt(studyAttempt({ knowledgePointIds: [] })).valid).toBe(false);
    expect(
      validateStudyAttempt(
        studyAttempt({ knowledgePointIds: ['linear-equations', 'linear-equations'] }),
      ).valid,
    ).toBe(false);
  });

  it('rejects invalid dates, enums, schema versions, and numeric boundaries', () => {
    const invalid: Partial<StudyAttempt> = {
      schemaVersion: 2,
      createdAt: 'not-a-date',
      questionSourceType: 'unknown' as StudyAttempt['questionSourceType'],
      attemptKind: 'unknown' as StudyAttempt['attemptKind'],
      initialOutcome: 'unknown' as StudyAttempt['initialOutcome'],
      finalOutcome: 'unknown' as StudyAttempt['finalOutcome'],
      hintsUsed: -1,
      sourcePage: 0,
      durationSeconds: -0.1,
      errorType: 'unknown' as StudyAttempt['errorType'],
    };
    const result = validateStudyAttempt(studyAttempt(invalid));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThanOrEqual(9);
    }
  });

  it('strictly derives independent correct from facts rather than a client flag', () => {
    const base = studyAttempt({
      attemptKind: 'transfer',
      finalOutcome: 'correct',
      studentAttemptedBeforeHelp: true,
    });
    expect(isIndependentCorrectAttempt(base)).toBe(true);
    expect(isIndependentCorrectAttempt({ ...base, hintsUsed: 1 })).toBe(false);
    expect(isIndependentCorrectAttempt({ ...base, usedKeyHint: true })).toBe(false);
    expect(isIndependentCorrectAttempt({ ...base, viewedFullAnswer: true })).toBe(false);
    expect(isIndependentCorrectAttempt({ ...base, studentAttemptedBeforeHelp: false })).toBe(false);
    expect(isIndependentCorrectAttempt({ ...base, attemptKind: 'initial' })).toBe(false);
    expect(isIndependentCorrectAttempt({ ...base, finalOutcome: 'partial' })).toBe(false);
    expect(isAssistedCorrectAttempt({ ...base, hintsUsed: 1 })).toBe(true);
    expect(isAssistedCorrectAttempt({ ...base, studentAttemptedBeforeHelp: false })).toBe(true);
    expect(isAssistedCorrectAttempt(base)).toBe(false);
    expect(validateStudyAttempt({ ...base, isIndependent: true } as unknown)).toMatchObject({
      valid: false,
    });
  });
});
