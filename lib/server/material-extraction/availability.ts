import {
  getDocumentExtractorProviders,
  getMediaExtractorProviders,
  type DocumentExtractorProvider,
  type MediaExtractorProvider,
} from '@/lib/document';
import {
  mediaExtractorConfig,
  resolveExtractionServices,
  type ExtractionServices,
} from './services';

export interface ExtractorAvailabilityDependencies {
  providers?: () => DocumentExtractorProvider[];
  mediaProviders?: () => MediaExtractorProvider[];
  configuredProviderIds?: () => string[];
  serverASRConfigured?: () => boolean;
  /** The owner's document and speech services; resolved from its slots by default. */
  services?: ExtractionServices;
  /** Whose slots apply when `services` is not given. */
  ownerId?: string;
  /** Whether `ownerId` is a stored owner to follow through a claim; false for a request's own workspace. */
  forward?: boolean;
}

/**
 * The MIME types this server can extract text from with its own configuration:
 * a document extractor counts when it is self-contained or the operator
 * configured its service, a media extractor when its own `availability` check
 * passes against the server media configuration (the same check extraction
 * runs). An extractor that transcribes through a server ASR provider counts
 * for audio only when one is configured; it still counts for video, which it
 * can read without an audio track (a video WITH an audio track then fails at
 * run time). This is the single answer to "can this upload be used as a source
 * document here", for both what is advertised and what is accepted.
 */
export async function resolveExtractableMimeTypes(
  dependencies: ExtractorAvailabilityDependencies = {},
): Promise<Set<string>> {
  const services =
    dependencies.services ??
    (await resolveExtractionServices(dependencies.ownerId, {
      forward: dependencies.forward ?? true,
    }));
  const configured = new Set(
    dependencies.configuredProviderIds?.() ??
      (services.document ? [services.document.providerId] : []),
  );
  const mimes = new Set<string>();
  const add = (supported: readonly string[]) => {
    for (const mime of supported) mimes.add(mime.toLowerCase());
  };

  for (const provider of dependencies.providers?.() ?? getDocumentExtractorProviders()) {
    if (!provider.requiresServiceConfig || configured.has(provider.id)) {
      add(provider.supportedMimeTypes);
    }
  }

  const mediaInput = {
    buffer: Buffer.alloc(0),
    mimeType: '',
    config: mediaExtractorConfig(services),
  };
  const serverASRConfigured = dependencies.serverASRConfigured?.() ?? Boolean(services.asr);
  for (const provider of dependencies.mediaProviders?.() ?? getMediaExtractorProviders()) {
    const availability = await provider.availability?.(mediaInput);
    if (availability && !availability.available) continue;
    add(
      provider.requiresServerASR && !serverASRConfigured
        ? provider.supportedMimeTypes.filter((mime) => !mime.toLowerCase().startsWith('audio/'))
        : provider.supportedMimeTypes,
    );
  }
  return mimes;
}
