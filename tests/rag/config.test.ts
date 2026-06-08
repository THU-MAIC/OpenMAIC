import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RAG_RETRIEVAL_CONFIG,
  RAG_CONFIG_STORAGE_KEY,
  normalizeRagRetrievalConfig,
  readStoredRagRetrievalConfig,
} from '@/lib/rag/config';

describe('RAG retrieval config', () => {
  it('returns defaults when no client preference is stored', () => {
    const storage = { getItem: () => null };

    expect(readStoredRagRetrievalConfig(storage)).toEqual(DEFAULT_RAG_RETRIEVAL_CONFIG);
  });

  it('clamps user-controlled values at the request boundary', () => {
    expect(
      normalizeRagRetrievalConfig({
        topK: 99,
        minSimilarity: -0.3,
        maxContextChars: 900,
      }),
    ).toEqual({
      topK: 20,
      minSimilarity: 0,
      maxContextChars: 2000,
    });
  });

  it('loads persisted controls and rounds numeric precision safely', () => {
    const storage = {
      getItem: (key: string) =>
        key === RAG_CONFIG_STORAGE_KEY
          ? JSON.stringify({ topK: 4.7, minSimilarity: 0.436, maxContextChars: 8600.4 })
          : null,
    };

    expect(readStoredRagRetrievalConfig(storage)).toEqual({
      topK: 5,
      minSimilarity: 0.44,
      maxContextChars: 8600,
    });
  });

  it('ignores malformed stored JSON', () => {
    const storage = { getItem: () => '{not-json' };

    expect(readStoredRagRetrievalConfig(storage)).toEqual(DEFAULT_RAG_RETRIEVAL_CONFIG);
  });
});
