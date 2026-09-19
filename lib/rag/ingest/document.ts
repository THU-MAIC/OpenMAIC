import { createHash } from 'node:crypto';

import {
  createDefaultDocumentTransformRegistry,
  transformDocument,
  type DocumentArtifact,
  type DocumentDiagnostic,
  type DocumentTransformMetrics,
  type DocumentTransformPipelineOptions,
} from '@/lib/document';

import {
  chunkDocumentArtifact,
  DOCUMENT_CHUNK_POLICY,
  resolveDocumentChunkPolicy,
  type DocumentChunkingOptions,
  type DocumentKnowledgeResource,
} from '../chunking';
import type {
  KnowledgeChunk,
  KnowledgeLineage,
  KnowledgeMetadata,
  KnowledgeResource,
  KnowledgeVersion,
} from '../types';

export type DocumentResourceInput = {
  readonly id: string;
  readonly workspaceId: string;
  readonly courseId?: string;
  readonly parentResourceId?: string;
  readonly modality: 'document' | 'html';
  readonly title: string;
  readonly mimeType?: string;
  readonly sourceRef: string;
  readonly contentHash: string;
  readonly extractor: KnowledgeVersion;
  readonly metadata?: KnowledgeMetadata;
};

export type DocumentRagIngestionRequest = {
  readonly artifact: DocumentArtifact;
  readonly resource: DocumentResourceInput;
  readonly chunking?: DocumentChunkingOptions;
  readonly transformOptions?: DocumentTransformPipelineOptions;
};

export type DocumentRagIngestionResult = {
  readonly artifact: DocumentArtifact;
  readonly resource: KnowledgeResource;
  readonly chunks: readonly KnowledgeChunk[];
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly metrics: DocumentTransformMetrics;
};

const DEFAULT_RAG_CONTEXT = {
  purpose: 'rag' as const,
  budget: { maxTextChars: 1_000_000, maxVisionImages: 0 },
};

function transformLineage(artifact: DocumentArtifact): readonly KnowledgeVersion[] {
  return (artifact.transforms ?? []).map((transform) => ({
    id: transform.transformId,
    version: transform.version,
  }));
}

function resourceLineage(
  input: DocumentResourceInput,
  artifact: DocumentArtifact,
  policyVersion: string,
): KnowledgeLineage {
  return {
    sourceHash: input.contentHash,
    extractor: input.extractor,
    transforms: transformLineage(artifact),
    chunkPolicy: { id: DOCUMENT_CHUNK_POLICY.id, version: policyVersion },
  };
}

function createResourceVersionId(
  input: DocumentResourceInput,
  lineage: KnowledgeLineage,
  metadata: KnowledgeMetadata,
): string {
  const fingerprint = [
    ['resource', input.id, input.workspaceId, input.courseId ?? null],
    ['source', lineage.sourceHash],
    ['extractor', lineage.extractor.id, lineage.extractor.version],
    [
      'transforms',
      lineage.transforms.map((transform) => [transform.id, transform.version] as const),
    ],
    ['chunkPolicy', lineage.chunkPolicy.id, lineage.chunkPolicy.version],
    ['metadata', Object.entries(metadata)],
  ] as const;
  return `document-version:${createHash('sha256')
    .update(JSON.stringify(fingerprint))
    .digest('hex')}`;
}

function normalizeResourceMetadata(metadata: KnowledgeMetadata): KnowledgeMetadata {
  const normalized: Record<string, string | number | boolean | readonly string[]> = {};
  const entries = Object.entries(metadata).sort(([leftKey], [rightKey]) => {
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return 0;
  });
  for (const [key, value] of entries) {
    if (key !== 'workspaceId' && key !== 'courseId') {
      normalized[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return normalized;
}

function hasTransformFailure(
  artifact: DocumentArtifact,
  diagnostics: readonly DocumentDiagnostic[],
): boolean {
  return (
    (artifact.transforms ?? []).some((transform) => transform.status === 'failed') ||
    [...diagnostics, ...(artifact.diagnostics ?? [])].some(
      (diagnostic) => diagnostic.severity === 'error',
    )
  );
}

function withoutProviderRaw(artifact: DocumentArtifact): DocumentArtifact {
  const safeArtifact = { ...artifact };
  delete safeArtifact.providerRaw;
  return safeArtifact;
}

export async function ingestDocumentForRag(
  request: DocumentRagIngestionRequest,
): Promise<DocumentRagIngestionResult> {
  const transformed = await transformDocument(
    request.artifact,
    createDefaultDocumentTransformRegistry().list(),
    DEFAULT_RAG_CONTEXT,
    request.transformOptions,
  );
  const policy = resolveDocumentChunkPolicy(request.chunking, DOCUMENT_CHUNK_POLICY.version);
  const lineage = resourceLineage(request.resource, transformed.artifact, policy.version);
  const metadata = normalizeResourceMetadata(request.resource.metadata ?? {});
  const resourceVersionId = createResourceVersionId(request.resource, lineage, metadata);
  const artifact = withoutProviderRaw(transformed.artifact);
  const resource: DocumentKnowledgeResource = {
    id: request.resource.id,
    workspaceId: request.resource.workspaceId,
    ...(request.resource.courseId !== undefined ? { courseId: request.resource.courseId } : {}),
    resourceVersionId,
    ...(request.resource.parentResourceId
      ? { parentResourceId: request.resource.parentResourceId }
      : {}),
    modality: request.resource.modality,
    title: request.resource.title,
    ...(request.resource.mimeType ? { mimeType: request.resource.mimeType } : {}),
    sourceRef: request.resource.sourceRef,
    contentHash: request.resource.contentHash,
    status: 'ready',
    lineage,
    metadata,
  };
  const chunks = chunkDocumentArtifact(transformed.artifact, resource, request.chunking);
  const diagnostics = [...transformed.diagnostics];
  const hasFailure = hasTransformFailure(transformed.artifact, diagnostics);

  if (chunks.length === 0) {
    diagnostics.push({
      severity: 'warning',
      message: `RAG ingestion produced no text chunks for resource "${resource.id}".`,
      metadata: { resourceId: resource.id },
    });
  }

  return {
    artifact,
    resource: { ...resource, status: chunks.length > 0 && !hasFailure ? 'ready' : 'partial' },
    chunks,
    diagnostics,
    metrics: transformed.metrics,
  };
}
