import type { DocumentArtifact, DocumentBlock, DocumentDiagnostic } from '../types';
import type { DocumentTransform } from './types';
import { cloneDocumentArtifact } from './utils';

const BARE_PAGE_NUMBER = /^\d{1,4}$/;
const EXPLICIT_PAGE_NUMBER = /^(?:page\s*\d{1,4}|[-–—]\s*\d{1,4}\s*[-–—])$/i;
const MAX_REPEATED_NOISE_CHARS = 120;
const MIN_REPEATED_PAGES = 3;
const MIN_PAGE_COVERAGE = 0.6;

function normalizedBlockText(block: DocumentBlock): string {
  return (block.text ?? block.html ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function isExplicitHeaderOrFooter(block: DocumentBlock): boolean {
  const role = block.metadata?.role;
  const layoutType = block.metadata?.layoutType;
  if (
    role === 'header' ||
    role === 'footer' ||
    layoutType === 'header' ||
    layoutType === 'footer'
  ) {
    return true;
  }

  const bbox = block.bbox;
  if (!bbox) return false;
  const normalizedCoordinates =
    bbox.x >= 0 &&
    bbox.y >= 0 &&
    bbox.width >= 0 &&
    bbox.height >= 0 &&
    bbox.x + bbox.width <= 1.01 &&
    bbox.y + bbox.height <= 1.01;
  return normalizedCoordinates && (bbox.y <= 0.12 || bbox.y + bbox.height >= 0.88);
}

function removableRepeatedTexts(artifact: DocumentArtifact): Set<string> {
  const documentPages = new Set(
    artifact.blocks
      .map((block) => block.pageNumber)
      .filter((page): page is number => typeof page === 'number'),
  );
  if (documentPages.size < MIN_REPEATED_PAGES) return new Set();

  const pagesByText = new Map<string, Set<number>>();
  for (const block of artifact.blocks) {
    if (typeof block.pageNumber !== 'number' || !isExplicitHeaderOrFooter(block)) continue;
    const text = normalizedBlockText(block);
    if (!text || text.length > MAX_REPEATED_NOISE_CHARS) continue;
    const pages = pagesByText.get(text) ?? new Set<number>();
    pages.add(block.pageNumber);
    pagesByText.set(text, pages);
  }

  return new Set(
    Array.from(pagesByText.entries())
      .filter(
        ([, pages]) =>
          pages.size >= MIN_REPEATED_PAGES && pages.size / documentPages.size >= MIN_PAGE_COVERAGE,
      )
      .map(([text]) => text),
  );
}

function cleanReferences(artifact: DocumentArtifact, removedBlockIds: ReadonlySet<string>): void {
  artifact.citations = artifact.citations?.filter(
    (citation) => !citation.blockId || !removedBlockIds.has(citation.blockId),
  );
}

export const removeDocumentNoiseTransform: DocumentTransform = {
  id: 'remove-noise',
  displayName: 'Remove repeated document noise',
  version: '1.0.0',
  capabilities: {},
  apply(input) {
    const artifact = cloneDocumentArtifact(input);
    const repeatedTexts = removableRepeatedTexts(artifact);
    const removedBlockIds = new Set<string>();

    artifact.blocks = artifact.blocks.filter((block) => {
      const text = normalizedBlockText(block);
      const standalonePageNumber =
        Boolean(text) &&
        ((block.metadata?.role === 'page-number' &&
          (BARE_PAGE_NUMBER.test(text) || EXPLICIT_PAGE_NUMBER.test(text))) ||
          (EXPLICIT_PAGE_NUMBER.test(text) && isExplicitHeaderOrFooter(block)));
      const repeatedHeaderOrFooter =
        Boolean(text) && isExplicitHeaderOrFooter(block) && repeatedTexts.has(text);
      if (standalonePageNumber || repeatedHeaderOrFooter) removedBlockIds.add(block.id);
      return !standalonePageNumber && !repeatedHeaderOrFooter;
    });
    cleanReferences(artifact, removedBlockIds);

    const diagnostics: DocumentDiagnostic[] = [];
    if (removedBlockIds.size > 0) {
      diagnostics.push({
        severity: 'info',
        message: `Removed ${removedBlockIds.size} repeated header, footer, or page-number block(s).`,
        metadata: { removedBlockIds: Array.from(removedBlockIds) },
      });
    }
    return {
      artifact,
      diagnostics,
      status: removedBlockIds.size > 0 ? 'applied' : 'skipped',
    };
  },
};
