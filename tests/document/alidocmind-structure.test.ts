import { describe, expect, it } from 'vitest';

import { parsedPdfToDocumentArtifact } from '@/lib/document';
import { detectDocumentStructureTransform } from '@/lib/document/transforms';
import { aliDocMindLayoutsToParsedPdf } from '@/lib/pdf/pdf-providers';

const context = {
  purpose: 'course-generation' as const,
  budget: { maxTextChars: 50_000, maxVisionImages: 20 },
};

describe('AliDocMind structure preservation', () => {
  it('threads native heading levels into provider outline nodes and suppresses text duplicates', async () => {
    const parsed = await aliDocMindLayoutsToParsedPdf(
      {
        data: {
          layouts: [
            {
              type: 'title',
              text: 'Introduction',
              markdownContent: '# Introduction',
              pageNum: 0,
              level: 1,
            },
            { type: 'text', text: 'Overview', pageNum: 0 },
            {
              type: 'title',
              text: 'Scope',
              markdownContent: '### Scope',
              pageNum: 0,
              level: 3,
            },
            // A duplicate native layout signal must not create another node.
            { type: 'title', text: 'Scope', pageNum: 0, level: 3 },
          ],
        },
        pageCountEstimate: 0,
        jobId: 'job-1',
      },
      'paper.pdf',
    );

    expect(parsed.layout?.filter((layout) => layout.type === 'title')).toEqual([
      { page: 1, type: 'title', content: 'Introduction', level: 1 },
      { page: 1, type: 'title', content: 'Scope', level: 3 },
      { page: 1, type: 'title', content: 'Scope', level: 3 },
    ]);

    const artifact = parsedPdfToDocumentArtifact(parsed, {
      buffer: Buffer.from('pdf'),
      fileName: 'paper.pdf',
      mimeType: 'application/pdf',
      config: { providerId: 'alidocmind' },
    });
    const output = await detectDocumentStructureTransform.apply(artifact, context);

    expect(output.artifact.outline).toHaveLength(2);
    expect(output.artifact.outline).toMatchObject([
      { title: 'Introduction', level: 1, source: 'provider' },
      { title: 'Scope', level: 3, source: 'provider', parentId: 'outline_1' },
    ]);
    expect(output.diagnostics?.[0].metadata).toMatchObject({
      strategy: 'hybrid',
      providerHeadingCount: 3,
      textHeadingCount: 2,
      matchedHeadingCount: 2,
      duplicateProviderHeadingsRemoved: 1,
    });
  });

  it('normalizes a zero-based AliDocMind heading hierarchy to one-based levels', async () => {
    const parsed = await aliDocMindLayoutsToParsedPdf(
      {
        data: {
          layouts: [
            { type: 'title', text: 'Contract', pageNum: 0, level: 0 },
            { type: 'title', text: 'Terms', pageNum: 0, level: 1 },
          ],
        },
      },
      'contract.docx',
    );

    expect(parsed.layout).toMatchObject([
      { content: 'Contract', level: 1 },
      { content: 'Terms', level: 2 },
    ]);
  });
});
