import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import { callLLM } from '@/lib/ai/llm';
import { buildInterviewSessionPrompt } from '@/lib/interview/prompts';
import type { InterviewConfig } from '@/lib/interview/types';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as InterviewConfig;
    const { model } = resolveModelFromHeaders(req);
    const result = await callLLM(
      {
        model,
        system: 'You are a realistic interviewer. Return JSON only.',
        prompt: buildInterviewSessionPrompt(body),
      },
      'interview-session',
    );
    return apiSuccess(JSON.parse(result.text.trim().match(/\{[\s\S]*\}/)?.[0] || '{}'));
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : 'Failed');
  }
}
