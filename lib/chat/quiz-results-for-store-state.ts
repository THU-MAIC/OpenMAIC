import type { QuestionResult } from '@/lib/quiz/grading';
import { readSubmittedState, type QuizAnswers } from '@/lib/quiz/persistence';

export interface QuizResultsForStoreState {
  sceneId: string;
  answers: QuizAnswers;
  results: QuestionResult[];
}

/**
 * Hydrate graded quiz context for chat. An empty result list still marks the
 * QuizView as reviewed, but carries no feedback that the agent can use.
 */
export function buildQuizResultsForStoreState(
  scenes: { id: string; type?: string }[],
  currentSceneId: string | null,
): QuizResultsForStoreState | undefined {
  if (!currentSceneId) return undefined;
  const scene = scenes.find((candidate) => candidate.id === currentSceneId);
  if (!scene || scene.type !== 'quiz') return undefined;
  const submitted = readSubmittedState(currentSceneId);
  if (!submitted || submitted.kind !== 'reviewing' || submitted.results.length === 0) {
    return undefined;
  }
  return {
    sceneId: currentSceneId,
    answers: submitted.answers,
    results: submitted.results,
  };
}
