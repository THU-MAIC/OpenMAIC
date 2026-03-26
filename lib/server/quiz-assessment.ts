import { callLLM } from '@/lib/ai/llm';
import { buildQuizAttempt, gradeChoiceQuestions, isShortAnswer } from '@/lib/quiz/assessment';
import type { QuizAnswerMap, QuizAttempt, QuizQuestionResult } from '@/lib/types/assessment';
import type { QuizQuestion } from '@/lib/types/stage';
import type { LanguageModel } from 'ai';

function fallbackShortAnswerResult(language: string, question: QuizQuestion): QuizQuestionResult {
  const points = question.points ?? 1;
  return {
    questionId: question.id,
    correct: null,
    status: 'incorrect',
    earned: Math.round(points * 0.5),
    aiComment:
      language === 'zh-CN'
        ? '评分服务暂时不可用，已给予基础分。'
        : 'Grading service unavailable. Base score given.',
  };
}

export async function gradeShortAnswerQuestion(params: {
  question: QuizQuestion;
  userAnswer: string;
  language: string;
  languageModel?: LanguageModel;
}): Promise<QuizQuestionResult> {
  const { question, userAnswer, language, languageModel } = params;
  const points = question.points ?? 1;
  const isZh = language === 'zh-CN';

  if (!languageModel) {
    return fallbackShortAnswerResult(language, question);
  }

  const systemPrompt = isZh
    ? `你是一位专业的教育评估专家。请根据题目和学生答案进行评分并给出简短评语。
必须以如下 JSON 格式回复（不要包含其他内容）：
{"score": <0到${points}的整数>, "comment": "<一两句评语>"}`
    : `You are a professional educational assessor. Grade the student's answer and provide brief feedback.
You must reply in the following JSON format only (no other content):
{"score": <integer from 0 to ${points}>, "comment": "<one or two sentences of feedback>"}`;

  const userPrompt = isZh
    ? `题目：${question.question}
满分：${points}分
${question.commentPrompt ? `评分要点：${question.commentPrompt}\n` : ''}学生答案：${userAnswer}`
    : `Question: ${question.question}
Full marks: ${points} points
${question.commentPrompt ? `Grading guidance: ${question.commentPrompt}\n` : ''}Student answer: ${userAnswer}`;

  try {
    const result = await callLLM(
      {
        model: languageModel,
        system: systemPrompt,
        prompt: userPrompt,
      },
      'quiz-grade',
    );

    const text = result.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const parsed = JSON.parse(jsonMatch[0]) as { score?: number; comment?: string };
    const earned = Math.max(0, Math.min(points, Math.round(Number(parsed.score))));

    return {
      questionId: question.id,
      correct: earned >= points * 0.8,
      status: earned >= points * 0.8 ? 'correct' : 'incorrect',
      earned,
      aiComment: String(parsed.comment || ''),
    };
  } catch {
    return fallbackShortAnswerResult(language, question);
  }
}

export async function buildQuizAttemptFromSubmission(params: {
  attemptId: string;
  stageId: string;
  sceneId: string;
  questions: QuizQuestion[];
  answers: QuizAnswerMap;
  language: string;
  languageModel?: LanguageModel;
  submittedAt: number;
}): Promise<QuizAttempt> {
  const { attemptId, stageId, sceneId, questions, answers, language, languageModel, submittedAt } =
    params;

  const choiceResults = gradeChoiceQuestions(questions, answers);
  const shortAnswerQuestions = questions.filter(isShortAnswer);
  const shortAnswerResults = await Promise.all(
    shortAnswerQuestions.map((question) =>
      gradeShortAnswerQuestion({
        question,
        userAnswer: String(answers[question.id] || ''),
        language,
        languageModel,
      }),
    ),
  );

  const resultsById = new Map<string, QuizQuestionResult>();
  for (const result of [...choiceResults, ...shortAnswerResults]) {
    resultsById.set(result.questionId, result);
  }

  const orderedResults = questions
    .map((question) => resultsById.get(question.id))
    .filter((result): result is QuizQuestionResult => result != null);

  return buildQuizAttempt({
    attemptId,
    stageId,
    sceneId,
    questions,
    answers,
    results: orderedResults,
    submittedAt,
  });
}
