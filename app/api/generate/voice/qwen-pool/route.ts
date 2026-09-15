import { NextRequest } from 'next/server';
import {
  isServerConfiguredProvider,
  isServerTTSProviderDisabled,
  resolveQwenVoiceCloneModel,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';
import {
  listQwenVoices,
  QwenVoiceCloneError,
  qwenVoiceCloneErrorMessage,
} from '@/lib/audio/qwen-voice-clone';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

/** Lists the caller's pre-existing Qwen voice-clone IDs for browser-local import. */
export async function POST(req: NextRequest) {
  try {
    if (isServerTTSProviderDisabled('qwen-tts')) {
      return apiError('PROVIDER_DISABLED', 403, 'This TTS provider is disabled by the server');
    }
    const body = (await req.json().catch(() => ({}))) as {
      ttsApiKey?: string;
      ttsBaseUrl?: string;
    };
    const managed = isServerConfiguredProvider('tts', 'qwen-tts');
    const clientBaseUrl = managed ? undefined : body.ttsBaseUrl?.trim() || undefined;
    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) return apiError('INVALID_URL', 403, ssrfError);
    }
    const apiKey = resolveTTSApiKey('qwen-tts', managed ? undefined : body.ttsApiKey?.trim());
    if (!apiKey)
      return apiError('MISSING_API_KEY', 400, 'No API key configured for TTS provider: qwen-tts');
    const baseUrl = resolveTTSBaseUrl('qwen-tts', clientBaseUrl);
    const voices = await listQwenVoices({
      apiKey,
      baseUrl,
      targetModel: resolveQwenVoiceCloneModel(),
    });
    return apiSuccess({ voices });
  } catch (error) {
    if (error instanceof QwenVoiceCloneError) {
      return apiError(error.code, error.httpStatus || 502, qwenVoiceCloneErrorMessage(error));
    }
    return apiError(
      'GENERATION_FAILED',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
