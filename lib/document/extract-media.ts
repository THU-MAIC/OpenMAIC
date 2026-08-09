import { selectMediaExtractorProvider } from './extractors/media-registry';
import type { MediaArtifact, MediaExtractorInput } from './types';

export async function extractMedia(input: MediaExtractorInput): Promise<MediaArtifact> {
  const provider = selectMediaExtractorProvider({
    mimeType: input.mimeType,
    preferredProviderId: input.config.providerId,
  });

  return provider.extract(input);
}
