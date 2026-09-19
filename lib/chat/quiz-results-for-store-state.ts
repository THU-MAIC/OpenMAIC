import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizAnswers } from '@/lib/quiz/persistence';
import { loadQuizAttemptState, type QuizAttemptState } from '@/lib/quiz/runtime';
import { createLogger } from '@/lib/logger';

const log = createLogger('ChatQuizContext');
const QUIZ_CONTEXT_TIMEOUT_MS = 1500;

export interface QuizResultsForStoreState {
  sceneId: string;
  answers: QuizAnswers;
  results: QuestionResult[];
}

export function didActiveSceneRemainUnchanged(
  scenesBefore: readonly { id: string }[],
  currentSceneIdBefore: string | null,
  scenesAfter: readonly { id: string }[],
  currentSceneIdAfter: string | null,
): boolean {
  // Identity comparison would be stricter than the intent (don't leak a stale
  // scene's results into the NEXT scene's request): a store update may
  // reallocate the scene object during the async quiz read while the learner
  // never left the scene, and dropping their graded answers for that turn
  // degrades the reply for no safety gain. The scene id is the boundary.
  if (!currentSceneIdBefore || currentSceneIdAfter !== currentSceneIdBefore) return false;
  return (
    scenesBefore.some((scene) => scene.id === currentSceneIdBefore) &&
    scenesAfter.some((scene) => scene.id === currentSceneIdAfter)
  );
}

/**
 * Hydrate graded quiz context for chat. An empty result list still marks the
 * QuizView as reviewed, but carries no feedback that the agent can use.
 */
export async function buildQuizResultsForStoreState(
  scenes: { id: string; type?: string; stageId?: string }[],
  currentSceneId: string | null,
): Promise<QuizResultsForStoreState | undefined> {
  if (!currentSceneId) return undefined;
  const scene = scenes.find((candidate) => candidate.id === currentSceneId);
  if (!scene || scene.type !== 'quiz' || !scene.stageId) return undefined;
  let state: QuizAttemptState | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    ({ state } = await Promise.race([
      loadQuizAttemptState({
        stageId: scene.stageId,
        sceneId: currentSceneId,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Timed out loading quiz context from RuntimeStore')),
          QUIZ_CONTEXT_TIMEOUT_MS,
        );
      }),
    ]));
  } catch (error) {
    log.warn('Failed to load quiz context:', error);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
  if (state?.phase !== 'reviewed' || !state.results || state.results.length === 0) {
    return undefined;
  }
  return {
    sceneId: currentSceneId,
    answers: state.answers,
    results: state.results,
  };
}
