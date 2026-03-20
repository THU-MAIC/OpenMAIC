import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import { callLLM } from '@/lib/ai/llm';
import { buildInterviewTurnPrompt } from '@/lib/interview/prompts';
import type { InterviewConfig } from '@/lib/interview/types';
import { parseFirstJsonObject } from '@/lib/server/json-parser';

function normalizeInterviewTurnResult(input: Record<string, unknown>) {
  const feedbackInput =
    input.feedback && typeof input.feedback === 'object'
      ? (input.feedback as Record<string, unknown>)
      : {};

  const feedback = {
    good: Array.isArray(feedbackInput.good)
      ? feedbackInput.good.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [],
    missing: Array.isArray(feedbackInput.missing)
      ? feedbackInput.missing.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [],
    strongAnswer: typeof feedbackInput.strongAnswer === 'string' ? feedbackInput.strongAnswer.trim() : '',
  };

  const nextQuestion = typeof input.nextQuestion === 'string' ? input.nextQuestion.trim() : '';

  if (!feedback.strongAnswer && feedback.good.length === 0 && feedback.missing.length === 0) {
    throw new Error('Interview turn response did not include valid feedback');
  }

  if (!nextQuestion) {
    throw new Error('Interview turn response did not include a next question');
  }

  return { feedback, nextQuestion };
}

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
    return apiSuccess(normalizeInterviewTurnResult(parseFirstJsonObject<Record<string, unknown>>(result.text)));
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : 'Failed');
  }
}
