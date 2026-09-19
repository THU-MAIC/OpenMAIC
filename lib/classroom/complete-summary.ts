import type { Scene, SceneType, QuizContent } from '@/lib/types/stage';
import { gradeChoiceQuestions } from '@/lib/quiz/grading';

export interface CompleteSummary {
  countsByType: Partial<Record<SceneType, number>>;
  quiz: { correct: number; total: number; pct: number } | null;
}

export interface ResolvedCompleteSummary {
  scenes: Scene[];
  summary: CompleteSummary;
}

export function pendingCompleteSummary(scenes: Scene[]): CompleteSummary {
  return {
    countsByType: scenes.reduce<CompleteSummary['countsByType']>((counts, scene) => {
      counts[scene.type] = (counts[scene.type] ?? 0) + 1;
      return counts;
    }, {}),
    quiz: null,
  };
}

/** Never render a completed summary produced for a different scenes snapshot. */
export function completeSummaryForScenes(
  scenes: Scene[],
  resolved: ResolvedCompleteSummary,
): CompleteSummary {
  return resolved.scenes === scenes ? resolved.summary : pendingCompleteSummary(scenes);
}

export type AnswerReader = (
  sceneId: string,
) => Promise<Record<string, string | string[]> | undefined>;

type QuizAnswerLoader = (input: {
  stageId: string;
  sceneId: string;
}) => Promise<{ state?: { answers: Record<string, string | string[]> } }>;

/** Skip malformed legacy scenes before opening their RuntimeStore partition. */
export async function readSceneQuizAnswers(
  scene: { id: string; stageId?: string } | undefined,
  load: QuizAnswerLoader,
): Promise<Record<string, string | string[]> | undefined> {
  if (!scene?.stageId) return undefined;
  const { state } = await load({ stageId: scene.stageId, sceneId: scene.id });
  return state?.answers ?? {};
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
    const results = gradeChoiceQuestions(questions, answers);
    for (const r of results) {
      total += 1;
      if (r.correct === true) correct += 1;
    }
  }

  const quiz = total > 0 ? { correct, total, pct: Math.round((correct / total) * 100) } : null;

  return { countsByType, quiz };
}
