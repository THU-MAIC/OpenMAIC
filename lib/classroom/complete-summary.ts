import type { Scene, SceneType, QuizContent } from '@/lib/types/stage';
import { gradeChoiceQuestions } from '@/lib/quiz/grading';

export interface CompleteSummary {
  countsByType: Partial<Record<SceneType, number>>;
  /** Graded results only; null when nothing has been graded. */
  quiz: { correct: number; total: number; pct: number } | null;
  /** Quiz pages not yet submitted, in deck order. They do not count against a score. */
  unattemptedQuizIds: string[];
  /** The first quiz page with a wrong answer. */
  firstWrongQuizId: string | null;
}

/**
 * A quiz page's graded answers. `null` is not attempted, drafts included: nothing was
 * handed in, so nothing is wrong yet. `undefined` is not known (a malformed scene).
 */
export type AnswerReader = (
  sceneId: string,
) => Promise<Record<string, string | string[]> | null | undefined>;

type QuizAnswerLoader = (input: {
  stageId: string;
  sceneId: string;
}) => Promise<{ state?: { phase: string; answers: Record<string, string | string[]> } | null }>;

/** Skip malformed legacy scenes before opening their RuntimeStore partition. */
export async function readSceneQuizAnswers(
  scene: { id: string; stageId?: string } | undefined,
  load: QuizAnswerLoader,
): Promise<Record<string, string | string[]> | null | undefined> {
  if (!scene?.stageId) return undefined;
  const { state } = await load({ stageId: scene.stageId, sceneId: scene.id });
  return state?.phase === 'reviewed' ? state.answers : null;
}

export async function summarizeScenes(
  scenes: Scene[],
  readAnswers: AnswerReader,
): Promise<CompleteSummary> {
  const countsByType: Partial<Record<SceneType, number>> = {};
  for (const scene of scenes) {
    countsByType[scene.type] = (countsByType[scene.type] ?? 0) + 1;
  }

  let correct = 0;
  let total = 0;
  const unattemptedQuizIds: string[] = [];
  let firstWrongQuizId: string | null = null;
  for (const scene of scenes) {
    if (scene.type !== 'quiz') continue;
    const questions = (scene.content as QuizContent).questions ?? [];
    let answers: Awaited<ReturnType<AnswerReader>>;
    try {
      answers = await readAnswers(scene.id);
    } catch {
      continue;
    }
    if (answers === undefined) continue;
    if (answers === null) {
      unattemptedQuizIds.push(scene.id);
      continue;
    }
    // Short answers have no grade to count (`gradeChoiceQuestions` leaves them out).
    for (const result of gradeChoiceQuestions(questions, answers)) {
      total += 1;
      if (result.correct === true) correct += 1;
      else firstWrongQuizId ??= scene.id;
    }
  }

  const quiz = total > 0 ? { correct, total, pct: Math.round((correct / total) * 100) } : null;

  return { countsByType, quiz, unattemptedQuizIds, firstWrongQuizId };
}
