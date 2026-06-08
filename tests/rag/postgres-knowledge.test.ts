import { afterEach, describe, expect, it, vi } from 'vitest';
import { chunkKnowledgeText } from '@/lib/server/knowledge/chunker';
import { DEFAULT_BGE_MODEL, embedWithBge, formatPgVector } from '@/lib/server/knowledge/embedding';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BGE_EMBEDDING_BASE_URL;
  delete process.env.BGE_EMBEDDING_API_KEY;
  delete process.env.BGE_EMBEDDING_MODEL;
});

describe('PostgreSQL knowledge base helpers', () => {
  it('retains text beyond the original direct-PDF prompt limit when chunking', () => {
    const text = `${'U660E 变速箱阀体油压测试步骤。'.repeat(4000)}\n结束标记`;
    const chunks = chunkKnowledgeText(text);

    expect(text.length).toBeGreaterThan(50000);
    expect(chunks.length).toBeGreaterThan(40);
    expect(chunks.at(-1)).toContain('结束标记');
  });

  it('serializes embedding values for pgvector parameters', () => {
    expect(formatPgVector([0.125, -0.5, 1])).toBe('[0.125,-0.5,1]');
  });

  it('requests 1024-dimensional BGE embeddings from an OpenAI-compatible endpoint', async () => {
    process.env.BGE_EMBEDDING_BASE_URL = 'http://embedding.local/v1';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: Array.from({ length: 1024 }, () => 0.1) }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await embedWithBge(['阀体油压测试']);

    expect(result[0]).toHaveLength(1024);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://embedding.local/v1/embeddings',
      expect.objectContaining({
        body: JSON.stringify({
          model: DEFAULT_BGE_MODEL,
          input: ['阀体油压测试'],
          encoding_format: 'float',
        }),
      }),
    );
  });
});
