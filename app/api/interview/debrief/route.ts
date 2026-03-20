import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import { callLLM } from '@/lib/ai/llm';
import { buildInterviewDebriefPrompt } from '@/lib/interview/prompts';
import type { InterviewConfig } from '@/lib/interview/types';
import { parseFirstJsonObject } from '@/lib/server/json-parser';

function clampTenPointScore(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(10, Math.round(numeric)));
}

function clampHundredPointScore(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeInterviewDebriefResult(input: Record<string, unknown>) {
  const topImprovements = Array.isArray(input.topImprovements)
    ? input.topImprovements.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';

  if (!summary) {
    throw new Error('Interview debrief response did not include a summary');
  }

  return {
    overallScore: clampHundredPointScore(input.overallScore),
    communicationRating: clampTenPointScore(input.communicationRating),
    technicalAccuracyRating: clampTenPointScore(input.technicalAccuracyRating),
    topImprovements,
    summary,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      config: InterviewConfig;
      turns: Array<{ question: string; answer?: string }>;
    };
    const { model } = resolveModelFromHeaders(req);
    const result = await callLLM(
      {
        model,
        system: 'You are an interview coach. Return JSON only.',
        prompt: buildInterviewDebriefPrompt(body),
      },
      'interview-debrief',
    );
    return apiSuccess(normalizeInterviewDebriefResult(parseFirstJsonObject<Record<string, unknown>>(result.text)));
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : 'Failed');
  }
}
