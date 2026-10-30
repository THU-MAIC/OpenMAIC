import 'server-only';
import type { ProjectDefinition } from '@/lib/pbl/v3/domain/project/project-schema';
import type { QuizAttempt } from '@/lib/pbl/v3/domain/orchestration/types';
import type { LearningView } from '@/lib/pbl/v3/types';

/** Return only feedback earned by the last submitted attempt, never unselected explanations or keys. */
export function quizQuestions(
  questions: ProjectDefinition['milestones'][number]['quiz'],
  attempt: QuizAttempt | null | undefined,
): LearningView['questions'] {
  return questions.map((question, index) => {
    const result: LearningView['questions'][number] = { q: question.q, options: question.options };
    if (!attempt || attempt.total !== questions.length) return result;
    const passed = !attempt.wrong.includes(index);
    const selected = attempt.answers?.[index];
    const known =
      Number.isInteger(selected) && selected! >= 0 && selected! < question.options.length;
    const explanation = passed
      ? question.explain
      : ((known ? question.optionFeedback?.[selected!] : undefined) ?? question.retryHint);
    return {
      ...result,
      feedback: {
        passed,
        ...(known ? { selectedAnswer: selected } : {}),
        ...(explanation ? { explanation } : {}),
      },
    };
  });
}
