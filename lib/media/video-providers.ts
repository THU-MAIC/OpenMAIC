/**
 * Video Generation Service -- routes to provider adapters
 */

import type {
  VideoProviderId,
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
  VideoProviderConfig,
} from './types';
import { generateWithSeedance, testSeedanceConnectivity } from './adapters/seedance-adapter';
import { generateWithKling, testKlingConnectivity } from './adapters/kling-adapter';
import { generateWithVeo, testVeoConnectivity } from './adapters/veo-adapter';
import {
  generateWithMiniMaxVideo,
  testMiniMaxVideoConnectivity,
} from './adapters/minimax-video-adapter';
import { generateWithGrokVideo, testGrokVideoConnectivity } from './adapters/grok-video-adapter';

export const VIDEO_PROVIDERS: Record<VideoProviderId, VideoProviderConfig> = {
  seedance: {
    id: 'seedance',
    name: 'Seedance',
    requiresApiKey: true,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com',
    models: [
      { id: 'doubao-seedance-1-5-pro-251215', name: 'Seedance 1.5 Pro' },
      { id: 'doubao-seedance-1-0-pro-250528', name: 'Seedance 1.0 Pro' },
      {
        id: 'doubao-seedance-1-0-pro-fast-251015',
        name: 'Seedance 1.0 Pro Fast',
      },
      {
        id: 'doubao-seedance-1-0-lite-t2v-250428',
        name: 'Seedance 1.0 Lite T2V',
      },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16', '3:4', '21:9'],
    supportedDurations: [5, 10],
    supportedResolutions: ['480p', '720p', '1080p'],
    maxDuration: 10,
  },
  kling: {
    id: 'kling',
    name: 'Kling',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api-beijing.klingai.com',
    models: [
      { id: 'kling-v2-6', name: 'Kling V2.6' },
      { id: 'kling-v1-6', name: 'Kling V1.6' },
    ],
    supportedAspectRatios: ['16:9', '1:1', '9:16'],
    supportedDurations: [5, 10],
    maxDuration: 10,
  },
  veo: {
    id: 'veo',
    name: 'Veo',
    requiresApiKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    models: [
      { id: 'veo-3.1-fast-generate-001', name: 'Veo 3.1 Fast' },
      { id: 'veo-3.1-generate-001', name: 'Veo 3.1' },
      { id: 'veo-3.0-fast-generate-001', name: 'Veo 3.0 Fast' },
      { id: 'veo-3.0-generate-001', name: 'Veo 3.0' },
      { id: 'veo-2.0-generate-001', name: 'Veo 2.0' },
    ],
    supportedAspectRatios: ['16:9', '1:1', '9:16'],
    supportedDurations: [8],
    supportedResolutions: ['720p'],
    maxDuration: 8,
  },
  sora: {
    id: 'sora',
    name: 'Sora',
    requiresApiKey: true,
    models: [],
    supportedAspectRatios: ['16:9', '1:1', '9:16'],
    maxDuration: 20,
  },
  'minimax-video': {
    id: 'minimax-video',
    name: 'MiniMax Video',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.minimaxi.com',
    models: [
      { id: 'MiniMax-Hailuo-2.3', name: 'Hailuo 2.3' },
      { id: 'MiniMax-Hailuo-2.3-Fast', name: 'Hailuo 2.3 Fast' },
      { id: 'MiniMax-Hailuo-02', name: 'Hailuo 02' },
      { id: 'T2V-01-Director', name: 'T2V-01 Director' },
      { id: 'T2V-01', name: 'T2V-01' },
    ],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
    supportedDurations: [6, 10],
    supportedResolutions: ['720p', '1080p'],
    maxDuration: 10,
  },
  'grok-video': {
    id: 'grok-video',
    name: 'Grok Video (xAI)',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
    models: [{ id: 'grok-imagine-video', name: 'Grok Imagine Video' }],
    supportedAspectRatios: ['16:9', '1:1', '9:16'],
    supportedDurations: [6],
    maxDuration: 6,
  },
};

export async function testVideoConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  switch (config.providerId) {
    case 'seedance':
      return testSeedanceConnectivity(config);
    case 'kling':
      return testKlingConnectivity(config);
    case 'veo':
      return testVeoConnectivity(config);
    case 'minimax-video':
      return testMiniMaxVideoConnectivity(config);
    case 'grok-video':
      return testGrokVideoConnectivity(config);
    default:
      return {
        success: false,
        message: `Unsupported video provider: ${config.providerId}`,
      };
  }
}

/**
 * Normalize video generation options against provider capabilities.
 * Ensures duration, aspectRatio, and resolution are valid for the given provider.
 * Falls back to the first supported value when the requested value is unsupported.
 */
export function normalizeVideoOptions(
  providerId: VideoProviderId,
  options: VideoGenerationOptions,
): VideoGenerationOptions {
  const provider = VIDEO_PROVIDERS[providerId];
  if (!provider) return options;

  const normalized = { ...options };

  // Duration: use first supported value if unset or unsupported
  if (provider.supportedDurations && provider.supportedDurations.length > 0) {
    if (!normalized.duration || !provider.supportedDurations.includes(normalized.duration)) {
      normalized.duration = provider.supportedDurations[0];
    }
  }

  // Aspect ratio: use first supported value if unset or unsupported
  if (provider.supportedAspectRatios && provider.supportedAspectRatios.length > 0) {
    if (
      !normalized.aspectRatio ||
      !provider.supportedAspectRatios.includes(normalized.aspectRatio)
    ) {
      normalized.aspectRatio = provider
        .supportedAspectRatios[0] as VideoGenerationOptions['aspectRatio'];
    }
  }

  // Resolution: use first supported value if unset or unsupported
  if (provider.supportedResolutions && provider.supportedResolutions.length > 0) {
    if (!normalized.resolution || !provider.supportedResolutions.includes(normalized.resolution)) {
      normalized.resolution = provider.supportedResolutions[0];
    }
  }

  return normalized;
}

export async function generateVideo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  switch (config.providerId) {
    case 'seedance':
      return generateWithSeedance(config, options);
    case 'kling':
      return generateWithKling(config, options);
    case 'veo':
      return generateWithVeo(config, options);
    case 'minimax-video':
      return generateWithMiniMaxVideo(config, options);
    case 'grok-video':
      return generateWithGrokVideo(config, options);
    default:
      throw new Error(`Unsupported video provider: ${config.providerId}`);
  }
}
