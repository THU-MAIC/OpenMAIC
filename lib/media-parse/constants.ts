import type { MediaParseProviderConfig, MediaParseProviderId } from './types';

const AUDIO_VIDEO_MIME_TYPES = [
  // Video
  'video/mp4',
  'video/quicktime', // .mov
  'video/x-msvideo', // .avi
  'video/x-matroska', // .mkv
  'video/x-ms-wmv',
  // Audio
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
] as const;

/**
 * Media Parse Provider Registry
 */
export const MEDIA_PARSE_PROVIDERS: Record<MediaParseProviderId, MediaParseProviderConfig> = {
  alidocmind: {
    id: 'alidocmind',
    name: 'AliDocMind',
    requiresApiKey: true,
    icon: '/logos/aliyun.svg',
    features: ['transcript', 'keyframes', 'synopsis', 'ocr'],
    supportedMimeTypes: AUDIO_VIDEO_MIME_TYPES,
  },
};

export function getAllMediaParseProviders(): MediaParseProviderConfig[] {
  return Object.values(MEDIA_PARSE_PROVIDERS);
}

export function getMediaParseProvider(
  providerId: MediaParseProviderId,
): MediaParseProviderConfig | undefined {
  return MEDIA_PARSE_PROVIDERS[providerId];
}
