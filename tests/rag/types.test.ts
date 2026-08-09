import { describe, expect, it } from 'vitest';

import { KNOWLEDGE_MODALITIES } from '@/lib/rag';
import type {
  GroundingContextRef,
  KnowledgeChunk,
  KnowledgeIndex,
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
    expect(KNOWLEDGE_MODALITIES).toEqual(['document', 'html', 'image', 'video', 'experiment']);
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
      modality: 'document',
      title: 'Manual',
      sourceRef: 'source://manual.md',
      contentHash: 'sha256:manual-v1',
      status: 'ready',
      lineage,
      metadata: { courseId: 'course-1', chapterId: 'chapter-1' },
    };
    const chunk: KnowledgeChunk = {
      id: 'resource-manual:block-1:0',
      resourceId: resource.id,
      workspaceId: resource.workspaceId,
      ordinal: 0,
      text: 'Wear protective equipment.',
      contentHash: 'sha256:chunk-v1',
      locator,
      lineage,
      metadata: { courseId: 'course-1', pageNumber: 4 },
    };

    expect(chunk).toMatchObject({
      resourceId: 'resource-manual',
      locator: { kind: 'document', blockId: 'block-1', pageNumber: 4 },
      lineage: { sourceHash: 'sha256:manual-v1' },
    });
    expect(resource.metadata.courseId).toBe('course-1');
  });

  it('supports an index implementation without coupling it to a storage backend', async () => {
    const index: KnowledgeIndex = {
      id: 'test-index',
      capabilities: { lexical: true, vector: false, metadataFilter: true },
      async upsert() {},
      async delete() {},
      async query() {
        return [];
      },
    };

    await expect(
      index.query({ workspaceId: 'workspace-test', text: 'safety', topK: 3 }),
    ).resolves.toEqual([]);
  });

  it('allows only an opaque server-owned grounding reference', () => {
    const reference: GroundingContextRef = { snapshotId: 'snapshot-1' };

    expect(reference).toEqual({ snapshotId: 'snapshot-1' });
  });
});
