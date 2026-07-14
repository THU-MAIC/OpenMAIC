import { normalizeDocumentTransform } from './normalize';
import { removeDocumentNoiseTransform } from './noise-removal';
import { DocumentTransformRegistry } from './registry';
import { detectDocumentStructureTransform } from './structure';

export { normalizeDocumentText, normalizeDocumentTransform } from './normalize';
export { removeDocumentNoiseTransform } from './noise-removal';
export { transformDocument } from './pipeline';
export { DocumentTransformRegistry } from './registry';
export { detectDocumentStructureTransform } from './structure';
export type {
  DocumentTransform,
  DocumentTransformCapabilities,
  DocumentTransformContext,
  DocumentTransformMetrics,
  DocumentTransformOutput,
  DocumentTransformPipelineOptions,
  DocumentTransformPurpose,
  DocumentTransformResult,
} from './types';

export const DEFAULT_DOCUMENT_TRANSFORMS = [
  normalizeDocumentTransform,
  detectDocumentStructureTransform,
  removeDocumentNoiseTransform,
] as const;

export function createDefaultDocumentTransformRegistry(): DocumentTransformRegistry {
  return new DocumentTransformRegistry(DEFAULT_DOCUMENT_TRANSFORMS);
}
