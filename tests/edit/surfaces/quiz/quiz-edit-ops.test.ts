import { describe, it, expect } from 'vitest';
import type { QuizContent, QuizQuestion } from '@/lib/types/stage';
import {
  addOption,
  addQuestion,
  commitQuizContent,
  createBlankQuestion,
  createQuizEditHistory,
  deleteOption,
  deleteQuestion,
  MAX_OPTIONS,
  redoQuiz,
  reorderOptions,
  reorderQuestions,
  setQuestionType,
  toggleCorrect,
  undoQuiz,
  updateOptionLabel,
  updateQuestion,
} from '@/components/edit/surfaces/quiz/quiz-edit-ops';

function choiceQuestion(over: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: 'q1',
    type: 'single',
    question: 'Capital of France?',
    options: [
      { label: 'Paris', value: 'A' },
      { label: 'Lyon', value: 'B' },
      { label: 'Nice', value: 'C' },
    ],
    answer: ['A'],
    points: 1,
    ...over,
  };
}

function content(...questions: QuizQuestion[]): QuizContent {
  return { type: 'quiz', questions };
}

describe('quiz history primitive', () => {
  it('commit pushes a fresh undo step and clears redo', () => {
    const a = content(choiceQuestion());
    const b = content(choiceQuestion({ question: 'changed' }));
    let h = createQuizEditHistory(a);
    h = commitQuizContent(h, b);
    expect(h.present).toBe(b);
    expect(h.past).toEqual([a]);
    expect(h.future).toEqual([]);
  });

  it('committing the same reference is a no-op (no empty undo step)', () => {
    const a = content(choiceQuestion());
    const h = createQuizEditHistory(a);
    expect(commitQuizContent(h, a)).toBe(h);
  });

  it('undo / redo walk the timeline', () => {
    const a = content(choiceQuestion({ question: 'a' }));
    const b = content(choiceQuestion({ question: 'b' }));
    let h = commitQuizContent(createQuizEditHistory(a), b);
    h = undoQuiz(h);
    expect(h.present).toBe(a);
    expect(h.future).toEqual([b]);
    h = redoQuiz(h);
    expect(h.present).toBe(b);
  });

  it('undo / redo at the ends are no-ops', () => {
    const h = createQuizEditHistory(content());
    expect(undoQuiz(h)).toBe(h);
    expect(redoQuiz(h)).toBe(h);
  });
});

