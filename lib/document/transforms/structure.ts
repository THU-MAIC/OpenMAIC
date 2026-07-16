import type {
  DocumentArtifact,
  DocumentBlock,
  DocumentDiagnostic,
  DocumentOutlineNode,
} from '../types';
import type { DocumentTransform } from './types';
import { cloneDocumentArtifact } from './utils';

const LOGICAL_SECTION_CHARS = 12_000;
const MARKDOWN_HEADING = /^(#{1,6})[ \t]+(.+?)\s*$/gm;
const NUMBERED_HEADING =
  /^(?:chapter\s+\d+|第[一二三四五六七八九十百零〇0-9]+[章节篇部]|\d+(?:\.\d+){0,3})[\s、.:：-]+(.+)$/i;

interface HeadingCandidate {
  title: string;
  level: number;
  block: DocumentBlock;
  blockIndex: number;
  startOffset?: number;
  source: DocumentOutlineNode['source'];
  confidence: number;
}

function headingFromMetadata(
  block: DocumentBlock,
  blockIndex: number,
): HeadingCandidate | undefined {
  const headingLevel = block.metadata?.headingLevel;
  const layoutType = block.metadata?.layoutType;
  const role = block.metadata?.role;
  const isHeadingLayout =
    typeof layoutType === 'string' && ['title', 'heading', 'section-title'].includes(layoutType);
  if (typeof headingLevel !== 'number' && !isHeadingLayout && role !== 'heading') return undefined;

  const title = block.text?.trim() || block.html?.trim();
  if (!title) return undefined;
  return {
    title: title.split('\n')[0],
    level: typeof headingLevel === 'number' ? Math.min(6, Math.max(1, headingLevel)) : 1,
    block,
    blockIndex,
    source: 'heading',
    confidence: typeof headingLevel === 'number' ? 1 : 0.9,
  };
}

function headingsFromText(block: DocumentBlock, blockIndex: number): HeadingCandidate[] {
  const text = block.text ?? '';
  const candidates: HeadingCandidate[] = [];
  for (const match of text.matchAll(MARKDOWN_HEADING)) {
    candidates.push({
      title: match[2].trim(),
      level: match[1].length,
      block,
      blockIndex,
      startOffset: match.index,
      source: 'heading',
      confidence: 0.95,
    });
  }
  if (candidates.length > 0) return candidates;

  const firstLine = text.split('\n')[0]?.trim();
  if (firstLine && firstLine.length <= 160 && NUMBERED_HEADING.test(firstLine)) {
    const numberedPrefix = firstLine.match(/^\d+(?:\.\d+)*/)?.[0];
    candidates.push({
      title: firstLine,
      level: numberedPrefix ? Math.min(6, numberedPrefix.split('.').length) : 1,
      block,
      blockIndex,
      source: 'heuristic',
      confidence: 0.75,
    });
  }
  return candidates;
}

function candidatesToOutline(
  candidates: HeadingCandidate[],
  blocks: DocumentBlock[],
): DocumentOutlineNode[] {
  const nodes: DocumentOutlineNode[] = [];
  const parentAtLevel = new Map<number, string>();

  for (const [index, candidate] of candidates.entries()) {
    const nextHeading = candidates[index + 1];
    const nextPeer = candidates.slice(index + 1).find((item) => item.level <= candidate.level);
    const endBlockIndex = nextPeer?.blockIndex ?? blocks.length;
    const sectionBlocks = blocks.slice(
      candidate.blockIndex,
      Math.max(candidate.blockIndex + 1, endBlockIndex),
    );
    const lastSectionBlock = sectionBlocks.at(-1) ?? candidate.block;
    const parentLevel = Array.from(parentAtLevel.keys())
      .filter((level) => level < candidate.level)
      .sort((a, b) => b - a)[0];
    const parentId = parentLevel ? parentAtLevel.get(parentLevel) : undefined;
    const node: DocumentOutlineNode = {
      id: `outline_${index + 1}`,
      title: candidate.title,
      level: candidate.level,
      order: index + 1,
      parentId,
      blockIds: Array.from(new Set(sectionBlocks.map((block) => block.id))),
      pageStart: candidate.block.pageNumber,
      pageEnd: lastSectionBlock.pageNumber ?? candidate.block.pageNumber,
      startOffset: candidate.startOffset,
      endOffset:
        nextHeading?.block.id === candidate.block.id && typeof nextHeading.startOffset === 'number'
          ? nextHeading.startOffset
          : typeof candidate.startOffset === 'number' && sectionBlocks.length === 1
            ? (candidate.block.text ?? candidate.block.html ?? '').length
            : undefined,
      confidence: candidate.confidence,
      source: candidate.source,
    };
    nodes.push(node);
    parentAtLevel.set(candidate.level, node.id);
    for (const level of Array.from(parentAtLevel.keys())) {
      if (level > candidate.level) parentAtLevel.delete(level);
    }
  }
  return nodes;
}

function logicalOutline(artifact: DocumentArtifact): DocumentOutlineNode[] {
  const nodes: DocumentOutlineNode[] = [];
  for (const block of artifact.blocks) {
    const text = block.text ?? block.html ?? '';
    if (!text.trim()) continue;
    if (text.length <= LOGICAL_SECTION_CHARS) {
      nodes.push({
        id: `logical_${nodes.length + 1}`,
        title: `Section ${nodes.length + 1}`,
        level: 1,
        order: nodes.length + 1,
        blockIds: [block.id],
        pageStart: block.pageNumber,
        pageEnd: block.pageNumber,
        confidence: 0.4,
        source: 'logical',
      });
      continue;
    }
    for (let startOffset = 0; startOffset < text.length; startOffset += LOGICAL_SECTION_CHARS) {
      nodes.push({
        id: `logical_${nodes.length + 1}`,
        title: `Section ${nodes.length + 1}`,
        level: 1,
        order: nodes.length + 1,
        blockIds: [block.id],
        pageStart: block.pageNumber,
        pageEnd: block.pageNumber,
        startOffset,
        endOffset: Math.min(text.length, startOffset + LOGICAL_SECTION_CHARS),
        confidence: 0.3,
        source: 'logical',
      });
    }
  }
  return nodes;
}

export const detectDocumentStructureTransform: DocumentTransform = {
  id: 'detect-structure',
  displayName: 'Detect document structure',
  version: '1.0.0',
  capabilities: { supportsSelection: true },
  apply(input) {
    const artifact = cloneDocumentArtifact(input);
    if (artifact.outline && artifact.outline.length > 0) {
      return { artifact, status: 'skipped' };
    }

    const candidates = artifact.blocks.flatMap((block, blockIndex) => {
      const metadataHeading = headingFromMetadata(block, blockIndex);
      return metadataHeading ? [metadataHeading] : headingsFromText(block, blockIndex);
    });
    artifact.outline =
      candidates.length > 0
        ? candidatesToOutline(candidates, artifact.blocks)
        : logicalOutline(artifact);

    const diagnostics: DocumentDiagnostic[] = [
      {
        severity: 'info',
        message:
          candidates.length > 0
            ? `Detected ${artifact.outline.length} document heading(s).`
            : `No headings detected; created ${artifact.outline.length} logical section(s).`,
        metadata: {
          outlineNodeCount: artifact.outline.length,
          strategy: candidates.length > 0 ? 'heading' : 'logical',
        },
      },
    ];
    return { artifact, diagnostics };
  },
};
