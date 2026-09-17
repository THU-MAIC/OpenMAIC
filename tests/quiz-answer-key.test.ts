import { describe, expect, test } from 'vitest';

import {
  answerIncludesOption,
  gradeChoiceQuestions,
  resolveAnswerKeyToValue,
} from '@/lib/quiz/grading';
import {
  canonQuizAnswerKey as appCanon,
  resolveQuizAnswerKey as appResolve,
} from '@/lib/quiz/answer-key';
import { normalizeQuizAnswer } from '../packages/@openmaic/generation/src/scene-generator';
import {
  canonQuizAnswerKey as genCanon,
  resolveQuizAnswerKey as genResolve,
} from '../packages/@openmaic/generation/src/quiz-answer-key';
import type { QuizQuestion } from '@/lib/types/stage';

const VECTOR_OPTIONS = [
  { value: 'A', label: '(6, 2)' },
  { value: 'B', label: '(2, -4)' },
  { value: 'C', label: '(6, -3)' },
  { value: 'D', label: '(6, -4)' },
];

const RELATION_OPTIONS = [
  { value: 'A', label: '平行' },
  { value: 'B', label: '垂直' },
  { value: 'C', label: '同向' },
  { value: 'D', label: '反向' },
];

function q(options: { value: string; label: string }[], answer?: string[]): QuizQuestion {
  return {
    id: 'qx',
    type: 'single',
    question: '?',
    options,
    answer: answer ?? ['A'],
    hasAnswer: true,
    points: 10,
  };
}

describe('canonQuizAnswerKey: generation and grading stay in lockstep', () => {
  test.each([
    'A',
    'a',
    'A.',
    'A、',
    '(B)',
    '（Ｂ）',
    '(6, 2)',
    '(6,2)',
    '（６，２）',
    '垂直 ',
    'A. (6, 2)',
  ])('same canonical form for %j', (sample) => {
    expect(appCanon(sample)).toBe(genCanon(sample));
  });

  test('same unique resolution for letter, content, and variant keys', () => {
    for (const key of ['A', 'a', '(6, 2)', '(6,2)', '（６，２）', '（Ｂ）', 'B.', 'A、']) {
      expect(appResolve(key, VECTOR_OPTIONS)).toBe(genResolve(key, VECTOR_OPTIONS));
    }
  });
});

describe('resolveAnswerKeyToValue: exact alignment', () => {
  test('exact option value resolves to itself', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), 'A')).toBe('A');
  });

  test('exact unique label resolves to that option value', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '(6, 2)')).toBe('A');
  });

  test('unknown key stays unresolved', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '(9, 9)')).toBe('(9, 9)');
  });

  test('ambiguous: two options sharing one label stays unresolved', () => {
    const dup = [
      { value: 'A', label: 'same' },
      { value: 'B', label: 'same' },
    ];
    expect(resolveAnswerKeyToValue(q(dup), 'same')).toBe('same');
  });
});

describe('resolveAnswerKeyToValue: canonical formatting variants', () => {
  test('case-differing letter key resolves to the option value', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), 'a')).toBe('A');
  });

  test('whitespace-differing content key resolves to the option value', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '(6,2)')).toBe('A');
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '(6,  2)')).toBe('A');
  });

  test('full-width content key resolves via NFKC', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '（６，２）')).toBe('A');
  });

  test('full-width wrapped letter key resolves to the option value', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '（Ｂ）')).toBe('B');
  });

  test('wrapped/prefixed letter keys resolve to the option value', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '(B)')).toBe('B');
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), 'B.')).toBe('B');
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), 'A、')).toBe('A');
  });

  test('leading letter wrapper on content resolves to the option value', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), 'A. (6, 2)')).toBe('A');
  });

  test('trailing-space content key resolves to the option value', () => {
    expect(resolveAnswerKeyToValue(q(RELATION_OPTIONS), '垂直 ')).toBe('B');
  });

  test('canonical-equal-not-byte-identical value match returns the option value', () => {
    // Persisted key holds a formatting variant of the option VALUE itself
    // (not the label). Must return the option's actual value, not the input.
    const contentValued = [
      { value: '(6, 2)', label: 'A' },
      { value: '(2, -4)', label: 'B' },
    ];
    expect(resolveAnswerKeyToValue(q(contentValued), '（６，２）')).toBe('(6, 2)');
  });

  test('ambiguous canonical labels stay unresolved', () => {
    const dup = [
      { value: 'A', label: '(6, 2)' },
      { value: 'B', label: '(6,2)' },
    ];
    expect(resolveAnswerKeyToValue(q(dup), '(6, 2)')).toBe('(6, 2)');
    expect(resolveAnswerKeyToValue(q(dup), '(6,2)')).toBe('(6,2)');
  });

  test('semantic synonym stays unresolved', () => {
    expect(resolveAnswerKeyToValue(q(RELATION_OPTIONS), '正交')).toBe('正交');
  });
});