describe('question factories + list ops', () => {
  it('createBlankQuestion seeds two options for choice, none for short_answer', () => {
    const single = createBlankQuestion('single', 'x');
    expect(single).toMatchObject({ id: 'x', type: 'single', answer: [], points: 1 });
    expect(single.options).toHaveLength(2);
    const short = createBlankQuestion('short_answer', 'y');
    expect(short).toMatchObject({ id: 'y', type: 'short_answer', hasAnswer: false });
    expect(short.options).toBeUndefined();
  });

  it('addQuestion appends; deleteQuestion removes by id; both return new content', () => {
    const c0 = content(choiceQuestion());
    const c1 = addQuestion(c0, 'multiple', 'q2');
    expect(c1).not.toBe(c0);
    expect(c1.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    const c2 = deleteQuestion(c1, 'q1');
    expect(c2.questions.map((q) => q.id)).toEqual(['q2']);
  });

  it('reorderQuestions reorders by id and keeps unnamed questions', () => {
    const c0 = content(
      choiceQuestion({ id: 'q1' }),
      choiceQuestion({ id: 'q2' }),
      choiceQuestion({ id: 'q3' }),
    );
    const c1 = reorderQuestions(c0, ['q3', 'q1']);
    expect(c1.questions.map((q) => q.id)).toEqual(['q3', 'q1', 'q2']);
  });

  it('updateQuestion patches scalar fields only', () => {
    const c0 = content(choiceQuestion());
    const c1 = updateQuestion(c0, 'q1', { points: 5, analysis: 'because' });
    expect(c1.questions[0]).toMatchObject({ points: 5, analysis: 'because' });
  });
});

describe('setQuestionType transitions', () => {
  it('choice → short_answer drops options/answer and seeds grading fields', () => {
    const c0 = content(choiceQuestion({ type: 'multiple', answer: ['A', 'C'] }));
    const q = setQuestionType(c0, 'q1', 'short_answer').questions[0];
    expect(q.type).toBe('short_answer');
    expect(q.options).toBeUndefined();
    expect(q.answer).toBeUndefined();
    expect(q.hasAnswer).toBe(false);
  });

  it('short_answer → choice seeds two blank options + empty answer', () => {
    const c0 = content(createBlankQuestion('short_answer', 'q1'));
    const q = setQuestionType(c0, 'q1', 'single').questions[0];
    expect(q.type).toBe('single');
    expect(q.options).toHaveLength(2);
    expect(q.answer).toEqual([]);
    expect(q.hasAnswer).toBeUndefined();
  });

  it('multiple → single keeps options but collapses to a single correct answer', () => {
    const c0 = content(choiceQuestion({ type: 'multiple', answer: ['A', 'C'] }));
    const q = setQuestionType(c0, 'q1', 'single').questions[0];
    expect(q.type).toBe('single');
    expect(q.options).toHaveLength(3);
    expect(q.answer).toEqual(['A']);
  });

  it('same-type is a no-op (identity question object)', () => {
    const c0 = content(choiceQuestion({ type: 'single' }));
    expect(setQuestionType(c0, 'q1', 'single').questions[0]).toBe(c0.questions[0]);
  });
});

describe('option mutations keep value=letter and answer correct', () => {
  it('addOption appends a blank C-row; updateOptionLabel sets its text', () => {
    let c = content(choiceQuestion());
    c = addOption(c, 'q1');
    const q = c.questions[0];
    expect(q.options?.map((o) => o.value)).toEqual(['A', 'B', 'C', 'D']);
    expect(q.options?.[3]).toEqual({ label: '', value: 'D' });
    c = updateOptionLabel(c, 'q1', 3, 'Marseille');
    expect(c.questions[0].options?.[3].label).toBe('Marseille');
  });

  it('deleteOption removes a row, re-letters the rest, and drops it from answer', () => {
    // answer = A (Paris). Delete A → remaining re-lettered, answer recomputed.
    const c0 = content(choiceQuestion({ answer: ['A'] }));
    const q = deleteOption(c0, 'q1', 0).questions[0];
    expect(q.options).toEqual([
      { label: 'Lyon', value: 'A' },
      { label: 'Nice', value: 'B' },
    ]);
    expect(q.answer).toEqual([]); // the correct option was deleted
  });

  it('deleteOption keeps answer pointing at the surviving correct option', () => {
    const c0 = content(choiceQuestion({ answer: ['C'] })); // Nice correct
    const q = deleteOption(c0, 'q1', 0).questions[0]; // delete Paris (A)
    // Nice slides from C→B; answer must follow.
    expect(q.options?.find((o) => o.label === 'Nice')?.value).toBe('B');
    expect(q.answer).toEqual(['B']);
  });

  it('reorderOptions re-letters by new position and answer follows the correct option', () => {
    const c0 = content(choiceQuestion({ answer: ['A'] })); // Paris correct at A
    // Move Paris (index 0) to the end (index 2).
    const q = reorderOptions(c0, 'q1', 0, 2).questions[0];
    expect(q.options).toEqual([
      { label: 'Lyon', value: 'A' },
      { label: 'Nice', value: 'B' },
      { label: 'Paris', value: 'C' },
    ]);
    expect(q.answer).toEqual(['C']); // answer tracked Paris to its new letter
  });

  it('toggleCorrect on single is radio (one correct); on multiple is checkbox', () => {
    const single = toggleCorrect(
      content(choiceQuestion({ type: 'single', answer: ['A'] })),
      'q1',
      2,
    );
    expect(single.questions[0].answer).toEqual(['C']);

    let multi = content(choiceQuestion({ type: 'multiple', answer: ['A'] }));
    multi = toggleCorrect(multi, 'q1', 2); // add C
    expect(multi.questions[0].answer).toEqual(['A', 'C']);
    multi = toggleCorrect(multi, 'q1', 0); // remove A
    expect(multi.questions[0].answer).toEqual(['C']);
  });

  it('option mutations on a short_answer question are no-ops', () => {
    const c0 = content(createBlankQuestion('short_answer', 'q1'));
    expect(addOption(c0, 'q1').questions[0].options).toBeUndefined();
    expect(toggleCorrect(c0, 'q1', 0).questions[0]).toEqual(c0.questions[0]);
  });

  it('addOption caps at MAX_OPTIONS (A–Z)', () => {
    let c = content(choiceQuestion({ options: [], answer: [] }));
    for (let i = 0; i < MAX_OPTIONS + 5; i++) c = addOption(c, 'q1');
    expect(c.questions[0].options).toHaveLength(MAX_OPTIONS);
    expect(c.questions[0].options?.at(-1)?.value).toBe('Z');
  });

  it('reorderOptions with out-of-range or equal indices is a no-op', () => {
    const c0 = content(choiceQuestion());
    expect(reorderOptions(c0, 'q1', 1, 1).questions[0].options).toEqual(c0.questions[0].options);
    expect(reorderOptions(c0, 'q1', -1, 0).questions[0].options).toEqual(c0.questions[0].options);
    expect(reorderOptions(c0, 'q1', 0, 99).questions[0].options).toEqual(c0.questions[0].options);
  });
});
