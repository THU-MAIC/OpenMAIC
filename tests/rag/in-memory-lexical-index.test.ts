import { describe, expect, it, vi } from 'vitest';

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
  readonly ordinal?: number;
  readonly resourceId?: string;
  readonly resourceVersionId?: string;
  readonly workspaceId?: string;
  readonly metadata?: KnowledgeChunk['metadata'];
};

function chunk(input: ChunkInput): KnowledgeChunk {
  return {
    id: input.id,
    resourceId: input.resourceId ?? `resource-${input.courseId ?? 'shared'}`,
    resourceVersionId: input.resourceVersionId ?? 'resource-version-1',
    workspaceId: input.workspaceId ?? 'workspace-test',
    ...(input.courseId ? { courseId: input.courseId } : {}),
    ordinal: input.ordinal ?? 0,
    text: input.text,
    contentHash: `hash-${input.id}`,
    locator: {
      kind: 'document',
      blockId: input.id,
      pageNumber: (input.ordinal ?? 0) + 1,
    },
    lineage,
    metadata: input.metadata ?? {},
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

describe('in-memory lexical index', () => {
  it('ranks token matches, returns lexical hits, and enforces topK', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'calibration',
          text: 'Calibration procedure for the pressure sensor.',
          courseId: 'course-1',
        }),
        chunk({ id: 'safety', text: 'Safety rules for laboratory work.', courseId: 'course-1' }),
      ]),
    );

    const hits = await index.query({
      workspaceId: 'workspace-test',
      courseScope: 'exact',
      courseId: 'course-1',
      text: 'calibration procedure',
      topK: 1,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      chunk: { id: 'calibration', locator: { kind: 'document', blockId: 'calibration' } },
      method: 'lexical',
    });
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it('filters metadata after applying the explicit course scope', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'shared',
          text: 'new terminology',
          courseId: 'course-1',
          metadata: { chapterId: 'chapter-1' },
        }),
      ]),
    );
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'other-course',
          text: 'new terminology',
          courseId: 'course-2',
          metadata: { chapterId: 'chapter-2' },
        }),
      ]),
    );

    const hits = await index.query({
      workspaceId: 'workspace-test',
      courseScope: 'exact',
      courseId: 'course-1',
      text: 'new terminology',
      topK: 5,
      filters: { chapterId: 'chapter-1' },
    });

    expect(hits.map((hit) => hit.chunk.id)).toEqual(['shared']);

    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'all',
        text: 'new terminology',
        topK: 5,
      }),
    ).resolves.toHaveLength(2);
  });

  it('matches string-list metadata filters by member within the explicit scope', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([
        chunk({
          id: 'safety-tag',
          text: 'shared procedure',
          courseId: 'course-1',
          metadata: { tags: ['safety', 'laboratory'] },
        }),
        chunk({
          id: 'calibration-tag',
          text: 'shared procedure',
          courseId: 'course-1',
          metadata: { tags: ['calibration'] },
        }),
      ]),
    );

    const hits = await index.query({
      workspaceId: 'workspace-test',
      courseScope: 'exact',
      courseId: 'course-1',
      text: 'shared procedure',
      topK: 5,
      filters: { tags: 'safety' },
    });

    expect(hits.map((hit) => hit.chunk.id)).toEqual(['safety-tag']);
  });

  it('orders score ties by chunk ID and deletes all chunks for a resource', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([
        chunk({ id: 'zeta', text: 'safety procedure', courseId: 'course-1' }),
        chunk({ id: 'alpha', text: 'safety procedure', courseId: 'course-1' }),
      ]),
    );

    const tiedHits = await index.query({
      workspaceId: 'workspace-test',
      courseScope: 'exact',
      courseId: 'course-1',
      text: 'safety procedure',
      topK: 5,
    });
    expect(tiedHits.map((hit) => hit.chunk.id)).toEqual(['alpha', 'zeta']);

    await index.delete({
      workspaceId: 'workspace-test',
      courseScope: 'exact',
      courseId: 'course-1',
      resourceIds: ['resource-course-1'],
    });
    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-1',
        text: 'safety procedure',
        topK: 5,
      }),
    ).resolves.toEqual([]);
  });

  it('returns no hits for blank or non-positive queries', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([chunk({ id: 'one', text: 'searchable text', courseId: 'course-1' })]),
    );

    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-1',
        text: '   ',
        topK: 5,
      }),
    ).resolves.toEqual([]);
    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-1',
        text: 'searchable',
        topK: 0,
      }),
    ).resolves.toEqual([]);
  });

  it('keeps case folding independent from the ambient locale', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([chunk({ id: 'istanbul', text: 'Istanbul procedure', courseId: 'course-1' })]),
    );

    const original = String.prototype.toLocaleLowerCase;
    const localeSpy = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (
      this: string,
    ) {
      return original.call(this, 'tr');
    });

    let hits;
    try {
      hits = await index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-1',
        text: 'istanbul',
        topK: 1,
      });
    } finally {
      localeSpy.mockRestore();
    }

    expect(hits).toHaveLength(1);
  });

  it('scores canonically equivalent Unicode text identically', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([chunk({ id: 'cafe', text: 'café procedure', courseId: 'course-1' })]),
    );

    const composedHits = await index.query({
      workspaceId: 'workspace-test',
      courseScope: 'exact',
      courseId: 'course-1',
      text: 'café',
      topK: 1,
    });
    const decomposedHits = await index.query({
      workspaceId: 'workspace-test',
      courseScope: 'exact',
      courseId: 'course-1',
      text: 'cafe\u0301',
      topK: 1,
    });

    expect(decomposedHits).toEqual(composedHits);
    expect(decomposedHits).toHaveLength(1);
  });

  it('retrieves Chinese terms with character-level CJK tokens', async () => {
    const index = new InMemoryLexicalIndex();
    await index.replaceResourceVersion(
      replacement([chunk({ id: 'zh', text: '实验室安全操作规范', courseId: 'course-zh' })]),
    );

    await expect(
      index.query({
        workspaceId: 'workspace-test',
        courseScope: 'exact',
        courseId: 'course-zh',
        text: '安全',
        topK: 1,
      }),
    ).resolves.toMatchObject([{ chunk: { id: 'zh' } }]);
  });
});
