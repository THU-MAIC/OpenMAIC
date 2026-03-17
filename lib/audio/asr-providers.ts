/**
 * ASR (Automatic Speech Recognition) Provider Implementation
 *
 * Factory pattern for routing ASR requests to appropriate provider implementations.
 * Follows the same architecture as lib/ai/providers.ts for consistency.
 *
 * Currently Supported Providers:
 * - OpenAI Whisper: https://platform.openai.com/docs/guides/speech-to-text
 * - Browser Native: Web Speech API (https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API)
 * - Qwen ASR: https://bailian.console.aliyun.com/
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * 1. Add provider ID to ASRProviderId in lib/audio/types.ts
 *    Example: | 'assemblyai-asr'
 *
 * 2. Add provider configuration to lib/audio/constants.ts
 *    Example:
 *    'assemblyai-asr': {
 *      id: 'assemblyai-asr',
 *      name: 'AssemblyAI',
 *      requiresApiKey: true,
 *      defaultBaseUrl: 'https://api.assemblyai.com/v2',
 *      icon: '/assemblyai.svg',
 *      supportedLanguages: ['en', 'es', 'fr', 'de', 'auto'],
 *      supportedFormats: ['mp3', 'wav', 'flac', 'm4a']
 *    }
 *
 * 3. Implement provider function in this file
 *    Pattern: async function transcribeXxxASR(config, audioBuffer): Promise<ASRTranscriptionResult>
 *    - Handle Buffer/Blob conversion (see helper patterns below)
 *    - Build API request with audio data (FormData or base64)
 *    - Handle API authentication (apiKey, headers)
 *    - Convert language codes if needed
 *    - Return { text: string }
 *
 *    Example:
 *    async function transcribeAssemblyAIASR(
 *      config: ASRModelConfig,
 *      audioBuffer: Buffer | Blob
 *    ): Promise<ASRTranscriptionResult> {
 *      const baseUrl = config.baseUrl || ASR_PROVIDERS['assemblyai-asr'].defaultBaseUrl;
 *
 *      // Step 1: Upload audio file
 *      let blob: Blob;
 *      if (audioBuffer instanceof Buffer) {
 *        blob = new Blob([audioBuffer.buffer.slice(
 *          audioBuffer.byteOffset,
 *          audioBuffer.byteOffset + audioBuffer.byteLength
 *        ) as ArrayBuffer], { type: 'audio/webm' });
 *      } else {
 *        blob = audioBuffer;
 *      }
 *
 *      const uploadResponse = await fetch(`${baseUrl}/upload`, {
 *        method: 'POST',
 *        headers: {
 *          'authorization': config.apiKey!,
 *        },
 *        body: blob,
 *      });
 *
 *      if (!uploadResponse.ok) {
 *        throw new Error(`AssemblyAI upload error: ${uploadResponse.statusText}`);
 *      }
 *
 *      const { upload_url } = await uploadResponse.json();
 *
 *      // Step 2: Request transcription
 *      const transcriptResponse = await fetch(`${baseUrl}/transcript`, {
 *        method: 'POST',
 *        headers: {
 *          'authorization': config.apiKey!,
 *          'Content-Type': 'application/json',
 *        },
 *        body: JSON.stringify({
 *          audio_url: upload_url,
 *          language_code: config.language === 'auto' ? undefined : config.language,
 *        }),
 *      });
 *
 *      const { id } = await transcriptResponse.json();
 *
 *      // Step 3: Poll for completion
 *      while (true) {
 *        const statusResponse = await fetch(`${baseUrl}/transcript/${id}`, {
 *          headers: { 'authorization': config.apiKey! },
 *        });
 *        const result = await statusResponse.json();
 *
 *        if (result.status === 'completed') {
 *          return { text: result.text || '' };
 *        } else if (result.status === 'error') {
 *          throw new Error(`AssemblyAI error: ${result.error}`);
 *        }
 *
 *        await new Promise(resolve => setTimeout(resolve, 1000));
 *      }
 *    }
 *
 * 4. Add case to transcribeAudio() switch statement
 *    case 'assemblyai-asr':
 *      return await transcribeAssemblyAIASR(config, audioBuffer);
 *
 * 5. Add i18n translations in lib/i18n.ts
 *    providerAssemblyAIASR: { zh: 'AssemblyAI 语音识别', en: 'AssemblyAI ASR' }
 *
 * Buffer/Blob Conversion Patterns:
 *
 * Pattern 1: Buffer to Blob (for FormData)
 *   const blob = new Blob([
 *     audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength) as ArrayBuffer
 *   ], { type: 'audio/webm' });
 *
 * Pattern 2: Buffer to base64 (for JSON API)
 *   let base64Audio: string;
 *   if (audioBuffer instanceof Buffer) {
 *     base64Audio = audioBuffer.toString('base64');
 *   } else {
 *     const arrayBuffer = await audioBuffer.arrayBuffer();
 *     base64Audio = Buffer.from(arrayBuffer).toString('base64');
 *   }
 *
 * Pattern 3: Buffer/Blob to File (for Vercel AI SDK)
 *   let audioFile: File;
 *   if (audioBuffer instanceof Buffer) {
 *     const arrayBuffer = audioBuffer.buffer.slice(...) as ArrayBuffer;
 *     const blob = new Blob([arrayBuffer], { type: 'audio/webm' });
 *     audioFile = new File([blob], 'audio.webm', { type: 'audio/webm' });
 *   } else {
 *     audioFile = new File([audioBuffer], 'audio.webm', { type: 'audio/webm' });
 *   }
 *
 * Error Handling Patterns:
 * - Always validate API key if requiresApiKey is true
 * - Throw descriptive errors for API failures
 * - Include response.statusText or error messages from API
 * - For client-only providers (browser-native), throw error directing to client-side usage
 * - Handle polling/async APIs with proper timeout and error checking
 *
 * API Call Patterns:
 * - Vercel AI SDK: Use createOpenAI + transcribe (OpenAI, compatible providers)
 * - FormData: For providers expecting multipart/form-data (most providers)
 * - Base64: For providers expecting JSON with base64 audio (Qwen, DashScope)
 * - Upload + Poll: For async providers (AssemblyAI, Deepgram batch)
 */

