import type { QuizQuestion } from '@/lib/types/stage';

export type QuizRenderingIssue =
  | { code: 'missing-question-id'; question: number }
  | { code: 'duplicate-question-id'; question: number; value: string }
  | { code: 'missing-options'; question: number }
  | { code: 'missing-option-value'; question: number; option: number }
  | { code: 'duplicate-option-value'; question: number; value: string };

/**
 * Detect quiz data that cannot be rendered safely.
 *
 * This is intentionally narrower than generation validation. Its job is to
 * protect playback from malformed persisted/imported quiz data that would
 * otherwise break React identity or make answers ambiguous.
 */
export function findQuizRenderingIssue(
  questions: readonly QuizQuestion[],
): QuizRenderingIssue | null {
  const questionIds = new Set<string>();

  for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
    const question = questions[questionIndex];
    const questionNumber = questionIndex + 1;

    if (!question.id) {
      return { code: 'missing-question-id', question: questionNumber };
    }

    if (questionIds.has(question.id)) {
      return {
        code: 'duplicate-question-id',
        question: questionNumber,
        value: question.id,
      };
    }
    questionIds.add(question.id);

    if (question.type === 'short_answer') continue;

    const options = question.options;
    if (!options || options.length === 0) {
      return { code: 'missing-options', question: questionNumber };
    }

    const optionValues = new Set<string>();

    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      const value = options[optionIndex]?.value;

      if (!value) {
        return {
          code: 'missing-option-value',
          question: questionNumber,
          option: optionIndex + 1,
        };
      }

      if (optionValues.has(value)) {
        return {
          code: 'duplicate-option-value',
          question: questionNumber,
          value,
        };
      }

      optionValues.add(value);
    }
  }

  return null;
}
