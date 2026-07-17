import { mediaBackedExtractorProviders } from './media';
import type { MediaExtractorProvider, MediaExtractorProviderId } from '../types';

const MEDIA_EXTRACTOR_PROVIDERS: Record<MediaExtractorProviderId, MediaExtractorProvider> =
  Object.fromEntries(mediaBackedExtractorProviders.map((p) => [p.id, p]));

export function getMediaExtractorProviders(): MediaExtractorProvider[] {
  return Object.values(MEDIA_EXTRACTOR_PROVIDERS);
}

export function getMediaExtractorProvider(
  providerId: MediaExtractorProviderId,
): MediaExtractorProvider | undefined {
  return MEDIA_EXTRACTOR_PROVIDERS[providerId];
}

export function selectMediaExtractorProvider(options: {
  mimeType: string;
  preferredProviderId?: MediaExtractorProviderId;
  requiredCapabilities?: Partial<MediaExtractorProvider['capabilities']>;
}): MediaExtractorProvider {
  const normalizedMimeType = options.mimeType.toLowerCase();
  const supportsRequest = (provider: MediaExtractorProvider) =>
    provider.supportedMimeTypes.includes(normalizedMimeType) &&
    Object.entries(options.requiredCapabilities ?? {}).every(
      ([capability, required]) =>
        !required ||
        provider.capabilities[capability as keyof MediaExtractorProvider['capabilities']],
    );

  if (options.preferredProviderId) {
    const preferred = getMediaExtractorProvider(options.preferredProviderId);
    if (!preferred) {
      throw new Error(`Unknown media extractor provider: ${options.preferredProviderId}`);
    }
    if (!supportsRequest(preferred)) {
      throw new Error(
        `Media extractor "${preferred.id}" does not support MIME type "${options.mimeType}" with the requested capabilities`,
      );
    }
    return preferred;
  }

  const provider = getMediaExtractorProviders().find(supportsRequest);
  if (!provider) {
    throw new Error(
      `No media extractor supports MIME type "${options.mimeType}" with the requested capabilities`,
    );
  }
  return provider;
}
