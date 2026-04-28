/**
 * TTS (Text-to-Speech) Provider Implementation
 *
 * Factory pattern for routing TTS requests to appropriate provider implementations.
 * Follows the same architecture as lib/ai/providers.ts for consistency.
 *
 * Currently Supported Providers:
 * - OpenAI TTS: https://platform.openai.com/docs/guides/text-to-speech
 * - Azure TTS: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech
 * - GLM TTS: https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-tts
 * - Qwen TTS: https://bailian.console.aliyun.com/
 * - MiniMax TTS: https://platform.minimaxi.com/docs/api-reference/speech-t2a-http
 * - Doubao TTS: https://www.volcengine.com/docs/6561/1257543
 * - ElevenLabs TTS: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 * - Browser Native: Web Speech API (client-side only)
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * 1. Add provider ID to TTSProviderId in lib/audio/types.ts
 *    Example: | 'elevenlabs-tts'
 *
 * 2. Add provider configuration to lib/audio/constants.ts
 *    Example:
 *    'elevenlabs-tts': {
 *      id: 'elevenlabs-tts',
 *      name: 'ElevenLabs',
 *      requiresApiKey: true,
 *      defaultBaseUrl: 'https://api.elevenlabs.io/v1',
 *      icon: '/logos/elevenlabs.svg',
 *      voices: [...],
 *      supportedFormats: ['mp3', 'pcm'],
 *      speedRange: { min: 0.5, max: 2.0, default: 1.0 }
 *    }
 *
 * 3. Implement provider function in this file
 *    Pattern: async function generateXxxTTS(config, text): Promise<TTSGenerationResult>
 *    - Validate config and build API request
 *    - Handle API authentication (apiKey, headers)
 *    - Convert provider-specific parameters (voice, speed, format)
 *    - Return { audio: Uint8Array, format: string }
 *
 *    Example:
 *    async function generateElevenLabsTTS(
 *      config: TTSModelConfig,
 *      text: string
 *    ): Promise<TTSGenerationResult> {
 *      const baseUrl = config.baseUrl || TTS_PROVIDERS['elevenlabs-tts'].defaultBaseUrl;
 *
 *      const response = await fetch(`${baseUrl}/text-to-speech/${config.voice}`, {
 *        method: 'POST',
 *        headers: {
 *          'xi-api-key': config.apiKey!,
 *          'Content-Type': 'application/json',
 *        },
 *        body: JSON.stringify({
 *          text,
 *          model_id: 'eleven_multilingual_v2',
 *          voice_settings: {
 *            stability: 0.5,
 *            similarity_boost: 0.75,
 *          }
 *        }),
 *      });
 *
 *      if (!response.ok) {
 *        throw new Error(`ElevenLabs TTS API error: ${response.statusText}`);
 *      }
 *
 *      const arrayBuffer = await response.arrayBuffer();
 *      return {
 *        audio: new Uint8Array(arrayBuffer),
 *        format: 'mp3',
 *      };
 *    }
 *
 * 4. Add case to generateTTS() switch statement
 *    case 'elevenlabs-tts':
 *      return await generateElevenLabsTTS(config, text);
 *
 * 5. Add i18n translations in lib/i18n.ts
 *    providerElevenLabsTTS: { zh: 'ElevenLabs TTS', en: 'ElevenLabs TTS' }
 *
 * Error Handling Patterns:
 * - Always validate API key if requiresApiKey is true
 * - Throw descriptive errors for API failures
 * - Include response.statusText or error messages from API
 * - For client-only providers (browser-native), throw error directing to client-side usage
 *
 * API Call Patterns:
 * - Direct API: Use fetch with appropriate headers and body format (recommended for better encoding support)
 * - SSML: For Azure-like providers requiring SSML markup
 * - URL-based: For providers returning audio URL (download in second step)
 */

import type { TTSModelConfig } from './types';
import { isCustomTTSProvider } from './types';
import { TTS_PROVIDERS } from './constants';
import {
  VOXCPM_VLLM_MODEL_ID,
  VOXCPM_AUTO_VOICE_ID,
  normalizeVoxCPMBackend,
  type VoxCPMProviderOptions,
} from './voxcpm';

/**
 * Result of TTS generation
 */
export interface TTSGenerationResult {
  audio: Uint8Array;
  format: string;
}

