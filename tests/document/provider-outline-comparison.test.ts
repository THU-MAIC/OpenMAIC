import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DOCUMENT_TRANSFORMS,
  parsedPdfToDocumentArtifact,
  transformDocument,
} from '@/lib/document';
import type { DocumentArtifact, DocumentOutlineSource } from '@/lib/document';
import type { ParsedPdfContent } from '@/lib/types/pdf';

const context = {
  purpose: 'course-generation' as const,
  budget: { maxTextChars: 50_000, maxVisionImages: 20 },
};

function outlineReport(artifact: DocumentArtifact) {
  const outline = artifact.outline ?? [];
  const titleCounts = new Map<string, number>();
  const sourceBreakdown: Partial<Record<DocumentOutlineSource, number>> = {};
  const levelBreakdown: Record<number, number> = {};

  for (const node of outline) {
    const title = node.title
      .replace(/^#+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    sourceBreakdown[node.source] = (sourceBreakdown[node.source] ?? 0) + 1;
    levelBreakdown[node.level] = (levelBreakdown[node.level] ?? 0) + 1;
  }

  return {
    totalNodes: outline.length,
    uniqueTitles: titleCounts.size,
    duplicateOccurrences: Array.from(titleCounts.values()).reduce(
      (total, count) => total + Math.max(0, count - 1),
      0,
    ),
    sourceBreakdown,
    levelBreakdown,
    logicalFallback: outline.some((node) => node.source === 'logical'),
    logicalRanges: outline
      .filter((node) => node.source === 'logical')
      .map((node) => [node.startOffset, node.endOffset]),
  };
}

async function reportFor(providerId: string, parsed: ParsedPdfContent) {
  const artifact = parsedPdfToDocumentArtifact(parsed, {
    buffer: Buffer.from(providerId),
    fileName: 'structured-paper.pdf',
    mimeType: 'application/pdf',
    config: { providerId },
  });
  const transformed = await transformDocument(artifact, DEFAULT_DOCUMENT_TRANSFORMS, context);
  return {
    outline: transformed.artifact.outline,
    report: outlineReport(transformed.artifact),
  };
}

describe('cross-provider outline comparison', () => {
  it('produces a consistent three-section hierarchy from representative provider shapes', async () => {
    const unpdf = await reportFor('unpdf', {
      text: [
        '1 Introduction',
        'Overview of the paper.',
        '1.1 Scope',
        'Scope details.',
        '2 Methods',
        'Method details.',
      ].join('\n'),
      images: [],
      metadata: { pageCount: 3, parser: 'unpdf' },
    });
    const mineru = await reportFor('mineru', {
      text: '# Introduction\n\nOverview.\n\n## Scope\n\nDetails.\n\n# Methods\n\nMethod details.',
      images: [],
      metadata: { pageCount: 3, parser: 'mineru' },
    });
    const alidocmind = await reportFor('alidocmind', {
      text: '# Introduction\n\nOverview.\n\n## Scope\n\nDetails.\n\n# Methods',
      images: [],
      layout: [
        { page: 1, type: 'title', content: 'Introduction', level: 1 },
        { page: 1, type: 'text', content: 'Overview.' },
        { page: 2, type: 'title', content: 'Scope', level: 2 },
        { page: 2, type: 'title', content: 'Scope', level: 2 },
        { page: 3, type: 'title', content: 'Methods', level: 1 },
      ],
      metadata: { pageCount: 3, parser: 'alidocmind' },
    });

    expect(unpdf.report).toMatchObject({
      totalNodes: 3,
      uniqueTitles: 3,
      duplicateOccurrences: 0,
      sourceBreakdown: { heuristic: 3 },
      levelBreakdown: { 1: 2, 2: 1 },
      logicalFallback: false,
    });
    expect(mineru.report).toMatchObject({
      totalNodes: 3,
      uniqueTitles: 3,
      duplicateOccurrences: 0,
      sourceBreakdown: { heading: 3 },
      levelBreakdown: { 1: 2, 2: 1 },
      logicalFallback: false,
    });
    expect(alidocmind.report).toMatchObject({
      totalNodes: 3,
      uniqueTitles: 3,
      duplicateOccurrences: 0,
      sourceBreakdown: { provider: 3 },
      levelBreakdown: { 1: 2, 2: 1 },
      logicalFallback: false,
    });

    for (const result of [unpdf, mineru, alidocmind]) {
      expect(result.outline?.map(({ level }) => level)).toEqual([1, 2, 1]);
      expect(result.outline?.[1].parentId).toBe(result.outline?.[0].id);
      expect(result.outline?.[2].parentId).toBeUndefined();
    }
    expect(unpdf.outline?.map(({ title }) => title)).toEqual([
      '1 Introduction',
      '1.1 Scope',
      '2 Methods',
    ]);
    expect(mineru.outline?.map(({ title }) => title)).toEqual(['Introduction', 'Scope', 'Methods']);
    expect(alidocmind.outline?.map(({ title }) => title)).toEqual([
      'Introduction',
      'Scope',
      'Methods',
    ]);
  });
});
