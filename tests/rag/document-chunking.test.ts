import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_CHUNK_POLICY,
  chunkDocumentArtifact,
  type DocumentKnowledgeResource,
} from '@/lib/rag';
import type { DocumentArtifact } from '@/lib/document';

function resource(): DocumentKnowledgeResource {
  return {
    id: 'resource-manual',
    workspaceId: 'workspace-test',
    modality: 'document',
    title: 'Manual',
    sourceRef: 'source://manual.md',
    contentHash: 'sha256:manual-v1',
    status: 'ready',
    lineage: {
      sourceHash: 'sha256:manual-v1',
      extractor: { id: 'plain-text', version: '1.0.0' },
      transforms: [],
      chunkPolicy: { id: DOCUMENT_CHUNK_POLICY.id, version: DOCUMENT_CHUNK_POLICY.version },
    },
    metadata: { courseId: 'course-1', chapterId: 'chapter-1' },
  };
}

describe('document RAG chunking', () => {
  it('keeps block locators and metadata while splitting oversized text deterministically', () => {
    const artifact: DocumentArtifact = {
      metadata: { fileName: 'manual.md', mimeType: 'text/markdown' },
      blocks: [
        {
          id: 'block-1',
          type: 'markdown',
          pageNumber: 4,
          text: 'First paragraph has enough words.\n\nSecond paragraph keeps the same source block.',
          metadata: { heading: 'Safety' },
        },
      ],
      assets: [],
    };

    const chunks = chunkDocumentArtifact(artifact, resource(), { maxChars: 35 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 35)).toBe(true);
    expect(chunks.map((chunk) => chunk.id)).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      locator: { kind: 'document', blockId: 'block-1', pageNumber: 4, heading: 'Safety' },
      metadata: {
        courseId: 'course-1',
        chapterId: 'chapter-1',
        pageNumber: 4,
        blockType: 'markdown',
      },
    });
  });

  it('skips blocks without searchable text', () => {
    const artifact: DocumentArtifact = {
      metadata: {},
      blocks: [
        { id: 'image-1', type: 'image' },
        { id: 'empty-1', type: 'text', text: '   ' },
      ],
      assets: [],
    };

    expect(chunkDocumentArtifact(artifact, resource())).toEqual([]);
  });

  it('projects HTML blocks to searchable text without script content', () => {
    const artifact: DocumentArtifact = {
      metadata: {},
      blocks: [
        {
          id: 'html-1',
          type: 'layout',
          html: '<h2>Guide</h2><p>Wear <strong>protective</strong> equipment.</p><script>ignore()</script>',
        },
      ],
      assets: [],
    };

    const chunks = chunkDocumentArtifact(artifact, resource());

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('Guide\nWear protective equipment.');
    expect(chunks[0]?.text).not.toContain('ignore');
    expect(chunks[0]?.text).not.toContain('<strong>');
  });

  it('keeps chunk IDs distinct when source identifiers contain separators', () => {
    const left = chunkDocumentArtifact(
      { metadata: {}, blocks: [{ id: 'c', type: 'text', text: 'left' }], assets: [] },
      { ...resource(), id: 'a:b' },
    );
    const right = chunkDocumentArtifact(
      { metadata: {}, blocks: [{ id: 'b:c', type: 'text', text: 'right' }], assets: [] },
      { ...resource(), id: 'a' },
    );

    expect(left[0]?.id).not.toBe(right[0]?.id);
  });

  it('keeps duplicate block IDs distinct by source occurrence', () => {
    const chunks = chunkDocumentArtifact(
      {
        metadata: {},
        blocks: [
          { id: 'duplicate', type: 'text', text: 'first block' },
          { id: 'duplicate', type: 'text', text: 'second block' },
        ],
        assets: [],
      },
      resource(),
    );

    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(2);
    expect(chunks.map((chunk) => chunk.text)).toEqual(['first block', 'second block']);
  });
});
