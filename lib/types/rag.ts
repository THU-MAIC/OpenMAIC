export interface RagRetrievalConfig {
  topK: number;
  minSimilarity: number;
  maxContextChars: number;
}

export interface RagHit {
  documentId: string;
  documentName: string;
  chunkIndex: number;
  score: number;
  excerpt: string;
}

export interface RagSource {
  documentId: string;
  name: string;
  score: number;
  excerptCount: number;
}

export interface RagEvidence {
  id: string;
  query: string;
  config: RagRetrievalConfig;
  selectionConfirmed: boolean;
  hits: RagHit[];
  sources: RagSource[];
}
