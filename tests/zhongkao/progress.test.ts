import { describe, expect, it } from 'vitest';

import { deriveKnowledgeProgress } from '@/lib/zhongkao/progress';

import { evaluatedStudyAttemptV2, NOW, studyAttempt, unassessedStudyAttemptV2 } from './fixtures';

const input = {
  profileId: 'student-alpha',
  subjectId: 'math',
  knowledgePointId: 'linear-equations',
};

function at(id: string, createdAt: string, overrides: Parameters<typeof studyAttempt>[0] = {}) {
  return studyAttempt({ id, createdAt, ...overrides });
}

describe('KnowledgeProgress derivation', () => {
  it('returns unobserved without matching attempts', () => {
    expect(deriveKnowledgeProgress({ ...input, attempts: [] })).toEqual({
      ...input,
      state: 'unobserved',
      attempts: 0,
      independentCorrectCount: 0,
      assistedCorrectCount: 0,
      incorrectObservationCount: 0,
      evidenceAttemptIds: [],
    });
  });

  it('requires two real error observations before weak', () => {
    const one = deriveKnowledgeProgress({
      ...input,
      attempts: [at('wrong-1', NOW)],
    });
    expect(one.state).toBe('needs_observation');
    expect(one.incorrectObservationCount).toBe(1);

    const two = deriveKnowledgeProgress({
      ...input,
      attempts: [at('wrong-2', '2026-08-29T08:00:00.000Z'), at('wrong-1', NOW)],
    });
    expect(two.state).toBe('weak');
    expect(two.incorrectObservationCount).toBe(2);
  });

  it('deduplicates attempt ids and sorts evidence by time', () => {
    const result = deriveKnowledgeProgress({
      ...input,
      attempts: [at('later', '2026-08-30T08:00:00.000Z'), at('first', NOW), at('first', NOW)],
    });
    expect(result.attempts).toBe(2);
    expect(result.evidenceAttemptIds).toEqual(['first', 'later']);
  });

  it('rejects conflicting outcomes in either input order', () => {
    const first = at('conflict-outcome', NOW);
    const conflicting = at('conflict-outcome', NOW, { finalOutcome: 'correct' });
    for (const attempts of [
      [first, conflicting],
      [conflicting, first],
    ]) {
      expect(() => deriveKnowledgeProgress({ ...input, attempts })).toThrow(
        'ZHONGKAO_STUDY_ATTEMPT_CONFLICT',
      );
    }
  });

  it('rejects conflicting help facts and knowledge-point facts', () => {
    const first = at('conflict-facts', NOW);
    expect(() =>
      deriveKnowledgeProgress({
        ...input,
        attempts: [first, at('conflict-facts', NOW, { hintsUsed: 1 })],
      }),
    ).toThrow('ZHONGKAO_STUDY_ATTEMPT_CONFLICT');
    expect(() =>
      deriveKnowledgeProgress({
        ...input,
        attempts: [
          first,
          at('conflict-facts', NOW, {
            knowledgePointIds: ['linear-equations', 'fractions'],
          }),
        ],
      }),
    ).toThrow('ZHONGKAO_STUDY_ATTEMPT_CONFLICT');
  });

  it('sorts different ids with the same timestamp by id', () => {
    const result = deriveKnowledgeProgress({
      ...input,
      attempts: [at('z-last', NOW), at('a-first', NOW)],
    });
    expect(result.evidenceAttemptIds).toEqual(['a-first', 'z-last']);
  });

  it('does not turn repeated identical facts into weak or developing', () => {
    const wrong = at('duplicate-wrong', NOW);
    const independent = at('duplicate-correct', '2026-08-29T08:00:00.000Z', {
      attemptKind: 'transfer',
      initialOutcome: 'correct',
      finalOutcome: 'correct',
    });
    const result = deriveKnowledgeProgress({
      ...input,
      attempts: [wrong, wrong, independent, independent],
    });
    expect(result.attempts).toBe(2);
    expect(result.incorrectObservationCount).toBe(1);
    expect(result.independentCorrectCount).toBe(1);
    expect(result.state).toBe('needs_observation');
  });

  it('does not count assisted, initial, hinted, or answer-viewed correct as independent', () => {
    const result = deriveKnowledgeProgress({
      ...input,
      attempts: [
        at('initial-correct', NOW, {
          finalOutcome: 'correct',
          initialOutcome: 'correct',
        }),
        at('hinted', '2026-08-29T08:00:00.000Z', {
          attemptKind: 'transfer',
          initialOutcome: 'correct',
          finalOutcome: 'correct',
          hintsUsed: 1,
        }),
        at('answer', '2026-08-30T08:00:00.000Z', {
          attemptKind: 'review',
          initialOutcome: 'correct',
          finalOutcome: 'correct',
          viewedFullAnswer: true,
        }),
      ],
    });
    expect(result.independentCorrectCount).toBe(0);
    expect(result.assistedCorrectCount).toBe(2);
    expect(result.state).toBe('needs_observation');
  });

  it('develops after two recent independent transfer/review successes', () => {
    const result = deriveKnowledgeProgress({
      ...input,
      attempts: [
        at('old-wrong-1', NOW),
        at('old-wrong-2', '2026-08-29T08:00:00.000Z'),
        at('transfer-1', '2026-08-30T08:00:00.000Z', {
          attemptKind: 'transfer',
          initialOutcome: 'correct',
          finalOutcome: 'correct',
        }),
        at('review-1', '2026-08-31T08:00:00.000Z', {
          attemptKind: 'review',
          initialOutcome: 'correct',
          finalOutcome: 'correct',
        }),
      ],
    });
    expect(result.state).toBe('developing');
    expect(result.independentCorrectCount).toBe(2);
    expect(result.incorrectObservationCount).toBe(2);
  });

  it('filters by profile, subject, and knowledge point and never auto-produces stable', () => {
    const result = deriveKnowledgeProgress({
      ...input,
      attempts: [
        at('right-profile', NOW, {
          attemptKind: 'transfer',
          initialOutcome: 'correct',
          finalOutcome: 'correct',
        }),
        at('wrong-profile', '2026-08-29T08:00:00.000Z', {
          profileId: 'student-beta',
        }),
        at('wrong-subject', '2026-08-30T08:00:00.000Z', {
          subjectId: 'physics',
        }),
        at('wrong-point', '2026-08-31T08:00:00.000Z', {
          knowledgePointIds: ['fractions'],
        }),
      ],
    });
    expect(result.attempts).toBe(1);
    expect(result.state).toBe('needs_observation');
    expect(result.state).not.toBe('stable');
  });

  it('applies the existing outcome semantics to evaluated v2 attempts', () => {
    const result = deriveKnowledgeProgress({
      ...input,
      attempts: [
        evaluatedStudyAttemptV2({
          id: 'v2-wrong',
          attemptKind: 'initial',
          initialOutcome: 'incorrect',
          finalOutcome: 'incorrect',
        }),
        evaluatedStudyAttemptV2({
          id: 'v2-independent',
          createdAt: '2026-08-29T08:00:00.000Z',
        }),
        evaluatedStudyAttemptV2({
          id: 'v2-hinted',
          createdAt: '2026-08-30T08:00:00.000Z',
          hintsUsed: 1,
        }),
      ],
    });

    expect(result.incorrectObservationCount).toBe(1);
    expect(result.independentCorrectCount).toBe(1);
    expect(result.assistedCorrectCount).toBe(1);
    expect(result.state).toBe('needs_observation');
  });

  it('retains unassessed learning evidence without deriving correctness or mastery state', () => {
    const unassessed = unassessedStudyAttemptV2();
    const result = deriveKnowledgeProgress({ ...input, attempts: [unassessed] });

    expect(result).toEqual({
      ...input,
      state: 'unobserved',
      attempts: 1,
      independentCorrectCount: 0,
      assistedCorrectCount: 0,
      incorrectObservationCount: 0,
      evidenceAttemptIds: [unassessed.id],
      lastAttemptAt: unassessed.createdAt,
    });
  });

  it('does not let later unassessed attempts displace recent evaluated observations', () => {
    const result = deriveKnowledgeProgress({
      ...input,
      attempts: [
        evaluatedStudyAttemptV2({ id: 'evaluated-1' }),
        evaluatedStudyAttemptV2({
          id: 'evaluated-2',
          createdAt: '2026-08-29T08:00:00.000Z',
          attemptKind: 'review',
        }),
        unassessedStudyAttemptV2({
          id: 'unassessed-1',
          createdAt: '2026-08-30T08:00:00.000Z',
        }),
        unassessedStudyAttemptV2({
          id: 'unassessed-2',
          createdAt: '2026-08-31T08:00:00.000Z',
        }),
      ],
    });

    expect(result.attempts).toBe(4);
    expect(result.independentCorrectCount).toBe(2);
    expect(result.state).toBe('developing');
  });

  it('keeps original answer exposure separate from transfer independence', () => {
    const result = deriveKnowledgeProgress({
      ...input,
      attempts: [
        evaluatedStudyAttemptV2({
          id: 'original-viewed',
          attemptKind: 'initial',
          viewedFullAnswer: true,
        }),
        evaluatedStudyAttemptV2({
          id: 'transfer-independent',
          createdAt: '2026-08-29T08:00:00.000Z',
        }),
      ],
    });

    expect(result.independentCorrectCount).toBe(1);
    expect(result.assistedCorrectCount).toBe(1);
    expect(result.state).toBe('needs_observation');
    expect(result.state).not.toBe('stable');
  });
});
