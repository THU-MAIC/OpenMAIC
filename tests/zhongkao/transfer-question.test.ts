import { describe, expect, it } from 'vitest';

import {
  transferQuestionPublicFromCandidate,
  validateTransferQuestionCandidate,
  validateTransferQuestionGradingSpec,
} from '@/lib/server/zhongkao/transfer-question-private';
import * as publicZhongkao from '@/lib/zhongkao';
import { validateTransferQuestionPublic } from '@/lib/zhongkao/transfer-question';

const POLICY = {
  allowedKnowledgePointIds: ['linear-equations', 'fractions'],
  allowedDifficulties: ['same'] as const,
  subjectId: 'math',
};

function base(type: string) {
  return {
    schemaVersion: 1,
    type,
    question: '若 3x = 12，x 等于多少？',
    knowledgePointIds: ['linear-equations'],
    difficulty: 'same',
    claims: [],
  };
}

function single() {
  return {
    ...base('single_choice'),
    options: [
      { id: 'A', text: '2' },
      { id: 'B', text: '3' },
      { id: 'C', text: '4' },
    ],
    expectedAnswer: { correctOptionId: 'C' },
  };
}

function multiple() {
  return {
    ...base('multiple_choice'),
    question: '下列哪些数满足 x > 1？',
    options: [
      { id: 'opt-a', text: '0' },
      { id: 'opt-b', text: '2' },
      { id: 'opt-c', text: '3' },
    ],
    expectedAnswer: { correctOptionIds: ['opt-b', 'opt-c'] },
  };
}

function numeric() {
  return {
    ...base('numeric'),
    question: '若 5x = 15，写出 x 的数值。',
    expectedAnswer: { expectedNumericValue: 3 },
  };
}

function short() {
  return {
    ...base('exact_short_answer'),
    question: '英文单词 China 的中文是什么？',
    expectedAnswer: { acceptedAnswers: ['中国'] },
  };
}

