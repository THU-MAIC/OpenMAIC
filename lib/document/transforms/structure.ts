import type {
  DocumentArtifact,
  DocumentBlock,
  DocumentDiagnostic,
  DocumentOutlineNode,
} from '../types';
import type { DocumentTransform } from './types';
import { cloneDocumentArtifact } from './utils';

const LOGICAL_SECTION_CHARS = 12_000;
const MAX_HEADING_CHARS = 160;
const MIN_REPEATED_RUNNING_PAGES = 3;
const MIN_REPEATED_RUNNING_PAGE_COVERAGE = 0.6;
const MARKDOWN_HEADING = /^(#{1,6})[ \t]+(.+?)\s*$/gm;
const NUMBERED_HEADING =
  /^(?:(?:chapter\s+\d+|第[一二三四五六七八九十百零〇0-9]+[章节篇部]|\d+(?:\.\d+){0,3})[\s、.:：-]+.+|第[一二三四五六七八九十百零〇0-9]+条(?:[\s、.:：-]*.*))$/gim;

interface HeadingCandidate {
  title: string;
  level: number;
  block: DocumentBlock;
  blockIndex: number;
  pageNumber?: number;
  startOffset?: number;
  source: DocumentOutlineNode['source'];
  confidence: number;
}

interface ReconciledHeadings {
  candidates: HeadingCandidate[];
  matchedCount: number;
  unmatchedProviderCount: number;
  unmatchedTextCount: number;
}

function looksLikeBodyParagraph(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_HEADING_CHARS) return true;

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const sentenceMarks = text.match(/[.!?。！？…](?:\s|$)/g)?.length ?? 0;
  return sentenceMarks >= 2 || (wordCount >= 8 && /[.!?。！？…]$/.test(text));
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
  if (!title || looksLikeBodyParagraph(title)) return undefined;
  const normalizedLevel =
    typeof headingLevel === 'number' && Number.isFinite(headingLevel)
      ? Math.max(1, Math.trunc(headingLevel))
      : undefined;
  return {
    title: title.split('\n')[0],
    level: normalizedLevel ?? 1,
    block,
    blockIndex,
    pageNumber: block.pageNumber,
    source: normalizedLevel === undefined ? 'heading' : 'provider',
    confidence: normalizedLevel === undefined ? 0.9 : 1,
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
      pageNumber: block.pageNumber,
      startOffset: match.index,
      source: 'heading',
      confidence: 0.95,
    });
  }
  for (const match of text.matchAll(NUMBERED_HEADING)) {
    const heading = match[0].trim();
    if (heading.length > MAX_HEADING_CHARS) continue;
    const numberedPrefix = heading.match(/^\d+(?:\.\d+)*/)?.[0];
    const chineseSubsection = /^第.+[节条]/.test(heading);
    candidates.push({
      title: heading,
      level: numberedPrefix
        ? Math.min(6, numberedPrefix.split('.').length)
        : chineseSubsection
          ? 2
          : 1,
      block,
      blockIndex,
      pageNumber: block.pageNumber,
      startOffset: match.index,
      source: 'heuristic',
      confidence: 0.75,
    });
  }
  return candidates
    .sort((a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0))
    .filter(
      (candidate, index, all) =>
        index === 0 ||
        candidate.startOffset !== all[index - 1].startOffset ||
        normalizedHeadingTitle(candidate.title) !== normalizedHeadingTitle(all[index - 1].title),
    );
}

