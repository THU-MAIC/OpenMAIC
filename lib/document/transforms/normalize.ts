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
    typeof current.html !== 'string'
  );
}

function remapArtifactReferences(
  artifact: DocumentArtifact,
  blockIdMap: ReadonlyMap<string, string>,
  removedBlockIds: ReadonlySet<string>,
): void {
  artifact.citations = artifact.citations
    ?.filter((citation) => !citation.blockId || !removedBlockIds.has(citation.blockId))
    .map((citation) => ({
      ...citation,
      blockId: citation.blockId
        ? (blockIdMap.get(citation.blockId) ?? citation.blockId)
        : undefined,
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
    const normalizedBlocks = artifact.blocks.map((block) => ({
      ...block,
      text:
        typeof block.text === 'string'
          ? block.type === 'markdown'
            ? normalizeMarkdownText(block.text)
            : normalizeDocumentText(block.text)
          : undefined,
      html: typeof block.html === 'string' ? normalizeDocumentText(block.html) : undefined,
    }));
    const removedEmptyBlockIds = new Set(
      normalizedBlocks.filter(isEmptyTextBlock).map((block) => block.id),
    );
    const normalized = normalizedBlocks.filter((block) => !removedEmptyBlockIds.has(block.id));

    const removedEmptyBlocks = removedEmptyBlockIds.size;
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
    remapArtifactReferences(artifact, blockIdMap, removedEmptyBlockIds);

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
