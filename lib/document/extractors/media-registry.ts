import { mediaBackedExtractorProviders } from './media';
import { localMediaExtractorProvider } from './local-media';
import type {
  MediaExtractorInput,
  MediaExtractorProvider,
  MediaExtractorProviderId,
} from '../types';

const MEDIA_EXTRACTOR_PROVIDERS: Record<MediaExtractorProviderId, MediaExtractorProvider> =
  Object.fromEntries(
    [...mediaBackedExtractorProviders, localMediaExtractorProvider].map((p) => [p.id, p]),
  );

export function getMediaExtractorProviders(): MediaExtractorProvider[] {
  return Object.values(MEDIA_EXTRACTOR_PROVIDERS);
}

export function getMediaExtractorProvider(
  providerId: MediaExtractorProviderId,
): MediaExtractorProvider | undefined {
  return MEDIA_EXTRACTOR_PROVIDERS[providerId];
}

export async function selectMediaExtractorProvider(options: {
  mimeType: string;
  preferredProviderId?: MediaExtractorProviderId;
  requiredCapabilities?: Partial<MediaExtractorProvider['capabilities']>;
  input: MediaExtractorInput;
  providers?: MediaExtractorProvider[];
}): Promise<MediaExtractorProvider> {
  const normalizedMimeType = options.mimeType.toLowerCase();
  const supportsRequest = (provider: MediaExtractorProvider) =>
    provider.supportedMimeTypes.includes(normalizedMimeType) &&
    Object.entries(options.requiredCapabilities ?? {}).every(
      ([capability, required]) =>
        !required ||
        provider.capabilities[capability as keyof MediaExtractorProvider['capabilities']],
    );

  const providers = options.providers ?? getMediaExtractorProviders();
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const availabilityReason = async (provider: MediaExtractorProvider) => {
    const availability = await provider.availability?.(options.input);
    return availability && !availability.available
      ? (availability.reason ?? 'unavailable')
      : undefined;
  };

  if (options.preferredProviderId) {
    const preferred = providerById.get(options.preferredProviderId);
    if (!preferred) {
      throw new Error(`Unknown media extractor provider: ${options.preferredProviderId}`);
    }
    if (!supportsRequest(preferred)) {
      throw new Error(
        `Media extractor "${preferred.id}" does not support MIME type "${options.mimeType}" with the requested capabilities`,
      );
    }
    const reason = await availabilityReason(preferred);
    if (reason) {
      throw new Error(`Media extractor "${preferred.id}" is unavailable: ${reason}`);
    }
    return preferred;
  }

  const supported = providers.filter(supportsRequest);
  for (const provider of supported) {
    if (!(await availabilityReason(provider))) return provider;
  }
  throw new Error(
    `Media extraction is unavailable for "${options.mimeType}". Configure AliDocMind credentials for cloud extraction, or install ffmpeg (including ffprobe) and configure a server ASR provider for local extraction.`,
  );
}
