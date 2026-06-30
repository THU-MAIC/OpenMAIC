export { extractDocument } from './extract';
export {
  getDocumentExtractorProvider,
  getDocumentExtractorProviders,
  selectDocumentExtractorProvider,
} from './extractors/registry';
export { documentArtifactToParsedPdfContent, parsedPdfToDocumentArtifact } from './pdf-compat';
export type {
  DocumentArtifact,
  DocumentAsset,
  DocumentBlock,
  DocumentCitation,
  DocumentDiagnostic,
  DocumentExtractorCapabilities,
  DocumentExtractorConfig,
  DocumentExtractorInput,
  DocumentExtractorProvider,
  DocumentExtractorProviderId,
} from './types';
