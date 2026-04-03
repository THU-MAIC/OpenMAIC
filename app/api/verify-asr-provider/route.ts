/**
 * Verify ASR Provider API
 *
 * Lightweight endpoint that validates ASR provider credentials.
 *
 * POST /api/verify-asr-provider
 *
 * Body:
 *   providerId: ASRProviderId
 *   apiKey: string (optional, server fallback)
 *   baseUrl: string (optional)
 *   modelId: string (optional)
 *   language: string (optional)
 *
 * Response: { success: boolean, message: string }
 */

import { NextRequest } from 'next/server';
import { transcribeAudio } from '@/lib/audio/asr-providers';
import { ASR_PROVIDERS } from '@/lib/audio/constants';
import type { ASRProviderId, ASRModelConfig } from '@/lib/audio/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('VerifyASRProvider');

/**
 * Create a minimal test audio buffer (100ms of silence at 16kHz)
 */
function createTestAudioBuffer(): Buffer {
  const sampleRate = 16000;
  const duration = 0.1; // 100ms
  const samples = Math.floor(sampleRate * duration);
  
  // Create WAV buffer with minimal valid WAV header
  const buffer = Buffer.alloc(44 + samples * 2);
  
  // WAV header
  buffer.write('RIFF');
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // Mono
  buffer.writeUInt32LE(sampleRate, 24); // Sample rate
  buffer.writeUInt32LE(sampleRate * 2, 28); // Byte rate
  buffer.writeUInt16LE(2, 32); // Block align
  buffer.writeUInt16LE(16, 34); // Bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  
  // Audio data (silence)
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(0, 44 + i * 2);
  }
  
  return buffer;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      providerId: ASRProviderId;
      apiKey?: string;
      baseUrl?: string;
      modelId?: string;
      language?: string;
    };

    const { providerId, apiKey, baseUrl, modelId, language } = body;

    if (!providerId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Provider ID is required');
    }

    const provider = ASR_PROVIDERS[providerId];
    if (!provider) {
      return apiError('INVALID_REQUEST', 400, `Unknown ASR provider: ${providerId}`);
    }

    if (!apiKey) {
      return apiError('MISSING_API_KEY', 400, 'API key is required');
    }

    try {
      const config: ASRModelConfig = {
        providerId,
        apiKey,
        baseUrl: baseUrl || provider.defaultBaseUrl,
        modelId: modelId || provider.defaultModelId,
        language: language || 'auto',
      };

      // Create test audio buffer
      const testAudio = createTestAudioBuffer();

      // Try to transcribe test audio
      const result = await transcribeAudio(config, testAudio);
      
      // For silence, we expect either an error or empty result, which is fine
      // The important thing is that the API accepted our request with valid auth
      return apiSuccess({
        success: true,
        message: 'ASR provider connection successful',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('ASR verification failed:', { providerId, error: message });
      
      // Check if it's an auth error
      if (message.includes('401') || message.includes('Unauthorized') || message.includes('API key')) {
        return apiError('INVALID_REQUEST', 401, 'Authentication failed: Check your API key');
      }
      
      return apiError('UPSTREAM_ERROR', 400, `ASR verification failed: ${message}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Verify ASR provider error:', message);
    return apiError('INTERNAL_ERROR', 500, `Internal error: ${message}`);
  }
}