import { createOpenAI } from '@ai-sdk/openai';
import { experimental_transcribe as transcribe } from 'ai';
import type { ASRModelConfig } from './types';
import { ASR_PROVIDERS } from './constants';

/**
 * Result of ASR transcription
 */
export interface ASRTranscriptionResult {
  text: string;
}

/**
 * Transcribe audio using specified ASR provider
 */
export async function transcribeAudio(
  config: ASRModelConfig,
  audioBuffer: Buffer | Blob,
): Promise<ASRTranscriptionResult> {
  const provider = ASR_PROVIDERS[config.providerId];
  if (!provider) {
    throw new Error(`Unknown ASR provider: ${config.providerId}`);
  }

  // Validate API key if required
  if (provider.requiresApiKey && !config.apiKey) {
    throw new Error(`API key required for ASR provider: ${config.providerId}`);
  }

  switch (config.providerId) {
    case 'openai-whisper':
      return await transcribeOpenAIWhisper(config, audioBuffer);

    case 'browser-native':
      throw new Error('Browser Native ASR must be handled client-side using useBrowserASR hook');

    case 'qwen-asr':
      return await transcribeQwenASR(config, audioBuffer);

    default:
      throw new Error(`Unsupported ASR provider: ${config.providerId}`);
  }
}

/**
 * OpenAI Whisper implementation (using Vercel AI SDK)
 */
