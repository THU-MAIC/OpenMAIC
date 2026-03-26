import type { AssessmentContext, QuizAnswerMap, QuizAttempt, QuizQuestionResult } from '@/lib/types/assessment';
import type { QuizQuestion } from '@/lib/types/stage';

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

export function isShortAnswer(question: QuizQuestion): boolean {
  return (
    question.type === 'short_answer' ||
    (!question.hasAnswer && (!question.answer || question.answer.length === 0))
  );
}

export function gradeChoiceQuestions(
  questions: QuizQuestion[],
  answers: QuizAnswerMap,
): QuizQuestionResult[] {
  return questions
    .filter((q) => !isShortAnswer(q))
    .map((q) => {
      const pts = q.points ?? 1;
      const userAnswer = toArray(answers[q.id]);
      const correctAnswer = toArray(q.answer);
      const correct = arraysEqual(userAnswer, correctAnswer);
      return {
        questionId: q.id,
        correct,
        status: correct ? 'correct' : 'incorrect',
        earned: correct ? pts : 0,
      };
    });
}

function deriveWeakConcepts(questions: QuizQuestion[], results: QuizQuestionResult[]): string[] {
  const incorrectIds = new Set(
    results.filter((result) => result.status === 'incorrect').map((result) => result.questionId),
  );
  return questions
    .filter((question) => incorrectIds.has(question.id))
    .map((question) => question.analysis?.trim() || question.question.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function deriveMasteryLevel(scoreRatio: number): AssessmentContext['masteryLevel'] {
  if (scoreRatio >= 0.85) return 'high';
  if (scoreRatio >= 0.6) return 'medium';
  return 'low';
}

function deriveRecommendedNextStep(
  masteryLevel: AssessmentContext['masteryLevel'],
): AssessmentContext['recommendedNextStep'] {
  if (masteryLevel === 'high') return 'advance';
  if (masteryLevel === 'medium') return 'review';
  return 'remediate';
}

export function buildAssessmentContext(params: {
  attemptId: string;
  stageId: string;
  sceneId: string;
  questions: QuizQuestion[];
  results: QuizQuestionResult[];
  submittedAt: number;
}): AssessmentContext {
  const { attemptId, stageId, sceneId, questions, results, submittedAt } = params;
  const maxScore = questions.reduce((sum, question) => sum + (question.points ?? 1), 0);
  const latestQuizScore = results.reduce((sum, result) => sum + result.earned, 0);
  const scoreRatio = maxScore > 0 ? latestQuizScore / maxScore : 0;
  const masteryLevel = deriveMasteryLevel(scoreRatio);
  const incorrectQuestions = questions
    .filter((question) => results.some((result) => result.questionId === question.id && result.status === 'incorrect'))
    .map((question) => question.question)
    .slice(0, 5);

  return {
    attemptId,
    stageId,
    sceneId,
    latestQuizScore,
    maxScore,
    incorrectQuestions,
    weakConcepts: deriveWeakConcepts(questions, results),
    masteryLevel,
    recommendedNextStep: deriveRecommendedNextStep(masteryLevel),
    submittedAt,
  };
}

export function buildQuizAttempt(params: {
  attemptId: string;
  stageId: string;
  sceneId: string;
  questions: QuizQuestion[];
  answers: QuizAnswerMap;
  results: QuizQuestionResult[];
  submittedAt: number;
}): QuizAttempt {
  const { attemptId, stageId, sceneId, questions, answers, results, submittedAt } = params;
  const assessmentContext = buildAssessmentContext({
    attemptId,
    stageId,
    sceneId,
    questions,
    results,
    submittedAt,
  });

  return {
    attemptId,
    stageId,
    sceneId,
    answers,
    results,
    totalScore: assessmentContext.latestQuizScore,
    maxScore: assessmentContext.maxScore,
    questions,
    assessmentContext,
    submittedAt,
  };
}
