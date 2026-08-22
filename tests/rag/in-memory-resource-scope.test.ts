import { describe, expect, it } from 'vitest';

import {
  InMemoryLexicalIndex,
  type KnowledgeChunk,
  type KnowledgeIndexReplaceRequest,
} from '@/lib/rag';

const lineage = {
  sourceHash: 'sha256:source',
  extractor: { id: 'plain-text', version: '1.0.0' },
  transforms: [],
  chunkPolicy: { id: 'document-block', version: '1.1.0' },
} as const;

type ChunkInput = {
  readonly id: string;
  readonly text: string;
  readonly courseId?: string;
  readonly resourceId?: string;
  readonly resourceVersionId?: string;
  readonly workspaceId?: string;
};

function chunk(input: ChunkInput): KnowledgeChunk {
  return {
    id: input.id,
    resourceId: input.resourceId ?? `resource-${input.courseId ?? 'shared'}`,
    resourceVersionId: input.resourceVersionId ?? 'resource-version-1',
    workspaceId: input.workspaceId ?? 'workspace-test',
    ...(input.courseId ? { courseId: input.courseId } : {}),
    ordinal: 0,
    text: input.text,
    contentHash: `hash-${input.id}`,
    locator: { kind: 'document', blockId: input.id, pageNumber: 1 },
    lineage,
    metadata: {},
  };
}

function replacement(chunks: readonly KnowledgeChunk[]): KnowledgeIndexReplaceRequest {
  const firstChunk = chunks[0];
  if (!firstChunk) throw new Error('replacement fixture requires a chunk');
  return {
    workspaceId: firstChunk.workspaceId,
    ...(firstChunk.courseId ? { courseId: firstChunk.courseId } : {}),
    resourceId: firstChunk.resourceId,
    resourceVersionId: firstChunk.resourceVersionId,
    chunks,
  };
}

describe('in-memory resource scope', () => {
  it('requires workspace and optional course scope for retrieval and deletion', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'same-id',
          text: 'shared safety procedure',
          courseId: 'course-a',
          workspaceId: 'workspace-a',
        }),
      ]),
    );
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'same-id',
          text: 'shared safety procedure',
          courseId: 'course-b',
          workspaceId: 'workspace-b',
        }),
      ]),
    );

    await expect(
      index.query({
        workspaceId: 'workspace-a',
        courseScope: 'exact',
        courseId: 'course-a',
        text: 'shared safety',
        topK: 5,
      }),
    ).resolves.toMatchObject([{ chunk: { id: 'same-id' } }]);
    await expect(
      index.query({
        workspaceId: 'workspace-b',
        courseScope: 'exact',
        courseId: 'course-b',
        text: 'shared safety',
        topK: 5,
      }),
    ).resolves.toMatchObject([{ chunk: { id: 'same-id' } }]);

    await index.delete({
      workspaceId: 'workspace-a',
      courseScope: 'exact',
      courseId: 'course-a',
      resourceIds: ['resource-course-a'],
    });
    await expect(
      index.query({
        workspaceId: 'workspace-b',
        courseScope: 'exact',
        courseId: 'course-b',
        text: 'shared safety',
        topK: 5,
      }),
    ).resolves.toMatchObject([{ chunk: { id: 'same-id' } }]);
  });

  it('keeps equal chunk IDs from distinct resources separate', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'shared-id',
          resourceId: 'resource-left',
          text: 'left procedure',
          courseId: 'course-1',
        }),
      ]),
    );
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'shared-id',
          resourceId: 'resource-right',
          text: 'right procedure',
          courseId: 'course-1',
        }),
      ]),
    );

    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-1',
        text: 'procedure',
        topK: 5,
      }),
    ).resolves.toHaveLength(2);
  });

  it('keeps replacement isolated when a resource ID is reused across courses', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'same-id',
          resourceId: 'shared-resource',
          resourceVersionId: 'course-a-v1',
          courseId: 'course-a',
          text: 'alpha procedure',
        }),
      ]),
    );
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'same-id',
          resourceId: 'shared-resource',
          resourceVersionId: 'course-b-v1',
          courseId: 'course-b',
          text: 'beta procedure',
        }),
      ]),
    );

    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'same-id',
          resourceId: 'shared-resource',
          resourceVersionId: 'course-a-v2',
          courseId: 'course-a',
          text: 'updated alpha procedure',
        }),
      ]),
    );

    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-b',
        text: 'beta',
        topK: 5,
      }),
    ).resolves.toMatchObject([{ chunk: { text: 'beta procedure' } }]);
    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-a',
        text: 'alpha',
        topK: 5,
      }),
    ).resolves.toMatchObject([{ chunk: { text: 'updated alpha procedure' } }]);
  });

  it('does not let an unscoped replacement remove a course-scoped resource', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'course-scoped',
          resourceId: 'shared-resource',
          resourceVersionId: 'course-a-v1',
          courseId: 'course-a',
          text: 'course scoped procedure',
        }),
      ]),
    );
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'unscoped',
          resourceId: 'shared-resource',
          resourceVersionId: 'unscoped-v1',
          text: 'unscoped procedure',
        }),
      ]),
    );

    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-a',
        text: 'course scoped',
        topK: 5,
      }),
    ).resolves.toMatchObject([{ chunk: { id: 'course-scoped' } }]);
    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        text: 'unscoped',
        topK: 5,
      }),
    ).resolves.toMatchObject([{ chunk: { id: 'unscoped' } }]);
  });

  it('queries only unscoped resources when the course scope is exact', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'unscoped',
          resourceId: 'shared-resource',
          text: 'shared procedure',
        }),
      ]),
    );
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'course-a',
          resourceId: 'shared-resource',
          courseId: 'course-a',
          text: 'shared procedure',
        }),
      ]),
    );

    const hits = await index.query({
      workspaceId: 'workspace-test',
      courseScope: 'exact',
      text: 'shared procedure',
      topK: 5,
    });

    expect(hits.map((hit) => hit.chunk.id)).toEqual(['unscoped']);
  });

  it('deletes only unscoped resources when the course scope is exact', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'unscoped',
          resourceId: 'shared-resource',
          text: 'shared procedure',
        }),
      ]),
    );
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'course-a',
          resourceId: 'shared-resource',
          courseId: 'course-a',
          text: 'shared procedure',
        }),
      ]),
    );

    await index.delete({
      workspaceId: 'workspace-test',
      courseScope: 'exact',
      resourceIds: ['shared-resource'],
    });

    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        text: 'shared procedure',
        topK: 5,
      }),
    ).resolves.toEqual([]);
    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-a',
        text: 'shared procedure',
        topK: 5,
      }),
    ).resolves.toMatchObject([{ chunk: { id: 'course-a' } }]);
  });

  it('queries and deletes all course scopes only in explicit all mode', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'unscoped',
          resourceId: 'shared-resource',
          text: 'shared procedure',
        }),
      ]),
    );
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'course-a',
          resourceId: 'shared-resource',
          courseId: 'course-a',
          text: 'shared procedure',
        }),
      ]),
    );

    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'all',
        text: 'shared procedure',
        topK: 5,
      }),
    ).resolves.toHaveLength(2);

    await index.delete({
      workspaceId: 'workspace-test',
      courseScope: 'all',
      resourceIds: ['shared-resource'],
    });

    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'all',
        text: 'shared procedure',
        topK: 5,
      }),
    ).resolves.toEqual([]);
  });
});
