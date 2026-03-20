import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { buildCodingQuizPrompt, buildPlacementQuizPrompt } from '@/lib/quiz/prompts';
import { parseQuizSession } from '@/lib/quiz/question-parser';
import { callQuizLLM } from '@/lib/quiz/llm';

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

    const session = parseQuizSession(result.text.trim());
    return apiSuccess({ ...session });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to generate quiz',
    );
  }
}
