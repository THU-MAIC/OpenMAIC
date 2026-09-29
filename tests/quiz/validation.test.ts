import { describe, expect, it } from 'vitest';
import { findQuizRenderingIssue } from '@/lib/quiz/validation';
import type { QuizQuestion } from '@/lib/types/stage';

function choiceQuestion(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: 'q1',
    type: 'single',
    question: 'Example?',
    options: [
      { value: 'A', label: 'Alpha' },
      { value: 'B', label: 'Bravo' },
      { value: 'C', label: 'Charlie' },
      { value: 'D', label: 'Delta' },
    ],
    answer: ['A'],
    ...overrides,
  };
}

describe('findQuizRenderingIssue', () => {
  it('accepts a normal choice quiz', () => {
    expect(findQuizRenderingIssue([choiceQuestion()])).toBeNull();
  });

  it('rejects duplicate option values before React renders them', () => {
    expect(
      findQuizRenderingIssue([
        choiceQuestion({
          options: [
            { value: 'A', label: 'Alpha' },
            { value: 'B', label: 'Correct answer' },
            { value: 'B', label: 'Different answer with duplicate identity' },
            { value: 'D', label: 'Delta' },
          ],
        }),
      ]),
    ).toEqual({
      code: 'duplicate-option-value',
      question: 1,
      value: 'B',
    });
  });

  it('rejects duplicate question ids', () => {
    expect(
      findQuizRenderingIssue([
        choiceQuestion({ id: 'same' }),
        choiceQuestion({ id: 'same', question: 'Second question?' }),
      ]),
    ).toEqual({
      code: 'duplicate-question-id',
      question: 2,
      value: 'same',
    });
  });

  it('allows short-answer questions without options', () => {
    expect(
      findQuizRenderingIssue([
        {
          id: 'text-1',
          type: 'short_answer',
          question: 'Explain the idea.',
        },
      ]),
    ).toBeNull();
  });
});
