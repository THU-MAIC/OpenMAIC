export { KNOWLEDGE_MODALITIES } from './types';
export { DOCUMENT_CHUNK_POLICY, chunkDocumentArtifact } from './chunking';
export { ingestDocumentForRag } from './ingest';
export { InMemoryLexicalIndex } from './providers';
export type {
  DocumentRagIngestionRequest,
  DocumentRagIngestionResult,
  DocumentResourceInput,
} from './ingest';
export type { DocumentChunkingOptions } from './chunking';
export type { DocumentKnowledgeResource } from './chunking';
export type {
  KnowledgeChunk,
  KnowledgeExactScope,
  KnowledgeFilterValue,
  KnowledgeHit,
  KnowledgeIndex,
  KnowledgeIndexCapabilities,
  KnowledgeIndexDeleteRequest,
  KnowledgeIndexReplaceRequest,
  KnowledgeIndexScope,
  KnowledgeIndexQuery,
  KnowledgeLineage,
  KnowledgeLocator,
  KnowledgeMetadata,
  KnowledgeMetadataValue,
  KnowledgeModality,
  KnowledgeResource,
  KnowledgeResourceStatus,
  KnowledgeVersion,
} from './types';
