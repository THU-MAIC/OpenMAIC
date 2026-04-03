/**
 * Verify TTS Provider API
 *
 * Lightweight endpoint that validates TTS provider credentials.
 *
 * POST /api/verify-tts-provider
 *
 * Body:
 *   providerId: TTSProviderId
 *   apiKey: string (optional, server fallback)
 *   baseUrl: string (optional)
 *   modelId: string (optional)
 *
 * Response: { success: boolean, message: string }
 */

import { NextRequest } from 'next/server';
import { generateTTS } from '@/lib/audio/tts-providers';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import type { TTSProviderId, TTSModelConfig } from '@/lib/audio/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('VerifyTTSProvider');

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      providerId: TTSProviderId;
      apiKey?: string;
      baseUrl?: string;
      modelId?: string;
    };

    const { providerId, apiKey, baseUrl, modelId } = body;

    if (!providerId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Provider ID is required');
    }

    const provider = TTS_PROVIDERS[providerId];
    if (!provider) {
      return apiError('INVALID_REQUEST', 400, `Unknown TTS provider: ${providerId}`);
    }

    if (!apiKey) {
      return apiError('MISSING_API_KEY', 400, 'API key is required');
    }

    try {
      const config: TTSModelConfig = {
        providerId,
        apiKey,
        baseUrl: baseUrl || provider.defaultBaseUrl,
        modelId: modelId || provider.defaultModelId,
        voice: provider.voices[0]?.id || 'default',
        speed: 1.0,
      };

      // Try to generate test TTS
      const result = await generateTTS(config, 'test');
      
      if (result.audio && result.audio.length > 0) {
        return apiSuccess({
          success: true,
          message: 'TTS provider connection successful',
        });
      } else {
        return apiError('UPSTREAM_ERROR', 500, 'TTS generation returned empty audio');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('TTS verification failed:', { providerId, error: message });
      
      // Check if it's an auth error
      if (message.includes('401') || message.includes('Unauthorized') || message.includes('API key')) {
        return apiError('INVALID_REQUEST', 401, 'Authentication failed: Check your API key');
      }
      
      return apiError('UPSTREAM_ERROR', 400, `TTS verification failed: ${message}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Verify TTS provider error:', message);
    return apiError('INTERNAL_ERROR', 500, `Internal error: ${message}`);
  }
}
