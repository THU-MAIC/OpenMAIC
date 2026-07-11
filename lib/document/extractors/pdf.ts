import { parseWithMinerUCloud } from '@/lib/pdf/mineru-cloud';
import { parsePDF, parseWithMinerUDocument } from '@/lib/pdf/pdf-providers';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderConfig, PDFProviderId } from '@/lib/pdf/types';
import { DOCUMENT_MIME_TYPES, MINERU_CLOUD_MIMES, MINERU_SELFHOST_MIMES } from '../mime';
import { parsedPdfToDocumentArtifact } from '../pdf-compat';
import type {
  DocumentExtractorCapabilities,
  DocumentExtractorInput,
  DocumentExtractorProvider,
} from '../types';

const PDF_MIME_TYPES = [DOCUMENT_MIME_TYPES.pdf];

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
    supportedMimeTypes:
      id === 'mineru'
        ? MINERU_SELFHOST_MIMES
        : id === 'mineru-cloud'
          ? MINERU_CLOUD_MIMES
          : PDF_MIME_TYPES,
    capabilities: capabilitiesFromPdfProvider(pdfProvider, id),
    async extract(input: DocumentExtractorInput) {
      const config = {
        providerId: id,
        apiKey: input.config.apiKey,
        baseUrl: input.config.baseUrl,
      };
      const parsed =
        id === 'mineru-cloud'
          ? await parseWithMinerUCloud(config, input.buffer, input.fileName)
          : input.mimeType === DOCUMENT_MIME_TYPES.pdf
            ? await parsePDF(config, input.buffer)
            : await parseWithMinerUDocument(config, input.buffer, {
                fileName: input.fileName || 'document',
                mimeType: input.mimeType,
              });

      return parsedPdfToDocumentArtifact(parsed, input);
    },
  };
}

export const pdfDocumentExtractorProviders: DocumentExtractorProvider[] = Object.keys(
  PDF_PROVIDERS,
).map((id) => createPdfBackedDocumentExtractor(id as PDFProviderId));