/**
 * Thrown when a TTS provider returns a rate-limit / concurrency-quota error.
 * Allows downstream consumers to distinguish rate-limit errors from other TTS failures.
 *
 * TODO: The API route currently catches all errors uniformly as GENERATION_FAILED.
 * This class enables future retry/backoff logic without changing the throw sites.
 */
export class TTSRateLimitError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = 'TTSRateLimitError';
  }
}

/**
 * Generate speech using specified TTS provider
 */
export async function generateTTS(
  config: TTSModelConfig,
  text: string,
): Promise<TTSGenerationResult> {
  const provider = TTS_PROVIDERS[config.providerId as keyof typeof TTS_PROVIDERS];

  // Validate API key if required (only for built-in providers with known config)
  if (provider?.requiresApiKey && !config.apiKey) {
    throw new Error(`API key required for TTS provider: ${config.providerId}`);
  }

  switch (config.providerId) {
    case 'openai-tts':
      return await generateOpenAITTS(config, text);

    case 'azure-tts':
      return await generateAzureTTS(config, text);

    case 'glm-tts':
      return await generateGLMTTS(config, text);

    case 'qwen-tts':
      return await generateQwenTTS(config, text);

    case 'voxcpm-tts':
      return await generateVoxCPMTTS(config, text);

    case 'minimax-tts':
      return await generateMiniMaxTTS(config, text);
    case 'doubao-tts':
      return await generateDoubaoTTS(config, text);
    case 'elevenlabs-tts':
      return await generateElevenLabsTTS(config, text);

    case 'browser-native-tts':
      throw new Error(
        'Browser Native TTS must be handled client-side using Web Speech API. This provider cannot be used on the server.',
      );

    default:
      if (isCustomTTSProvider(config.providerId)) {
        return await generateOpenAITTS(config, text);
      }
      throw new Error(`Unsupported TTS provider: ${config.providerId}`);
  }
}

/**
 * OpenAI TTS implementation (direct API call with explicit UTF-8 encoding)
 */
