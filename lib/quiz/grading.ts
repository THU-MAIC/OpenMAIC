import type { QuizQuestion } from '@/lib/types/stage';

export interface QuestionResult {
  questionId: string;
  correct: boolean | null;
  status: 'correct' | 'incorrect';
  earned: number;
  aiComment?: string;
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Whether a question is graded as open text (AI) rather than by exact
 * answer-key match. Classification is by the explicit `type` only: an
 * unanswered choice question (empty `answer`) is still a choice question and
 * must not be re-routed to AI grading. `hasAnswer` does not override the type.
 */
export function isShortAnswer(q: QuizQuestion): boolean {
  return q.type === 'short_answer';
}

/**
 * Resolve a stored answer-key entry to an option value. Exact, unique
 * alignment only (per review): an entry that exactly equals one option VALUE
 * resolves to it; one that exactly equals exactly one option LABEL resolves
 * to that option's value. Unknown or ambiguous entries stay unresolved —
 * no case folding, whitespace/Unicode normalization, or wrapper/prefix
 * interpretation is applied.
 */
export function resolveAnswerKeyToValue(q: QuizQuestion, answer: string): string {
  const opts = q.options ?? [];
  if (opts.length === 0) return answer;
  const valueMatches = opts.filter((o) => o.value === answer);
  if (valueMatches.length === 1) return valueMatches[0].value;
  const labelMatches = opts.filter((o) => o.label === answer);
  if (labelMatches.length === 1) return labelMatches[0].value;
  return answer;
}

/**
 * Review-UI projection of the same exact resolver used for grading: whether
 * an option's value is among the question's resolved correct-answer values.
 * Receives the question so label-stored keys resolve through the identical
 * exact/unique alignment instead of a separate fuzzy matcher.
 */
export function answerIncludesOption(q: QuizQuestion, optionValue: string): boolean {
  return toArray(q.answer).some((a) => resolveAnswerKeyToValue(q, a) === optionValue);
}

/** Grade choice questions locally. Returns results only for non-short-answer questions. */
export function gradeChoiceQuestions(
  questions: QuizQuestion[],
  answers: Record<string, string | string[]>,
): QuestionResult[] {
  return questions
    .filter((q) => !isShortAnswer(q))
    .map((q) => {
      const pts = q.points ?? 1;
      const userAnswer = toArray(answers[q.id]).map((a) => resolveAnswerKeyToValue(q, a));
      const correctAnswer = toArray(q.answer).map((a) => resolveAnswerKeyToValue(q, a));
      const correct = arraysEqual(userAnswer, correctAnswer);
      return {
        questionId: q.id,
        correct,
        status: correct ? ('correct' as const) : ('incorrect' as const),
        earned: correct ? pts : 0,
      };
    });
}
