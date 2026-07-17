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
    expect(output.artifact.outline?.[0].endOffset).toBe(
      input.blocks[0].text?.indexOf('## Inspection'),
    );
    expect(output.artifact.outline?.[1]).toMatchObject({
      title: 'Inspection',
      level: 2,
      parentId: 'outline_1',
      blockIds: ['markdown'],
    });
    expect(output.artifact.outline?.[1].endOffset).toBe(input.blocks[0].text?.length);
  });

  it('stops a parent heading at the next child heading in the same block', async () => {
    const text = '# Intro\n\nOverview\n\n## Details\n\nSpecifics';
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [{ id: 'markdown', type: 'markdown', text }],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline?.[0]).toMatchObject({
      startOffset: 0,
      endOffset: text.indexOf('## Details'),
    });
    expect(output.artifact.outline?.[1]).toMatchObject({
      startOffset: text.indexOf('## Details'),
      endOffset: text.length,
    });
  });

  it('assigns a level-skipping heading to the nearest shallower ancestor', async () => {
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [
        {
          id: 'markdown',
          type: 'markdown',
          text: '# Root\n\nIntro\n\n### Deep section\n\nDetails',
        },
      ],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline?.[1]).toMatchObject({
      title: 'Deep section',
      level: 3,
      parentId: 'outline_1',
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
      source: 'provider',
    });
  });

  it('does not let unlevelled layout titles flatten richer Markdown headings', async () => {
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [
        {
          id: 'markdown',
          type: 'markdown',
          text: '# Root\n\nOverview\n\n## Child\n\nDetails',
        },
        {
          id: 'layout-title',
          type: 'layout',
          text: 'Root',
          metadata: { layoutType: 'title' },
        },
      ],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(
      output.artifact.outline?.map(({ title, level, source }) => ({ title, level, source })),
    ).toEqual([
      { title: 'Root', level: 1, source: 'heading' },
      { title: 'Child', level: 2, source: 'heading' },
    ]);
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

  it('prefers a paragraph boundary over cutting a logical section mid-paragraph', async () => {
    const firstParagraph = 'a'.repeat(10_000);
    const secondParagraph = 'b'.repeat(4_000);
    const text = `${firstParagraph}\n\n${secondParagraph}`;
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [{ id: 'plain', type: 'text', text }],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline?.map((node) => [node.startOffset, node.endOffset])).toEqual([
      [0, firstParagraph.length + 2],
      [firstParagraph.length + 2, text.length],
    ]);
  });
});
