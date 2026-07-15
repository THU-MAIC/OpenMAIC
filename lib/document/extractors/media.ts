import { parseMedia } from '@/lib/media-parse';
import { MEDIA_PARSE_PROVIDERS } from '@/lib/media-parse/constants';
import type { MediaParseProviderConfig, MediaParseProviderId } from '@/lib/media-parse/types';
import type {
  MediaExtractorCapabilities,
  MediaExtractorInput,
  MediaExtractorProvider,
} from '../types';

function capabilitiesFromMediaParseProvider(
  provider: MediaParseProviderConfig,
): MediaExtractorCapabilities {
  const features = new Set(provider.features);
  return {
    transcript: features.has('transcript'),
    keyframes: features.has('keyframes'),
    synopsis: features.has('synopsis'),
    ocr: features.has('ocr'),
    async: true,
  };
}

function createMediaBackedExtractor(id: MediaParseProviderId): MediaExtractorProvider {
  const mp = MEDIA_PARSE_PROVIDERS[id];
  return {
    id,
    displayName: mp.name,
    supportedMimeTypes: [...mp.supportedMimeTypes],
    capabilities: capabilitiesFromMediaParseProvider(mp),
    async extract(input: MediaExtractorInput) {
      return parseMedia({
        buffer: input.buffer,
        fileName: input.fileName ?? 'media',
        mimeType: input.mimeType,
        config: {
          providerId: id,
          apiKey: input.config.apiKey,
          baseUrl: input.config.baseUrl,
          accessKeyId: input.config.accessKeyId,
          accessKeySecret: input.config.accessKeySecret,
          allowEnvFallback: input.config.allowEnvFallback,
        },
      });
    },
  };
}

export const mediaBackedExtractorProviders: MediaExtractorProvider[] = Object.keys(
  MEDIA_PARSE_PROVIDERS,
).map((id) => createMediaBackedExtractor(id as MediaParseProviderId));
