import { describe, expect, it } from 'vitest';

import { ingestDocumentForRag } from '@/lib/rag';
import type { DocumentArtifact } from '@/lib/document';

function artifact(): DocumentArtifact {
  return {
    metadata: {
      fileName: 'manual.md',
      mimeType: 'text/markdown',
      providerId: 'plain-text',
    },
    providerRaw: { provider: 'fixture', secret: 'must-not-cross-rag-boundary' },
    blocks: [
      { id: 'heading', type: 'markdown', text: '# Safety' },
      {
        id: 'body',
        type: 'text',
        pageNumber: 2,
        bbox: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
        text: '  Wear protective equipment.\r\n',
      },
      {
        id: 'page-number',
        type: 'text',
        pageNumber: 2,
        text: '2',
        metadata: { role: 'page-number' },
      },
    ],
    assets: [],
  };
}

const resource = {
  id: 'resource-manual',
  workspaceId: 'workspace-test',
  modality: 'document' as const,
  title: 'Manual',
  sourceRef: 'source://manual.md',
  contentHash: 'sha256:manual-v1',
  extractor: { id: 'plain-text', version: '1.0.0' },
  metadata: { courseId: 'course-1', chapterId: 'chapter-1' },
};

describe('document RAG ingestion', () => {
  it('transforms an artifact before emitting searchable chunks and keeps input immutable', async () => {
    const input = artifact();

    const result = await ingestDocumentForRag({ artifact: input, resource });

    expect(input.blocks[1]?.text).toBe('  Wear protective equipment.\r\n');
    expect(input.providerRaw).toEqual({
      provider: 'fixture',
      secret: 'must-not-cross-rag-boundary',
    });
    expect(result.artifact.blocks.map((block) => block.id)).toEqual(['heading', 'body']);
    expect(result.artifact.providerRaw).toBeUndefined();
    expect(result.artifact.blocks[1]?.text).toBe('Wear protective equipment.');
    expect(result.resource.status).toBe('ready');
    expect(result.resource.lineage.transforms.map((transform) => transform.id)).toEqual([
      'normalize',
      'remove-noise',
    ]);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[1]).toMatchObject({
      workspaceId: 'workspace-test',
      locator: { kind: 'document', blockId: 'body', pageNumber: 2 },
      metadata: { courseId: 'course-1', chapterId: 'chapter-1' },
    });
  });

  it('marks an artifact partial when transforms leave no searchable text', async () => {
    const result = await ingestDocumentForRag({
      artifact: {
        metadata: { fileName: 'empty.md', providerId: 'plain-text' },
        blocks: [{ id: 'empty', type: 'text', text: '   ' }],
        assets: [],
      },
      resource: { ...resource, id: 'resource-empty', title: 'Empty' },
    });

    expect(result.resource.status).toBe('partial');
    expect(result.chunks).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('no text') }),
    );
  });

  it('rebuilds the same chunk IDs and hashes for the same source and policy', async () => {
    const first = await ingestDocumentForRag({ artifact: artifact(), resource });
    const second = await ingestDocumentForRag({ artifact: artifact(), resource });

    expect(second.chunks.map((chunk) => [chunk.id, chunk.contentHash])).toEqual(
      first.chunks.map((chunk) => [chunk.id, chunk.contentHash]),
    );
  });

  it('records custom chunk limits in the effective lineage policy', async () => {
    const result = await ingestDocumentForRag({
      artifact: artifact(),
      resource,
      chunking: { maxChars: 10 },
    });

    expect(result.resource.lineage.chunkPolicy.version).toContain('maxChars=10');
    expect(
      result.chunks.every((chunk) => chunk.lineage.chunkPolicy.version.includes('maxChars=10')),
    ).toBe(true);
  });
});