async function transcribeOpenAIWhisper(
  config: ASRModelConfig,
  audioBuffer: Buffer | Blob,
): Promise<ASRTranscriptionResult> {
  const openai = createOpenAI({
    apiKey: config.apiKey!,
    baseURL: config.baseUrl || ASR_PROVIDERS['openai-whisper'].defaultBaseUrl,
  });

  // Convert to Buffer or Uint8Array (which is required by the AI SDK)
  let audioData: Buffer | Uint8Array;
  if (audioBuffer instanceof Buffer) {
    audioData = audioBuffer;
  } else if (audioBuffer instanceof Blob) {
    const arrayBuffer = await audioBuffer.arrayBuffer();
    audioData = new Uint8Array(arrayBuffer);
  } else {
    throw new Error('Invalid audio buffer type');
  }

  try {
    const result = await transcribe({
      model: openai.transcription('gpt-4o-mini-transcribe'),
      audio: audioData,
      providerOptions: {
        openai: {
          language: config.language === 'auto' ? undefined : config.language,
        },
      },
    });

    return { text: result.text || '' };
  } catch (error: unknown) {
    // Short/silent audio may cause the SDK to throw — treat as empty transcription
    const errMsg = error instanceof Error ? error.message : '';
    if (errMsg.includes('empty') || errMsg.includes('too short')) {
      return { text: '' };
    }
    throw error;
  }
}

/**
 * Qwen ASR implementation (DashScope API - Qwen3 ASR Flash)
 */
async function transcribeQwenASR(
  config: ASRModelConfig,
  audioBuffer: Buffer | Blob,
): Promise<ASRTranscriptionResult> {
  const baseUrl = config.baseUrl || ASR_PROVIDERS['qwen-asr'].defaultBaseUrl;

  // Convert audio to base64
  let base64Audio: string;
  if (audioBuffer instanceof Buffer) {
    base64Audio = audioBuffer.toString('base64');
  } else if (audioBuffer instanceof Blob) {
    const arrayBuffer = await audioBuffer.arrayBuffer();
    base64Audio = Buffer.from(arrayBuffer).toString('base64');
  } else {
    throw new Error('Invalid audio buffer type');
  }

  // Build request body
  const requestBody: Record<string, unknown> = {
    model: 'qwen3-asr-flash',
    input: {
      messages: [
        {
          role: 'user',
          content: [
            {
              audio: `data:audio/wav;base64,${base64Audio}`,
            },
          ],
        },
      ],
    },
  };

  // Add language parameter in asr_options if specified (optional - improves accuracy for known languages)
  // If language is uncertain or mixed, don't specify (auto-detect)
  if (config.language && config.language !== 'auto') {
    requestBody.parameters = {
      asr_options: {
        language: config.language,
      },
    };
  }

  const response = await fetch(`${baseUrl}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
      'X-DashScope-Audio-Format': 'wav',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    // "The audio is empty" — treat as no speech detected
    if (errorText.includes('audio is empty') || errorText.includes('InvalidParameter')) {
      return { text: '' };
    }
    throw new Error(`Qwen ASR API error: ${errorText}`);
  }

  const data = await response.json();

  // Check for transcription result in response
  // Qwen3 ASR returns OpenAI-compatible format:
  // { output: { choices: [{ message: { content: [{ text: "transcribed text" }] } }] } }
  if (
    !data.output?.choices ||
    !Array.isArray(data.output.choices) ||
    data.output.choices.length === 0
  ) {
    throw new Error(`Qwen ASR error: No choices in response. Response: ${JSON.stringify(data)}`);
  }

  const firstChoice = data.output.choices[0];
  const messageContent = firstChoice?.message?.content;

  if (!Array.isArray(messageContent) || messageContent.length === 0) {
    // Empty content typically means audio was too short or contained no speech
    return { text: '' };
  }

  // Extract text from first content item
  const transcribedText = messageContent[0]?.text || '';
  return { text: transcribedText };
}

/**
 * Get current ASR configuration from settings store
 * Note: This function should only be called in browser context
 */
export async function getCurrentASRConfig(): Promise<ASRModelConfig> {
  if (typeof window === 'undefined') {
    throw new Error('getCurrentASRConfig() can only be called in browser context');
  }

  // Lazy import to avoid circular dependency
  const { useSettingsStore } = await import('@/lib/store/settings');
  const { asrProviderId, asrLanguage, asrProvidersConfig } = useSettingsStore.getState();

  const providerConfig = asrProvidersConfig?.[asrProviderId];

  return {
    providerId: asrProviderId,
    apiKey: providerConfig?.apiKey,
    baseUrl: providerConfig?.baseUrl,
    language: asrLanguage,
  };
}

// Re-export from constants for convenience
export { getAllASRProviders, getASRProvider, getASRSupportedLanguages } from './constants';
