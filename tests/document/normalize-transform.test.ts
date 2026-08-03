import { describe, expect, it } from 'vitest';

import { normalizeDocumentTransform } from '@/lib/document';
import type { DocumentArtifact } from '@/lib/document';

const context = {
  purpose: 'course-generation' as const,
  budget: { maxTextChars: 1000, maxVisionImages: 5 },
};

describe('document normalization transform', () => {
  it('sanitizes text, removes empty text blocks, and merges adjacent compatible blocks', async () => {
    const input: DocumentArtifact = {
      metadata: { fileName: 'notes.txt' },
      blocks: [
        { id: 'a', type: 'text', text: '  First\r\nline\u0000  ' },
        { id: 'empty', type: 'text', text: ' \n ' },
        { id: 'b', type: 'text', text: 'Second   line' },
        { id: 'formula', type: 'formula', text: '' },
      ],
      assets: [],
      citations: [{ id: 'citation-b', blockId: 'b' }],
    };

    const output = await normalizeDocumentTransform.apply(input, context);

    expect(input.blocks).toHaveLength(4);
    expect(output.artifact.blocks).toEqual([
      {
        id: 'a',
        type: 'text',
        text: 'First\nline\n\nSecond line',
        html: undefined,
        metadata: { sourceBlockIds: ['a', 'b'] },
      },
      { id: 'formula', type: 'formula', text: '', html: undefined },
    ]);
    expect(output.artifact.citations?.[0].blockId).toBe('a');
    expect(output.diagnostics?.[0].metadata).toEqual({
      removedEmptyBlocks: 1,
      mergedBlockCount: 1,
    });
  });

  it('does not merge blocks across pages', async () => {
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [
        { id: 'p1', type: 'text', text: 'Page one', pageNumber: 1 },
        { id: 'p2', type: 'text', text: 'Page two', pageNumber: 2 },
      ],
      assets: [],
    };

    const output = await normalizeDocumentTransform.apply(input, context);
    expect(output.artifact.blocks.map((block) => block.id)).toEqual(['p1', 'p2']);
  });

  it('preserves indentation and whitespace-significant Markdown', async () => {
    const markdown = [
      '    def f():',
      '        return 1',
      '',
      '```text',
      'column A    column B',
      '```',
      'hard break  ',
      'next line',
    ].join('\r\n');
    const input: DocumentArtifact = {
      metadata: { mimeType: 'text/markdown' },
      blocks: [{ id: 'markdown', type: 'markdown', text: markdown }],
      assets: [],
    };

    const output = await normalizeDocumentTransform.apply(input, context);

    expect(output.artifact.blocks[0].text).toBe(markdown.replace(/\r\n/g, '\n'));
  });

  it('does not merge text blocks that carry HTML payloads', async () => {
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [
        { id: 'a', type: 'text', text: 'First', html: '<p>First</p>' },
        { id: 'b', type: 'text', text: 'Second', html: '<p>Second</p>' },
      ],
      assets: [],
    };

    const output = await normalizeDocumentTransform.apply(input, context);

    expect(output.artifact.blocks).toHaveLength(2);
    expect(output.artifact.blocks.map((block) => block.html)).toEqual([
      '<p>First</p>',
      '<p>Second</p>',
    ]);
  });

  it('removes citations to discarded empty blocks', async () => {
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [
        { id: 'empty', type: 'text', text: '   ' },
        { id: 'keep', type: 'text', text: 'Keep this content' },
      ],
      assets: [],
      citations: [
        { id: 'empty-citation', blockId: 'empty' },
        { id: 'keep-citation', blockId: 'keep' },
      ],
    };

    const output = await normalizeDocumentTransform.apply(input, context);

    expect(output.artifact.citations).toEqual([{ id: 'keep-citation', blockId: 'keep' }]);
  });
});
