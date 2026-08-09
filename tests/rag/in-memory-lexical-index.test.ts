import { describe, expect, it, vi } from 'vitest';

import { InMemoryLexicalIndex, type KnowledgeChunk } from '@/lib/rag';

const lineage = {
  sourceHash: 'sha256:source',
  extractor: { id: 'plain-text', version: '1.0.0' },
  transforms: [],
  chunkPolicy: { id: 'document-block', version: '1.0.0' },
} as const;

function chunk(
  id: string,
  text: string,
  courseId: string,
  ordinal = 0,
  workspaceId = 'workspace-test',
): KnowledgeChunk {
  return {
    id,
    resourceId: `resource-${courseId}`,
    workspaceId,
    ordinal,
    text,
    contentHash: `hash-${id}`,
    locator: { kind: 'document', blockId: id, pageNumber: ordinal + 1 },
    lineage,
    metadata: { courseId },
  };
}

describe('in-memory lexical index', () => {
  it('ranks token matches, returns lexical hits, and enforces topK', async () => {
    const index = new InMemoryLexicalIndex();
    await index.upsert([
      chunk('calibration', 'Calibration procedure for the pressure sensor.', 'course-1'),
      chunk('safety', 'Safety rules for laboratory work.', 'course-1'),
    ]);

    const hits = await index.query({
      workspaceId: 'workspace-test',
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

  it('filters metadata before scoring and replaces duplicate chunk IDs', async () => {
    const index = new InMemoryLexicalIndex();
    await index.upsert([chunk('shared', 'old terminology', 'course-1')]);
    await index.upsert([
      chunk('shared', 'new terminology', 'course-1'),
      chunk('other-course', 'new terminology', 'course-2'),
    ]);

    const hits = await index.query({
      workspaceId: 'workspace-test',
      text: 'new terminology',
      topK: 5,
      filters: { courseId: 'course-1' },
    });

    expect(hits.map((hit) => hit.chunk.id)).toEqual(['shared']);
    expect(hits[0]?.chunk.text).toBe('new terminology');
  });

  it('orders score ties by chunk ID and deletes all chunks for a resource', async () => {
    const index = new InMemoryLexicalIndex();
    await index.upsert([
      chunk('zeta', 'safety procedure', 'course-1'),
      chunk('alpha', 'safety procedure', 'course-1'),
    ]);

    const tiedHits = await index.query({
      workspaceId: 'workspace-test',
      text: 'safety procedure',
      topK: 5,
    });
    expect(tiedHits.map((hit) => hit.chunk.id)).toEqual(['alpha', 'zeta']);

    await index.delete({ workspaceId: 'workspace-test', resourceIds: ['resource-course-1'] });
    await expect(
      index.query({ workspaceId: 'workspace-test', text: 'safety procedure', topK: 5 }),
    ).resolves.toEqual([]);
  });

  it('returns no hits for blank or non-positive queries', async () => {
    const index = new InMemoryLexicalIndex();
    await index.upsert([chunk('one', 'searchable text', 'course-1')]);

    await expect(
      index.query({ workspaceId: 'workspace-test', text: '   ', topK: 5 }),
    ).resolves.toEqual([]);
    await expect(
      index.query({ workspaceId: 'workspace-test', text: 'searchable', topK: 0 }),
    ).resolves.toEqual([]);
  });

  it('keeps case folding independent from the ambient locale', async () => {
    const index = new InMemoryLexicalIndex();
    await index.upsert([chunk('istanbul', 'Istanbul procedure', 'course-1')]);

    const original = String.prototype.toLocaleLowerCase;
    const localeSpy = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (
      this: string,
    ) {
      return original.call(this, 'tr');
    });

    let hits;
    try {
      hits = await index.query({ workspaceId: 'workspace-test', text: 'istanbul', topK: 1 });
    } finally {
      localeSpy.mockRestore();
    }

    expect(hits).toHaveLength(1);
  });

  it('retrieves Chinese terms with character-level CJK tokens', async () => {
    const index = new InMemoryLexicalIndex();
    await index.upsert([chunk('zh', '实验室安全操作规范', 'course-zh')]);

    await expect(
      index.query({ workspaceId: 'workspace-test', text: '安全', topK: 1 }),
    ).resolves.toMatchObject([{ chunk: { id: 'zh' } }]);
  });

  it('requires workspace scope for retrieval and deletion', async () => {
    const index = new InMemoryLexicalIndex();
    await index.upsert([
      chunk('same-id', 'shared safety procedure', 'course-a', 0, 'workspace-a'),
      chunk('same-id', 'shared safety procedure', 'course-b', 0, 'workspace-b'),
    ]);

    await expect(
      index.query({ workspaceId: 'workspace-a', text: 'shared safety', topK: 5 }),
    ).resolves.toMatchObject([{ chunk: { id: 'same-id' } }]);
    await expect(
      index.query({ workspaceId: 'workspace-b', text: 'shared safety', topK: 5 }),
    ).resolves.toMatchObject([{ chunk: { id: 'same-id' } }]);

    await index.delete({ workspaceId: 'workspace-a', resourceIds: ['resource-course-a'] });
    await expect(
      index.query({ workspaceId: 'workspace-b', text: 'shared safety', topK: 5 }),
    ).resolves.toMatchObject([{ chunk: { id: 'same-id' } }]);
  });

  it('snapshots chunks across upsert and query boundaries', async () => {
    const index = new InMemoryLexicalIndex();
    const original = chunk('snapshot', 'stable indexed text', 'course-1');

    await index.upsert([original]);
    Object.assign(original, { text: 'mutated after upsert' });

    const first = await index.query({ workspaceId: 'workspace-test', text: 'stable', topK: 1 });
    expect(first).toHaveLength(1);
    Object.assign(first[0]?.chunk ?? {}, { text: 'mutated after query' });

    await expect(
      index.query({ workspaceId: 'workspace-test', text: 'stable', topK: 1 }),
    ).resolves.toMatchObject([{ chunk: { text: 'stable indexed text' } }]);
  });
});
