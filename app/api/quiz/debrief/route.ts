import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { buildPlacementDebriefPrompt } from '@/lib/quiz/prompts';
import { callQuizLLM } from '@/lib/quiz/llm';
import { parseFirstJsonObject } from '@/lib/server/json-parser';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { summary: string };
    const result = await callQuizLLM(
      req,
      'You are a supportive coach. Return strict JSON only.',
      buildPlacementDebriefPrompt(body.summary),
      'quiz-debrief',
    );
    return apiSuccess(parseFirstJsonObject<Record<string, unknown>>(result.text));
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to generate debrief',
    );
  }
}