describe('answerIncludesOption: canonical resolver projection', () => {
  test('exact value and exact unique label both project to the option', () => {
    const question = q(VECTOR_OPTIONS, ['(6, 2)']);
    expect(answerIncludesOption(question, 'A')).toBe(true);
    expect(answerIncludesOption(question, 'B')).toBe(false);
  });

  test('formatting-variant stored keys project to the matching option', () => {
    expect(answerIncludesOption(q(VECTOR_OPTIONS, ['a']), 'A')).toBe(true);
    expect(answerIncludesOption(q(VECTOR_OPTIONS, ['（Ｂ）']), 'B')).toBe(true);
    expect(answerIncludesOption(q(VECTOR_OPTIONS, ['(6,2)']), 'A')).toBe(true);
    expect(answerIncludesOption(q(VECTOR_OPTIONS, ['(6,2)']), 'B')).toBe(false);
  });

  test('ambiguous labels project to false for every option', () => {
    const dup = [
      { value: 'A', label: 'same' },
      { value: 'B', label: 'same' },
    ];
    const question = q(dup, ['same']);
    expect(answerIncludesOption(question, 'A')).toBe(false);
    expect(answerIncludesOption(question, 'B')).toBe(false);
  });
});

describe('gradeChoiceQuestions: consumer paths', () => {
  test('persisted exact-label key grades correct in single-choice review', () => {
    const question: QuizQuestion = {
      id: 'q1',
      type: 'single',
      question: 'a+b=?',
      options: VECTOR_OPTIONS,
      answer: ['(6, 2)'],
      hasAnswer: true,
      points: 10,
    };
    const results = gradeChoiceQuestions([question], { q1: 'A' });
    expect(results[0].correct).toBe(true);
  });

  test('multiple-choice with exact-value and exact-label keys grades correct', () => {
    const question: QuizQuestion = {
      id: 'q2',
      type: 'multiple',
      question: 'select all',
      options: VECTOR_OPTIONS,
      answer: ['A', '(2, -4)'],
      hasAnswer: true,
      points: 10,
    };
    const results = gradeChoiceQuestions([question], { q2: ['A', 'B'] });
    expect(results[0].correct).toBe(true);
  });

  test('formatting-variant keys grade correct when the learner picks the option value', () => {
    const question: QuizQuestion = {
      id: 'q3',
      type: 'single',
      question: '?',
      options: VECTOR_OPTIONS,
      answer: ['(6,2)'],
      hasAnswer: true,
      points: 10,
    };
    const results = gradeChoiceQuestions([question], { q3: 'A' });
    expect(results[0].correct).toBe(true);
  });

  test('full-width letter key grades correct', () => {
    const question: QuizQuestion = {
      id: 'q3b',
      type: 'single',
      question: '?',
      options: VECTOR_OPTIONS,
      answer: ['（Ｂ）'],
      hasAnswer: true,
      points: 10,
    };
    expect(gradeChoiceQuestions([question], { q3b: 'B' })[0].correct).toBe(true);
  });

  test('compatibility resolution applies to the persisted key only (negative)', () => {
    // 键是值键 A；提交的却是该选项的 label。只有持久化键才做兼容解析，
    // 提交按原值比较 —— label 提交必须判错，否则别名提交会被当成另一选项。
    const question: QuizQuestion = {
      id: 'q4',
      type: 'single',
      question: '?',
      options: VECTOR_OPTIONS,
      answer: ['A'],
      hasAnswer: true,
      points: 10,
    };
    expect(gradeChoiceQuestions([question], { q4: '(6, 2)' })[0].correct).toBe(false);
    expect(gradeChoiceQuestions([question], { q4: 'A' })[0].correct).toBe(true);
  });

  test('multiple-choice with formatting-variant keys grades a fully-correct selection', () => {
    const question: QuizQuestion = {
      id: 'q5',
      type: 'multiple',
      question: '选出正确的坐标',
      options: VECTOR_OPTIONS,
      answer: ['（Ａ）', 'c'],
      hasAnswer: true,
      points: 10,
    };
    expect(question.answer!.map((a) => resolveAnswerKeyToValue(question, a))).toEqual(['A', 'C']);
    expect(gradeChoiceQuestions([question], { q5: ['A', 'C'] })[0].correct).toBe(true);
  });
});

