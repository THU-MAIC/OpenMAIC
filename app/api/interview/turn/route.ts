/**
 * Interview Turn API Endpoint
 *
 * POST /api/interview/turn
 *
 * Replaces the direct callLLM() path with two statelessGenerate() calls,
 * using the same orchestration entrypoint as /api/chat.
 *
 * Turn sequence per submission:
 *   1. Coach agent  → feedback  { good, missing, strongAnswer }
 *   2. Interviewer agent → nextQuestion string
 *
 * Request shape (unchanged from previous callLLM version):
 *   { config: InterviewConfig, history: [...], answer: string }
 *   Model credentials supplied via x-model / x-api-key / x-base-url headers.
 *
 * Response shape (unchanged — frontend reads payload.feedback + payload.nextQuestion):
 *   { feedback: { good, missing, strongAnswer }, nextQuestion }
 */

import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import { statelessGenerate } from '@/lib/orchestration/stateless-generate';
import { buildInterviewTurnPrompt } from '@/lib/interview/prompts';
import type { InterviewConfig } from '@/lib/interview/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { ThinkingConfig } from '@/lib/types/provider';
import { createLogger } from '@/lib/logger';

const log = createLogger('Interview Turn API');

export const maxDuration = 60;

// ── Agent IDs ─────────────────────────────────────────────────────────────────

const COACH_ID = 'interview-coach';
const INTERVIEWER_ID = 'interview-interviewer';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Drain a statelessGenerate() generator and return accumulated text deltas. */
async function collectText(gen: AsyncGenerator<StatelessEvent>): Promise<string> {
  let text = '';
  for await (const event of gen) {
    if (event.type === 'text_delta') {
      text += event.data.content;
    }
  }
  return text.trim();
}

/**
 * Try to parse the first JSON object found in a string.
 * Falls back to an empty object so the caller never throws.
 */
function extractJson(raw: string): Record<string, unknown> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      config: InterviewConfig;
      history: Array<{ question: string; answer?: string }>;
      answer: string;
    };

    const { config, history, answer } = body;

    if (!answer || !config) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'answer and config are required');
    }

    const { model: languageModel, modelString } = resolveModelFromHeaders(req);

    const signal = req.signal;
    const thinking: ThinkingConfig = { enabled: false };

    // Build the full interview context as the user message — same text that
    // callLLM() used as its `prompt`, so context quality is unchanged.
    const contextPrompt = buildInterviewTurnPrompt({ config, history, answer });

    const storeState: StatelessChatRequest['storeState'] = {
      stage: null,
      scenes: [],
      currentSceneId: null,
      mode: 'autonomous',
      whiteboardOpen: false,
    };

    // ── Coach turn ────────────────────────────────────────────────────────────
    // The coach persona tells the LLM to embed JSON in the text content so we
    // can extract { good, missing, strongAnswer } from the text_delta stream.

    const coachPersona = [
      `You are a professional interview coach reviewing a ${config.role} interview answer.`,
      `Difficulty: ${config.difficulty}. Interview type: ${config.interviewType}.`,
      'Analyse the candidate\'s answer and output ONLY a JSON object (no markdown, no prose):',
      '{"good":["..."],"missing":["..."],"strongAnswer":"..."}',
      'Each array should contain 1-3 concise bullet points. strongAnswer is one sentence.',
    ].join(' ');

    const coachRequest: StatelessChatRequest = {
      messages: [{ id: 'ctx-1', role: 'user', content: contextPrompt, createdAt: new Date() }],
      storeState,
      config: {
        agentIds: [COACH_ID],
        agentConfigs: [
          {
            id: COACH_ID,
            name: 'Interview Coach',
            role: 'coach',
            persona: coachPersona,
            avatar: '🎓',
            color: '#4CAF50',
            allowedActions: [],
            priority: 1,
            isGenerated: true,
          },
        ],
      },
      apiKey: req.headers.get('x-api-key') || '',
      baseUrl: req.headers.get('x-base-url') || undefined,
      model: modelString,
    };

    log.info(`Coach turn — role: ${config.role}, difficulty: ${config.difficulty}`);
    const coachText = await collectText(statelessGenerate(coachRequest, signal, languageModel, thinking));
    const feedback = extractJson(coachText);

    // ── Interviewer turn ──────────────────────────────────────────────────────
    const interviewerPersona = [
      `You are an experienced ${config.role} interviewer conducting a ${config.difficulty} ${config.interviewType} interview.`,
      'Based on the conversation so far, ask exactly one natural follow-up question.',
      'Do NOT repeat a question already asked. Output the question only — no preamble, no JSON.',
    ].join(' ');

    const interviewerRequest: StatelessChatRequest = {
      messages: [{ id: 'ctx-1', role: 'user', content: contextPrompt, createdAt: new Date() }],
      storeState,
      config: {
        agentIds: [INTERVIEWER_ID],
        agentConfigs: [
          {
            id: INTERVIEWER_ID,
            name: 'Interviewer',
            role: 'interviewer',
            persona: interviewerPersona,
            avatar: '👔',
            color: '#2196F3',
            allowedActions: [],
            priority: 1,
            isGenerated: true,
          },
        ],
      },
      apiKey: req.headers.get('x-api-key') || '',
      baseUrl: req.headers.get('x-base-url') || undefined,
      model: modelString,
    };

    log.info(`Interviewer turn — role: ${config.role}`);
    const nextQuestion = await collectText(
      statelessGenerate(interviewerRequest, signal, languageModel, thinking),
    );

    log.info(
      `Interview turn complete — feedback keys: ${Object.keys(feedback).join(',')}, question length: ${nextQuestion.length}`,
    );

    return apiSuccess({ feedback, nextQuestion });
  } catch (error) {
    log.error('Error:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
