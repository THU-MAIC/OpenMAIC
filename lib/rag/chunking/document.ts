import { createHash } from 'node:crypto';

import sanitizeHtml from 'sanitize-html';

import type { DocumentArtifact, DocumentBlock } from '@/lib/document';

import type { KnowledgeChunk, KnowledgeMetadata, KnowledgeResource } from '../types';
import { splitGraphemeText } from './grapheme';

export const DOCUMENT_CHUNK_POLICY = {
  id: 'document-block',
  version: '1.1.3',
  maxChars: 1200,
  maxCharsUnit: 'grapheme-cluster',
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

const HTML_LINE_BREAK_PATTERN = /<br(?=[ \t\n\f\r/>])(?:[^"'<>]|"[^"]*"|'[^']*')*\/?\s*>/gi;
const HTML_BLOCK_END_TAG_PATTERN =
  /<\/(?:address|article|aside|blockquote|dd|div|dl|dt|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)[ \t\n\f\r]*>/gi;
const HTML_BLOCK_START_TAG_PATTERN =
  /<(?:address|article|aside|blockquote|dd|div|dl|dt|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)(?=[ \t\n\f\r/>])(?:[^"'<>]|"[^"]*"|'[^']*')*\/?\s*>/gi;
const HTML_BLOCK_START_TAG_AT_END_PATTERN =
  /<(?:address|article|aside|blockquote|dd|div|dl|dt|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)(?=[ \t\n\f\r/>])(?:[^"'<>]|"[^"]*"|'[^']*')*\/?\s*>[ \t]*$/i;
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
  const maxCharsMarker = `:maxChars=${maxChars}:unit=${DOCUMENT_CHUNK_POLICY.maxCharsUnit}`;
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
  const projectedHtml = block.html
    .replace(HTML_LINE_BREAK_PATTERN, '\n')
    .replace(HTML_BLOCK_END_TAG_PATTERN, '\n')
    .replace(HTML_BLOCK_START_TAG_PATTERN, (_match, offset: number, source: string) => {
      const before = source.slice(0, offset);
      return /(?:^|\n)[ \t]*$/u.test(before) || HTML_BLOCK_START_TAG_AT_END_PATTERN.test(before)
        ? ''
        : '\n';
    });
  return sanitizeHtml(projectedHtml, {
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

function splitBlockText(value: string, maxChars: number): string[] {
  const paragraphs = value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  let currentLength = 0;

  for (const paragraph of paragraphs) {
    const paragraphChunks = splitGraphemeText(paragraph, maxChars);
    if (paragraphChunks.length > 1) {
      if (current) {
        chunks.push(current);
        current = '';
        currentLength = 0;
      }
      chunks.push(...paragraphChunks.map(({ text }) => text));
      continue;
    }

    const paragraphChunk = paragraphChunks[0];
    if (!paragraphChunk) continue;
    const combinedLength = current
      ? currentLength + 2 + paragraphChunk.length
      : paragraphChunk.length;
    if (current && combinedLength > maxChars) {
      chunks.push(current);
      current = paragraphChunk.text;
      currentLength = paragraphChunk.length;
    } else {
      current = current ? `${current}\n\n${paragraphChunk.text}` : paragraphChunk.text;
      currentLength = combinedLength;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function chunkMetadata(
  resource: DocumentKnowledgeResource,
  block: DocumentBlock,
): KnowledgeMetadata {
  const metadata: Record<string, string | number | boolean | readonly string[]> = {};
  for (const [key, value] of Object.entries(resource.metadata)) {
    if (key !== 'workspaceId' && key !== 'courseId') metadata[key] = value;
  }
  metadata.blockType = block.type;
  if (typeof block.pageNumber === 'number') metadata.pageNumber = block.pageNumber;
  const role = block.metadata?.role;
  if (typeof role === 'string') metadata.role = role;
  const heading = blockHeading(block);
  if (heading) metadata.heading = heading;
  return metadata;
}

function chunkHash(input: {
  readonly resourceId: string;
  readonly resourceVersionId: string;
  readonly blockId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly policyVersion: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.resourceId,
        input.resourceVersionId,
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
  readonly resourceVersionId: string;
  readonly blockId: string;
  readonly blockOccurrence: number;
  readonly partIndex: number;
}): string {
  return `document-chunk:${createHash('sha256')
    .update(
      JSON.stringify([
        'document-chunk',
        input.resourceId,
        input.resourceVersionId,
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
          resourceVersionId: resource.resourceVersionId,
          blockId: block.id,
          blockOccurrence,
          partIndex,
        }),
        resourceId: resource.id,
        resourceVersionId: resource.resourceVersionId,
        workspaceId: resource.workspaceId,
        ...(resource.courseId !== undefined ? { courseId: resource.courseId } : {}),
        ordinal,
        text: part,
        contentHash: chunkHash({
          resourceId: resource.id,
          resourceVersionId: resource.resourceVersionId,
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
