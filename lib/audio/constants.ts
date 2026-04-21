/**
 * Audio Provider Constants
 *
 * Registry of all TTS and ASR providers with their metadata.
 * Separated from tts-providers.ts and asr-providers.ts to avoid importing
 * Node.js libraries (like sharp, buffer) in client components.
 *
 * This file is client-safe and can be imported in both client and server components.
 *
 * To add a new provider:
 * 1. Add the provider ID to TTSProviderId or ASRProviderId in types.ts
 * 2. Add provider configuration to TTS_PROVIDERS or ASR_PROVIDERS below
 * 3. Implement provider logic in tts-providers.ts or asr-providers.ts
 * 4. Add i18n translations in lib/i18n.ts
 *
 * Provider configuration should include:
 * - id: Unique identifier matching the type definition
 * - name: Display name for the provider
 * - requiresApiKey: Whether the provider needs an API key
 * - defaultBaseUrl: Default API endpoint (optional)
 * - icon: Path to provider icon (optional)
 * - models: Available model choices (empty array if no model concept)
 * - defaultModelId: Default model ID (empty string if no models)
 * - voices: Array of available voices (TTS only)
 * - supportedFormats: Audio formats supported by the provider
 * - speedRange: Min/max/default speed settings (TTS only)
 * - supportedLanguages: Languages supported by the provider (ASR only)
 */

import type {
  TTSProviderId,
  TTSProviderConfig,
  TTSVoiceInfo,
  ASRProviderId,
  ASRProviderConfig,
} from './types';

/**
 * TTS Provider Registry
 *
 * Central registry for all TTS providers.
 * Keep in sync with TTSProviderId type definition.
 */
export const MINIMAX_TTS_MODELS = [
  { id: 'speech-2.8-hd', name: 'Speech 2.8 HD' },
  { id: 'speech-2.8-turbo', name: 'Speech 2.8 Turbo' },
  { id: 'speech-2.6-hd', name: 'Speech 2.6 HD' },
  { id: 'speech-2.6-turbo', name: 'Speech 2.6 Turbo' },
  { id: 'speech-02-hd', name: 'Speech 02 HD' },
  { id: 'speech-02-turbo', name: 'Speech 02 Turbo' },
] as const;

