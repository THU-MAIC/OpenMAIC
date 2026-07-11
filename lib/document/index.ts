export { extractDocument } from './extract';
export {
  getDocumentExtractorProvider,
  getDocumentExtractorProviders,
  selectDocumentExtractorProvider,
} from './extractors/registry';
export {
  COURSE_MATERIAL_ACCEPT,
  DOCUMENT_MIME_TYPES,
  SUPPORTED_COURSE_MATERIAL_MIME_TYPES,
  isSupportedCourseMaterial,
  normalizeDocumentMimeType,
} from './mime';
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
