import { pdfDocumentExtractorProviders } from './pdf';
import type { DocumentExtractorProvider, DocumentExtractorProviderId } from '../types';

const DOCUMENT_EXTRACTOR_PROVIDERS: Record<DocumentExtractorProviderId, DocumentExtractorProvider> =
  Object.fromEntries(pdfDocumentExtractorProviders.map((provider) => [provider.id, provider]));

export function getDocumentExtractorProviders(): DocumentExtractorProvider[] {
  return Object.values(DOCUMENT_EXTRACTOR_PROVIDERS);
}

export function getDocumentExtractorProvider(
  providerId: DocumentExtractorProviderId,
): DocumentExtractorProvider | undefined {
  return DOCUMENT_EXTRACTOR_PROVIDERS[providerId];
}

export function selectDocumentExtractorProvider(options: {
  mimeType: string;
  preferredProviderId?: DocumentExtractorProviderId;
  requiredCapabilities?: Partial<DocumentExtractorProvider['capabilities']>;
}): DocumentExtractorProvider {
  const normalizedMimeType = options.mimeType.toLowerCase();
  const supportsRequest = (provider: DocumentExtractorProvider) =>
    provider.supportedMimeTypes.includes(normalizedMimeType) &&
    Object.entries(options.requiredCapabilities ?? {}).every(
      ([capability, required]) =>
        !required ||
        provider.capabilities[capability as keyof DocumentExtractorProvider['capabilities']],
    );

  if (options.preferredProviderId) {
    const preferred = getDocumentExtractorProvider(options.preferredProviderId);
    if (!preferred) {
      throw new Error(`Unknown document extractor provider: ${options.preferredProviderId}`);
    }
    if (!supportsRequest(preferred)) {
      throw new Error(
        `Document extractor "${preferred.id}" does not support MIME type "${options.mimeType}" with the requested capabilities`,
      );
    }
    return preferred;
  }

  const provider = getDocumentExtractorProviders().find(supportsRequest);
  if (!provider) {
    throw new Error(
      `No document extractor supports MIME type "${options.mimeType}" with the requested capabilities`,
    );
  }
  return provider;
}
