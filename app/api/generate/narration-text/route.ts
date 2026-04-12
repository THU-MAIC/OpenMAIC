/**
 * Generates narration text for a slide from its indication (description + key points).
 * Used by the "Regenerate narration" AI button in the slide regeneration dialog.
 */
import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess, requireAuth } from '@/lib/server/api-response';
import { callLLM } from '@/lib/ai/llm';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';

const log = createLogger('NarrationText API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const user = await requireAuth(req);
  if ('status' in user && user instanceof Response) return user;

  try {
    const body = await req.json();
    const { indicationText, language } = body as {
      indicationText: string;
      language?: string;
    };

    if (!indicationText || !indicationText.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'indicationText is required');
    }

    const { model: languageModel } = await resolveModelFromHeaders(req);

    const langHint = language
      ? ` The narration MUST be written in ${language} (match the language of the key points).`
      : '';

    const result = await callLLM(
      {
        model: languageModel,
        system: `You are an expert educational narrator. Given a slide's description and key points, write a natural spoken narration for a teacher to deliver while presenting the slide. The narration should:\n- Be conversational and engaging, as if speaking directly to students\n- Cover the key points clearly without reading them verbatim\n- Be 2-4 sentences long (suitable for a 15-30 second voiceover)\n- NOT include stage directions, quotes, or explanations — only the spoken text itself${langHint}`,
        prompt: indicationText,
        maxOutputTokens: 300,
      },
      'narration-text',
    );

    const text = result.text.trim();
    log.info(`Generated narration text (${text.length} chars)`);

    return apiSuccess({ data: { text } });
  } catch (error) {
    log.error('narration-text generation failed:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