describe('normalizeQuizAnswer (generation): canonical alignment', () => {
  test('exact value passes through', () => {
    expect(normalizeQuizAnswer({ answer: 'A' }, VECTOR_OPTIONS)).toEqual(['A']);
  });

  test('exact unique label resolves to the option value', () => {
    expect(normalizeQuizAnswer({ answer: '(6, 2)' }, VECTOR_OPTIONS)).toEqual(['A']);
  });

  test('letter answer resolves to itself', () => {
    expect(normalizeQuizAnswer({ answer: 'A' }, VECTOR_OPTIONS)).toEqual(['A']);
  });

  test('content answer resolves to the matching option value', () => {
    expect(normalizeQuizAnswer({ answer: '(6, 2)' }, VECTOR_OPTIONS)).toEqual(['A']);
  });

  test('full-width formatting variant resolves via NFKC', () => {
    expect(normalizeQuizAnswer({ answer: '（６，２）' }, VECTOR_OPTIONS)).toEqual(['A']);
  });

  test('content without inner spaces resolves to the spaced option', () => {
    expect(normalizeQuizAnswer({ answer: '(6,2)' }, VECTOR_OPTIONS)).toEqual(['A']);
  });

  test('trailing-space Chinese content resolves to the trimmed option', () => {
    expect(normalizeQuizAnswer({ answer: '垂直 ' }, RELATION_OPTIONS)).toEqual(['B']);
  });

  test('wrapped full-width single-letter key resolves', () => {
    expect(normalizeQuizAnswer({ answer: '（Ｂ）' }, VECTOR_OPTIONS)).toEqual(['B']);
  });

  test('prefixed letter keys resolve', () => {
    expect(normalizeQuizAnswer({ answer: 'A.' }, VECTOR_OPTIONS)).toEqual(['A']);
    expect(normalizeQuizAnswer({ answer: 'A、' }, VECTOR_OPTIONS)).toEqual(['A']);
    expect(normalizeQuizAnswer({ answer: '(B)' }, VECTOR_OPTIONS)).toEqual(['B']);
  });

  test('multiple letter answers pass through', () => {
    expect(normalizeQuizAnswer({ answer: ['A', 'C'] }, VECTOR_OPTIONS)).toEqual(['A', 'C']);
  });

  test('multiple mixed variants resolve independently', () => {
    expect(normalizeQuizAnswer({ answer: ['（Ａ）', 'c'] }, VECTOR_OPTIONS)).toEqual(['A', 'C']);
  });

  test('unknown answer passes through untouched', () => {
    expect(normalizeQuizAnswer({ answer: '正交' }, RELATION_OPTIONS)).toEqual(['正交']);
    expect(normalizeQuizAnswer({ answer: '(9, 9)' }, VECTOR_OPTIONS)).toEqual(['(9, 9)']);
  });

  test('ambiguous keys stay unresolved', () => {
    const dup = [
      { value: 'A', label: 'same' },
      { value: 'B', label: 'same' },
    ];
    expect(normalizeQuizAnswer({ answer: 'same' }, dup)).toEqual(['same']);
  });

  test('ambiguous canonical labels stay unresolved', () => {
    const dup = [
      { value: 'A', label: '(6, 2)' },
      { value: 'B', label: '(6,2)' },
    ];
    expect(normalizeQuizAnswer({ answer: '(6, 2)' }, dup)).toEqual(['(6, 2)']);
  });

  test('missing options passes answers through untouched', () => {
    expect(normalizeQuizAnswer({ answer: '(6, 2)' }, undefined)).toEqual(['(6, 2)']);
  });
});
