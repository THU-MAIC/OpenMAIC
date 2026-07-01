import { parsePDF } from '@/lib/pdf/pdf-providers';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderConfig, PDFProviderId } from '@/lib/pdf/types';
import { parsedPdfToDocumentArtifact } from '../pdf-compat';
import type {
  DocumentExtractorCapabilities,
  DocumentExtractorInput,
  DocumentExtractorProvider,
} from '../types';

const PDF_MIME_TYPES = ['application/pdf'];

function capabilitiesFromPdfProvider(
  provider: PDFProviderConfig,
  providerId: PDFProviderId,
): DocumentExtractorCapabilities {
  const features = new Set(provider.features);
  const isMinerU = providerId === 'mineru' || providerId === 'mineru-cloud';
  return {
    text: features.has('text'),
    images: features.has('images'),
    tables: features.has('tables'),
    formulas: features.has('formulas'),
    layout: features.has('layout-analysis'),
    ocr: isMinerU,
    async: providerId === 'mineru-cloud',
  };
}

function createPdfBackedDocumentExtractor(id: PDFProviderId): DocumentExtractorProvider {
  const pdfProvider = PDF_PROVIDERS[id];
  return {
    id,
    displayName: pdfProvider.name,
    supportedMimeTypes: PDF_MIME_TYPES,
    capabilities: capabilitiesFromPdfProvider(pdfProvider, id),
    async extract(input: DocumentExtractorInput) {
      const parsed = await parsePDF(
        {
          providerId: id,
          apiKey: input.config.apiKey,
          baseUrl: input.config.baseUrl,
        },
        input.buffer,
      );

      return parsedPdfToDocumentArtifact(parsed, input);
    },
  };
}

export const pdfDocumentExtractorProviders: DocumentExtractorProvider[] = Object.keys(
  PDF_PROVIDERS,
).map((id) => createPdfBackedDocumentExtractor(id as PDFProviderId));
