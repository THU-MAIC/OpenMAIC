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

describe('in-memory resource replacement', () => {
  it('replaces a complete resource version when the new set has fewer chunks', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'obsolete',
          text: 'obsolete indexed text',
          courseId: 'course-1',
          resourceVersionId: 'resource-version-1',
        }),
        chunk({
          id: 'retained',
          text: 'retained indexed text',
          courseId: 'course-1',
          resourceVersionId: 'resource-version-1',
        }),
      ]),
    );

    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'retained',
          text: 'retained revised text',
          courseId: 'course-1',
          resourceVersionId: 'resource-version-2',
        }),
      ]),
    );

    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-1',
        text: 'obsolete',
        topK: 5,
      }),
    ).resolves.toEqual([]);
    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-1',
        text: 'revised',
        topK: 5,
      }),
    ).resolves.toMatchObject([
      { chunk: { id: 'retained', resourceVersionId: 'resource-version-2' } },
    ]);
  });

  it('keeps the previous complete set when a replacement contains an invalid chunk', async () => {
    const index = new InMemoryLexicalIndex();
    const original = chunk({ id: 'snapshot', text: 'stable indexed text', courseId: 'course-1' });

    await index.replaceResourceVersion(replacement([original]));
    Object.assign(original, { text: 'mutated after replace' });

    const first = await index.query({
      workspaceId: 'workspace-test',
      courseScope: 'exact',
      courseId: 'course-1',
      text: 'stable',
      topK: 1,
    });
    expect(first).toHaveLength(1);
    Object.assign(first[0]?.chunk ?? {}, { text: 'mutated after query' });

    await expect(
      index.replaceResourceVersion({
        workspaceId: 'workspace-test',
        courseId: 'course-1',
        resourceId: original.resourceId,
        resourceVersionId: 'resource-version-2',
        chunks: [
          chunk({
            id: 'invalid',
            text: 'invalid replacement',
            courseId: 'course-1',
            workspaceId: 'workspace-other',
            resourceVersionId: 'resource-version-2',
          }),
        ],
      }),
    ).rejects.toThrow('does not match');

    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-1',
        text: 'stable',
        topK: 1,
      }),
    ).resolves.toMatchObject([{ chunk: { text: 'stable indexed text' } }]);
  });

  it('keeps the previous complete set when cloning a later chunk fails', async () => {
    const index = new InMemoryLexicalIndex();
    const original = chunk({ id: 'original', text: 'stable indexed text', courseId: 'course-1' });
    await index.replaceResourceVersion(replacement([original]));

    const firstReplacement = chunk({
      id: 'first-replacement',
      text: 'novelreplacement payload',
      courseId: 'course-1',
      resourceVersionId: 'resource-version-2',
    });
    const unclonableReplacement = new Proxy(
      chunk({
        id: 'unclonable-replacement',
        text: 'novelreplacement payload',
        courseId: 'course-1',
        resourceVersionId: 'resource-version-2',
      }),
      {},
    );

    await expect(
      index.replaceResourceVersion({
        workspaceId: 'workspace-test',
        courseId: 'course-1',
        resourceId: original.resourceId,
        resourceVersionId: 'resource-version-2',
        chunks: [firstReplacement, unclonableReplacement],
      }),
    ).rejects.toThrow();

    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-1',
        text: 'stable',
        topK: 5,
      }),
    ).resolves.toMatchObject([{ chunk: { id: 'original' } }]);
    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-1',
        text: 'novelreplacement',
        topK: 5,
      }),
    ).resolves.toEqual([]);
  });

  it('removes the active set when a complete replacement has no chunks', async () => {
    const index = new InMemoryLexicalIndex();
    const original = chunk({
      id: 'empty',
      text: 'temporary searchable text',
      courseId: 'course-1',
    });
    await index.replaceResourceVersion(replacement([original]));

    await index.replaceResourceVersion({
      workspaceId: 'workspace-test',
      courseId: 'course-1',
      resourceId: original.resourceId,
      resourceVersionId: 'resource-version-2',
      chunks: [],
    });

    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-1',
        text: 'temporary',
        topK: 1,
      }),
    ).resolves.toEqual([]);
  });
});
