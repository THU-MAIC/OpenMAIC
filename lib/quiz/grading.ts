import type { QuizQuestion } from '@/lib/types/stage';
import { resolveQuizAnswerKey } from '@/lib/quiz/answer-key';

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
 * Resolve a PERSISTED answer-key entry to an option value. Canonical, unique
 * alignment: NFKC + whitespace-stripped + lowercase, tolerant of leading
 * letter wrappers ("A." / "A、" / "(B)" / "（Ｂ）"). An entry that canonically
 * equals exactly one option VALUE or LABEL resolves to that option's actual
 * `value`. Unknown or ambiguous entries stay unresolved.
 *
 * This compatibility resolution exists for the stored key, whose form is
 * whatever the generator wrote (content, letter, or a formatting variant).
 * A learner submission is produced by the UI from the option values
 * themselves, so it is compared as-is — see `gradeChoiceQuestions`.
 */
export function resolveAnswerKeyToValue(q: QuizQuestion, answer: string): string {
  return resolveQuizAnswerKey(answer, q.options ?? []);
}

/**
 * Review-UI projection of the same canonical resolver used for grading:
 * whether an option's value is among the question's resolved correct-answer
 * values. Receives the question so content/format-variant keys resolve
 * through the identical unique alignment instead of a separate matcher.
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
      // Compatibility resolution applies to the persisted key only. The
      // submission is a value the UI produced from the options, so resolving
      // it too would let a label (or any alias the key accepts) be submitted
      // and accepted as a different option.
      const userAnswer = toArray(answers[q.id]);
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
