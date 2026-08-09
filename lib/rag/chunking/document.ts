import { createHash } from 'node:crypto';

import sanitizeHtml from 'sanitize-html';

import type { DocumentArtifact, DocumentBlock } from '@/lib/document';

import type { KnowledgeChunk, KnowledgeMetadata, KnowledgeResource } from '../types';

export const DOCUMENT_CHUNK_POLICY = {
  id: 'document-block',
  version: '1.0.0',
  maxChars: 1200,
} as const;

export type DocumentChunkingOptions = {
  readonly maxChars?: number;
  readonly policyVersion?: string;
};

export type DocumentKnowledgeResource = Omit<KnowledgeResource, 'modality'> & {
  readonly modality: 'document' | 'html';
};

export type ResolvedDocumentChunkPolicy = {
  readonly maxChars: number;
  readonly version: string;
};

const HTML_BLOCK_END_TAG_PATTERN =
  /<\/(?:address|article|aside|blockquote|br|dd|div|dl|dt|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)>/gi;

class InvalidDocumentChunkPolicyError extends Error {
  readonly name = 'InvalidDocumentChunkPolicyError';

  constructor(readonly maxChars: number) {
    super(`Document chunk maxChars must be a positive integer, got ${maxChars}`);
  }
}

export function resolveDocumentChunkPolicy(
  options: DocumentChunkingOptions = {},
  basePolicyVersion: string = DOCUMENT_CHUNK_POLICY.version,
): ResolvedDocumentChunkPolicy {
  const maxChars = options.maxChars ?? DOCUMENT_CHUNK_POLICY.maxChars;
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new InvalidDocumentChunkPolicyError(maxChars);
  }

  const policyVersion = options.policyVersion ?? basePolicyVersion;
  const maxCharsMarker = `:maxChars=${maxChars}`;
  return {
    maxChars,
    version: policyVersion.endsWith(maxCharsMarker)
      ? policyVersion
      : `${policyVersion}${maxCharsMarker}`,
  };
}

function blockText(block: DocumentBlock): string {
  const text = block.text?.trim();
  if (text) return text;
  if (!block.html) return '';
  return sanitizeHtml(block.html.replace(HTML_BLOCK_END_TAG_PATTERN, '\n'), {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function blockHeading(block: DocumentBlock): string | undefined {
  const heading = block.metadata?.heading;
  return typeof heading === 'string' && heading.trim() ? heading.trim() : undefined;
}

function splitLongSegment(value: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = value.trim();

  while (remaining.length > maxChars) {
    const whitespaceBoundary = remaining.lastIndexOf(' ', maxChars);
    const boundary = whitespaceBoundary > Math.floor(maxChars / 2) ? whitespaceBoundary : maxChars;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function splitBlockText(value: string, maxChars: number): string[] {
  const paragraphs = value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitLongSegment(paragraph, maxChars));
      continue;
    }

    const combinedLength = current ? current.length + 2 + paragraph.length : paragraph.length;
    if (current && combinedLength > maxChars) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function chunkMetadata(
  resource: DocumentKnowledgeResource,
  block: DocumentBlock,
): KnowledgeMetadata {
  const metadata: Record<string, string | number | boolean | readonly string[]> = {
    ...resource.metadata,
    blockType: block.type,
  };
  if (typeof block.pageNumber === 'number') metadata.pageNumber = block.pageNumber;
  const role = block.metadata?.role;
  if (typeof role === 'string') metadata.role = role;
  const heading = blockHeading(block);
  if (heading) metadata.heading = heading;
  return metadata;
}

function chunkHash(input: {
  readonly resourceId: string;
  readonly blockId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly policyVersion: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.resourceId,
        input.blockId,
        input.ordinal,
        input.text,
        input.policyVersion,
      ]),
    )
    .digest('hex');
}

function chunkId(input: {
  readonly resourceId: string;
  readonly blockId: string;
  readonly blockOccurrence: number;
  readonly partIndex: number;
}): string {
  return `document-chunk:${createHash('sha256')
    .update(
      JSON.stringify([
        'document-chunk',
        input.resourceId,
        input.blockId,
        input.blockOccurrence,
        input.partIndex,
      ]),
    )
    .digest('hex')}`;
}

export function chunkDocumentArtifact(
  artifact: DocumentArtifact,
  resource: DocumentKnowledgeResource,
  options: DocumentChunkingOptions = {},
): readonly KnowledgeChunk[] {
  const policy = resolveDocumentChunkPolicy(options, resource.lineage.chunkPolicy.version);
  const lineage = {
    ...resource.lineage,
    chunkPolicy: { ...resource.lineage.chunkPolicy, version: policy.version },
  };
  const chunks: KnowledgeChunk[] = [];
  const blockOccurrences = new Map<string, number>();

  for (const block of artifact.blocks) {
    const blockOccurrence = blockOccurrences.get(block.id) ?? 0;
    blockOccurrences.set(block.id, blockOccurrence + 1);
    const text = blockText(block);
    if (!text) continue;
    const heading = blockHeading(block);
    const locator = {
      kind: 'document' as const,
      blockId: block.id,
      ...(typeof block.pageNumber === 'number' ? { pageNumber: block.pageNumber } : {}),
      ...(heading ? { heading } : {}),
    };

    for (const [partIndex, part] of splitBlockText(text, policy.maxChars).entries()) {
      const ordinal = chunks.length;
      chunks.push({
        id: chunkId({
          resourceId: resource.id,
          blockId: block.id,
          blockOccurrence,
          partIndex,
        }),
        resourceId: resource.id,
        workspaceId: resource.workspaceId,
        ordinal,
        text: part,
        contentHash: chunkHash({
          resourceId: resource.id,
          blockId: block.id,
          ordinal,
          text: part,
          policyVersion: policy.version,
        }),
        locator,
        lineage,
        metadata: chunkMetadata(resource, block),
      });
    }
  }

  return chunks;
}