async function generateOpenAITTS(
  config: TTSModelConfig,
  text: string,
): Promise<TTSGenerationResult> {
  const baseUrl = config.baseUrl || TTS_PROVIDERS['openai-tts'].defaultBaseUrl;

  // Use gpt-4o-mini-tts for best quality and intelligent realtime applications
  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      model: config.modelId || 'gpt-4o-mini-tts',
      input: text,
      voice: config.voice,
      speed: config.speed || 1.0,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`OpenAI TTS API error: ${error.error?.message || response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') || '';
  const format = getAudioResponseFormat(contentType);
  return {
    audio: new Uint8Array(arrayBuffer),
    format,
  };
}

/**
 * VoxCPM2 TTS implementation.
 *
 * OpenMAIC keeps one internal VoxCPM request shape, then adapts it to the
 * selected official backend protocol.
 */
async function generateVoxCPMTTS(
  config: TTSModelConfig,
  text: string,
): Promise<TTSGenerationResult> {
  const baseUrl = (config.baseUrl || TTS_PROVIDERS['voxcpm-tts'].defaultBaseUrl || '').replace(
    /\/$/,
    '',
  );
  if (!baseUrl) {
    throw new Error('VoxCPM base URL is required');
  }

  const options = (config.providerOptions || {}) as VoxCPMProviderOptions;
  const backend = normalizeVoxCPMBackend(options.backend);
  const voicePrompt =
    options.voicePrompt ||
    (config.voice && config.voice !== 'default' && config.voice !== VOXCPM_AUTO_VOICE_ID
      ? config.voice
      : undefined);
  if (config.voice === VOXCPM_AUTO_VOICE_ID && !voicePrompt) {
    throw new Error('VoxCPM Auto Voice requires agent context');
  }
  const cfgValue = options.cfgValue ?? 2.0;
  const inferenceTimesteps = options.inferenceTimesteps ?? 10;
  const normalize = options.normalize ?? false;
  const denoise = options.denoise ?? false;
  const usePromptContinuation = Boolean(options.promptText?.trim() && options.referenceAudioBase64);

  const request = {
    targetText: usePromptContinuation ? text : buildVoxCPMTargetText(text, voicePrompt),
    voicePrompt,
    promptText: options.promptText,
    cfgValue,
    inferenceTimesteps,
    normalize,
    denoise,
    referenceAudioBase64: options.referenceAudioBase64,
    referenceAudioMimeType: options.referenceAudioMimeType,
    referenceAudioName: options.referenceAudioName,
  };

  const response =
    backend === 'nano-vllm'
      ? await postVoxCPMNanoVLLM(baseUrl, request, config.apiKey)
      : backend === 'python-api'
        ? await postVoxCPMPythonAPI(baseUrl, request, config.apiKey)
        : await postVoxCPMVLLMOmni(baseUrl, request, config);

  if (!response.ok) {
    throw new Error(`VoxCPM TTS API error: ${await readTTSApiError(response)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') || '';
  const format = getAudioResponseFormat(contentType);
  return {
    audio: new Uint8Array(arrayBuffer),
    format,
  };
}

function buildVoxCPMTargetText(text: string, voicePrompt?: string): string {
  const prompt = voicePrompt
    ?.replace(/[\p{C}]+/gu, ' ')
    .replace(/[()（）]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return prompt ? `(${prompt})${text}` : text;
}

function getAudioResponseFormat(contentType: string): string {
  if (contentType.includes('audio/wav') || contentType.includes('audio/x-wav')) return 'wav';
  if (contentType.includes('audio/mpeg') || contentType.includes('audio/mp3')) return 'mp3';
  if (contentType.includes('audio/flac')) return 'flac';
  if (contentType.includes('audio/ogg')) return 'ogg';
  if (contentType.includes('audio/webm')) return 'webm';
  return 'mp3';
}

function getVoxCPMAudioFormat(mimeType?: string, fileName?: string): string {
  const lowerName = fileName?.toLowerCase() || '';
  if (mimeType?.includes('wav') || lowerName.endsWith('.wav')) return 'wav';
  if (mimeType?.includes('mpeg') || mimeType?.includes('mp3') || lowerName.endsWith('.mp3')) {
    return 'mp3';
  }
  if (mimeType?.includes('flac') || lowerName.endsWith('.flac')) return 'flac';
  if (mimeType?.includes('ogg') || lowerName.endsWith('.ogg')) return 'ogg';
  if (mimeType?.includes('webm') || lowerName.endsWith('.webm')) return 'webm';
  return 'wav';
}

function getVLLMOmniSpeechUrl(baseUrl: string): string {
  return baseUrl.endsWith('/v1') ? `${baseUrl}/audio/speech` : `${baseUrl}/v1/audio/speech`;
}

function getVLLMOmniModelId(config: TTSModelConfig): string {
  const modelId = config.modelId?.trim();
  if (!modelId || modelId === 'VoxCPM2') return VOXCPM_VLLM_MODEL_ID;
  return modelId;
}

function getBackendAuthHeaders(apiKey?: string): Record<string, string> {
  return apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {};
}

async function postVoxCPMVLLMOmni(
  baseUrl: string,
  params: {
    targetText: string;
    promptText?: string;
    referenceAudioBase64?: string;
    referenceAudioMimeType?: string;
    referenceAudioName?: string;
  },
  config: TTSModelConfig,
): Promise<Response> {
  const payload: Record<string, unknown> = {
    model: getVLLMOmniModelId(config),
    input: params.targetText,
    // VoxCPM2's vLLM-Omni adapter currently ignores named voices; prompts/ref_audio carry voice identity.
    voice: 'default',
    response_format: 'wav',
    stream: false,
  };

  if (params.referenceAudioBase64) {
    const referenceAudio = getVoxCPMDataAudioUrl(
      params.referenceAudioBase64,
      params.referenceAudioMimeType,
      params.referenceAudioName,
    );
    payload.ref_audio = referenceAudio;
    if (params.promptText?.trim()) {
      payload.prompt_audio = referenceAudio;
      payload.prompt_text = params.promptText.trim();
    }
  }

  return fetch(getVLLMOmniSpeechUrl(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...getBackendAuthHeaders(config.apiKey),
    },
    body: JSON.stringify(payload),
  });
}

function getVoxCPMDataAudioUrl(base64: string, mimeType?: string, fileName?: string): string {
  const format = getVoxCPMAudioFormat(mimeType, fileName);
  const mediaType =
    mimeType?.trim() ||
    (format === 'mp3'
      ? 'audio/mpeg'
      : format === 'flac'
        ? 'audio/flac'
        : format === 'ogg'
          ? 'audio/ogg'
          : format === 'webm'
            ? 'audio/webm'
            : 'audio/wav');
  return `data:${mediaType};base64,${base64}`;
}

function base64ToBlob(base64: string, mimeType?: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType || 'audio/wav' });
}

