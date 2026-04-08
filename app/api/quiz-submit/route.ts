import { nanoid } from 'nanoid';
import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { buildQuizAttemptFromSubmission } from '@/lib/server/quiz-assessment';
import { isShortAnswer } from '@/lib/quiz/assessment';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import type { QuizAnswerMap } from '@/lib/types/assessment';
import type { QuizQuestion } from '@/lib/types/stage';

interface QuizSubmitRequest {
  stageId: string;
  sceneId: string;
  questions: QuizQuestion[];
  answers: QuizAnswerMap;
  language?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as QuizSubmitRequest;
    const { stageId, sceneId, questions, answers, language } = body;

    if (!stageId || !sceneId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId and sceneId are required');
    }
    if (!questions || questions.length === 0) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'questions are required');
    }
    if (!answers || Object.keys(answers).length === 0) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'answers are required');
    }

    const requiresShortAnswerModel = questions.some(isShortAnswer);
    let languageModel: ReturnType<typeof resolveModelFromHeaders>['model'] | undefined;
    if (requiresShortAnswerModel) {
      try {
        languageModel = resolveModelFromHeaders(req).model;
      } catch {
        languageModel = undefined;
      }
    }
    const submittedAt = Date.now();
    const attempt = await buildQuizAttemptFromSubmission({
      attemptId: nanoid(),
      stageId,
      sceneId,
      questions,
      answers,
      language: language || 'en-US',
      languageModel,
      submittedAt,
    });

    return apiSuccess({
      attempt,
      assessmentContext: attempt.assessmentContext,
    });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to submit quiz',
    );
  }
}
