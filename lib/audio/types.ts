/**
 * Audio Provider Type Definitions
 *
 * Unified types for TTS (Text-to-Speech) and ASR (Automatic Speech Recognition)
 * with extensible architecture to support multiple providers.
 *
 * Currently Supported TTS Providers:
 * - OpenAI TTS (https://platform.openai.com/docs/guides/text-to-speech)
 * - Azure TTS (https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech)
 * - GLM TTS (https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-tts)
 * - Qwen TTS (https://bailian.console.aliyun.com/)
 * - Browser Native TTS (Web Speech API, client-side only)
 *
 * Currently Supported ASR Providers:
 * - OpenAI Whisper (https://platform.openai.com/docs/guides/speech-to-text)
 * - Browser Native (Web Speech API, client-side only)
 * - Qwen ASR (DashScope API)
 *
 * Future Provider Support (extensible):
 * - ElevenLabs TTS/ASR (https://elevenlabs.io/docs)
 * - Fish Audio TTS (https://fish.audio/docs)
 * - Cartesia TTS (https://cartesia.ai/docs)
 * - PlayHT TTS (https://docs.play.ht/)
 * - AssemblyAI ASR (https://www.assemblyai.com/docs)
 * - Deepgram ASR (https://developers.deepgram.com/docs)
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * Step 1: Add provider ID to the union type
 *   - For TTS: Add to TTSProviderId below
 *   - For ASR: Add to ASRProviderId below
 *
 * Step 2: Add provider configuration to constants.ts
 *   - Define provider metadata (name, icon, voices, formats, etc.)
 *   - Add to TTS_PROVIDERS or ASR_PROVIDERS registry
 *
 * Step 3: Implement provider logic in tts-providers.ts or asr-providers.ts
 *   - Add case to generateTTS() or transcribeAudio() switch statement
 *   - Implement API call logic for the new provider
 *
 * Step 4: Add i18n translations
 *   - Add provider name translations in lib/i18n.ts
 *   - Format: `provider{ProviderName}TTS` or `provider{ProviderName}ASR`
 *
 * Step 5 (Optional): Create client-side hook if needed
 *   - For browser-only providers, create hooks like use-browser-tts.ts
 *   - Export from lib/hooks/
 *
 * Example: Adding ElevenLabs TTS
 * ================================
 * 1. Add 'elevenlabs-tts' to TTSProviderId union type
 * 2. In constants.ts:
 *    TTS_PROVIDERS['elevenlabs-tts'] = {
 *      id: 'elevenlabs-tts',
 *      name: 'ElevenLabs',
 *      requiresApiKey: true,
 *      defaultBaseUrl: 'https://api.elevenlabs.io/v1',
 *      icon: '/elevenlabs.svg',
 *      voices: [...],
 *      supportedFormats: ['mp3', 'pcm'],
 *      speedRange: { min: 0.5, max: 2.0, default: 1.0 }
 *    }
 * 3. In tts-providers.ts:
 *    case 'elevenlabs-tts':
 *      return await generateElevenLabsTTS(config, text);
 * 4. In i18n.ts:
 *    providerElevenLabsTTS: 'ElevenLabs TTS' / 'ElevenLabs Text-to-Speech'
 */

// ============================================================================
// TTS (Text-to-Speech) Types
// ============================================================================

/**
 * TTS Provider IDs
 *
 * Add new TTS providers here as union members.
 * Keep in sync with TTS_PROVIDERS registry in constants.ts
 */
export type TTSProviderId =
  | 'openai-tts'
  | 'azure-tts'
  | 'glm-tts'
  | 'qwen-tts'
  | 'elevenlabs-tts'
  | 'browser-native-tts';
// Add new TTS providers below (uncomment and modify):
// | 'fish-audio-tts'
// | 'cartesia-tts'
// | 'playht-tts'

/**
 * Voice information for TTS
 */
export interface TTSVoiceInfo {
  id: string;
  name: string;
  language: string;
  localeName?: string; // Language name in its native script (e.g., "中文（简体，中国）", "日本語")
  gender?: 'male' | 'female' | 'neutral';
  description?: string;
}

/**
 * TTS Provider Configuration
 */
export interface TTSProviderConfig {
  id: TTSProviderId;
  name: string;
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  icon?: string;
  voices: TTSVoiceInfo[];
  supportedFormats: string[]; // ['mp3', 'wav', 'opus', etc.]
  speedRange?: {
    min: number;
    max: number;
    default: number;
  };
}

/**
 * TTS Model Configuration for API calls
 */
export interface TTSModelConfig {
  providerId: TTSProviderId;
  apiKey?: string;
  baseUrl?: string;
  voice: string;
  speed?: number;
  format?: string;
}

// ============================================================================
// ASR (Automatic Speech Recognition) Types
// ============================================================================

/**
 * ASR Provider IDs
 *
 * Add new ASR providers here as union members.
 * Keep in sync with ASR_PROVIDERS registry in constants.ts
 */
export type ASRProviderId = 'openai-whisper' | 'browser-native' | 'qwen-asr';
// Add new ASR providers below (uncomment and modify):
// | 'elevenlabs-asr'
// | 'assemblyai-asr'
// | 'deepgram-asr'
// | 'azure-asr'

/**
 * ASR Provider Configuration
 */
export interface ASRProviderConfig {
  id: ASRProviderId;
  name: string;
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  icon?: string;
  supportedLanguages: string[];
  supportedFormats: string[];
}

/**
 * ASR Model Configuration for API calls
 */
export interface ASRModelConfig {
  providerId: ASRProviderId;
  apiKey?: string;
  baseUrl?: string;
  language?: string;
}
