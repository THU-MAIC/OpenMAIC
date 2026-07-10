import { ALIDOCMIND_MEDIA_MIMES } from '@/lib/document/mime';
import type { MediaParseProviderConfig, MediaParseProviderId } from './types';

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
    // Single source of truth in lib/document/mime.ts so the picker's accept
    // string and this registry can't drift.
    supportedMimeTypes: ALIDOCMIND_MEDIA_MIMES,
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
