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
  { id: 'speech-2.8-turbo', name: 'Speech 2.8 Turbo' },
  { id: 'speech-2.8-hd', name: 'Speech 2.8 HD' },
  { id: 'speech-2.6-turbo', name: 'Speech 2.6 Turbo' },
  { id: 'speech-2.6-hd', name: 'Speech 2.6 HD' },
  { id: 'speech-02-turbo', name: 'Speech 02 Turbo' },
  { id: 'speech-02-hd', name: 'Speech 02 HD' },
  { id: 'speech-01-turbo', name: 'Speech 01 Turbo' },
  { id: 'speech-01-hd', name: 'Speech 01 HD' },
] as const;

export const TTS_PROVIDERS: Record<TTSProviderId, TTSProviderConfig> = {
  'openai-tts': {
    id: 'openai-tts',
    name: 'OpenAI TTS',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    icon: '/logos/openai.svg',
    voices: [
      // Recommended voices (best quality)
      {
        id: 'marin',
        name: 'Marin',
        language: 'en',
        gender: 'neutral',
        description: 'voiceMarin',
      },
      {
        id: 'cedar',
        name: 'Cedar',
        language: 'en',
        gender: 'neutral',
        description: 'voiceCedar',
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
    voices: [
      {
        id: 'zh-CN-XiaoxiaoNeural',
        name: '晓晓 (女)',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh-CN-YunxiNeural',
        name: '云希 (男)',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'zh-CN-XiaoyiNeural',
        name: '晓伊 (女)',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh-CN-YunjianNeural',
        name: '云健 (男)',
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
    voices: [
      {
        id: 'tongtong',
        name: '彤彤',
        language: 'zh',
        gender: 'neutral',
        description: 'glmVoiceTongtong',
      },
      {
        id: 'chuichui',
        name: '锤锤',
        language: 'zh',
        gender: 'neutral',
        description: 'glmVoiceChuichui',
      },
      {
        id: 'xiaochen',
        name: '小陈',
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
        name: '豆几',
        language: 'zh',
        gender: 'neutral',
        description: 'glmVoiceDouji',
      },
      {
        id: 'luodo',
        name: '罗多',
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
    name: 'Qwen TTS (阿里云百炼)',
    requiresApiKey: true,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    icon: '/logos/bailian.svg',
    voices: [
      // Standard Mandarin voices
      {
        id: 'Cherry',
        name: '芊悦 (Cherry)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceCherry',
      },
      {
        id: 'Serena',
        name: '苏瑶 (Serena)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceSerena',
      },
      {
        id: 'Ethan',
        name: '晨煦 (Ethan)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceEthan',
      },
      {
        id: 'Chelsie',
        name: '千雪 (Chelsie)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceChelsie',
      },
      {
        id: 'Momo',
        name: '茉兔 (Momo)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceMomo',
      },
      {
        id: 'Vivian',
        name: '十三 (Vivian)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceVivian',
      },
      {
        id: 'Moon',
        name: '月白 (Moon)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceMoon',
      },
      {
        id: 'Maia',
        name: '四月 (Maia)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceMaia',
      },
      {
        id: 'Kai',
        name: '凯 (Kai)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceKai',
      },
      {
        id: 'Nofish',
        name: '不吃鱼 (Nofish)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceNofish',
      },
      {
        id: 'Bella',
        name: '萌宝 (Bella)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceBella',
      },
      {
        id: 'Jennifer',
        name: '詹妮弗 (Jennifer)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceJennifer',
      },
      {
        id: 'Ryan',
        name: '甜茶 (Ryan)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceRyan',
      },
      {
        id: 'Katerina',
        name: '卡捷琳娜 (Katerina)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceKaterina',
      },
      {
        id: 'Aiden',
        name: '艾登 (Aiden)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceAiden',
      },
      {
        id: 'Eldric Sage',
        name: '沧明子 (Eldric Sage)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceEldricSage',
      },
      {
        id: 'Mia',
        name: '乖小妹 (Mia)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceMia',
      },
      {
        id: 'Mochi',
        name: '沙小弥 (Mochi)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceMochi',
      },
      {
        id: 'Bellona',
        name: '燕铮莺 (Bellona)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceBellona',
      },
      {
        id: 'Vincent',
        name: '田叔 (Vincent)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceVincent',
      },
      {
        id: 'Bunny',
        name: '萌小姬 (Bunny)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceBunny',
      },
      {
        id: 'Neil',
        name: '阿闻 (Neil)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceNeil',
      },
      {
        id: 'Elias',
        name: '墨讲师 (Elias)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceElias',
      },
      {
        id: 'Arthur',
        name: '徐大爷 (Arthur)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceArthur',
      },
      {
        id: 'Nini',
        name: '邻家妹妹 (Nini)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceNini',
      },
      {
        id: 'Ebona',
        name: '诡婆婆 (Ebona)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceEbona',
      },
      {
        id: 'Seren',
        name: '小婉 (Seren)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceSeren',
      },
      {
        id: 'Pip',
        name: '顽屁小孩 (Pip)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoicePip',
      },
      {
        id: 'Stella',
        name: '少女阿月 (Stella)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceStella',
      },
      // International voices
      {
        id: 'Bodega',
        name: '博德加 (Bodega)',
        language: 'es',
        gender: 'male',
        description: 'qwenVoiceBodega',
      },
      {
        id: 'Sonrisa',
        name: '索尼莎 (Sonrisa)',
        language: 'es',
        gender: 'female',
        description: 'qwenVoiceSonrisa',
      },
      {
        id: 'Alek',
        name: '阿列克 (Alek)',
        language: 'ru',
        gender: 'male',
        description: 'qwenVoiceAlek',
      },
      {
        id: 'Dolce',
        name: '多尔切 (Dolce)',
        language: 'it',
        gender: 'male',
        description: 'qwenVoiceDolce',
      },
      {
        id: 'Sohee',
        name: '素熙 (Sohee)',
        language: 'ko',
        gender: 'female',
        description: 'qwenVoiceSohee',
      },
      {
        id: 'Ono Anna',
        name: '小野杏 (Ono Anna)',
        language: 'ja',
        gender: 'female',
        description: 'qwenVoiceOnoAnna',
      },
      {
        id: 'Lenn',
        name: '莱恩 (Lenn)',
        language: 'de',
        gender: 'male',
        description: 'qwenVoiceLenn',
      },
      {
        id: 'Emilien',
        name: '埃米尔安 (Emilien)',
        language: 'fr',
        gender: 'male',
        description: 'qwenVoiceEmilien',
      },
      {
        id: 'Andre',
        name: '安德雷 (Andre)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceAndre',
      },
      {
        id: 'Radio Gol',
        name: '拉迪奥·戈尔 (Radio Gol)',
        language: 'pt',
        gender: 'male',
        description: 'qwenVoiceRadioGol',
      },
      // Dialect voices
      {
        id: 'Jada',
        name: '上海-阿珍 (Jada)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceJada',
      },
      {
        id: 'Dylan',
        name: '北京-晓东 (Dylan)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceDylan',
      },
      {
        id: 'Li',
        name: '南京-老李 (Li)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceLi',
      },
      {
        id: 'Marcus',
        name: '陕西-秦川 (Marcus)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceMarcus',
      },
      {
        id: 'Roy',
        name: '闽南-阿杰 (Roy)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceRoy',
      },
      {
        id: 'Peter',
        name: '天津-李彼得 (Peter)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoicePeter',
      },
      {
        id: 'Sunny',
        name: '四川-晴儿 (Sunny)',
        language: 'zh-CN',
        gender: 'female',
        description: 'qwenVoiceSunny',
      },
      {
        id: 'Eric',
        name: '四川-程川 (Eric)',
        language: 'zh-CN',
        gender: 'male',
        description: 'qwenVoiceEric',
      },
      {
        id: 'Rocky',
        name: '粤语-阿强 (Rocky)',
        language: 'zh-HK',
        gender: 'male',
        description: 'qwenVoiceRocky',
      },
      {
        id: 'Kiki',
        name: '粤语-阿清 (Kiki)',
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
    voices: [
      {
        id: 'Chinese (Mandarin)_Warm_Girl',
        name: '普通话 - Warm Girl',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'Chinese (Mandarin)_Radio_Host',
        name: '普通话 - Radio Host',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'Chinese (Mandarin)_Gentleman',
        name: '普通话 - Gentleman',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'Chinese (Mandarin)_Male_Announcer',
        name: '普通话 - Male Announcer',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'English_expressive_narrator',
        name: 'English - Expressive Narrator',
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
    name: '豆包 TTS 2.0（火山引擎）',
    requiresApiKey: true,
    defaultBaseUrl: 'https://openspeech.bytedance.com/api/v3/tts',
    icon: '/logos/doubao.svg',
    voices: [
      { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0', language: 'zh-CN', gender: 'female' },
      {
        id: 'zh_female_xiaohe_uranus_bigtts',
        name: '小何 2.0',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_male_m191_uranus_bigtts',
        name: '云舟 2.0',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'zh_male_taocheng_uranus_bigtts',
        name: '小天 2.0',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'zh_male_liufei_uranus_bigtts',
        name: '刘飞 2.0',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'zh_female_qingxinnvsheng_uranus_bigtts',
        name: '清新女声 2.0',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_female_cancan_uranus_bigtts',
        name: '知性灿灿 2.0',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_female_shuangkuaisisi_uranus_bigtts',
        name: '爽快思思 2.0',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_female_tianmeixiaoyuan_uranus_bigtts',
        name: '甜美小源 2.0',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_female_linjianvhai_uranus_bigtts',
        name: '邻家女孩 2.0',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_male_shaonianzixin_uranus_bigtts',
        name: '少年梓辛 2.0',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'zh_male_ruyayichen_uranus_bigtts',
        name: '儒雅逸辰 2.0',
        language: 'zh-CN',
        gender: 'male',
      },
      {
        id: 'zh_female_yingyujiaoxue_uranus_bigtts',
        name: 'Tina老师 2.0',
        language: 'zh-CN',
        gender: 'female',
      },
      {
        id: 'zh_female_kefunvsheng_uranus_bigtts',
        name: '暖阳女声 2.0',
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

  'browser-native-tts': {
    id: 'browser-native-tts',
    name: '浏览器原生 (Web Speech API)',
    requiresApiKey: false,
    icon: '/logos/browser.svg',
    voices: [
      // Note: Actual voices are determined by the browser and OS
      // These are placeholder - real voices are fetched dynamically via speechSynthesis.getVoices()
      { id: 'default', name: '默认', language: 'zh-CN', gender: 'neutral' },
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
    name: 'Qwen ASR (阿里云百炼)',
    requiresApiKey: true,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    icon: '/logos/bailian.svg',
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
    name: '浏览器原生 ASR (Web Speech API)',
    requiresApiKey: false,
    icon: '/logos/browser.svg',
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
  'openai-tts': 'alloy',
  'azure-tts': 'zh-CN-XiaoxiaoNeural',
  'glm-tts': 'tongtong',
  'qwen-tts': 'Cherry',
  'doubao-tts': 'zh_female_vv_uranus_bigtts',
  'elevenlabs-tts': 'EXAVITQu4vr4xnSDxMaL',
  'minimax-tts': 'Chinese (Mandarin)_Warm_Girl',
  'browser-native-tts': 'default',
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
