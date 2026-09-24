import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';

/**
 * i18n key suffixes for media provider display names — shared by the 模型服务
 * service list and the 课程模型配置 media pickers so both show the same
 * localized name. Lives in its own module to avoid an import cycle between
 * the settings index and the course-model-config panel.
 */
export const IMAGE_PROVIDER_NAMES: Record<ImageProviderId, string> = {
  seedream: 'providerSeedream',
  'openai-image': 'providerOpenAIImage',
  'qwen-image': 'providerQwenImage',
  'nano-banana': 'providerNanoBanana',
  'minimax-image': 'providerMiniMaxImage',
  'grok-image': 'providerGrokImage',
  'comfyui-image': 'providerComfyUIImage',
  'openrouter-image': 'providerOpenRouterImage',
  lemonade: 'providerLemonadeImage',
};

export const VIDEO_PROVIDER_NAMES: Record<VideoProviderId, string> = {
  seedance: 'providerSeedance',
  kling: 'providerKling',
  veo: 'providerVeo',
  'minimax-video': 'providerMiniMaxVideo',
  'grok-video': 'providerGrokVideo',
  'openrouter-video': 'providerOpenRouterVideo',
  happyhorse: 'providerHappyHorse',
};
