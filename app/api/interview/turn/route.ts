import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import { callLLM } from '@/lib/ai/llm';
import { buildInterviewTurnPrompt } from '@/lib/interview/prompts';
import type { InterviewConfig } from '@/lib/interview/types';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      config: InterviewConfig;
      history: Array<{ question: string; answer?: string }>;
      answer: string;
    };
    const { model } = resolveModelFromHeaders(req);
    const result = await callLLM(
      {
        model,
        system: 'You are a natural interviewer and coach. Return JSON only.',
        prompt: buildInterviewTurnPrompt(body),
      },
      'interview-turn',
    );
    return apiSuccess(JSON.parse(result.text.trim().match(/\{[\s\S]*\}/)?.[0] || '{}'));
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : 'Failed');
  }
}
