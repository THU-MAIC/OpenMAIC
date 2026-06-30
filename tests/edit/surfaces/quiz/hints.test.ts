import { describe, it, expect } from 'vitest';
import type { QuizContent, QuizQuestion } from '@/lib/types/stage';
import { buildQuizHints } from '@/components/edit/surfaces/quiz/use-quiz-surface';

// Fake translator: echoes the key + interpolated question number.
const t = (k: string, o?: Record<string, unknown>) => `${k}#${o?.n ?? ''}`;

function content(...questions: QuizQuestion[]): QuizContent {
  return { type: 'quiz', questions };
}

const validSingle = (over: Partial<QuizQuestion> = {}): QuizQuestion => ({
  id: 'q',
  type: 'single',
  question: 'A real question?',
  options: [
    { label: 'Yes', value: 'A' },
    { label: 'No', value: 'B' },
  ],
  answer: ['A'],
  points: 1,
  ...over,
});

describe('buildQuizHints', () => {
  it('emits nothing for a fully valid quiz', () => {
    const c = content(validSingle(), {
      id: 'q2',
      type: 'short_answer',
      question: 'Explain.',
      commentPrompt: 'guidance',
      points: 1,
    });
    expect(buildQuizHints(c, t)).toEqual([]);
  });

  it('flags an empty question as a suggestion', () => {
    const h = buildQuizHints(content(validSingle({ id: 'q1', question: '   ' })), t);
    expect(h).toEqual([
      { id: 'q1', severity: 'suggestion', message: 'edit.quiz.hint.emptyText#1' },
    ]);
  });

  it('flags a choice question with no correct answer as a warning', () => {
    const h = buildQuizHints(content(validSingle({ id: 'q1', answer: [] })), t);
    expect(h).toEqual([{ id: 'q1', severity: 'warning', message: 'edit.quiz.hint.noCorrect#1' }]);
  });

  it('flags fewer than two options and empty option labels', () => {
    const fewOpts = buildQuizHints(
      content(validSingle({ id: 'q1', options: [{ label: 'Only', value: 'A' }], answer: ['A'] })),
      t,
    );
    expect(fewOpts[0]).toMatchObject({
      severity: 'warning',
      message: 'edit.quiz.hint.fewOptions#1',
    });

    const emptyOpt = buildQuizHints(
      content(
        validSingle({
          id: 'q1',
          options: [
            { label: 'Yes', value: 'A' },
            { label: '  ', value: 'B' },
          ],
        }),
      ),
      t,
    );
    expect(emptyOpt[0]).toMatchObject({
      severity: 'suggestion',
      message: 'edit.quiz.hint.emptyOption#1',
    });
  });

  it('does not flag a short-answer question for options/answer', () => {
    const c = content({ id: 'q1', type: 'short_answer', question: 'Discuss.', points: 1 });
    expect(buildQuizHints(c, t)).toEqual([]);
  });

  it('reports one hint per question with the question number, capped at 5', () => {
    const blanks = Array.from({ length: 7 }, (_, i) => validSingle({ id: `q${i}`, question: '' }));
    const h = buildQuizHints(content(...blanks), t);
    expect(h).toHaveLength(5);
    expect(h[0].message).toBe('edit.quiz.hint.emptyText#1');
    expect(h[4].message).toBe('edit.quiz.hint.emptyText#5');
  });
});
