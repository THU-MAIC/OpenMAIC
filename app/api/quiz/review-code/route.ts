import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { buildCodeReviewPrompt } from '@/lib/quiz/prompts';
import { callQuizLLM } from '@/lib/quiz/llm';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      title: string;
      prompt: string;
      code: string;
      language: 'python' | 'java' | 'cpp' | 'javascript';
    };
    const result = await callQuizLLM(
      req,
      'You are a senior interviewer reviewing coding solutions. Return strict JSON only.',
      buildCodeReviewPrompt(body),
      'quiz-review-code',
    );
    return apiSuccess(JSON.parse(result.text.trim().match(/\{[\s\S]*\}/)?.[0] || '{}'));
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to review code',
    );
  }
}
