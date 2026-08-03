import type { DocumentArtifact } from '../types';

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

export function cloneDocumentArtifact(artifact: DocumentArtifact): DocumentArtifact {
  return {
    ...artifact,
    metadata: { ...artifact.metadata },
    blocks: artifact.blocks.map((block) => ({
      ...block,
      bbox: block.bbox ? { ...block.bbox } : undefined,
      metadata: block.metadata ? cloneRecord(block.metadata) : undefined,
    })),
    assets: artifact.assets.map((asset) => ({
      ...asset,
      metadata: asset.metadata ? cloneRecord(asset.metadata) : undefined,
    })),
    citations: artifact.citations?.map((citation) => ({
      ...citation,
      metadata: citation.metadata ? cloneRecord(citation.metadata) : undefined,
    })),
    diagnostics: artifact.diagnostics?.map((diagnostic) => ({
      ...diagnostic,
      metadata: diagnostic.metadata ? cloneRecord(diagnostic.metadata) : undefined,
    })),
    transforms: artifact.transforms?.map((record) => ({
      ...record,
      options: record.options ? cloneRecord(record.options) : undefined,
      diagnostics: record.diagnostics?.map((diagnostic) => ({
        ...diagnostic,
        metadata: diagnostic.metadata ? cloneRecord(diagnostic.metadata) : undefined,
      })),
    })),
  };
}

export function documentTextLength(artifact: DocumentArtifact): number {
  return artifact.blocks.reduce(
    (total, block) => total + (block.text?.length ?? 0) + (block.html?.length ?? 0),
    0,
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Document transform was aborted', 'AbortError');
}
