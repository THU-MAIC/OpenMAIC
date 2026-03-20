import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { callQuizLLM } from '@/lib/quiz/llm';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { prompt: string };
    const result = await callQuizLLM(
      req,
      'You explain wrong quiz answers clearly and briefly. Return plain text only.',
      body.prompt,
      'quiz-explain',
    );
    return apiSuccess({ explanation: result.text.trim() });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : 'Failed');
  }
}
