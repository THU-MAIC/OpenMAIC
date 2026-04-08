import type { AssessmentContext, QuizAttempt } from '@/lib/types/assessment';
import { db } from '@/lib/utils/database';

export async function saveQuizAttempt(attempt: QuizAttempt): Promise<void> {
  await db.quizAttempts.put({
    attemptId: attempt.attemptId,
    stageId: attempt.stageId,
    sceneId: attempt.sceneId,
    answers: attempt.answers,
    results: attempt.results,
    totalScore: attempt.totalScore,
    maxScore: attempt.maxScore,
    assessmentContext: attempt.assessmentContext,
    submittedAt: attempt.submittedAt,
    createdAt: attempt.submittedAt,
  });
}

export async function getLatestQuizAttemptForScene(
  stageId: string,
  sceneId: string,
): Promise<QuizAttempt | null> {
  const attempts = await db.quizAttempts
    .where('[stageId+sceneId]')
    .equals([stageId, sceneId])
    .toArray();

  const latest = attempts.sort((a, b) => b.submittedAt - a.submittedAt)[0];
  if (!latest) return null;

  return {
    attemptId: latest.attemptId,
    stageId: latest.stageId,
    sceneId: latest.sceneId,
    answers: latest.answers,
    results: latest.results,
    totalScore: latest.totalScore,
    maxScore: latest.maxScore,
    questions: [],
    assessmentContext: latest.assessmentContext,
    submittedAt: latest.submittedAt,
  };
}

export async function deleteQuizAttemptsForScene(stageId: string, sceneId: string): Promise<void> {
  const attempts = await db.quizAttempts.where('[stageId+sceneId]').equals([stageId, sceneId]).toArray();
  if (attempts.length === 0) return;
  await db.quizAttempts.bulkDelete(attempts.map((attempt) => attempt.attemptId));
}

export async function getLatestAssessmentContextForStage(
  stageId: string,
): Promise<AssessmentContext | null> {
  const attempts = await db.quizAttempts.where('stageId').equals(stageId).toArray();
  if (attempts.length === 0) return null;

  const latest = attempts.sort((a, b) => b.submittedAt - a.submittedAt)[0];
  return latest?.assessmentContext || null;
}
