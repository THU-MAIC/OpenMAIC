import type { QuizQuestion } from '@/lib/types/stage';

/**
 * Return a learner-facing reason a quiz cannot be rendered safely.
 *
 * This is intentionally narrower than generation validation. Its job is to
 * protect playback from malformed persisted/imported quiz data that would
 * otherwise break React identity or make answers ambiguous.
 */
export function findQuizRenderingIssue(
  questions: readonly QuizQuestion[],
): string | null {
  const questionIds = new Set<string>();

  for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
    const question = questions[questionIndex];

    if (!question.id) {
      return `Question ${questionIndex + 1} is missing an id.`;
    }

    if (questionIds.has(question.id)) {
      return `Question ${questionIndex + 1} repeats question id "${question.id}".`;
    }
    questionIds.add(question.id);

    if (question.type === 'short_answer') continue;

    const options = question.options;
    if (!options || options.length === 0) {
      return `Question ${questionIndex + 1} has no answer options.`;
    }

    const optionValues = new Set<string>();

    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      const value = options[optionIndex]?.value;

      if (!value) {
        return `Question ${questionIndex + 1}, option ${optionIndex + 1} is missing a value.`;
      }

      if (optionValues.has(value)) {
        return `Question ${questionIndex + 1} repeats option value "${value}".`;
      }

      optionValues.add(value);
    }
  }

  return null;
}
