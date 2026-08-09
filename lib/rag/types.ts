export const KNOWLEDGE_MODALITIES = ['document', 'html', 'image', 'video', 'experiment'] as const;

export type KnowledgeModality = (typeof KNOWLEDGE_MODALITIES)[number];

export type KnowledgeMetadataValue = string | number | boolean | readonly string[];

export type KnowledgeMetadata = Readonly<Record<string, KnowledgeMetadataValue>>;

export type KnowledgeFilterValue = string | number | boolean;

export type KnowledgeLocator =
  | {
      readonly kind: 'document';
      readonly blockId: string;
      readonly pageNumber?: number;
      readonly heading?: string;
    }
  | {
      readonly kind: 'media';
      readonly segmentId?: string;
      readonly keyframeId?: string;
      readonly startMs?: number;
      readonly endMs?: number;
    }
  | {
      readonly kind: 'experiment';
      readonly courseId: string;
      readonly chapterId?: string;
      readonly resourceId?: string;
      readonly section?: string;
      readonly fileRef?: string;
      readonly route?: string;
    };

export type KnowledgeVersion = {
  readonly id: string;
  readonly version: string;
};

export type KnowledgeLineage = {
  readonly sourceHash: string;
  readonly extractor: KnowledgeVersion;
  readonly transforms: readonly KnowledgeVersion[];
  readonly chunkPolicy: KnowledgeVersion;
};

export type KnowledgeResourceStatus = 'ready' | 'partial' | 'failed';

export type KnowledgeResource = {
  readonly id: string;
  readonly workspaceId: string;
  readonly courseId?: string;
  readonly parentResourceId?: string;
  readonly modality: KnowledgeModality;
  readonly title: string;
  readonly mimeType?: string;
  readonly sourceRef: string;
  readonly contentHash: string;
  readonly status: KnowledgeResourceStatus;
  readonly lineage: KnowledgeLineage;
  readonly metadata: KnowledgeMetadata;
};

export type KnowledgeChunk = {
  readonly id: string;
  readonly resourceId: string;
  readonly workspaceId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly contentHash: string;
  readonly locator: KnowledgeLocator;
  readonly lineage: KnowledgeLineage;
  readonly metadata: KnowledgeMetadata;
};

export type KnowledgeIndexCapabilities = {
  readonly lexical: boolean;
  readonly vector: boolean;
  readonly metadataFilter: boolean;
};

export type KnowledgeIndexQuery = {
  readonly workspaceId: string;
  readonly text: string;
  readonly topK: number;
  readonly filters?: Readonly<Record<string, KnowledgeFilterValue>>;
};

export type KnowledgeIndexDeleteRequest = {
  readonly workspaceId: string;
  readonly resourceIds: readonly string[];
};

export type KnowledgeHit = {
  readonly chunk: KnowledgeChunk;
  readonly score: number;
  readonly method: 'lexical' | 'vector';
};

export interface KnowledgeIndex {
  readonly id: string;
  readonly capabilities: KnowledgeIndexCapabilities;
  upsert(chunks: readonly KnowledgeChunk[]): Promise<void>;
  delete(request: KnowledgeIndexDeleteRequest): Promise<void>;
  query(request: KnowledgeIndexQuery): Promise<readonly KnowledgeHit[]>;
}

export type GroundingContextRef = {
  readonly snapshotId?: string;
};
