/**
 * Knowledge Layer Types
 *
 * Defines types for the vector store integration, RAG pipeline,
 * and knowledge-grounded explanations.
 */

/**
 * Knowledge document - a piece of content indexed for RAG
 */
export interface KnowledgeDocument {
  id: string;
  /** Source type */
  sourceType: 'course-material' | 'student-notes' | 'external' | 'generated';
  /** Associated course/lesson IDs */
  courseId?: string;
  lessonId?: string;
  /** Document content */
  title: string;
  content: string;
  /** Metadata for filtering */
  metadata: Record<string, string>;
  /** Embedding vector (populated by vector store) */
  embedding?: number[];
  /** Chunk information */
  chunkIndex?: number;
  totalChunks?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * RAG query result
 */
export interface RAGResult {
  documentId: string;
  content: string;
  score: number;
  metadata: Record<string, string>;
}

/**
 * RAG pipeline configuration
 */
export interface RAGConfig {
  /** Vector store provider */
  provider: 'pgvector' | 'qdrant' | 'memory';
  /** Number of results to retrieve */
  topK: number;
  /** Minimum similarity score threshold */
  scoreThreshold: number;
  /** Whether to rerank results */
  rerankEnabled: boolean;
  /** Embedding model configuration */
  embeddingModel: {
    providerId: string;
    modelId: string;
  };
}

/**
 * Concept in the knowledge graph
 */
export interface Concept {
  id: string;
  name: string;
  description: string;
  domain: string;
  prerequisites: string[];
  relatedConcepts: string[];
  linkedLessonIds: string[];
  difficulty: number;
}
