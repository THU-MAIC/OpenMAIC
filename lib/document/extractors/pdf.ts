import { parseWithMinerUCloud } from '@/lib/pdf/mineru-cloud';
import { parsePDF, parseWithMinerUDocument } from '@/lib/pdf/pdf-providers';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { DOCUMENT_MIME_TYPES } from '../mime';
import { parsedPdfToDocumentArtifact } from '../pdf-compat';
import type { DocumentExtractorInput, DocumentExtractorProvider } from '../types';
import { getDocumentExtractorManifestEntry, type DocumentExtractorManifestEntry } from './manifest';

/** The manifest entry backing a PDF provider, or a loud failure at module init. */
function pdfManifestEntry(id: PDFProviderId): DocumentExtractorManifestEntry {
  const entry = getDocumentExtractorManifestEntry(id);
  if (!entry) {
    throw new Error(`No document extractor manifest entry for PDF provider "${id}"`);
  }
  return entry;
}

function createPdfBackedDocumentExtractor(id: PDFProviderId): DocumentExtractorProvider {
  return {
    // Metadata comes from the browser-safe manifest — single source of truth
    // for the extractor identity (RFC #1153 part 1); the implementation is
    // attached here. `pdfManifestEntry` throws at module init if a
    // PDF_PROVIDERS entry ever lacks a manifest entry, and the registry sync
    // test pins the reverse direction (no orphan manifest entries).
    ...pdfManifestEntry(id),
    async extract(input: DocumentExtractorInput) {
      const config = {
        providerId: id,
        apiKey: input.config.apiKey,
        baseUrl: input.config.baseUrl,
        accessKeyId: input.config.accessKeyId,
        accessKeySecret: input.config.accessKeySecret,
        allowEnvFallback: input.config.allowEnvFallback,
        textOnly: input.config.textOnly,
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
