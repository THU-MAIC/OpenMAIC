import { describe, it, expect } from 'vitest';
import { gradeChoiceQuestions, isShortAnswer } from '@/lib/quiz/grading';
import type { QuizQuestion } from '@/lib/types/stage';

function q(overrides: Partial<QuizQuestion>): QuizQuestion {
  return {
    id: 'q1',
    type: 'single',
    question: 'Pick one',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
    answer: ['a'],
    hasAnswer: true,
    points: 1,
    ...overrides,
  };
}

describe('gradeChoiceQuestions', () => {
  it('scores a correct single-choice answer', () => {
    const results = gradeChoiceQuestions([q({})], { q1: 'a' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ questionId: 'q1', correct: true, earned: 1 });
  });

  it('grades legacy content answer keys against option values', () => {
    const question = q({
      options: [
        { value: 'A', label: '(6, 2)' },
        { value: 'B', label: '(2, -4)' },
      ],
      answer: ['（６，２）'],
    });

    const results = gradeChoiceQuestions([question], { q1: 'A' });
    expect(results[0]).toMatchObject({ correct: true, earned: 1 });
  });

  it('normalizes prefixed and whitespace variants for multiple answers', () => {
    const question = q({
      id: 'm1',
      type: 'multiple',
      options: [
        { value: 'A', label: 'First choice' },
        { value: 'B', label: 'Second choice' },
      ],
      answer: ['A. First choice', ' Second   choice '],
    });

    const results = gradeChoiceQuestions([question], { m1: ['B', 'A'] });
    expect(results[0].correct).toBe(true);
  });

  it('preserves an ambiguous legacy answer key instead of guessing', () => {
    const question = q({
      options: [
        { value: 'A', label: 'Yes' },
        { value: 'B', label: 'yes' },
      ],
      answer: ['YES'],
    });

    const results = gradeChoiceQuestions([question], { q1: 'A' });
    expect(results[0].correct).toBe(false);
  });

  it('preserves an unknown legacy answer key instead of accepting a wrong choice', () => {
    const question = q({ answer: ['not an option'] });
    const results = gradeChoiceQuestions([question], { q1: 'a' });
    expect(results[0].correct).toBe(false);
  });

  it('scores an incorrect single-choice answer', () => {
    const results = gradeChoiceQuestions([q({})], { q1: 'b' });
    expect(results[0]).toMatchObject({ correct: false, earned: 0 });
  });

  it('treats multi-choice order-insensitively', () => {
    const question = q({ id: 'm1', type: 'multiple', answer: ['a', 'b'] });
    const results = gradeChoiceQuestions([question], { m1: ['b', 'a'] });
    expect(results[0].correct).toBe(true);
  });

  it('scores missing answer as incorrect', () => {
    const results = gradeChoiceQuestions([q({})], {});
    expect(results[0]).toMatchObject({ correct: false, earned: 0 });
  });

  it('skips short-answer questions', () => {
    const sa = q({ id: 's1', type: 'short_answer', answer: [], hasAnswer: false });
    const results = gradeChoiceQuestions([sa], { s1: 'anything' });
    expect(results).toHaveLength(0);
  });

  it('honors custom point values', () => {
    const results = gradeChoiceQuestions([q({ points: 5 })], { q1: 'a' });
    expect(results[0].earned).toBe(5);
  });
});

describe('isShortAnswer', () => {
  it('returns true for type=short_answer', () => {
    expect(isShortAnswer(q({ type: 'short_answer' }))).toBe(true);
  });

  it('classifies by type only: an unanswered choice question is still a choice question', () => {
    // hasAnswer / empty answer must NOT re-route a single/multiple question to
    // AI grading — the explicit type wins.
    expect(isShortAnswer(q({ type: 'single', hasAnswer: false, answer: [] }))).toBe(false);
    expect(isShortAnswer(q({ type: 'multiple', hasAnswer: undefined, answer: [] }))).toBe(false);
  });

  it('returns false for a regular choice question', () => {
    expect(isShortAnswer(q({}))).toBe(false);
  });
});
