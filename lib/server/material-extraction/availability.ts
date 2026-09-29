import {
  getDocumentExtractorProviders,
  getMediaExtractorProviders,
  type DocumentExtractorProvider,
  type MediaExtractorProvider,
} from '@/lib/document';
import {
  getServerPDFProviders,
  resolveServerMediaExtractorConfig,
} from '@/lib/server/provider-config';

export interface ExtractorAvailabilityDependencies {
  providers?: () => DocumentExtractorProvider[];
  mediaProviders?: () => MediaExtractorProvider[];
  configuredProviderIds?: () => string[];
}

/**
 * The MIME types this server can extract text from with its own configuration:
 * a document extractor counts when it is self-contained or the operator
 * configured its service, a media extractor when its own `availability` check
 * passes against the server media configuration (the same check extraction
 * runs). This is the single answer to "can this upload be used as a source
 * document here", for both what is advertised and what is accepted.
 */
export async function resolveExtractableMimeTypes(
  dependencies: ExtractorAvailabilityDependencies = {},
): Promise<Set<string>> {
  const configured = new Set(
    dependencies.configuredProviderIds?.() ?? Object.keys(getServerPDFProviders()),
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
    config: resolveServerMediaExtractorConfig(),
  };
  for (const provider of dependencies.mediaProviders?.() ?? getMediaExtractorProviders()) {
    const availability = await provider.availability?.(mediaInput);
    if (!availability || availability.available) add(provider.supportedMimeTypes);
  }
  return mimes;
}