async function postVoxCPMPythonAPI(
  baseUrl: string,
  params: {
    targetText: string;
    promptText?: string;
    cfgValue: number;
    inferenceTimesteps: number;
    normalize: boolean;
    denoise: boolean;
    referenceAudioBase64?: string;
    referenceAudioMimeType?: string;
    referenceAudioName?: string;
  },
  apiKey?: string,
): Promise<Response> {
  const formData = new FormData();
  formData.set('text', params.targetText);
  formData.set('cfg_value', String(params.cfgValue));
  formData.set('inference_timesteps', String(params.inferenceTimesteps));
  formData.set('normalize', String(params.normalize));
  formData.set('denoise', String(params.denoise));

  if (params.referenceAudioBase64) {
    const audioBlob = base64ToBlob(params.referenceAudioBase64, params.referenceAudioMimeType);
    const audioName = params.referenceAudioName || 'reference.wav';
    formData.set('reference_audio', audioBlob, audioName);
    if (params.promptText?.trim()) {
      formData.set('prompt_audio', audioBlob, audioName);
      formData.set('prompt_text', params.promptText.trim());
    }
  }

  return fetch(`${baseUrl}/tts/upload`, {
    method: 'POST',
    headers: getBackendAuthHeaders(apiKey),
    body: formData,
  });
}

