import { describe, expect, test } from 'vitest';

import {
  answerIncludesOption,
  gradeChoiceQuestions,
  resolveAnswerKeyToValue,
} from '@/lib/quiz/grading';
import { normalizeQuizAnswer } from '../packages/@openmaic/generation/src/scene-generator';
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
    answer: answer ?? ['A'], // 默认存储一个值键，供投影测试使用
    hasAnswer: true,
    points: 10,
  };
}

describe('resolveAnswerKeyToValue: exact alignment only', () => {
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

describe('negative cases: formatting differences are NOT silently equivalent', () => {
  test('case-differing key stays unresolved', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), 'a')).toBe('a');
  });

  test('whitespace-differing key stays unresolved', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '(6,2)')).toBe('(6,2)');
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '(6,  2)')).toBe('(6,  2)');
  });

  test('full-width wrapped key stays unresolved', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '（Ｂ）')).toBe('（Ｂ）');
  });

  test('wrapped/prefixed letter key stays unresolved', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '(B)')).toBe('(B)');
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), 'B.')).toBe('B.');
  });
});

describe('answerIncludesOption: exact resolver projection', () => {
  test('exact value and exact unique label both project to the option', () => {
    const question = q(VECTOR_OPTIONS, ['(6, 2)']); // label 存储
    expect(answerIncludesOption(question, 'A')).toBe(true); // label 解析后命中选项 A
    expect(answerIncludesOption(question, 'B')).toBe(false);
  });

  test('case/whitespace/full-width/wrapper differences project to false', () => {
    expect(answerIncludesOption(q(VECTOR_OPTIONS), 'a')).toBe(false);
    expect(answerIncludesOption(q(VECTOR_OPTIONS), '（Ｂ）')).toBe(false);
    expect(answerIncludesOption(q(VECTOR_OPTIONS), '(6,2)')).toBe(false);
  });

  test('ambiguous labels project to false for every option', () => {
    const dup = [
      { value: 'A', label: 'same' },
      { value: 'B', label: 'same' },
    ];
    const question = q(dup, ['same']); // 歧义存储：投影对任何选项都是 false
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
      answer: ['(6, 2)'], // 存储为 label（精确形态）
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
      answer: ['A', '(2, -4)'], // 值 + 精确 label 混合存储
      hasAnswer: true,
      points: 10,
    };
    const results = gradeChoiceQuestions([question], { q2: ['A', 'B'] });
    expect(results[0].correct).toBe(true);
  });

  test('formatting-variant keys do NOT silently grade correct (negative)', () => {
    const question: QuizQuestion = {
      id: 'q3',
      type: 'single',
      question: '?',
      options: VECTOR_OPTIONS,
      answer: ['(6,2)'], // 无空格变体：与任何选项值/label 都不精确相等
      hasAnswer: true,
      points: 10,
    };
    const results = gradeChoiceQuestions([question], { q3: 'A' });
    expect(results[0].correct).toBe(false);
  });
});

describe('normalizeQuizAnswer (generation): narrowed exact alignment', () => {
  test('exact value passes through', () => {
    expect(normalizeQuizAnswer({ answer: 'A' }, VECTOR_OPTIONS)).toEqual(['A']);
  });

  test('exact unique label resolves to the option value', () => {
    expect(normalizeQuizAnswer({ answer: '(6, 2)' }, VECTOR_OPTIONS)).toEqual(['A']);
  });

  test('formatting variants stay unresolved (fail closed)', () => {
    expect(normalizeQuizAnswer({ answer: '(6,2)' }, VECTOR_OPTIONS)).toEqual(['(6,2)']);
    expect(normalizeQuizAnswer({ answer: '（Ｂ）' }, VECTOR_OPTIONS)).toEqual(['（Ｂ）']);
  });

  test('ambiguous keys stay unresolved', () => {
    const dup = [
      { value: 'A', label: 'same' },
      { value: 'B', label: 'same' },
    ];
    expect(normalizeQuizAnswer({ answer: 'same' }, dup)).toEqual(['same']);
  });
});
