/**
 * Auto-generates a media generation prompt from a slide indication text.
 * Used when the user picks a media type not present in the original slide.
 */
import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { callLLM } from '@/lib/ai/llm';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';

const log = createLogger('MediaPrompt API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { indicationText, mediaType, language } = body as {
      indicationText: string;
      mediaType: 'image' | 'video';
      language?: string;
    };

    if (!indicationText || !indicationText.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'indicationText is required');
    }
    if (!mediaType) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'mediaType is required');
    }
    if (mediaType !== 'image' && mediaType !== 'video') {
      return apiError('INVALID_REQUEST', 400, 'mediaType must be "image" or "video"');
    }

    const { model: languageModel } = await resolveModelFromHeaders(req);

    const mediaLabel = mediaType === 'image' ? 'image' : 'short video loop';
    const langHint = language ? ` The course language is ${language}.` : '';

    const result = await callLLM(
      {
        model: languageModel,
        system: `You are a visual media prompt writer. Given a slide description, write a concise prompt (1–2 sentences, max 30 words) for generating a ${mediaLabel} that visually represents the slide content. Respond with ONLY the prompt text — no quotes, no explanation.${langHint}`,
        prompt: indicationText,
        maxOutputTokens: 150,
      },
      'media-prompt',
    );

    const prompt = result.text.trim();
    log.info(`Generated media prompt for ${mediaType}: "${prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt}"`);

    return apiSuccess({ data: { prompt } });
  } catch (error) {
    log.error('media-prompt generation failed:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
