export const KNOWLEDGE_MODALITIES = ['document', 'html'] as const;

export type KnowledgeModality = (typeof KNOWLEDGE_MODALITIES)[number];

export type KnowledgeMetadataValue = string | number | boolean | readonly string[];

export type KnowledgeMetadata = Readonly<Record<string, KnowledgeMetadataValue>>;

export type KnowledgeFilterValue = string | number | boolean;

export type KnowledgeExactScope = {
  readonly workspaceId: string;
  readonly courseId?: string;
};

export type KnowledgeIndexScope =
  | (KnowledgeExactScope & { readonly courseScope: 'exact' })
  | {
      readonly workspaceId: string;
      readonly courseScope: 'all';
      readonly courseId?: never;
    };

export type KnowledgeLocator = {
  readonly kind: 'document';
  readonly blockId: string;
  readonly pageNumber?: number;
  readonly heading?: string;
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

export type KnowledgeResource = KnowledgeExactScope & {
  readonly id: string;
  readonly resourceVersionId: string;
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

export type KnowledgeChunk = KnowledgeExactScope & {
  readonly id: string;
  readonly resourceId: string;
  readonly resourceVersionId: string;
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

export type KnowledgeIndexQuery = KnowledgeIndexScope & {
  readonly text: string;
  readonly topK: number;
  readonly filters?: Readonly<Record<string, KnowledgeFilterValue>>;
};

export type KnowledgeIndexDeleteRequest = KnowledgeIndexScope & {
  readonly resourceIds: readonly string[];
};

export type KnowledgeIndexReplaceRequest = KnowledgeExactScope & {
  readonly resourceId: string;
  readonly resourceVersionId: string;
  readonly chunks: readonly KnowledgeChunk[];
};

export type KnowledgeHit = {
  readonly chunk: KnowledgeChunk;
  readonly score: number;
  readonly method: 'lexical' | 'vector';
};

export interface KnowledgeIndex {
  readonly id: string;
  readonly capabilities: KnowledgeIndexCapabilities;
  replaceResourceVersion(request: KnowledgeIndexReplaceRequest): Promise<void>;
  delete(request: KnowledgeIndexDeleteRequest): Promise<void>;
  query(request: KnowledgeIndexQuery): Promise<readonly KnowledgeHit[]>;
}
