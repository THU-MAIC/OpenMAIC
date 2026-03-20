import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { buildCodeReviewPrompt } from '@/lib/quiz/prompts';
import { callQuizLLM } from '@/lib/quiz/llm';
import type { CodeReviewResult } from '@/lib/quiz/types';
import { parseFirstJsonObject } from '@/lib/server/json-parser';

function normalizeReviewResult(input: Partial<CodeReviewResult>): CodeReviewResult {
  const score = Number.isFinite(input.score) ? Math.round(Number(input.score)) : 0;
  const normalizedScore = Math.max(0, Math.min(100, score));
  const verdict =
    input.verdict === 'strong' || input.verdict === 'partial' || input.verdict === 'incorrect'
      ? input.verdict
      : normalizedScore >= 80
        ? 'strong'
        : normalizedScore >= 60
          ? 'partial'
          : 'incorrect';

  return {
    summary: input.summary || 'No review summary returned.',
    strengths: Array.isArray(input.strengths) ? input.strengths : [],
    missingPoints: Array.isArray(input.missingPoints) ? input.missingPoints : [],
    optimalApproach: input.optimalApproach || 'No optimal approach returned.',
    timeComplexity: input.timeComplexity || 'Unknown',
    spaceComplexity: input.spaceComplexity || 'Unknown',
    cleanerVersion: input.cleanerVersion,
    score: normalizedScore,
    verdict,
  };
}

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
    const parsed = parseFirstJsonObject<Partial<CodeReviewResult>>(result.text);
    return apiSuccess(normalizeReviewResult(parsed));
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to review code',
    );
  }
}