function normalizedHeadingTitle(value: string): string {
  return value
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function deduplicateAdjacentProviderHeadings(candidates: HeadingCandidate[]): HeadingCandidate[] {
  return candidates.filter((candidate, index) => {
    const previous = candidates[index - 1];
    if (!previous) return true;
    return !(
      typeof candidate.block.pageNumber === 'number' &&
      candidate.block.pageNumber === previous.block.pageNumber &&
      candidate.blockIndex === previous.blockIndex + 1 &&
      candidate.level === previous.level &&
      normalizedHeadingTitle(candidate.title) === normalizedHeadingTitle(previous.title)
    );
  });
}

function repeatedRunningHeadingTitles(
  artifact: DocumentArtifact,
  candidates: HeadingCandidate[],
): Set<string> {
  const documentPageCount =
    artifact.metadata.pageCount ??
    new Set(
      artifact.blocks
        .map((block) => block.pageNumber)
        .filter((page): page is number => typeof page === 'number'),
    ).size;
  if (documentPageCount < MIN_REPEATED_RUNNING_PAGES) return new Set();

  const pagesByTitle = new Map<string, Set<number>>();
  for (const candidate of candidates) {
    if (typeof candidate.block.pageNumber !== 'number') continue;
    const title = normalizedHeadingTitle(candidate.title);
    const pages = pagesByTitle.get(title) ?? new Set<number>();
    pages.add(candidate.block.pageNumber);
    pagesByTitle.set(title, pages);
  }

  return new Set(
    Array.from(pagesByTitle.entries())
      .filter(
        ([, pages]) =>
          pages.size >= MIN_REPEATED_RUNNING_PAGES &&
          pages.size / documentPageCount >= MIN_REPEATED_RUNNING_PAGE_COVERAGE,
      )
      .map(([title]) => title),
  );
}

function mergeMatchedHeading(
  textHeading: HeadingCandidate,
  providerHeading: HeadingCandidate,
): HeadingCandidate {
  if (providerHeading.source !== 'provider') return textHeading;
  return {
    ...textHeading,
    title: providerHeading.title,
    level: providerHeading.level,
    pageNumber: providerHeading.pageNumber,
    source: 'provider',
    confidence: providerHeading.confidence,
  };
}

function reconcileHeadings(
  providerHeadings: HeadingCandidate[],
  textHeadings: HeadingCandidate[],
): ReconciledHeadings {
  if (providerHeadings.length === 0) {
    return {
      candidates: textHeadings,
      matchedCount: 0,
      unmatchedProviderCount: 0,
      unmatchedTextCount: textHeadings.length,
    };
  }
  if (textHeadings.length === 0) {
    return {
      candidates: providerHeadings,
      matchedCount: 0,
      unmatchedProviderCount: providerHeadings.length,
      unmatchedTextCount: 0,
    };
  }

  const matchedTextIndexes = new Set<number>();
  const textIndexByProviderIndex = new Map<number, number>();
  let lastMatchedTextIndex = -1;

  for (const [providerIndex, providerHeading] of providerHeadings.entries()) {
    const providerTitle = normalizedHeadingTitle(providerHeading.title);
    const textIndex = textHeadings.findIndex(
      (textHeading, index) =>
        index > lastMatchedTextIndex &&
        !matchedTextIndexes.has(index) &&
        normalizedHeadingTitle(textHeading.title) === providerTitle,
    );
    if (textIndex < 0) continue;
    matchedTextIndexes.add(textIndex);
    textIndexByProviderIndex.set(providerIndex, textIndex);
    lastMatchedTextIndex = Math.max(lastMatchedTextIndex, textIndex);
  }

  const providerByTextIndex = new Map<number, HeadingCandidate>();
  for (const [providerIndex, textIndex] of textIndexByProviderIndex) {
    providerByTextIndex.set(textIndex, providerHeadings[providerIndex]);
  }

  const providersBeforeTextIndex = new Map<number, HeadingCandidate[]>();
  const providersAfterText = [] as HeadingCandidate[];
  for (const [providerIndex, providerHeading] of providerHeadings.entries()) {
    if (textIndexByProviderIndex.has(providerIndex)) continue;
    const nextMatchedProviderIndex = Array.from(textIndexByProviderIndex.keys()).find(
      (matchedProviderIndex) => matchedProviderIndex > providerIndex,
    );
    if (nextMatchedProviderIndex === undefined) {
      providersAfterText.push(providerHeading);
      continue;
    }
    const textIndex = textIndexByProviderIndex.get(nextMatchedProviderIndex) as number;
    const pending = providersBeforeTextIndex.get(textIndex) ?? [];
    pending.push(providerHeading);
    providersBeforeTextIndex.set(textIndex, pending);
  }

  const candidates: HeadingCandidate[] = [];
  for (const [textIndex, textHeading] of textHeadings.entries()) {
    candidates.push(...(providersBeforeTextIndex.get(textIndex) ?? []));
    const providerHeading = providerByTextIndex.get(textIndex);
    candidates.push(
      providerHeading ? mergeMatchedHeading(textHeading, providerHeading) : textHeading,
    );
  }
  candidates.push(...providersAfterText);

  return {
    candidates,
    matchedCount: matchedTextIndexes.size,
    unmatchedProviderCount: providerHeadings.length - matchedTextIndexes.size,
    unmatchedTextCount: textHeadings.length - matchedTextIndexes.size,
  };
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
      pageStart: candidate.pageNumber ?? candidate.block.pageNumber,
      pageEnd: lastSectionBlock.pageNumber ?? candidate.pageNumber ?? candidate.block.pageNumber,
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

function findLogicalSectionEnd(text: string, startOffset: number): number {
  const hardEnd = Math.min(text.length, startOffset + LOGICAL_SECTION_CHARS);
  if (hardEnd === text.length) return hardEnd;

  const minimumUsefulEnd = startOffset + Math.floor(LOGICAL_SECTION_CHARS * 0.6);
  const paragraphEnd = text.lastIndexOf('\n\n', hardEnd);
  if (paragraphEnd >= minimumUsefulEnd) return paragraphEnd + 2;

  const lineEnd = text.lastIndexOf('\n', hardEnd);
  if (lineEnd >= minimumUsefulEnd) return lineEnd + 1;

  for (let index = hardEnd - 1; index >= minimumUsefulEnd; index -= 1) {
    if ('.!?。！？'.includes(text[index])) return index + 1;
  }
  return hardEnd;
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
    let startOffset = 0;
    while (startOffset < text.length) {
      const endOffset = findLogicalSectionEnd(text, startOffset);
      nodes.push({
        id: `logical_${nodes.length + 1}`,
        title: `Section ${nodes.length + 1}`,
        level: 1,
        order: nodes.length + 1,
        blockIds: [block.id],
        pageStart: block.pageNumber,
        pageEnd: block.pageNumber,
        startOffset,
        endOffset,
        confidence: 0.3,
        source: 'logical',
      });
      startOffset = endOffset;
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

    const metadataHeadings = artifact.blocks.flatMap((block, blockIndex) => {
      const metadataHeading = headingFromMetadata(block, blockIndex);
      return metadataHeading ? [metadataHeading] : [];
    });
    const deduplicatedMetadataHeadings = deduplicateAdjacentProviderHeadings(metadataHeadings);
    const repeatedRunningTitles = repeatedRunningHeadingTitles(
      artifact,
      deduplicatedMetadataHeadings,
    );
    const selectedMetadataHeadings = deduplicatedMetadataHeadings.filter(
      (heading) => !repeatedRunningTitles.has(normalizedHeadingTitle(heading.title)),
    );
    const providerHeadings = selectedMetadataHeadings.filter(
      (heading) => heading.source === 'provider',
    );
    const textHeadings = artifact.blocks.flatMap((block, blockIndex) =>
      block.type === 'text' || block.type === 'markdown' ? headingsFromText(block, blockIndex) : [],
    );
    const reconciled = reconcileHeadings(selectedMetadataHeadings, textHeadings);
    const candidates = reconciled.candidates;
    const strategy =
      selectedMetadataHeadings.length > 0 && textHeadings.length > 0
        ? 'hybrid'
        : providerHeadings.length > 0
          ? 'provider'
          : candidates.length > 0
            ? 'heading'
            : 'logical';
    artifact.outline =
      candidates.length > 0
        ? candidatesToOutline(candidates, artifact.blocks)
        : logicalOutline(artifact);

    const diagnostics: DocumentDiagnostic[] = [
      {
        severity: 'info',
        message:
          strategy === 'hybrid'
            ? `Reconciled provider and text headings into ${artifact.outline.length} section(s).`
            : strategy === 'provider'
              ? `Reused ${artifact.outline.length} provider heading(s).`
              : candidates.length > 0
                ? `Detected ${artifact.outline.length} document heading(s).`
                : `No headings detected; created ${artifact.outline.length} logical section(s).`,
        metadata: {
          outlineNodeCount: artifact.outline.length,
          strategy,
          providerHeadingCount: metadataHeadings.length,
          textHeadingCount: textHeadings.length,
          matchedHeadingCount: reconciled.matchedCount,
          unmatchedProviderHeadingCount: reconciled.unmatchedProviderCount,
          unmatchedTextHeadingCount: reconciled.unmatchedTextCount,
          duplicateProviderHeadingsRemoved:
            metadataHeadings.length - deduplicatedMetadataHeadings.length,
          repeatedRunningHeadingsRemoved:
            deduplicatedMetadataHeadings.length - selectedMetadataHeadings.length,
        },
      },
    ];
    if (providerHeadings.length > 0 && reconciled.unmatchedTextCount > 0) {
      diagnostics.push({
        severity: 'warning',
        message: `Provider structure was partial; retained ${reconciled.unmatchedTextCount} additional text heading(s).`,
        metadata: {
          providerHeadingCount: providerHeadings.length,
          matchedHeadingCount: reconciled.matchedCount,
          retainedTextHeadingCount: reconciled.unmatchedTextCount,
        },
      });
    }
    return { artifact, diagnostics };
  },
};
