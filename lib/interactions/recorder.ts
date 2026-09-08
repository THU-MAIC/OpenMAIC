/**
 * Client-side interaction recorder.
 *
 * Fire-and-forget bridge to `POST /api/interactions`. The server resolves the
 * identity from the SSO session cookie, so nothing here claims who the user
 * is. Events are skipped entirely when the session probe shows SSO is off or
 * nobody is logged in (e.g. an admin previewing via the access code) — that
 * keeps anonymous traffic from producing 401 noise.
 */

import type { QuizQuestion } from '@/lib/types/stage';
import type { QuestionResult } from '@/lib/quiz/grading';

export type InteractionType = 'quiz_answer' | 'chat_message' | 'view_event';

let recorderReady: boolean | null = null;

export async function ensureInteractionRecorderReady(): Promise<boolean> {
  if (recorderReady !== null) return recorderReady;
  try {
    const res = await fetch('/api/auth/session', { headers: { accept: 'application/json' } });
    const data = (await res.json()) as { ssoEnabled?: boolean; user?: unknown };
    recorderReady = Boolean(data?.ssoEnabled && data?.user);
  } catch {
    recorderReady = false;
  }
  return recorderReady;
}

async function postInteraction(
  type: InteractionType,
  stageId: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!(await ensureInteractionRecorderReady())) return;
  try {
    await fetch('/api/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, stageId, data }),
      keepalive: true,
    });
  } catch {
    // Recording must never disturb the viewing experience.
  }
}

function answerText(answer: string | string[] | undefined): string | null {
  if (answer === undefined) return null;
  if (Array.isArray(answer)) {
    const joined = answer.join(',');
    return joined === '' ? null : joined;
  }
  const trimmed = answer.trim();
  return trimmed === '' ? null : trimmed;
}

/** Record one graded quiz submission (per question, with the result). */
export async function recordQuizSubmission(
  stageId: string,
  sceneId: string,
  questions: QuizQuestion[],
  answers: Record<string, string | string[]>,
  results: QuestionResult[],
  attemptId?: string | null,
): Promise<void> {
  if (!(await ensureInteractionRecorderReady())) return;
  const resultByQuestion = new Map(results.map((result) => [result.questionId, result]));
  for (const question of questions) {
    const result = resultByQuestion.get(question.id);
    const pts = question.points ?? 1;
    await postInteraction('quiz_answer', stageId, {
      sceneId,
      questionId: question.id,
      question: question.question,
      userAnswer: answerText(answers[question.id]),
      isCorrect: result ? result.status === 'correct' : null,
      score: result ? result.earned : null,
      maxScore: pts,
      attemptId: attemptId ?? null,
    });
  }
}

export function recordChatMessage(
  stageId: string,
  data: {
    role: 'user' | 'assistant' | 'system';
    content: string;
    chatSessionId?: string;
    sceneId?: string;
  },
): void {
  void postInteraction('chat_message', stageId, data);
}

export function recordViewEvent(stageId: string, event: 'enter' | 'exit', sceneId?: string): void {
  void postInteraction('view_event', stageId, { event, sceneId: sceneId ?? null });
}
