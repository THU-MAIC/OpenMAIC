import { describe, expect, it } from 'vitest';

import { removeDocumentNoiseTransform } from '@/lib/document';
import type { DocumentArtifact, DocumentBlock } from '@/lib/document';

const context = {
  purpose: 'course-generation' as const,
  budget: { maxTextChars: 50_000, maxVisionImages: 20 },
};

function pageBlocks(page: number): DocumentBlock[] {
  return [
    {
      id: `header_${page}`,
      type: 'layout',
      text: 'OpenMAIC Training Manual',
      pageNumber: page,
      metadata: { role: 'header' },
    },
    { id: `body_${page}`, type: 'text', text: `Important content ${page}`, pageNumber: page },
    {
      id: `page_${page}`,
      type: 'layout',
      text: String(page),
      pageNumber: page,
      metadata: { role: 'page-number' },
    },
  ];
}

describe('document noise-removal transform', () => {
  it('removes repeated explicit headers and page numbers while preserving body content', async () => {
    const input: DocumentArtifact = {
      metadata: { pageCount: 3 },
      blocks: [...pageBlocks(1), ...pageBlocks(2), ...pageBlocks(3)],
      assets: [],
      citations: [
        { id: 'header-citation', blockId: 'header_1' },
        { id: 'body-citation', blockId: 'body_1' },
      ],
    };

    const output = await removeDocumentNoiseTransform.apply(input, context);

    expect(output.artifact.blocks.map((block) => block.id)).toEqual(['body_1', 'body_2', 'body_3']);
    expect(output.artifact.citations).toEqual([{ id: 'body-citation', blockId: 'body_1' }]);
    expect(output.diagnostics?.[0].metadata?.removedBlockIds).toHaveLength(6);
  });

  it('does not remove repeated body text without header/footer evidence', async () => {
    const input: DocumentArtifact = {
      metadata: { pageCount: 3 },
      blocks: [1, 2, 3].map((page) => ({
        id: `body_${page}`,
        type: 'text' as const,
        text: 'Shared safety warning',
        pageNumber: page,
      })),
      assets: [],
    };

    const output = await removeDocumentNoiseTransform.apply(input, context);
    expect(output.status).toBe('skipped');
    expect(output.artifact.blocks).toHaveLength(3);
  });

  it('preserves a body block whose text matches a removable repeated header', async () => {
    const input: DocumentArtifact = {
      metadata: { pageCount: 3 },
      blocks: [
        {
          id: 'body-title',
          type: 'text',
          text: 'Course Overview',
          pageNumber: 1,
        },
        ...[1, 2, 3].map(
          (page): DocumentBlock => ({
            id: `header_${page}`,
            type: 'layout',
            text: 'Course Overview',
            pageNumber: page,
            metadata: { role: 'header' },
          }),
        ),
      ],
      assets: [],
    };

    const output = await removeDocumentNoiseTransform.apply(input, context);

    expect(output.artifact.blocks).toEqual([
      {
        id: 'body-title',
        type: 'text',
        text: 'Course Overview',
        pageNumber: 1,
      },
    ]);
    expect(output.diagnostics?.[0].metadata?.removedBlockIds).toEqual([
      'header_1',
      'header_2',
      'header_3',
    ]);
  });

  it('preserves bare numeric footer content without an explicit page-number role', async () => {
    const input: DocumentArtifact = {
      metadata: { pageCount: 2 },
      blocks: [
        {
          id: 'year',
          type: 'layout',
          text: '2024',
          pageNumber: 1,
          metadata: { role: 'footer' },
        },
        {
          id: 'code',
          type: 'layout',
          text: '512',
          pageNumber: 2,
          bbox: { x: 0.4, y: 0.92, width: 0.1, height: 0.03 },
        },
      ],
      assets: [],
    };

    const output = await removeDocumentNoiseTransform.apply(input, context);

    expect(output.status).toBe('skipped');
    expect(output.artifact.blocks.map((block) => block.id)).toEqual(['year', 'code']);
  });

  it('removes decorated page numbers with footer evidence', async () => {
    const input: DocumentArtifact = {
      metadata: { pageCount: 2 },
      blocks: [
        {
          id: 'page-prefix',
          type: 'layout',
          text: 'Page 12',
          pageNumber: 1,
          metadata: { role: 'footer' },
        },
        {
          id: 'page-dashes',
          type: 'layout',
          text: '— 13 —',
          pageNumber: 2,
          bbox: { x: 0.4, y: 0.92, width: 0.1, height: 0.03 },
        },
      ],
      assets: [],
    };

    const output = await removeDocumentNoiseTransform.apply(input, context);

    expect(output.artifact.blocks).toEqual([]);
  });
});
