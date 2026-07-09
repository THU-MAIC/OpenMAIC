export { extractDocument } from './extract';
export { extractMedia } from './extract-media';
export {
  getDocumentExtractorProvider,
  getDocumentExtractorProviders,
  selectDocumentExtractorProvider,
} from './extractors/registry';
export {
  getMediaExtractorProvider,
  getMediaExtractorProviders,
  selectMediaExtractorProvider,
} from './extractors/media-registry';
export {
  COURSE_MATERIAL_ACCEPT,
  DOCUMENT_MIME_TYPES,
  SUPPORTED_COURSE_MATERIAL_MIME_TYPES,
  isSupportedCourseMaterial,
  normalizeDocumentMimeType,
} from './mime';
export { documentArtifactToParsedPdfContent, parsedPdfToDocumentArtifact } from './pdf-compat';
export {
  MAX_DOCUMENT_BUNDLE_FILES,
  MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES,
  allocateDocumentTextBudgets,
  buildDocumentBundle,
  sortDocumentImagesForVision,
} from './bundle';
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
  ExtractionArtifact,
  ExtractionError,
  ExtractionJob,
  ExtractionResult,
  MediaArtifact,
  MediaExtractorCapabilities,
  MediaExtractorInput,
  MediaExtractorProvider,
  MediaExtractorProviderId,
  MediaKeyframe,
  MediaTranscriptSegment,
} from './types';
export type { DocumentBundleResult, ParsedDocumentImage, ParsedDocumentPart } from './bundle';
