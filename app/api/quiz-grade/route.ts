/**
 * Quiz Grading API
 *
 * POST: Receives a text question + user answer, calls LLM for scoring and feedback.
 * Used for short-answer (text) questions that cannot be graded locally.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
const log = createLogger('Quiz Grade');

interface GradeRequest {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
  language?: string;
}

interface GradeResponse {
  score: number | null;
  comment: string;
}

export async function POST(req: NextRequest) {
  let questionSnippet: string | undefined;
  let resolvedPoints: number | undefined;
  try {
    const body = (await req.json()) as GradeRequest;
    const { question, userAnswer, points, commentPrompt, language } = body;
    questionSnippet = question?.substring(0, 60);
    resolvedPoints = points;

    if (!question || !userAnswer) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'question and userAnswer are required');
    }

    // Validate points is a positive finite number
    if (!points || !Number.isFinite(points) || points <= 0) {
      return apiError('INVALID_REQUEST', 400, 'points must be a positive number');
    }

    // Resolve model from request headers/body
    const { model: languageModel, thinkingConfig } = await resolveModelFromRequest(
      req,
      body,
      'quiz-grade',
    );

    const isZh = language === 'zh-CN';

    const systemPrompt = isZh
      ? `你是一位专业的教育评估专家。请只根据题目、评分要点和学生原答进行评估。
评语必须指出原答中的一个具体证据（可短引原词，也可明确指出缺少哪一处），并给出一个下一步可执行建议；不要给学生贴能力、性格或心理标签。
必须以如下 JSON 格式回复（不要包含其他内容）：
{"score": <0到${points}的整数>, "comment": "<一两句评语>"}`
      : `You are a professional educational assessor. Use only the question, grading guidance, and the student's original answer.
The comment must point to one concrete piece of evidence in the answer (or identify what is missing) and give one actionable next step; do not assign ability, personality, or psychological labels.
You must reply in the following JSON format only (no other content):
{"score": <integer from 0 to ${points}>, "comment": "<one or two sentences of feedback>"}`;

    const userPrompt = isZh
      ? `题目：${question}
满分：${points}分
${commentPrompt ? `评分要点：${commentPrompt}\n` : ''}学生答案：${userAnswer}`
      : `Question: ${question}
Full marks: ${points} points
${commentPrompt ? `Grading guidance: ${commentPrompt}\n` : ''}Student answer: ${userAnswer}`;

    const result = await callLLM(
      {
        model: languageModel,
        system: systemPrompt,
        prompt: userPrompt,
      },
      'quiz-grade',
      undefined,
      thinkingConfig,
    );

    // Parse the LLM response as JSON
    const text = result.text.trim();
    let gradeResult: GradeResponse;

    try {
      // Try to extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      const parsed = JSON.parse(jsonMatch[0]);
      const rawScore = parsed?.score;
      // Accept a numeric string for compatibility with older model prompts,
      // but reject empty strings, booleans, fractions, and out-of-range values.
      const parsedScore =
        typeof rawScore === 'number'
          ? rawScore
          : typeof rawScore === 'string' && rawScore.trim().length > 0
            ? Number(rawScore)
            : Number.NaN;
      if (
        !Number.isFinite(parsedScore) ||
        !Number.isInteger(parsedScore) ||
        parsedScore < 0 ||
        parsedScore > points ||
        typeof parsed?.comment !== 'string' ||
        parsed.comment.trim().length === 0
      ) {
        throw new Error('Invalid grade payload');
      }
      gradeResult = {
        score: parsedScore,
        comment: parsed.comment,
      };
    } catch {
      // Never invent a score when the assessor did not return valid JSON.
      gradeResult = {
        score: null,
        comment: isZh
          ? '自动评分未返回可验证结果，请由家长或老师复核。'
          : 'No verifiable automatic score was returned. Please review manually.',
      };
    }

    return apiSuccess({ ...gradeResult });
  } catch (error) {
    log.error(
      `Quiz grading failed [question="${questionSnippet ?? 'unknown'}...", points=${resolvedPoints ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, 'Failed to grade answer');
  }
}