describe('transfer question candidate and private grading contract', () => {
  it.each([
    ['single_choice', single()],
    ['multiple_choice', multiple()],
    ['numeric', numeric()],
    ['exact_short_answer', short()],
  ])('accepts a closed %s candidate', (_type, candidate) => {
    const result = validateTransferQuestionCandidate(candidate, POLICY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.gradingSpec).toMatchObject({ schemaVersion: 1, type: candidate.type });
    }
  });

  it('projects only the public question and never the expected answer', () => {
    const result = validateTransferQuestionCandidate(single(), POLICY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const question = transferQuestionPublicFromCandidate(result.candidate, 'transfer-question-1');
    expect(question).toEqual({
      schemaVersion: 1,
      transferQuestionId: 'transfer-question-1',
      type: 'single_choice',
      question: '若 3x = 12，x 等于多少？',
      options: single().options,
      knowledgePointIds: ['linear-equations'],
      difficulty: 'same',
    });
    expect(JSON.stringify(question)).not.toMatch(/answer|correct|grading|tolerance/iu);
  });

  it('rejects unsupported types with the dedicated stable code', () => {
    expect(validateTransferQuestionCandidate({ ...base('essay') }, POLICY)).toEqual({
      ok: false,
      code: 'TRANSFER_QUESTION_TYPE_UNSUPPORTED',
      reason: 'QUESTION_TYPE_UNSUPPORTED',
    });
  });

  it.each([
    ['model status', { ...single(), validationStatus: 'verified' }],
    ['model verification flag', { ...single(), verified: true }],
    ['model grading spec', { ...single(), gradingSpec: { correctOptionId: 'C' } }],
    [
      'extra nested answer field',
      { ...single(), expectedAnswer: { correctOptionId: 'C', rationale: 'secret' } },
    ],
    ['empty question', { ...single(), question: '   ' }],
    ['empty knowledge points', { ...single(), knowledgePointIds: [] }],
    [
      'numeric tolerance',
      { ...numeric(), expectedAnswer: { expectedNumericValue: 3, tolerance: 1 } },
    ],
  ])('rejects %s as an invalid closed candidate', (_label, candidate) => {
    expect(validateTransferQuestionCandidate(candidate, POLICY)).toMatchObject({
      ok: false,
      code: 'TRANSFER_QUESTION_INVALID',
    });
  });

  it('rejects a knowledge point outside the server-authorized set', () => {
    expect(
      validateTransferQuestionCandidate(
        { ...single(), knowledgePointIds: ['quadratic-equations'] },
        POLICY,
      ),
    ).toMatchObject({ ok: false, reason: 'KNOWLEDGE_POINT_UNAUTHORIZED' });
  });

  it('allows a non-empty strict subset of the authorized knowledge points', () => {
    const result = validateTransferQuestionCandidate(single(), {
      ...POLICY,
      allowedKnowledgePointIds: ['linear-equations', 'fractions'],
    });
    expect(result.ok).toBe(true);
  });

  it('sorts authorized knowledge points into one durable canonical order', () => {
    const result = validateTransferQuestionCandidate(
      { ...single(), knowledgePointIds: ['linear-equations', 'fractions'] },
      POLICY,
    );
    expect(result).toMatchObject({
      ok: true,
      candidate: { knowledgePointIds: ['fractions', 'linear-equations'] },
    });
  });

  it('remaps model-owned option ids and answer references to server display labels', () => {
    const result = validateTransferQuestionCandidate(
      {
        ...single(),
        options: [
          { id: 'correct-answer', text: '2' },
          { id: 'A', text: '3' },
          { id: 'choice-three', text: '4' },
        ],
        expectedAnswer: { correctOptionId: 'correct-answer' },
      },
      POLICY,
    );
    expect(result).toMatchObject({
      ok: true,
      candidate: {
        options: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
        expectedAnswer: { correctOptionId: 'A' },
      },
      gradingSpec: {
        optionIds: ['A', 'B', 'C'],
        correctOptionId: 'A',
      },
    });
  });

  it('keeps a shuffled model id namespace deterministic after remapping', () => {
    const result = validateTransferQuestionCandidate(
      {
        ...single(),
        options: [
          { id: 'B', text: '2' },
          { id: 'A', text: '3' },
          { id: 'C', text: '4' },
        ],
        expectedAnswer: { correctOptionId: 'A' },
      },
      POLICY,
    );
    expect(result).toMatchObject({
      ok: true,
      candidate: { expectedAnswer: { correctOptionId: 'B' } },
      gradingSpec: { optionIds: ['A', 'B', 'C'], correctOptionId: 'B' },
    });
  });

  it.each([
    [
      'duplicate option id',
      { ...single(), options: [...single().options.slice(0, 2), { id: 'B', text: '4' }] },
      'OPTION_ID_DUPLICATE',
    ],
    [
      'missing single key',
      { ...single(), expectedAnswer: { correctOptionId: 'D' } },
      'ANSWER_KEY_INVALID',
    ],
    [
      'duplicate multiple keys',
      { ...multiple(), expectedAnswer: { correctOptionIds: ['opt-b', 'opt-b'] } },
      'ANSWER_KEY_DUPLICATE',
    ],
    [
      'all options correct',
      { ...multiple(), expectedAnswer: { correctOptionIds: ['opt-a', 'opt-b', 'opt-c'] } },
      'ALL_OPTIONS_CORRECT',
    ],
  ])('rejects %s', (_label, candidate, reason) => {
    expect(validateTransferQuestionCandidate(candidate, POLICY)).toMatchObject({
      ok: false,
      reason,
    });
  });

  it('rejects NaN and Infinity even for direct JavaScript inputs', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        validateTransferQuestionCandidate(
          { ...numeric(), expectedAnswer: { expectedNumericValue: value } },
          POLICY,
        ),
      ).toMatchObject({ ok: false });
    }
  });

  it('rejects an unsafe integer answer key that cannot round-trip through JSON', () => {
    expect(
      validateTransferQuestionCandidate(
        { ...numeric(), expectedAnswer: { expectedNumericValue: 9_007_199_254_740_992 } },
        POLICY,
      ),
    ).toMatchObject({ ok: false, reason: 'NUMERIC_ANSWER_INVALID' });
  });

  it('rejects empty and canonically duplicate exact accepted answers', () => {
    expect(
      validateTransferQuestionCandidate(
        { ...short(), expectedAnswer: { acceptedAnswers: [] } },
        POLICY,
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateTransferQuestionCandidate(
        { ...short(), expectedAnswer: { acceptedAnswers: ['中国', ' 中国 '] } },
        POLICY,
      ),
    ).toMatchObject({ ok: false });
  });

  it('fails closed when a persisted private grading spec is malformed', () => {
    expect(
      validateTransferQuestionGradingSpec({
        schemaVersion: 1,
        type: 'single_choice',
        optionIds: ['A', 'B', 'C'],
        correctOptionId: 'missing',
      }),
    ).toBeNull();
    expect(
      validateTransferQuestionGradingSpec({
        schemaVersion: 1,
        type: 'single_choice',
        optionIds: ['B', 'A', 'C'],
        correctOptionId: 'A',
      }),
    ).toBeNull();
    expect(
      validateTransferQuestionGradingSpec({
        schemaVersion: 1,
        type: 'numeric',
        expectedNumericValue: 3,
        tolerance: 0,
        expectedAnswer: 3,
      }),
    ).toBeNull();
  });

  it('does not export the private grading schema or verifier from the public barrel', () => {
    expect(publicZhongkao).not.toHaveProperty('TRANSFER_QUESTION_GRADING_SPEC_SCHEMA');
    expect(publicZhongkao).not.toHaveProperty('TRANSFER_QUESTION_CANDIDATE_SCHEMA');
    expect(publicZhongkao).not.toHaveProperty('generateVerifiedTransferQuestion');
  });
});

describe('public transfer question validation', () => {
  it('accepts a valid answer-free public payload and copies it', () => {
    const candidate = validateTransferQuestionCandidate(single(), POLICY);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    const question = transferQuestionPublicFromCandidate(candidate.candidate, 'transfer-1');
    expect(validateTransferQuestionPublic(question)).toEqual(question);
  });

  it.each(['expectedAnswer', 'correctOptionIds', 'acceptedAnswers', 'tolerance', 'gradingSpec'])(
    'rejects leaked %s fields',
    (field) => {
      const candidate = validateTransferQuestionCandidate(single(), POLICY);
      expect(candidate.ok).toBe(true);
      if (!candidate.ok) return;
      const question = transferQuestionPublicFromCandidate(candidate.candidate, 'transfer-1')!;
      expect(validateTransferQuestionPublic({ ...question, [field]: 'secret' })).toBeNull();
    },
  );

  it('rejects a choice payload whose ids are not the ordered A-F display subsequence', () => {
    const candidate = validateTransferQuestionCandidate(single(), POLICY);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    const question = transferQuestionPublicFromCandidate(candidate.candidate, 'transfer-1')!;
    expect(
      validateTransferQuestionPublic({
        ...question,
        options: [
          { id: 'B', text: '2' },
          { id: 'A', text: '3' },
          { id: 'C', text: '4' },
        ],
      }),
    ).toBeNull();
  });
});
