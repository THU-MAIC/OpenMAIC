import type { DocumentArtifact, DocumentBlock, DocumentDiagnostic } from '../types';
import type { DocumentTransform } from './types';
import { cloneDocumentArtifact } from './utils';

export function normalizeDocumentText(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeMarkdownText(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\r\n?/g, '\n');
}

function isEmptyTextBlock(block: DocumentBlock): boolean {
  return (
    (block.type === 'text' || block.type === 'markdown') &&
    !block.text?.trim() &&
    !block.html?.trim()
  );
}

function canMergeTextBlocks(previous: DocumentBlock, current: DocumentBlock): boolean {
  return (
    (current.type === 'text' || current.type === 'markdown') &&
    previous.type === current.type &&
    previous.pageNumber === current.pageNumber &&
    !previous.bbox &&
    !current.bbox &&
    typeof previous.text === 'string' &&
    typeof current.text === 'string' &&
    typeof previous.html !== 'string' &&
    typeof current.html !== 'string' &&
    typeof previous.metadata?.headingLevel !== 'number' &&
    typeof current.metadata?.headingLevel !== 'number'
  );
}

function remapArtifactReferences(
  artifact: DocumentArtifact,
  blockIdMap: ReadonlyMap<string, string>,
): void {
  artifact.citations = artifact.citations?.map((citation) => ({
    ...citation,
    blockId: citation.blockId ? (blockIdMap.get(citation.blockId) ?? citation.blockId) : undefined,
  }));
  artifact.outline = artifact.outline?.map((node) => ({
    ...node,
    blockIds: Array.from(
      new Set(node.blockIds.map((blockId) => blockIdMap.get(blockId) ?? blockId)),
    ),
    startOffset: node.blockIds.some((blockId) => blockIdMap.has(blockId))
      ? undefined
      : node.startOffset,
    endOffset: node.blockIds.some((blockId) => blockIdMap.has(blockId))
      ? undefined
      : node.endOffset,
  }));
}

export const normalizeDocumentTransform: DocumentTransform = {
  id: 'normalize',
  displayName: 'Normalize document content',
  version: '1.0.0',
  capabilities: {},
  apply(input) {
    const artifact = cloneDocumentArtifact(input);
    const diagnostics: DocumentDiagnostic[] = [];
    const normalized = artifact.blocks
      .map((block) => ({
        ...block,
        text:
          typeof block.text === 'string'
            ? block.type === 'markdown'
              ? normalizeMarkdownText(block.text)
              : normalizeDocumentText(block.text)
            : undefined,
        html: typeof block.html === 'string' ? normalizeDocumentText(block.html) : undefined,
      }))
      .filter((block) => !isEmptyTextBlock(block));

    const removedEmptyBlocks = artifact.blocks.length - normalized.length;
    const blockIdMap = new Map<string, string>();
    const merged: DocumentBlock[] = [];
    let mergedBlockCount = 0;

    for (const block of normalized) {
      const previous = merged.at(-1);
      if (!previous || !canMergeTextBlocks(previous, block)) {
        merged.push(block);
        continue;
      }

      const mergedSourceIds = [
        ...((previous.metadata?.sourceBlockIds as string[] | undefined) ?? [previous.id]),
        block.id,
      ];
      previous.text = [previous.text, block.text].filter(Boolean).join('\n\n');
      previous.metadata = { ...previous.metadata, sourceBlockIds: mergedSourceIds };
      blockIdMap.set(block.id, previous.id);
      mergedBlockCount += 1;
    }

    artifact.blocks = merged;
    remapArtifactReferences(artifact, blockIdMap);

    if (removedEmptyBlocks > 0 || mergedBlockCount > 0) {
      diagnostics.push({
        severity: 'info',
        message: `Normalized document blocks: removed ${removedEmptyBlocks} empty block(s), merged ${mergedBlockCount} adjacent block(s).`,
        metadata: { removedEmptyBlocks, mergedBlockCount },
      });
    }

    return {
      artifact,
      diagnostics,
      status: removedEmptyBlocks > 0 || mergedBlockCount > 0 ? 'applied' : 'skipped',
    };
  },
};
