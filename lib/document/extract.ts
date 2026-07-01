import { selectDocumentExtractorProvider } from './extractors/registry';
import type { DocumentArtifact, DocumentExtractorInput } from './types';

export async function extractDocument(input: DocumentExtractorInput): Promise<DocumentArtifact> {
  const provider = selectDocumentExtractorProvider({
    mimeType: input.mimeType,
    preferredProviderId: input.config.providerId,
  });

  return provider.extract(input);
}
