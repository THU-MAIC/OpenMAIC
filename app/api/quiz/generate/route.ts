import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { buildCodingQuizPrompt, buildPlacementQuizPrompt } from '@/lib/quiz/prompts';
import { parseQuizSession } from '@/lib/quiz/question-parser';
import { callQuizLLM } from '@/lib/quiz/llm';
import type { QuizSession } from '@/lib/quiz/types';

function validateQuizSession(session: QuizSession) {
  if (session.track === 'placement-aptitude') {
    if (!Array.isArray(session.questions) || session.questions.length === 0) {
      throw new Error('Quiz generation returned no placement questions');
    }
    return session;
  }

  if (!Array.isArray(session.problems) || session.problems.length === 0) {
    throw new Error('Quiz generation returned no coding problems');
  }
  return session;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, string>;
    const track = body.track;

    const prompt =
      track === 'coding-examination'
        ? buildCodingQuizPrompt({
            language: (body.language as 'python' | 'java' | 'cpp' | 'javascript') || 'python',
            difficulty: (body.difficulty as 'easy' | 'medium' | 'hard') || 'medium',
          })
        : buildPlacementQuizPrompt({
            company: body.company || 'General',
            difficulty: (body.difficulty as 'easy' | 'medium' | 'hard') || 'medium',
            language: body.locale || 'English',
          });

    const result = await callQuizLLM(
      req,
      'You generate interview-style quizzes in strict JSON. No markdown.',
      prompt,
      'quiz-generate',
    );

    const session = validateQuizSession(parseQuizSession(result.text.trim()));
    return apiSuccess({ ...session });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to generate quiz',
    );
  }
}
