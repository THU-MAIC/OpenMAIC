import { parseWithMinerUCloud } from '@/lib/pdf/mineru-cloud';
import { parsePDF, parseWithMinerUDocument } from '@/lib/pdf/pdf-providers';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderConfig, PDFProviderId } from '@/lib/pdf/types';
import {
  ALIDOCMIND_MIMES,
  DOCUMENT_MIME_TYPES,
  MINERU_CLOUD_MIMES,
  MINERU_SELFHOST_MIMES,
} from '../mime';
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
  const isCloudAsync = providerId === 'mineru-cloud' || providerId === 'alidocmind';
  const hasOcr =
    providerId === 'mineru' || providerId === 'mineru-cloud' || providerId === 'alidocmind';
  return {
    text: features.has('text'),
    images: features.has('images'),
    tables: features.has('tables'),
    formulas: features.has('formulas'),
    layout: features.has('layout-analysis'),
    ocr: hasOcr,
    async: isCloudAsync,
  };
}

function supportedMimeTypesForProvider(id: PDFProviderId): readonly string[] {
  switch (id) {
    case 'mineru':
      return MINERU_SELFHOST_MIMES;
    case 'mineru-cloud':
      return MINERU_CLOUD_MIMES;
    case 'alidocmind':
      return ALIDOCMIND_MIMES;
    default:
      return PDF_MIME_TYPES;
  }
}

function createPdfBackedDocumentExtractor(id: PDFProviderId): DocumentExtractorProvider {
  const pdfProvider = PDF_PROVIDERS[id];
  return {
    id,
    displayName: pdfProvider.name,
    supportedMimeTypes: [...supportedMimeTypesForProvider(id)],
    capabilities: capabilitiesFromPdfProvider(pdfProvider, id),
    async extract(input: DocumentExtractorInput) {
      const config = {
        providerId: id,
        apiKey: input.config.apiKey,
        baseUrl: input.config.baseUrl,
        accessKeyId: input.config.accessKeyId,
        accessKeySecret: input.config.accessKeySecret,
        allowEnvFallback: input.config.allowEnvFallback,
      };
      let parsed;
      if (id === 'alidocmind') {
        // AliDocMind handles pdf/docx/pptx/xlsx/images through one flow.
        parsed = await parsePDF(config, input.buffer, {
          fileName: input.fileName,
          mimeType: input.mimeType,
        });
      } else if (id === 'mineru-cloud') {
        parsed = await parseWithMinerUCloud(config, input.buffer, input.fileName);
      } else if (id === 'mineru') {
        // Self-host MinerU routes every type (incl. pdf) through /file_parse.
        parsed = await parseWithMinerUDocument(config, input.buffer, {
          fileName: input.fileName || 'document.pdf',
          mimeType: input.mimeType,
        });
      } else if (input.mimeType === DOCUMENT_MIME_TYPES.pdf) {
        parsed = await parsePDF(config, input.buffer);
      } else {
        parsed = await parseWithMinerUDocument(config, input.buffer, {
          fileName: input.fileName || 'document',
          mimeType: input.mimeType,
        });
      }

      return parsedPdfToDocumentArtifact(parsed, input);
    },
  };
}

export const pdfDocumentExtractorProviders: DocumentExtractorProvider[] = Object.keys(
  PDF_PROVIDERS,
).map((id) => createPdfBackedDocumentExtractor(id as PDFProviderId));
