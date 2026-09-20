import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveTTSApiKey, resolveTTSBaseUrl } from '@/lib/server/provider-config';

const log = createLogger('ElevenLabs Voices');

export const maxDuration = 30;

const PROVIDER_ID = 'elevenlabs-tts';
/** ElevenLabs caps a single page at 100 (docs: voices/search `page_size`). */
const PAGE_SIZE = 100;

/**
 * The provider's configured base URL points at the v1 root (that is where
 * `/text-to-speech/{voice_id}` lives), but the voice catalogue is only exposed
 * on v2. Swap the trailing version segment instead of hardcoding the host, so a
 * gateway or proxy base URL keeps working.
 */
function voicesEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? `${trimmed.slice(0, -3)}v2/voices` : `${trimmed}/v2/voices`;
}

interface ElevenLabsVerifiedLanguage {
  language?: string;
  accent?: string;
  locale?: string;
  model_id?: string;
}

interface ElevenLabsVoice {
  voice_id?: string;
  name?: string;
  category?: string;
  labels?: Record<string, string>;
  verified_languages?: ElevenLabsVerifiedLanguage[];
}

/**
 * ElevenLabs voice catalogue for the settings picker.
 *
 * The built-in voice list in `lib/audio/constants.ts` is a deliberately small
 * English-only starter set, so a deployment that needs a voice in another
 * language (Vietnamese, say) has no way to name it. This route reads the
 * catalogue the key actually has access to and hands back just what the picker
 * needs — never the raw upstream payload, which carries sharing//preview URLs
 * and other account metadata the browser has no use for.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const language = typeof body.language === 'string' ? body.language.trim() : '';
    const search = typeof body.search === 'string' ? body.search.trim() : '';

    // A server-managed key wins over anything the browser sends, matching every
    // other TTS path; BYOK deployments fall back to the client-supplied key.
    const apiKey = resolveTTSApiKey(PROVIDER_ID, body.apiKey);
    if (!apiKey) {
      return apiError('MISSING_API_KEY', 400, 'API Key is required');
    }

    const baseUrl = resolveTTSBaseUrl(PROVIDER_ID, body.baseUrl);
    if (!baseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Base URL is required');
    }

    const endpoint = voicesEndpoint(baseUrl);
    const ssrfError = await validateUrlForSSRF(endpoint);
    if (ssrfError) {
      return apiError('INVALID_URL', 403, ssrfError);
    }

    const url = new URL(endpoint);
    url.searchParams.set('page_size', String(PAGE_SIZE));
    if (language) url.searchParams.set('language', language);
    if (search) url.searchParams.set('search', search);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'xi-api-key': apiKey },
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return apiError(
        'UPSTREAM_ERROR',
        response.status,
        'Failed to fetch voices from ElevenLabs',
        errorText || response.statusText,
      );
    }

    const payload = (await response.json()) as { voices?: ElevenLabsVoice[]; has_more?: boolean };

    const voices = (payload.voices ?? [])
      .filter((voice): voice is ElevenLabsVoice & { voice_id: string } => !!voice?.voice_id)
      .map((voice) => {
        const verified = voice.verified_languages ?? [];
        return {
          id: voice.voice_id,
          name: voice.name || voice.voice_id,
          category: voice.category,
          accent: voice.labels?.accent,
          // Deduped so a voice verified on several models lists each language once.
          languages: [
            ...new Set(verified.map((entry) => entry.language).filter((v): v is string => !!v)),
          ],
        };
      });

    return apiSuccess({ voices, hasMore: payload.has_more === true });
  } catch (error) {
    log.error('Failed to list ElevenLabs voices:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
