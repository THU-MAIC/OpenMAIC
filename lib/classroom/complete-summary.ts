import type { Scene, SceneType, QuizContent } from '@/lib/types/stage';
import { gradeChoiceQuestions } from '@/lib/quiz/grading';

export interface CompleteSummary {
  countsByType: Partial<Record<SceneType, number>>;
  quiz: { correct: number; total: number; pct: number } | null;
}

export type AnswerReader = (sceneId: string) => Record<string, string | string[]>;

export function summarizeScenes(scenes: Scene[], readAnswers: AnswerReader): CompleteSummary {
  const countsByType: Partial<Record<SceneType, number>> = {};
  for (const scene of scenes) {
    countsByType[scene.type] = (countsByType[scene.type] ?? 0) + 1;
  }

  let correct = 0;
  let total = 0;
  for (const scene of scenes) {
    if (scene.type !== 'quiz') continue;
    const questions = (scene.content as QuizContent).questions ?? [];
    const answers = readAnswers(scene.id);
    const results = gradeChoiceQuestions(questions, answers);
    for (const r of results) {
      total += 1;
      if (r.correct === true) correct += 1;
    }
  }

  const quiz = total > 0 ? { correct, total, pct: Math.round((correct / total) * 100) } : null;

  return { countsByType, quiz };
}
