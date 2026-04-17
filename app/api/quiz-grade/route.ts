/**
 * Quiz Grading API
 *
 * POST: Receives a text question + user answer, calls LLM for scoring and feedback.
 * Used for short-answer (text) questions that cannot be graded locally.
 * 
 * Phase 3: Now uses dynamic prompts from Prompt Studio
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import { renderPrompt } from '@/lib/admin/prompt-renderer';
import { buildPromptContext } from '@/lib/admin/prompt-context';
import { PROMPT_KEYS } from '@/lib/admin/prompt-keys';
import { prisma } from '@/lib/auth/prisma';

const log = createLogger('Quiz Grade');

interface GradeRequest {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
  language?: string;
  studentId?: string;
  studentName?: string;
  classroomId?: string;
  sceneId?: string;
  sceneTitle?: string;
}

interface GradeResponse {
  score: number;
  comment: string;
}

export async function POST(req: NextRequest) {
  let questionSnippet: string | undefined;
  let resolvedPoints: number | undefined;
  let resolvedStudentId: string | undefined;
  try {
    const body = (await req.json()) as GradeRequest;
    const {
      question,
      userAnswer,
      points,
      commentPrompt,
      language,
      studentId,
      studentName,
      classroomId,
      sceneId,
      sceneTitle,
    } = body;
    questionSnippet = question?.substring(0, 60);
    resolvedPoints = points;
    resolvedStudentId = studentId;

    if (!question || !userAnswer) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'question and userAnswer are required');
    }

    // Validate points is a positive finite number
    if (!points || !Number.isFinite(points) || points <= 0) {
      return apiError('INVALID_REQUEST', 400, 'points must be a positive number');
    }

    // Resolve model from request headers
    const { model: languageModel } = resolveModelFromHeaders(req);

    const isZh = language === 'zh-CN';
    const lang = isZh ? 'zh' : 'en';

    // Build context for prompt injection (Phase 3)
    const context = await buildPromptContext(classroomId, lang, undefined, {
      question,
      student_answer: userAnswer,
      student_name: studentName || 'Student',
      grading_rubric: commentPrompt || '',
      correct_answer: '',
    });

    // Get the grading prompt from Prompt Studio or fallback
    let systemPrompt = '';
    let userPrompt = '';

    if (context) {
      try {
        // Try to fetch the dynamic prompt from Prompt Studio
        const dynamicPrompt = await renderPrompt(PROMPT_KEYS.GRADING.QUIZ_EVALUATION, context);
        if (dynamicPrompt) {
          systemPrompt = dynamicPrompt;
          userPrompt = `Question: ${question}\nStudent Answer: ${userAnswer}`;
        }
      } catch (err) {
        console.error('[quiz-grade] Error fetching dynamic prompt:', err);
      }
    }

    // Fallback to hardcoded default if dynamic prompt failed
    if (!systemPrompt) {
      systemPrompt = isZh
        ? `你是一位专业的教育评估专家。请根据题目和学生答案进行评分并给出简短评语。
必须以如下 JSON 格式回复（不要包含其他内容）：
{"score": <0到${points}的整数>, "comment": "<一两句评语>"}`
        : `You are a professional educational assessor. Grade the student's answer and provide brief feedback.
You must reply in the following JSON format only (no other content):
{"score": <integer from 0 to ${points}>, "comment": "<one or two sentences of feedback>"}`;

      userPrompt = isZh
        ? `题目：${question}
满分：${points}分
    ${studentName ? `学生：${studentName}\n` : ''}
${commentPrompt ? `评分要点：${commentPrompt}\n` : ''}学生答案：${userAnswer}`
        : `Question: ${question}
Full marks: ${points} points
    ${studentName ? `Student: ${studentName}\n` : ''}
${commentPrompt ? `Grading guidance: ${commentPrompt}\n` : ''}Student answer: ${userAnswer}`;
    }

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

    // Persist grading result when classroom + scene context is provided.
    // Never fail the grading response if persistence fails.
    if (classroomId && sceneId) {
      try {
        await prisma.quizResult.create({
          data: {
            classroomId,
            studentDbUserId: studentId ?? null,
            studentLabel: studentName || studentId || 'Unknown Student',
            sceneId,
            sceneTitle: sceneTitle || question.substring(0, 120),
            score: gradeResult.score,
            maxScore: points,
            answers: [
              {
                questionId: sceneId,
                answer: userAnswer,
                score: gradeResult.score,
                comment: gradeResult.comment,
              },
            ],
            gradedBy: 'ai',
          },
        });
      } catch (persistError) {
        log.warn('Failed to persist quiz result:', persistError);
      }
    }

    return apiSuccess({ ...gradeResult });
  } catch (error) {
    log.error(
      `Quiz grading failed [question="${questionSnippet ?? 'unknown'}...", points=${resolvedPoints ?? 'unknown'}, studentId=${resolvedStudentId ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, 'Failed to grade answer');
  }
}
