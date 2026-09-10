import { describe, expect, it } from 'vitest';

import { KNOWLEDGE_MODALITIES } from '@/lib/rag';
import type {
  KnowledgeChunk,
  KnowledgeIndex,
  KnowledgeIndexReplaceRequest,
  KnowledgeLineage,
  KnowledgeLocator,
  KnowledgeResource,
} from '@/lib/rag';

const lineage: KnowledgeLineage = {
  sourceHash: 'sha256:manual-v1',
  extractor: { id: 'plain-text', version: '1.0.0' },
  transforms: [{ id: 'normalize', version: '1.0.0' }],
  chunkPolicy: { id: 'document-block', version: '1.0.0' },
};

describe('RAG domain contract', () => {
  it('exposes the stable modality vocabulary', () => {
    expect(KNOWLEDGE_MODALITIES).toEqual(['document', 'html']);
  });

  it('preserves document anchors and lineage as typed records', () => {
    const locator: KnowledgeLocator = {
      kind: 'document',
      blockId: 'block-1',
      pageNumber: 4,
      heading: 'Safety',
    };
    const resource: KnowledgeResource = {
      id: 'resource-manual',
      workspaceId: 'workspace-test',
      courseId: 'course-1',
      resourceVersionId: 'resource-version-1',
      modality: 'document',
      title: 'Manual',
      sourceRef: 'source://manual.md',
      contentHash: 'sha256:manual-v1',
      status: 'ready',
      lineage,
      metadata: { chapterId: 'chapter-1' },
    };
    const chunk: KnowledgeChunk = {
      id: 'resource-manual:block-1:0',
      resourceId: resource.id,
      resourceVersionId: resource.resourceVersionId,
      workspaceId: resource.workspaceId,
      courseId: resource.courseId,
      ordinal: 0,
      text: 'Wear protective equipment.',
      contentHash: 'sha256:chunk-v1',
      locator,
      lineage,
      metadata: { pageNumber: 4 },
    };

    expect(chunk).toMatchObject({
      resourceId: 'resource-manual',
      locator: { kind: 'document', blockId: 'block-1', pageNumber: 4 },
      lineage: { sourceHash: 'sha256:manual-v1' },
    });
    expect(resource.courseId).toBe('course-1');
  });

  it('supports an index implementation without coupling it to a storage backend', async () => {
    const index: KnowledgeIndex = {
      id: 'test-index',
      capabilities: { lexical: true, vector: false, metadataFilter: true },
      async replaceResourceVersion(_request: KnowledgeIndexReplaceRequest) {},
      async delete() {},
      async query() {
        return [];
      },
    };

    await expect(
      index.query({ workspaceId: 'workspace-test', courseScope: 'all', text: 'safety', topK: 3 }),
    ).resolves.toEqual([]);
  });
});
