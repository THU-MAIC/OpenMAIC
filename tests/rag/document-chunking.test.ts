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
    courseId: 'course-1',
    resourceVersionId: 'resource-version-1',
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
    metadata: { chapterId: 'chapter-1' },
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

  it('projects br tags to line breaks before sanitizing HTML', () => {
    const chunks = chunkDocumentArtifact(
      {
        metadata: {},
        blocks: [
          {
            id: 'html-breaks',
            type: 'layout',
            html: '<p>First<br data-note="a > b">Second<BR class=\'x > y\'/>Third</p>',
          },
        ],
        assets: [],
      },
      resource(),
    );

    expect(chunks[0]?.text).toBe('First\nSecond\nThird');
  });

  it('does not project custom element names beginning with br as line breaks', () => {
    const chunks = chunkDocumentArtifact(
      {
        metadata: {},
        blocks: [
          {
            id: 'html-custom-element',
            type: 'layout',
            html: '<p>First<br-foo>Second<br>Third</p>',
          },
        ],
        assets: [],
      },
      resource(),
    );

    expect(chunks[0]?.text).toBe('FirstSecond\nThird');
  });

  it('does not treat non-HTML whitespace as a br tag-name terminator', () => {
    const chunks = chunkDocumentArtifact(
      {
        metadata: {},
        blocks: [
          {
            id: 'html-non-breaking-space',
            type: 'layout',
            html: '<p>First<br\u00a0foo>Second<br>Third</p>',
          },
        ],
        assets: [],
      },
      resource(),
    );

    expect(chunks[0]?.text).toBe('FirstSecond\nThird');
  });

  it('preserves text boundaries for HTML end tags with ASCII whitespace', () => {
    const chunks = chunkDocumentArtifact(
      {
        metadata: {},
        blocks: [
          {
            id: 'html-end-tag-whitespace',
            type: 'layout',
            html: '<p>First</p ><p>Second</p><ul><li>Third</li\t><li>Fourth</li></ul>',
          },
        ],
        assets: [],
      },
      resource(),
    );

    expect(chunks[0]?.text).toBe('First\nSecond\nThird\nFourth');
  });

  it('preserves boundaries for HTML elements with omitted optional end tags', () => {
    const chunks = chunkDocumentArtifact(
      {
        metadata: {},
        blocks: [
          {
            id: 'html-optional-end-tags',
            type: 'layout',
            html: '<p>First<p>Second<ul><li>Third<li>Fourth</ul>',
          },
        ],
        assets: [],
      },
      resource(),
    );

    expect(chunks[0]?.text).toBe('First\nSecond\nThird\nFourth');
  });

  it('keeps text in one chunk when it exactly fits the grapheme limit', () => {
    const chunks = chunkDocumentArtifact(
      {
        metadata: {},
        blocks: [{ id: 'exact-fit', type: 'text', text: 'abc d' }],
        assets: [],
      },
      resource(),
      { maxChars: 5 },
    );

    expect(chunks.map((chunk) => chunk.text)).toEqual(['abc d']);
  });

  it('still splits text that exceeds the grapheme limit by one', () => {
    const chunks = chunkDocumentArtifact(
      {
        metadata: {},
        blocks: [{ id: 'over-limit', type: 'text', text: 'abc de' }],
        assets: [],
      },
      resource(),
      { maxChars: 5 },
    );

    expect(chunks.map((chunk) => chunk.text)).toEqual(['abc', 'de']);
  });

  it('does not split grapheme clusters when applying the chunk limit', () => {
    const chunks = chunkDocumentArtifact(
      {
        metadata: {},
        blocks: [{ id: 'unicode', type: 'text', text: '👩‍🔬👨‍🚀e\u0301' }],
        assets: [],
      },
      resource(),
      { maxChars: 1 },
    );

    expect(chunks.map((chunk) => chunk.text)).toEqual(['👩‍🔬', '👨‍🚀', 'é']);
    expect(chunks.every((chunk) => chunk.text.length > 0)).toBe(true);
    expect(chunks[0]?.lineage.chunkPolicy.version).toBe('1.1.3:maxChars=1:unit=grapheme-cluster');
  });

  it(
    'handles long unbroken text without runtime-dependent grapheme rescans',
    { timeout: 2000 },
    () => {
      const longText = 'x'.repeat(100_000);
      const chunks = chunkDocumentArtifact(
        {
          metadata: {},
          blocks: [{ id: 'long-unbroken', type: 'text', text: longText }],
          assets: [],
        },
        resource(),
      );

      expect(chunks).toHaveLength(Math.ceil(longText.length / DOCUMENT_CHUNK_POLICY.maxChars));
      expect(chunks.map((chunk) => chunk.text).join('')).toBe(longText);
    },
  );

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
