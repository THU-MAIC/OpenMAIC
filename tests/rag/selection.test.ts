import { describe, expect, it } from 'vitest';
import { filterSelectedRagHits } from '@/lib/server/knowledge/repository';
import type { RagHit } from '@/lib/types/rag';

const candidates: RagHit[] = [
  {
    documentId: 'manual-a',
    documentName: 'manual.pdf',
    chunkIndex: 1,
    score: 0.91,
    excerpt: '步骤 A',
  },
  {
    documentId: 'manual-a',
    documentName: 'manual.pdf',
    chunkIndex: 2,
    score: 0.83,
    excerpt: '步骤 B',
  },
  {
    documentId: 'manual-b',
    documentName: 'service.pdf',
    chunkIndex: 0,
    score: 0.74,
    excerpt: '警告 C',
  },
];

describe('RAG excerpt selection', () => {
  it('keeps only excerpts explicitly selected by the user', () => {
    expect(
      filterSelectedRagHits(candidates, [
        { documentId: 'manual-a', chunkIndex: 2 },
        { documentId: 'manual-b', chunkIndex: 0 },
      ]),
    ).toEqual([candidates[1], candidates[2]]);
  });

  it('does not allow unknown client keys to inject new excerpts', () => {
    expect(filterSelectedRagHits(candidates, [{ documentId: 'manual-x', chunkIndex: 99 }])).toEqual(
      [],
    );
  });
});
