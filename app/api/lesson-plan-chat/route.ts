import { NextRequest } from 'next/server';
import { resolveModel } from '@/lib/server/resolve-model';
import { streamLLM } from '@/lib/ai/llm';
import { apiError } from '@/lib/server/api-response';
import { corsHeaders, getOrigin, corsOptionsHandler } from '@/lib/server/cors';
import { createLogger } from '@/lib/logger';
import type { CEFRLevel } from '@/lib/types/stage';

const log = createLogger('LessonPlanChat');

export const maxDuration = 60;
export { corsOptionsHandler as OPTIONS };

export interface CardContext {
  kind: string;
  cefrLevel: CEFRLevel;
  phrase?: string;
  answer?: string;
  grammarPoint: string;
  topic: string;
}

function buildSystemPrompt(ctx: CardContext): string {
  const level = ctx.cefrLevel;
  const isEarly = level === 'A1' || level === 'A2';
  const isMid = level === 'B1' || level === 'B2';

  let persona: string;
  if (isEarly) {
    persona = `You are a warm, encouraging Lithuanian language teacher. The student is a complete beginner (${level}).
- Explain everything in English. Use Lithuanian ONLY to say the target phrase, never for explanation.
- Keep sentences very short and simple.
- Praise every attempt enthusiastically.
- If the student makes a mistake, gently correct once and move on.`;
  } else if (isMid) {
    persona = `You are a friendly Lithuanian language teacher. The student is at ${level} level.
- Mix English and Lithuanian. Explain grammar rules in English; demonstrate and practice in Lithuanian.
- When you use a new Lithuanian word in your response, add the English meaning in parentheses.
- Encourage the student to try answering in Lithuanian.`;
  } else {
    persona = `You are a Lithuanian language teacher. The student is at ${level} level — near fluent.
- Speak Lithuanian by default. Only switch to English if the student is clearly stuck after two attempts.
- Correct errors naturally within your response, don't lecture about them.
- Push the student to express themselves more precisely in Lithuanian.`;
  }

  const cardInfo = [
    `Current exercise type: ${ctx.kind.replace(/_/g, ' ')}`,
    `Grammar focus: ${ctx.grammarPoint}`,
    `Topic: ${ctx.topic}`,
    ctx.phrase ? `Target phrase: "${ctx.phrase}"` : '',
    ctx.answer ? `Expected answer: "${ctx.answer}"` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return `${persona}

LESSON CONTEXT:
${cardInfo}

Help the student work through this exercise. React to their answers, provide corrections, and keep them engaged.`;
}

export async function POST(req: NextRequest) {
  const cors = corsHeaders(getOrigin(req));

  try {
    const body = await req.json() as {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      cardContext: CardContext;
    };

    if (!body.messages || !Array.isArray(body.messages)) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing messages', undefined, cors);
    }
    if (!body.cardContext) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing cardContext', undefined, cors);
    }

    const { model: languageModel } = await resolveModel({});
    const systemPrompt = buildSystemPrompt(body.cardContext);

    log.info(`Lesson chat: ${body.cardContext.cefrLevel} ${body.cardContext.kind}, ${body.messages.length} messages`);

    const result = streamLLM(
      {
        model: languageModel,
        system: systemPrompt,
        messages: body.messages,
        maxTokens: 400,
      },
      'lesson-plan-chat',
    );

    return result.toTextStreamResponse({
      headers: cors,
    });
  } catch (err) {
    log.error('Lesson chat error:', err);
    return apiError('INTERNAL_ERROR', 500, 'Chat failed', undefined, cors);
  }
}