export const TTS_PROVIDERS: Record<TTSProviderId, TTSProviderConfig> = {
  'smallest-tts': {
    id: 'smallest-tts',
    name: 'Smallest AI (Waves)',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.smallest.ai/waves/v1/lightning-v3.1/get_speech',
    icon: '/logos/smallest.svg',
    models: [
      { id: 'lightning-v3.1', name: 'Lightning v3.1' },
    ],
    defaultModelId: 'lightning-v3.1',
    voices: [
      { id: 'ethan', name: 'Ethan', language: 'en', gender: 'male' },
      { id: 'sandra', name: 'Sandra', language: 'en', gender: 'female' },
      { id: 'vanessa', name: 'Vanessa', language: 'en', gender: 'female' },
      { id: 'anuja', name: 'Anuja', language: 'en', gender: 'female' }, //Energy
      { id: 'kunal', name: 'Kunal', language: 'en', gender: 'male' }, // Deep
      { id: 'siddharth', name: 'Siddharth', language: 'en', gender: 'male' }, // energy
      { id: 'voice_ZPoOA6GhOT', name: 'Rahil', language: 'en', gender: 'male' },
    ],
    supportedFormats: ['wav'],
    speedRange: { min: 0.5, max: 2.0, default: 1.25 },
  },
  'openai-tts': {
    id: 'openai-tts',
    name: 'OpenAI TTS',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    icon: '/logos/openai.svg',
    models: [
      { id: 'gpt-4o-mini-tts', name: 'GPT-4o Mini TTS' },
      { id: 'tts-1', name: 'TTS-1' },
      { id: 'tts-1-hd', name: 'TTS-1 HD' },
    ],
    defaultModelId: 'gpt-4o-mini-tts',
    voices: [
      // Recommended voices (best quality)
      {
        id: 'marin',
        name: 'Marin',
        language: 'en',
        gender: 'neutral',
        description: 'voiceMarin',
        compatibleModels: ['gpt-4o-mini-tts'],
      },
      {
        id: 'cedar',
        name: 'Cedar',
        language: 'en',
        gender: 'neutral',
        description: 'voiceCedar',
        compatibleModels: ['gpt-4o-mini-tts'],
      },
      // Standard voices (alphabetical)
      {
        id: 'alloy',
        name: 'Alloy',
        language: 'en',
        gender: 'neutral',
        description: 'voiceAlloy',
      },
      {
        id: 'ash',
        name: 'Ash',
        language: 'en',
        gender: 'neutral',
        description: 'voiceAsh',
      },
      {
        id: 'ballad',
        name: 'Ballad',
        language: 'en',
        gender: 'neutral',
        description: 'voiceBallad',
      },
      {
        id: 'coral',
        name: 'Coral',
        language: 'en',
        gender: 'neutral',
        description: 'voiceCoral',
      },
      {
        id: 'echo',
        name: 'Echo',
        language: 'en',
        gender: 'male',
        description: 'voiceEcho',
      },
      {
        id: 'fable',
        name: 'Fable',
        language: 'en',
        gender: 'neutral',
        description: 'voiceFable',
      },
      {
        id: 'nova',
        name: 'Nova',
        language: 'en',
        gender: 'female',
        description: 'voiceNova',
      },
      {
        id: 'onyx',
        name: 'Onyx',
        language: 'en',
        gender: 'male',
        description: 'voiceOnyx',
      },
      {
        id: 'sage',
        name: 'Sage',
        language: 'en',
        gender: 'neutral',
        description: 'voiceSage',
      },
      {
        id: 'shimmer',
        name: 'Shimmer',
        language: 'en',
        gender: 'female',
        description: 'voiceShimmer',
      },
      {
        id: 'verse',
        name: 'Verse',
        language: 'en',
        gender: 'neutral',
        description: 'voiceVerse',
      },
    ],
    supportedFormats: ['mp3', 'opus', 'aac', 'flac'],
    speedRange: { min: 0.25, max: 4.0, default: 1.0 },
  },

  'azure-tts': {
    id: 'azure-tts',
    name: 'Azure TTS',
    requiresApiKey: true,
    defaultBaseUrl: 'https://{region}.tts.speech.microsoft.com',
    icon: '/logos/azure.svg',
    models: [],
    defaultModelId: '',
    voices: [
      {
        id: 'zh-CN-XiaoxiaoNeural',
        name: 'Xiaoxiao (Female)',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh-CN-YunxiNeural',
        name: 'Yunxi (Male)',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'zh-CN-XiaoyiNeural',
        name: 'Xiaoyi (Female)',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh-CN-YunjianNeural',
        name: 'Yunjian (Male)',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'en-US-JennyNeural',
        name: 'Jenny',
        language: 'en-US',
        gender: 'female',
      },
      { id: 'en-US-GuyNeural', name: 'Guy', language: 'en-US', gender: 'male' },
    ],
    supportedFormats: ['mp3', 'wav', 'ogg'],
    speedRange: { min: 0.5, max: 2.0, default: 1.0 },
  },

  'glm-tts': {
    id: 'glm-tts',
    name: 'GLM TTS',
    requiresApiKey: true,
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    icon: '/logos/glm.svg',
    models: [{ id: 'glm-tts', name: 'GLM TTS' }],
    defaultModelId: 'glm-tts',
    voices: [
      {
        id: 'tongtong',
        name: 'Tongtong',
        language: 'zh',
        gender: 'neutral',
        description: 'glmVoiceTongtong',
      },
      {
        id: 'chuichui',
        name: 'Chuichui',
        language: 'zh',
        gender: 'neutral',
        description: 'glmVoiceChuichui',
      },
      {
        id: 'xiaochen',
        name: 'Xiaochen',
        language: 'zh',
        gender: 'neutral',
        description: 'glmVoiceXiaochen',
      },
      {
        id: 'jam',
        name: 'Jam',
        language: 'zh',
        gender: 'neutral',
        description: 'glmVoiceJam',
      },
      {
        id: 'kazi',
        name: 'Kazi',
        language: 'zh',
        gender: 'neutral',
        description: 'glmVoiceKazi',
      },
      {
        id: 'douji',
        name: 'Douji',
        language: 'zh',
        gender: 'neutral',
        description: 'glmVoiceDouji',
      },
      {
        id: 'luodo',
        name: 'Luodo',
        language: 'zh',
        gender: 'neutral',
        description: 'glmVoiceLuodo',
      },
    ],
    supportedFormats: ['wav'],
    speedRange: { min: 0.5, max: 2.0, default: 1.0 },
  },

  'qwen-tts': {
    id: 'qwen-tts',
    name: 'Qwen TTS (Alibaba Cloud Bailian)',
    requiresApiKey: true,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    icon: '/logos/bailian.svg',
    models: [
      { id: 'qwen3-tts-flash', name: 'Qwen3 TTS Flash' },
      { id: 'qwen3-tts-instruct-flash', name: 'Qwen3 TTS Instruct Flash' },
      { id: 'qwen-tts', name: 'Qwen TTS' },
    ],
    defaultModelId: 'qwen3-tts-flash',
    voices: [
      // Standard Mandarin voices
      {
        id: 'Cherry',
        name: 'Cherry',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceCherry',
      },
      {
        id: 'Serena',
        name: 'Serena',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceSerena',
      },
      {
        id: 'Ethan',
        name: 'Ethan',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceEthan',
      },
      {
        id: 'Chelsie',
        name: 'Chelsie',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceChelsie',
      },
      {
        id: 'Momo',
        name: 'Momo',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceMomo',
      },
      {
        id: 'Vivian',
        name: 'Vivian',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceVivian',
      },
      {
        id: 'Moon',
        name: 'Moon',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceMoon',
      },
      {
        id: 'Maia',
        name: 'Maia',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceMaia',
      },
      {
        id: 'Kai',
        name: 'Kai',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceKai',
      },
      {
        id: 'Nofish',
        name: 'Nofish',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceNofish',
      },
      {
        id: 'Bella',
        name: 'Bella',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceBella',
      },
      {
        id: 'Jennifer',
        name: 'Jennifer',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceJennifer',
      },
      {
        id: 'Ryan',
        name: 'Ryan',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceRyan',
      },
      {
        id: 'Katerina',
        name: 'Katerina',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceKaterina',
      },
      {
        id: 'Aiden',
        name: 'Aiden',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceAiden',
      },
      {
        id: 'Eldric Sage',
        name: 'Eldric Sage',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceEldricSage',
      },
      {
        id: 'Mia',
        name: 'Mia',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceMia',
      },
      {
        id: 'Mochi',
        name: 'Mochi',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceMochi',
      },
      {
        id: 'Bellona',
        name: 'Bellona',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceBellona',
      },
      {
        id: 'Vincent',
        name: 'Vincent',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceVincent',
      },
      {
        id: 'Bunny',
        name: 'Bunny',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceBunny',
      },
      {
        id: 'Neil',
        name: 'Neil',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceNeil',
      },
      {
        id: 'Elias',
        name: 'Elias',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceElias',
      },
      {
        id: 'Arthur',
        name: 'Arthur',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceArthur',
      },
      {
        id: 'Nini',
        name: 'Nini',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceNini',
      },
      {
        id: 'Ebona',
        name: 'Ebona',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceEbona',
      },
      {
        id: 'Seren',
        name: 'Seren',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceSeren',
      },
      {
        id: 'Pip',
        name: 'Pip',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoicePip',
      },
      {
        id: 'Stella',
        name: 'Stella',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceStella',
      },
      // International voices
      {
        id: 'Bodega',
        name: 'Bodega',
        language: 'es',
        gender: 'male',
        description: 'qwenVoiceBodega',
      },
      {
        id: 'Sonrisa',
        name: 'Sonrisa',
        language: 'es',
        gender: 'female',
        description: 'qwenVoiceSonrisa',
      },
      {
        id: 'Alek',
        name: 'Alek',
        language: 'ru',
        gender: 'male',
        description: 'qwenVoiceAlek',
      },
      {
        id: 'Dolce',
        name: 'Dolce',
        language: 'it',
        gender: 'male',
        description: 'qwenVoiceDolce',
      },
      {
        id: 'Sohee',
        name: 'Sohee',
        language: 'ko',
        gender: 'female',
        description: 'qwenVoiceSohee',
      },
      {
        id: 'Ono Anna',
        name: 'Ono Anna',
        language: 'ja',
        gender: 'female',
        description: 'qwenVoiceOnoAnna',
      },
      {
        id: 'Lenn',
        name: 'Lenn',
        language: 'de',
        gender: 'male',
        description: 'qwenVoiceLenn',
      },
      {
        id: 'Emilien',
        name: 'Emilien',
        language: 'fr',
        gender: 'male',
        description: 'qwenVoiceEmilien',
      },
      {
        id: 'Andre',
        name: 'Andre',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceAndre',
      },
      {
        id: 'Radio Gol',
        name: 'Radio Gol',
        language: 'pt',
        gender: 'male',
        description: 'qwenVoiceRadioGol',
      },
      // Dialect voices
      {
        id: 'Jada',
        name: 'Jada',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceJada',
      },
      {
        id: 'Dylan',
        name: 'Dylan',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceDylan',
      },
      {
        id: 'Li',
        name: 'Li',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceLi',
      },
      {
        id: 'Marcus',
        name: 'Marcus',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceMarcus',
      },
      {
        id: 'Roy',
        name: 'Roy',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceRoy',
      },
      {
        id: 'Peter',
        name: 'Peter',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoicePeter',
      },
      {
        id: 'Sunny',
        name: 'Sunny',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceSunny',
      },
      {
        id: 'Eric',
        name: 'Eric',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceEric',
      },
      {
        id: 'Rocky',
        name: 'Rocky',
        language: 'zh-HK',
        gender: 'male',
        description: 'qwenVoiceRocky',
      },
      {
        id: 'Kiki',
        name: 'Kiki',
        language: 'zh-HK',
        gender: 'female',
        description: 'qwenVoiceKiki',
      },
    ],
    supportedFormats: ['mp3', 'wav', 'pcm'],
  },

  'minimax-tts': {
    id: 'minimax-tts',
    name: 'MiniMax TTS',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.minimaxi.com',
    icon: '/logos/minimax.svg',
    models: MINIMAX_TTS_MODELS.map((m) => ({ id: m.id, name: m.name })),
    defaultModelId: 'speech-2.8-hd',
    voices: [
      // Common Chinese voices
      {
        id: 'female-yujie',
        name: 'female-yujie',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'male-qn-jingying',
        name: 'male-qn-jingying',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'female-shaonv',
        name: 'female-shaonv',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'Chinese (Mandarin)_Gentleman',
        name: 'Chinese (Mandarin)_Gentleman',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'Chinese (Mandarin)_News_Anchor',
        name: 'Chinese (Mandarin)_News_Anchor',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'Chinese (Mandarin)_Warm_Girl',
        name: 'Chinese (Mandarin)_Warm_Girl',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'Chinese (Mandarin)_Radio_Host',
        name: 'Chinese (Mandarin)_Radio_Host',
        language: 'zh-CN',
        gender: 'male',
      },
      // English
      {
        id: 'English_Trustworthy_Man',
        name: 'Trustworthy Man',
        language: 'en-US',
        gender: 'male',
      },
      {
        id: 'English_Graceful_Lady',
        name: 'Graceful Lady',
        language: 'en-US',
        gender: 'female',
      },
      {
        id: 'English_expressive_narrator',
        name: 'Expressive Narrator',
        language: 'en-US',
        gender: 'neutral',
      },
    ],
    supportedFormats: ['mp3', 'wav', 'flac', 'pcm'],
    speedRange: {
      min: 0.5,
      max: 2.0,
      default: 1.0,
    },
  },

  'doubao-tts': {
    id: 'doubao-tts',
    name: 'Doubao TTS 2.0 (Volcengine)',
    requiresApiKey: true,
    defaultBaseUrl: 'https://openspeech.bytedance.com/api/v3/tts',
    icon: '/logos/doubao.svg',
    models: [],
    defaultModelId: '',
    voices: [
      { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0', language: 'zh-CN', gender: 'female' },
      {
        id: 'zh_female_xiaohe_uranus_bigtts',
        name: 'Xiaohe 2.0',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_male_m191_uranus_bigtts',
        name: 'Yunzhou 2.0',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'zh_male_taocheng_uranus_bigtts',
        name: 'Xiaotian 2.0',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'zh_male_liufei_uranus_bigtts',
        name: 'Liufei 2.0',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'zh_female_qingxinnvsheng_uranus_bigtts',
        name: 'zh_female_qingxinnvsheng_uranus_bigtts',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_female_cancan_uranus_bigtts',
        name: 'zh_female_cancan_uranus_bigtts',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_female_shuangkuaisisi_uranus_bigtts',
        name: 'zh_female_shuangkuaisisi_uranus_bigtts',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_female_tianmeixiaoyuan_uranus_bigtts',
        name: 'zh_female_tianmeixiaoyuan_uranus_bigtts',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_female_linjianvhai_uranus_bigtts',
        name: 'zh_female_linjianvhai_uranus_bigtts',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_male_shaonianzixin_uranus_bigtts',
        name: 'zh_male_shaonianzixin_uranus_bigtts',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'zh_male_ruyayichen_uranus_bigtts',
        name: 'zh_male_ruyayichen_uranus_bigtts',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'zh_female_yingyujiaoxue_uranus_bigtts',
        name: 'Tina 2.0',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_female_kefunvsheng_uranus_bigtts',
        name: 'zh_female_kefunvsheng_uranus_bigtts',
        language: 'zh-CN',
        gender: 'female',
      },
      { id: 'en_male_tim_uranus_bigtts', name: 'Tim', language: 'en-US', gender: 'male' },
      { id: 'en_female_dacey_uranus_bigtts', name: 'Dacey', language: 'en-US', gender: 'female' },
      {
        id: 'en_female_stokie_uranus_bigtts',
        name: 'Stokie',
        language: 'en-US',
        gender: 'female',
      },
    ],
    supportedFormats: ['mp3'],
    speedRange: { min: 0.5, max: 2.0, default: 1.0 },
  },
  'elevenlabs-tts': {
    id: 'elevenlabs-tts',
    name: 'ElevenLabs TTS',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.elevenlabs.io/v1',
    icon: '/logos/elevenlabs.svg',
    models: [
      { id: 'eleven_multilingual_v2', name: 'Multilingual v2' },
      { id: 'eleven_flash_v2_5', name: 'Flash v2.5' },
      { id: 'eleven_flash_v2', name: 'Flash v2' },
    ],
    defaultModelId: 'eleven_multilingual_v2',
    // Free-tier-safe fallback set; account-specific/custom voices should come from /v2/voices dynamically later.
    voices: [
      {
        id: 'EXAVITQu4vr4xnSDxMaL',
        name: 'Sarah',
        language: 'en-US',
        gender: 'female',
        description: 'Confident and warm professional voice for clear narration',
      },
      {
        id: 'Xb7hH8MSUJpSbSDYk0k2',
        name: 'Alice',
        language: 'en-GB',
        gender: 'female',
        description: 'Clear and engaging British educator voice for e-learning',
      },
      {
        id: 'XrExE9yKIg1WjnnlVkGX',
        name: 'Matilda',
        language: 'en-US',
        gender: 'female',
        description: 'Knowledgeable and upbeat voice suited for lectures',
      },
      {
        id: 'CwhRBWXzGAHq8TQ4Fs17',
        name: 'Roger',
        language: 'en-US',
        gender: 'male',
        description: 'Laid-back but resonant male voice for friendly lessons',
      },
      {
        id: 'cjVigY5qzO86Huf0OWal',
        name: 'Eric',
        language: 'en-US',
        gender: 'male',
        description: 'Smooth and trustworthy voice for polished classroom audio',
      },
      {
        id: 'onwK4e9ZLuTAKqWW03F9',
        name: 'Daniel',
        language: 'en-GB',
        gender: 'male',
        description: 'Steady British broadcaster voice for formal explanations',
      },
      {
        id: 'SAz9YHcvj6GT2YYXdXww',
        name: 'River',
        language: 'en-US',
        gender: 'neutral',
        description: 'Relaxed and informative neutral voice for general narration',
      },
    ],
    supportedFormats: ['mp3', 'opus', 'pcm', 'wav', 'ulaw', 'alaw'],
    speedRange: { min: 0.7, max: 1.2, default: 1.0 },
  },

  'hf-tts': {
    id: 'hf-tts',
    name: 'HuggingFace (Kokoro-82M)',
    requiresApiKey: true,
    icon: '/logos/huggingface.svg',
    models: [{ id: 'hexgrad/Kokoro-82M', name: 'Kokoro 82M' }],
    defaultModelId: 'hexgrad/Kokoro-82M',
    voices: [
      // US Male narration
      { id: 'am_michael', name: 'Michael (US Male)', language: 'en-US', gender: 'male', description: 'Warm US male narrator' },
      { id: 'am_adam', name: 'Adam (US Male)', language: 'en-US', gender: 'male', description: 'Deep US male narrator' },
      // US Female narration
      { id: 'af_heart', name: 'Heart (US Female)', language: 'en-US', gender: 'female', description: 'Expressive US female narrator' },
      { id: 'af_bella', name: 'Bella (US Female)', language: 'en-US', gender: 'female', description: 'Clear US female narrator' },
    ],
    supportedFormats: ['mp3', 'wav'],
    speedRange: { min: 0.5, max: 2.0, default: 1.0 },
  },

  'browser-native-tts': {
    id: 'browser-native-tts',
    name: 'Browser Native (Web Speech API)',
    requiresApiKey: false,
    icon: '/logos/browser.svg',
    models: [],
    defaultModelId: '',
    voices: [
      // Note: Actual voices are determined by the browser and OS
      // These are placeholder - real voices are fetched dynamically via speechSynthesis.getVoices()
      { id: 'default', name: 'Default', language: 'en-US', gender: 'neutral' },
    ],
    supportedFormats: ['browser'], // Browser native audio
    speedRange: { min: 0.1, max: 10.0, default: 1.0 },
  },
};

/**
 * ASR Provider Registry
 *
 * Central registry for all ASR providers.
 * Keep in sync with ASRProviderId type definition.
 */
export const ASR_PROVIDERS: Record<ASRProviderId, ASRProviderConfig> = {
  'openai-whisper': {
    id: 'openai-whisper',
    name: 'OpenAI Whisper',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    icon: '/logos/openai.svg',
    models: [
      { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o Mini (Transcribe)' },
      { id: 'whisper-1', name: 'Whisper-1' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Experimental)' },
      { id: 'gpt-4o', name: 'GPT-4o (Experimental)' },
    ],
    defaultModelId: 'gpt-4o-mini-transcribe',
    supportedLanguages: [
      // OpenAI Whisper supports 58 languages (as of official docs)
      // Source: https://platform.openai.com/docs/guides/speech-to-text
      'auto', // Auto-detect
      // Hot languages (commonly used)
      'zh', // Chinese
      'en', // English
      'ja', // Japanese
      'ko', // Korean
      'es', // Spanish
      'fr', // French
      'de', // German
      'ru', // Russian
      'ar', // Arabic
      'pt', // Portuguese
      'it', // Italian
      'hi', // Hindi
      // Other languages (alphabetical)
      'af', // Afrikaans
      'hy', // Armenian
      'az', // Azerbaijani
      'be', // Belarusian
      'bs', // Bosnian
      'bg', // Bulgarian
      'ca', // Catalan
      'hr', // Croatian
      'cs', // Czech
      'da', // Danish
      'nl', // Dutch
      'et', // Estonian
      'fi', // Finnish
      'gl', // Galician
      'el', // Greek
      'he', // Hebrew
      'hu', // Hungarian
      'is', // Icelandic
      'id', // Indonesian
      'kn', // Kannada
      'kk', // Kazakh
      'lv', // Latvian
      'lt', // Lithuanian
      'mk', // Macedonian
      'ms', // Malay
      'mr', // Marathi
      'mi', // Maori
      'ne', // Nepali
      'no', // Norwegian
      'fa', // Persian
      'pl', // Polish
      'ro', // Romanian
      'sr', // Serbian
      'sk', // Slovak
      'sl', // Slovenian
      'sw', // Swahili
      'sv', // Swedish
      'tl', // Tagalog
      'ta', // Tamil
      'th', // Thai
      'tr', // Turkish
      'uk', // Ukrainian
      'ur', // Urdu
      'vi', // Vietnamese
      'cy', // Welsh
    ],
    supportedFormats: ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'],
  },

  'qwen-asr': {
    id: 'qwen-asr',
    name: 'Qwen ASR (Alibaba Cloud Bailian)',
    requiresApiKey: true,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    icon: '/logos/bailian.svg',
    models: [{ id: 'qwen3-asr-flash', name: 'Qwen3 ASR Flash' }],
    defaultModelId: 'qwen3-asr-flash',
    supportedLanguages: [
      // Qwen ASR supports 27 languages + auto-detect
      // If language is uncertain or mixed (e.g. Chinese-English-Japanese-Korean), use "auto" (do not specify language parameter)
      'auto', // Auto-detect (do not specify language parameter)
      // Hot languages (commonly used)
      'zh', // Chinese (Mandarin, Sichuanese, Minnan, Wu dialects)
      'yue', // Cantonese
      'en', // English
      'ja', // Japanese
      'ko', // Korean
      'de', // German
      'fr', // French
      'ru', // Russian
      'es', // Spanish
      'pt', // Portuguese
      'ar', // Arabic
      'it', // Italian
      'hi', // Hindi
      // Other languages (alphabetical)
      'cs', // Czech
      'da', // Danish
      'fi', // Finnish
      'fil', // Filipino
      'id', // Indonesian
      'is', // Icelandic
      'ms', // Malay
      'no', // Norwegian
      'pl', // Polish
      'sv', // Swedish
      'th', // Thai
      'tr', // Turkish
      'uk', // Ukrainian
      'vi', // Vietnamese
    ],
    supportedFormats: ['mp3', 'wav', 'webm', 'm4a', 'flac'],
  },

  'browser-native': {
    id: 'browser-native',
    name: 'Browser Native ASR (Web Speech API)',
    requiresApiKey: false,
    icon: '/logos/browser.svg',
    models: [],
    defaultModelId: '',
    supportedLanguages: [
      // Chinese variants
      'zh-CN', // Mandarin (Simplified, China)
      'zh-TW', // Mandarin (Traditional, Taiwan)
      'zh-HK', // Cantonese (Hong Kong)
      'yue-Hant-HK', // Cantonese (Traditional)
      // English variants
      'en-US', // English (United States)
      'en-GB', // English (United Kingdom)
      'en-AU', // English (Australia)
      'en-CA', // English (Canada)
      'en-IN', // English (India)
      'en-NZ', // English (New Zealand)
      'en-ZA', // English (South Africa)
      // Japanese & Korean
      'ja-JP', // Japanese (Japan)
      'ko-KR', // Korean (South Korea)
      // European languages
      'de-DE', // German (Germany)
      'fr-FR', // French (France)
      'es-ES', // Spanish (Spain)
      'es-MX', // Spanish (Mexico)
      'es-AR', // Spanish (Argentina)
      'es-CO', // Spanish (Colombia)
      'it-IT', // Italian (Italy)
      'pt-BR', // Portuguese (Brazil)
      'pt-PT', // Portuguese (Portugal)
      'ru-RU', // Russian (Russia)
      'nl-NL', // Dutch (Netherlands)
      'pl-PL', // Polish (Poland)
      'cs-CZ', // Czech (Czech Republic)
      'da-DK', // Danish (Denmark)
      'fi-FI', // Finnish (Finland)
      'sv-SE', // Swedish (Sweden)
      'no-NO', // Norwegian (Norway)
      'tr-TR', // Turkish (Turkey)
      'el-GR', // Greek (Greece)
      'hu-HU', // Hungarian (Hungary)
      'ro-RO', // Romanian (Romania)
      'sk-SK', // Slovak (Slovakia)
      'bg-BG', // Bulgarian (Bulgaria)
      'hr-HR', // Croatian (Croatia)
      'ca-ES', // Catalan (Spain)
      // Middle East & Asia
      'ar-SA', // Arabic (Saudi Arabia)
      'ar-EG', // Arabic (Egypt)
      'he-IL', // Hebrew (Israel)
      'hi-IN', // Hindi (India)
      'th-TH', // Thai (Thailand)
      'vi-VN', // Vietnamese (Vietnam)
      'id-ID', // Indonesian (Indonesia)
      'ms-MY', // Malay (Malaysia)
      'fil-PH', // Filipino (Philippines)
      // Other
      'af-ZA', // Afrikaans (South Africa)
      'uk-UA', // Ukrainian (Ukraine)
    ],
    supportedFormats: ['webm'], // MediaRecorder format
  },
};

/**
 * Get all available TTS providers
 */
export function getAllTTSProviders(): TTSProviderConfig[] {
  return Object.values(TTS_PROVIDERS);
}

/**
 * Get TTS provider by ID
 */
export function getTTSProvider(providerId: TTSProviderId): TTSProviderConfig | undefined {
  return TTS_PROVIDERS[providerId];
}

/**
 * Default voice for each TTS provider.
 * Used when switching providers or testing a non-active provider.
 */
export const DEFAULT_TTS_VOICES: Record<TTSProviderId, string> = {
  'smallest-tts': 'ethan',
  'openai-tts': 'alloy',
  'azure-tts': 'zh-CN-XiaoxiaoNeural',
  'glm-tts': 'tongtong',
  'qwen-tts': 'Cherry',
  'doubao-tts': 'zh_female_vv_uranus_bigtts',
  'elevenlabs-tts': 'EXAVITQu4vr4xnSDxMaL',
  'minimax-tts': 'female-yujie',
  'hf-tts': 'am_adam',
  'browser-native-tts': 'default',
};

export const DEFAULT_TTS_MODELS: Record<TTSProviderId, string> = {
  'smallest-tts': 'lightning-v3.1',
  'openai-tts': 'gpt-4o-mini-tts',
  'azure-tts': '',
  'glm-tts': 'glm-tts',
  'qwen-tts': 'qwen3-tts-flash',
  'doubao-tts': '',
  'elevenlabs-tts': 'eleven_multilingual_v2',
  'minimax-tts': 'speech-2.8-hd',
  'hf-tts': 'hexgrad/Kokoro-82M',
  'browser-native-tts': '',
};

/**
 * Get voices for a specific TTS provider
 */
export function getTTSVoices(providerId: TTSProviderId): TTSVoiceInfo[] {
  return TTS_PROVIDERS[providerId]?.voices || [];
}

/**
 * Get all available ASR providers
 */
export function getAllASRProviders(): ASRProviderConfig[] {
  return Object.values(ASR_PROVIDERS);
}

/**
 * Get ASR provider by ID
 */
export function getASRProvider(providerId: ASRProviderId): ASRProviderConfig | undefined {
  return ASR_PROVIDERS[providerId];
}

/**
 * Get supported languages for a specific ASR provider
 */
export function getASRSupportedLanguages(providerId: ASRProviderId): string[] {
  return ASR_PROVIDERS[providerId]?.supportedLanguages || [];
}
