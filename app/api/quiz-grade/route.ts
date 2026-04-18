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
import { resolveLanguageName } from '@/lib/server/resolve-language-name';
const log = createLogger('Quiz Grade');

interface GradeRequest {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
  /** BCP-47 code for the language being graded (e.g. 'lt-LT'). */
  targetLanguage?: string;
  /** BCP-47 code for the learner's base language; feedback/comments will be in this language. */
  explanationLanguage?: string;
  /** The specific target-language word/phrase being practiced (sent by client, echoed back on correct answer). */
  lexeme?: string;
}

interface GradeResponse {
  score: number;
  comment: string;
  /** Echoed from the request when score > 0; omitted otherwise. Client uses this to record learned words. */
  lexeme?: string;
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
    const { question, userAnswer, points, commentPrompt, targetLanguage, explanationLanguage, lexeme } = body;
    questionSnippet = question?.substring(0, 60);
    resolvedPoints = points;

    if (!question || !userAnswer) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'question and userAnswer are required', undefined, cors);
    }

    if (!points || !Number.isFinite(points) || points <= 0) {
      return apiError('INVALID_REQUEST', 400, 'points must be a positive number', undefined, cors);
    }

    const { model: languageModel } = await resolveModelFromHeaders(req);

    let languageLearningContext = '';
    if (targetLanguage) {
      const langName = resolveLanguageName(targetLanguage);
      languageLearningContext = `\nYou are grading a ${langName} language exercise. The student is learning ${langName}.
Accept minor spelling variations and alternative correct forms.
When the student makes an error, explain the correct ${langName} form and why.
Consider case endings, verb conjugations, and word order flexibility.`;
    }

    // Omit a feedback-language instruction when explanationLanguage is absent rather than
    // silently defaulting to English — let the LLM match the student's writing language.
    const feedbackLangInstruction = explanationLanguage
      ? `\nWrite your feedback comment in ${resolveLanguageName(explanationLanguage)}.`
      : '';

    const systemPrompt = `You are a professional educational assessor. Grade the student's answer and provide brief feedback.${languageLearningContext}${feedbackLangInstruction}
You must reply in the following JSON format only (no other content):
{"score": <integer from 0 to ${points}>, "comment": "<one or two sentences of feedback>"}`;

    const userPrompt = `Question: ${question}
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

    const text = result.text.trim();
    let gradeResult: GradeResponse;

    try {
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
        comment: 'Answer received. Please refer to the standard answer.',
      };
    }

    return apiSuccess(
      {
        ...gradeResult,
        ...(lexeme && gradeResult.score > 0 ? { lexeme } : {}),
      },
      200,
      cors,
    );
  } catch (error) {
    log.error(
      `Quiz grading failed [question="${questionSnippet ?? 'unknown'}...", points=${resolvedPoints ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, 'Failed to grade answer', undefined, cors);
  }
}
