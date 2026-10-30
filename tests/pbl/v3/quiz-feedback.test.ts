import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { quizQuestions } from '@/lib/server/pbl-v3/quiz-feedback';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { projectSchema } from '@/lib/pbl/v3/domain/project/project-schema';

const question = {
  q: 'What happens?',
  options: ['First mistake', 'Correct option', 'Second mistake'],
  answer: 1,
  explain: 'CORRECT_EXPLANATION',
  optionFeedback: ['FIRST_MISCONCEPTION', 'UNSELECTED_CORRECT_TEXT', 'SECOND_MISCONCEPTION'],
  retryHint: 'GENERAL_HINT',
};
const attempt = { id: 'attempt', attempt: 1, passed: false, score: 0, total: 1, wrong: [0] };
it('keeps keys and explanations hidden before submission', () => {
  expect(quizQuestions([question], null)).toEqual([{ q: question.q, options: question.options }]);
});
it.each([0, 2])('returns feedback only for the actually submitted wrong option %s', (selected) => {
  const result = quizQuestions([question], { ...attempt, answers: [selected] });
  expect(result[0].feedback).toEqual({
    passed: false,
    selectedAnswer: selected,
    explanation: question.optionFeedback[selected],
  });
  expect(JSON.stringify(result)).not.toMatch(
    /CORRECT_EXPLANATION|UNSELECTED_CORRECT_TEXT|"answer":|correctAnswer/,
  );
});
it('explains correct answers and restores the submitted learner choice', () => {
  expect(
    quizQuestions([question], { ...attempt, passed: true, score: 1, wrong: [], answers: [1] })[0]
      .feedback,
  ).toEqual({ passed: true, selectedAnswer: 1, explanation: question.explain });
});
it('keeps old attempts/packages usable without inventing a previously selected answer', () => {
  expect(quizQuestions([question], attempt)[0].feedback).toEqual({
    passed: false,
    explanation: 'GENERAL_HINT',
  });
  expect(
    quizQuestions([{ ...question, optionFeedback: undefined, retryHint: undefined }], attempt)[0]
      .feedback,
  ).toEqual({ passed: false });
  expect(quizQuestions([question], { ...attempt, wrong: [] })[0].feedback).toEqual({
    passed: true,
    explanation: question.explain,
  });
});
it('rejects invalid authored answer indexes and misaligned option feedback', () => {
  const project = structuredClone(
    installedProject({ id: 'greeting-python-lab', version: '1.1.0' }).definition,
  );
  project.milestones[0].quiz = [{ ...question, answer: 3 }];
  expect(projectSchema.safeParse(project).success).toBe(false);
  project.milestones[0].quiz = [{ ...question, optionFeedback: ['incomplete'] }];
  expect(projectSchema.safeParse(project).success).toBe(false);
});
