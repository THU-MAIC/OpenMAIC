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
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import { corsHeaders, getOrigin, corsOptionsHandler } from '@/lib/server/cors';
import { validateApiKey } from '@/lib/server/api-auth';
const log = createLogger('Quiz Grade');

interface GradeRequest {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
  language?: string;
  targetLanguage?: string;
}

interface GradeResponse {
  score: number;
  comment: string;
}

export { corsOptionsHandler as OPTIONS };

export async function POST(req: NextRequest) {
  const cors = corsHeaders(getOrigin(req));

  if (!validateApiKey(req)) {
    return apiError('MISSING_API_KEY', 401, 'Invalid or missing API key', undefined, cors);
  }

  let questionSnippet: string | undefined;
  let resolvedPoints: number | undefined;
  try {
    const body = (await req.json()) as GradeRequest;
    const { question, userAnswer, points, commentPrompt, language, targetLanguage } = body;
    questionSnippet = question?.substring(0, 60);
    resolvedPoints = points;

    if (!question || !userAnswer) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'question and userAnswer are required', undefined, cors);
    }

    // Validate points is a positive finite number
    if (!points || !Number.isFinite(points) || points <= 0) {
      return apiError('INVALID_REQUEST', 400, 'points must be a positive number', undefined, cors);
    }

    // Resolve model from request headers
    const { model: languageModel } = await resolveModelFromHeaders(req);

    const isZh = language === 'zh-CN';

    // Build language-learning-specific grading guidance when targetLanguage is set
    let languageLearningContext = '';
    if (targetLanguage) {
      const langNames: Record<string, string> = { 'lt-LT': 'Lithuanian', 'lt': 'Lithuanian' };
      const langName = langNames[targetLanguage] || targetLanguage;
      languageLearningContext = `\nYou are grading a ${langName} language exercise. The student is learning ${langName}.
Accept minor spelling variations and alternative correct forms.
When the student makes an error, explain the correct ${langName} form and why.
Consider case endings, verb conjugations, and word order flexibility.`;
    }

    const systemPrompt = isZh
      ? `你是一位专业的教育评估专家。请根据题目和学生答案进行评分并给出简短评语。
必须以如下 JSON 格式回复（不要包含其他内容）：
{"score": <0到${points}的整数>, "comment": "<一两句评语>"}`
      : `You are a professional educational assessor. Grade the student's answer and provide brief feedback.${languageLearningContext}
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
    );

    // Parse the LLM response as JSON
    const text = result.text.trim();
    let gradeResult: GradeResponse;

    try {
      // Try to extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      const parsed = JSON.parse(jsonMatch[0]);
      gradeResult = {
        score: Math.max(0, Math.min(points, Math.round(Number(parsed.score)))),
        comment: String(parsed.comment || ''),
      };
    } catch {
      // Fallback: give partial credit with a generic comment
      gradeResult = {
        score: Math.round(points * 0.5),
        comment: isZh
          ? '已作答，请参考标准答案。'
          : 'Answer received. Please refer to the standard answer.',
      };
    }

    return apiSuccess({ ...gradeResult }, 200, cors);
  } catch (error) {
    log.error(
      `Quiz grading failed [question="${questionSnippet ?? 'unknown'}...", points=${resolvedPoints ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, 'Failed to grade answer', undefined, cors);
  }
}
