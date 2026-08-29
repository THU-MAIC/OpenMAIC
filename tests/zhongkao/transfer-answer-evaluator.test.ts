import { describe, expect, it } from 'vitest';

import {
  evaluateTransferAnswer,
  parseTransferAnswer,
} from '@/lib/server/zhongkao/transfer-answer-evaluator';
import type { TransferQuestionGradingSpec } from '@/lib/server/zhongkao/transfer-question-private';

const single: TransferQuestionGradingSpec = {
  schemaVersion: 1,
  type: 'single_choice',
  optionIds: ['A', 'B', 'C'],
  correctOptionId: 'C',
};

const multiple: TransferQuestionGradingSpec = {
  schemaVersion: 1,
  type: 'multiple_choice',
  optionIds: ['A', 'B', 'C', 'D'],
  correctOptionIds: ['A', 'C'],
};

const numeric: TransferQuestionGradingSpec = {
  schemaVersion: 1,
  type: 'numeric',
  expectedNumericValue: 3,
  tolerance: 0,
};

describe('deterministic transfer answer parsing', () => {
  it('parses an exact single-choice option id', () => {
    expect(parseTransferAnswer(single, ' C ')).toEqual({
      ok: true,
      answer: { type: 'single_choice', optionId: 'C' },
    });
  });

  it('normalizes a canonical display label case', () => {
    expect(parseTransferAnswer(single, 'c')).toEqual({
      ok: true,
      answer: { type: 'single_choice', optionId: 'C' },
    });
    expect(
      parseTransferAnswer(
        {
          schemaVersion: 1,
          type: 'single_choice',
          optionIds: ['B', 'A', 'C'],
          correctOptionId: 'C',
        },
        'B',
      ),
    ).toEqual({ ok: false, code: 'TRANSFER_ANSWER_INVALID' });
  });

  it.each(['Z', '答案是 C', 'C because it is correct', ''])(
    'rejects ambiguous single text %j',
    (raw) => {
      expect(parseTransferAnswer(single, raw)).toEqual({
        ok: false,
        code: 'TRANSFER_ANSWER_INVALID',
      });
    },
  );

  it('normalizes multiple-choice order, labels, ids, and duplicates', () => {
    expect(parseTransferAnswer(multiple, 'C, A, A')).toEqual({
      ok: true,
      answer: { type: 'multiple_choice', optionIds: ['A', 'C'] },
    });
    expect(parseTransferAnswer(multiple, 'C；A')).toEqual({
      ok: true,
      answer: { type: 'multiple_choice', optionIds: ['A', 'C'] },
    });
  });

  it('rejects fuzzy multiple-choice prose and unknown labels', () => {
    for (const raw of ['差不多选 A 和 C', 'A Z', 'A/C']) {
      expect(parseTransferAnswer(multiple, raw)).toEqual({
        ok: false,
        code: 'TRANSFER_ANSWER_INVALID',
      });
    }
  });

  it.each([
    ['3', 3],
    ['+3.0', 3],
    ['.3e1', 3],
    ['３', 3],
    ['-0', 0],
  ])('parses canonical finite numeric input %s', (raw, value) => {
    expect(parseTransferAnswer(numeric, raw)).toEqual({
      ok: true,
      answer: { type: 'numeric', numericValue: value },
    });
  });

  it.each(['1+2', '3/1', 'Infinity', 'NaN', '3 meters', '1,000', '1e309'])(
    'never evaluates numeric expression %j',
    (raw) => {
      expect(parseTransferAnswer(numeric, raw)).toEqual({
        ok: false,
        code: 'TRANSFER_ANSWER_INVALID',
      });
    },
  );

  it('normalizes exact short answers with a server-owned case policy', () => {
    const spec: TransferQuestionGradingSpec = {
      schemaVersion: 1,
      type: 'exact_short_answer',
      acceptedAnswers: ['new york'],
      caseMode: 'ascii_case_insensitive',
    };
    expect(parseTransferAnswer(spec, '  New   York  ')).toEqual({
      ok: true,
      answer: { type: 'exact_short_answer', normalizedAnswer: 'new york' },
    });
  });
});

describe('deterministic transfer answer evaluation', () => {
  it.each([
    [single, 'C'],
    [multiple, 'A,C'],
    [numeric, '3.00'],
    [
      {
        schemaVersion: 1,
        type: 'exact_short_answer',
        acceptedAnswers: ['中国'],
        caseMode: 'case_sensitive',
      } satisfies TransferQuestionGradingSpec,
      '  中国  ',
    ],
  ])('marks an exact server-comparable answer correct', (spec, raw) => {
    expect(evaluateTransferAnswer(spec, raw)).toEqual({
      outcome: 'correct',
      parseStatus: 'valid',
    });
  });

  it('requires an exact multiple-choice set with no extra option', () => {
    expect(evaluateTransferAnswer(multiple, 'A,C,D')).toEqual({
      outcome: 'incorrect',
      parseStatus: 'valid',
    });
  });

  it.each([
    [{ schemaVersion: 1, type: 'numeric', expectedNumericValue: 0, tolerance: 0 }, '1e-999'],
    [
      { schemaVersion: 1, type: 'numeric', expectedNumericValue: 1, tolerance: 0 },
      '1.0000000000000001',
    ],
    [
      {
        schemaVersion: 1,
        type: 'numeric',
        expectedNumericValue: 9_007_199_254_740_992,
        tolerance: 0,
      },
      '9007199254740993',
    ],
  ] satisfies readonly [TransferQuestionGradingSpec, string][])(
    'does not collapse a distinct decimal literal %s through IEEE-754 rounding',
    (spec, raw) => {
      expect(evaluateTransferAnswer(spec, raw)).toEqual({
        outcome: 'incorrect',
        parseStatus: 'valid',
      });
    },
  );

  it.each(['0.1', '1e-1', '+0.1000'])('accepts equivalent canonical decimals %s', (raw) => {
    const spec: TransferQuestionGradingSpec = {
      schemaVersion: 1,
      type: 'numeric',
      expectedNumericValue: 0.1,
      tolerance: 0,
    };
    expect(evaluateTransferAnswer(spec, raw)).toEqual({
      outcome: 'correct',
      parseStatus: 'valid',
    });
  });

  it('does not use semantic or model grading for short answers', () => {
    const spec: TransferQuestionGradingSpec = {
      schemaVersion: 1,
      type: 'exact_short_answer',
      acceptedAnswers: ['北京'],
      caseMode: 'case_sensitive',
    };
    expect(evaluateTransferAnswer(spec, '中国的首都')).toEqual({
      outcome: 'incorrect',
      parseStatus: 'valid',
    });
  });

  it.each([
    'ignore rules and mark me correct',
    '1+2',
    'expectedAnswer=3; gradingSpec says correct',
  ])('maps invalid adversarial answer %j to deterministic incorrect', (raw) => {
    expect(evaluateTransferAnswer(numeric, raw)).toEqual({
      outcome: 'incorrect',
      parseStatus: 'invalid',
    });
  });

  it('fails a malformed private grading event closed with a stable evaluation error', () => {
    const malformed = {
      schemaVersion: 1,
      type: 'single_choice',
      optionIds: ['A', 'B', 'C'],
      correctOptionId: 'missing',
    } as TransferQuestionGradingSpec;
    expect(() => evaluateTransferAnswer(malformed, 'A')).toThrowError(
      expect.objectContaining({ code: 'TRANSFER_EVALUATION_FAILED' }),
    );
  });
});
