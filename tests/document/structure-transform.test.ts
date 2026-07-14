import { describe, expect, it } from 'vitest';

import { detectDocumentStructureTransform } from '@/lib/document';
import type { DocumentArtifact } from '@/lib/document';

const context = {
  purpose: 'course-generation' as const,
  budget: { maxTextChars: 50_000, maxVisionImages: 20 },
};

describe('document structure transform', () => {
  it('preserves a provider-supplied outline', async () => {
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [{ id: 'chapter', type: 'text', text: 'Provider chapter' }],
      assets: [],
      outline: [
        {
          id: 'provider-node',
          title: 'Provider chapter',
          level: 1,
          order: 1,
          blockIds: ['chapter'],
          confidence: 1,
          source: 'provider',
        },
      ],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);
    expect(output.status).toBe('skipped');
    expect(output.artifact.outline).toEqual(input.outline);
  });

  it('detects nested Markdown headings with offsets and parent relationships', async () => {
    const input: DocumentArtifact = {
      metadata: { fileName: 'book.md' },
      blocks: [
        {
          id: 'markdown',
          type: 'markdown',
          text: '# Safety\n\nIntroduction\n\n## Inspection\n\nCheck the machine.',
        },
      ],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline).toHaveLength(2);
    expect(output.artifact.outline?.[0]).toMatchObject({
      title: 'Safety',
      level: 1,
      blockIds: ['markdown'],
      startOffset: 0,
      source: 'heading',
    });
    expect(output.artifact.outline?.[0].endOffset).toBeGreaterThan(0);
    expect(output.artifact.outline?.[1]).toMatchObject({
      title: 'Inspection',
      level: 2,
      parentId: 'outline_1',
      blockIds: ['markdown'],
    });
  });

  it('uses explicit extractor heading metadata before text heuristics', async () => {
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [
        {
          id: 'title',
          type: 'layout',
          text: 'Machine Setup',
          pageNumber: 2,
          metadata: { headingLevel: 2, layoutType: 'heading' },
        },
        { id: 'body', type: 'text', text: 'Install the guard before startup.', pageNumber: 3 },
      ],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);
    expect(output.artifact.outline?.[0]).toMatchObject({
      title: 'Machine Setup',
      level: 2,
      pageStart: 2,
      pageEnd: 3,
      blockIds: ['title', 'body'],
      confidence: 1,
      source: 'heading',
    });
  });

  it('creates bounded logical sections when no headings are available', async () => {
    const input: DocumentArtifact = {
      metadata: { fileName: 'plain.txt' },
      blocks: [{ id: 'plain', type: 'text', text: 'x'.repeat(25_000) }],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline).toHaveLength(3);
    expect(output.artifact.outline?.map((node) => node.source)).toEqual([
      'logical',
      'logical',
      'logical',
    ]);
    expect(output.artifact.outline?.map((node) => [node.startOffset, node.endOffset])).toEqual([
      [0, 12_000],
      [12_000, 24_000],
      [24_000, 25_000],
    ]);
  });
});