async function postVoxCPMNanoVLLM(
  baseUrl: string,
  params: {
    targetText: string;
    promptText?: string;
    cfgValue: number;
    referenceAudioBase64?: string;
    referenceAudioMimeType?: string;
    referenceAudioName?: string;
  },
  apiKey?: string,
): Promise<Response> {
  const payload: Record<string, unknown> = {
    target_text: params.targetText,
    cfg_value: params.cfgValue,
  };

  if (params.referenceAudioBase64) {
    const format = getVoxCPMAudioFormat(params.referenceAudioMimeType, params.referenceAudioName);
    payload.ref_audio_wav_base64 = params.referenceAudioBase64;
    payload.ref_audio_wav_format = format;
    if (params.promptText?.trim()) {
      payload.prompt_wav_base64 = params.referenceAudioBase64;
      payload.prompt_wav_format = format;
      payload.prompt_text = params.promptText.trim();
    }
  }

  return fetch(`${baseUrl}/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...getBackendAuthHeaders(apiKey),
    },
    body: JSON.stringify(payload),
  });
}

async function readTTSApiError(response: Response): Promise<string> {
  const text = await response.text().catch(() => response.statusText);
  if (!text) return response.statusText;
  try {
    const json = JSON.parse(text) as { detail?: unknown; error?: { message?: string } | string };
    if (typeof json.detail === 'string') return json.detail;
    if (typeof json.error === 'string') return json.error;
    if (json.error?.message) return json.error.message;
  } catch {
    // Fall through to raw text.
  }
  return text;
}

/**
 * Azure TTS implementation (direct API call with SSML)
 */
async function generateAzureTTS(
  config: TTSModelConfig,
  text: string,
): Promise<TTSGenerationResult> {
  const baseUrl = config.baseUrl || TTS_PROVIDERS['azure-tts'].defaultBaseUrl;

  // Build SSML
  const rate = config.speed ? `${((config.speed - 1) * 100).toFixed(0)}%` : '0%';
  const ssml = `
    <speak version='1.0' xml:lang='zh-CN'>
      <voice xml:lang='zh-CN' name='${config.voice}'>
        <prosody rate='${rate}'>${escapeXml(text)}</prosody>
      </voice>
    </speak>
  `.trim();

  const response = await fetch(`${baseUrl}/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': config.apiKey!,
      'Content-Type': 'application/ssml+xml; charset=utf-8',
      'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
    },
    body: ssml,
  });

  if (!response.ok) {
    throw new Error(`Azure TTS API error: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    audio: new Uint8Array(arrayBuffer),
    format: 'mp3',
  };
}

/**
 * GLM TTS implementation (GLM API)
 */
async function generateGLMTTS(config: TTSModelConfig, text: string): Promise<TTSGenerationResult> {
  const baseUrl = config.baseUrl || TTS_PROVIDERS['glm-tts'].defaultBaseUrl;

  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      model: config.modelId || 'glm-tts',
      input: text,
      voice: config.voice,
      speed: config.speed || 1.0,
      volume: 1.0,
      response_format: 'wav',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    let errorMessage = `GLM TTS API error: ${errorText}`;
    try {
      const errorJson = JSON.parse(errorText);
      if (errorJson.error?.message) {
        errorMessage = `GLM TTS API error: ${errorJson.error.message} (code: ${errorJson.error.code})`;
      }
    } catch {
      // If not JSON, use the text as is
    }
    throw new Error(errorMessage);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    audio: new Uint8Array(arrayBuffer),
    format: 'wav',
  };
}

/**
 * Qwen TTS implementation (DashScope API - Qwen3 TTS Flash)
 */
async function generateQwenTTS(config: TTSModelConfig, text: string): Promise<TTSGenerationResult> {
  const baseUrl = config.baseUrl || TTS_PROVIDERS['qwen-tts'].defaultBaseUrl;

  // Calculate speed: Qwen3 uses rate parameter from -500 to 500
  // speed 1.0 = rate 0, speed 2.0 = rate 500, speed 0.5 = rate -250
  const rate = Math.round(((config.speed || 1.0) - 1.0) * 500);

  const response = await fetch(`${baseUrl}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      model: config.modelId || 'qwen3-tts-flash',
      input: {
        text,
        voice: config.voice,
        language_type: 'Chinese', // Default to Chinese, can be made configurable
      },
      parameters: {
        rate, // Speech rate from -500 to 500
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Qwen TTS API error: ${errorText}`);
  }

  const data = await response.json();

  // Check for audio URL in response
  if (!data.output?.audio?.url) {
    throw new Error(`Qwen TTS error: No audio URL in response. Response: ${JSON.stringify(data)}`);
  }

  // Download audio from URL
  const audioUrl = data.output.audio.url;
  const audioResponse = await fetch(audioUrl);

  if (!audioResponse.ok) {
    throw new Error(`Failed to download audio from URL: ${audioResponse.statusText}`);
  }

  const arrayBuffer = await audioResponse.arrayBuffer();

  return {
    audio: new Uint8Array(arrayBuffer),
    format: 'wav', // Qwen3 TTS returns WAV format
  };
}

/**
 * MiniMax TTS implementation (synchronous HTTP API)
 */
async function generateMiniMaxTTS(
  config: TTSModelConfig,
  text: string,
): Promise<TTSGenerationResult> {
  const baseUrl = (config.baseUrl || TTS_PROVIDERS['minimax-tts'].defaultBaseUrl || '').replace(
    /\/$/,
    '',
  );
  const response = await fetch(`${baseUrl}/v1/t2a_v2`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      model: config.modelId || 'speech-2.8-hd',
      text,
      stream: false,
      output_format: 'hex',
      voice_setting: {
        voice_id: config.voice,
        speed: config.speed || 1.0,
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: config.format || 'mp3',
        channel: 1,
      },
      language_boost: 'auto',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`MiniMax TTS API error: ${errorText}`);
  }

  const data = await response.json();
  const hexAudio = data?.data?.audio;
  if (!hexAudio || typeof hexAudio !== 'string') {
    throw new Error(`MiniMax TTS error: No audio returned. Response: ${JSON.stringify(data)}`);
  }

  const cleanedHex = hexAudio.trim();
  if (cleanedHex.length % 2 !== 0) {
    throw new Error('MiniMax TTS error: invalid hex audio payload length');
  }

  const audio = new Uint8Array(
    cleanedHex.match(/.{1,2}/g)?.map((byte: string) => parseInt(byte, 16)) || [],
  );
  return {
    audio,
    format: data?.extra_info?.audio_format || config.format || 'mp3',
  };
}

/**
 * ElevenLabs TTS implementation (direct API call with voice-specific endpoint)
 */
async function generateElevenLabsTTS(
  config: TTSModelConfig,
  text: string,
): Promise<TTSGenerationResult> {
  const baseUrl = config.baseUrl || TTS_PROVIDERS['elevenlabs-tts'].defaultBaseUrl;
  const requestedFormat = config.format || 'mp3';
  const clampedSpeed = Math.min(1.2, Math.max(0.7, config.speed || 1.0));
  const outputFormatMap: Record<string, string> = {
    mp3: 'mp3_44100_128',
    opus: 'opus_48000_96',
    pcm: 'pcm_44100',
    wav: 'wav_44100',
    ulaw: 'ulaw_8000',
    alaw: 'alaw_8000',
  };
  const outputFormat = outputFormatMap[requestedFormat] || outputFormatMap.mp3;

  const response = await fetch(
    `${baseUrl}/text-to-speech/${encodeURIComponent(config.voice)}?output_format=${outputFormat}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': config.apiKey!,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        text,
        model_id: config.modelId || 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          speed: clampedSpeed,
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`ElevenLabs TTS API error: ${errorText || response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    audio: new Uint8Array(arrayBuffer),
    format: requestedFormat,
  };
}

/**
 * Get current TTS configuration from settings store
 * Note: This function should only be called in browser context
 */
export async function getCurrentTTSConfig(): Promise<TTSModelConfig> {
  if (typeof window === 'undefined') {
    throw new Error('getCurrentTTSConfig() can only be called in browser context');
  }

  // Lazy import to avoid circular dependency
  const { useSettingsStore } = await import('@/lib/store/settings');
  const { ttsProviderId, ttsVoice, ttsSpeed, ttsProvidersConfig } = useSettingsStore.getState();

  const providerConfig = ttsProvidersConfig?.[ttsProviderId];

  return {
    providerId: ttsProviderId,
    modelId:
      providerConfig?.modelId ||
      TTS_PROVIDERS[ttsProviderId as keyof typeof TTS_PROVIDERS]?.defaultModelId ||
      '',
    apiKey: providerConfig?.apiKey,
    baseUrl: providerConfig?.baseUrl || providerConfig?.customDefaultBaseUrl,
    voice: ttsVoice,
    speed: ttsSpeed,
  };
}

// Re-export from constants for convenience
export { getAllTTSProviders, getTTSProvider, getTTSVoices } from './constants';

/**
 * Doubao TTS 2.0 implementation (Volcengine Seed-TTS 2.0)
 */
async function generateDoubaoTTS(
  config: TTSModelConfig,
  text: string,
): Promise<TTSGenerationResult> {
  const colonIdx = (config.apiKey || '').indexOf(':');
  if (colonIdx <= 0) {
    throw new Error(
      'Doubao TTS requires API key in format "appId:accessKey". Get both from the Volcengine console.',
    );
  }
  const appId = config.apiKey!.slice(0, colonIdx);
  const accessKey = config.apiKey!.slice(colonIdx + 1);

  const baseUrl = config.baseUrl || TTS_PROVIDERS['doubao-tts'].defaultBaseUrl;
  const speechRate = Math.round(((config.speed || 1.0) - 1.0) * 100);

  const response = await fetch(`${baseUrl}/unidirectional`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Id': appId,
      'X-Api-Access-Key': accessKey,
      'X-Api-Resource-Id': 'seed-tts-2.0',
    },
    body: JSON.stringify({
      user: { uid: 'openmaic' },
      req_params: {
        text,
        speaker: config.voice,
        audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: speechRate },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Doubao TTS API error (${response.status}): ${errorText}`);
  }

  const responseText = await response.text();
  const audioChunks: Uint8Array[] = [];

  let depth = 0;
  let start = -1;
  for (let i = 0; i < responseText.length; i++) {
    if (responseText[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (responseText[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        let chunk: { code: number; message?: string; data?: string };
        try {
          chunk = JSON.parse(responseText.slice(start, i + 1));
        } catch {
          start = -1;
          continue;
        }
        start = -1;

        if (chunk.code === 0 && chunk.data) {
          audioChunks.push(new Uint8Array(Buffer.from(chunk.data, 'base64')));
        } else if (chunk.code === 20000000) {
          break;
        } else if (chunk.code && chunk.code !== 0) {
          if (chunk.code === 45000000 || chunk.code === 45000292) {
            throw new TTSRateLimitError(
              'doubao-tts',
              chunk.message || 'concurrency quota exceeded',
            );
          }
          throw new Error(`Doubao TTS error: ${chunk.message || 'unknown'} (code: ${chunk.code})`);
        }
      }
    }
  }

  if (audioChunks.length === 0) {
    throw new Error('Doubao TTS: no audio data received');
  }

  const totalLength = audioChunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of audioChunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return { audio: combined, format: 'mp3' };
}

/**
 * Escape XML special characters for SSML
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
