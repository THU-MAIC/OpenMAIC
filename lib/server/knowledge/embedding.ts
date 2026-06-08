import { BGE_VECTOR_DIMENSIONS } from './postgres';

export const DEFAULT_BGE_MODEL = 'BAAI/bge-m3';

function getEmbeddingConfig() {
  const baseUrl = process.env.BGE_EMBEDDING_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error('BGE_EMBEDDING_BASE_URL is not configured');
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: process.env.BGE_EMBEDDING_API_KEY?.trim(),
    model: process.env.BGE_EMBEDDING_MODEL?.trim() || DEFAULT_BGE_MODEL,
  };
}

export function getEmbeddingModel(): string {
  return process.env.BGE_EMBEDDING_MODEL?.trim() || DEFAULT_BGE_MODEL;
}

export async function embedWithBge(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const config = getEmbeddingConfig();
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      input: texts,
      encoding_format: 'float',
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`BGE embedding request failed (${response.status}): ${detail.slice(0, 240)}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ index: number; embedding: number[] }>;
  };
  const embeddings = [...(payload.data || [])]
    .sort((left, right) => left.index - right.index)
    .map((item) => item.embedding);
  if (embeddings.length !== texts.length) {
    throw new Error('BGE embedding response did not include one vector per input text');
  }
  for (const embedding of embeddings) {
    if (embedding.length !== BGE_VECTOR_DIMENSIONS) {
      throw new Error(
        `BGE embedding dimension ${embedding.length} does not match required dimension ${BGE_VECTOR_DIMENSIONS}`,
      );
    }
  }
  return embeddings;
}

export function formatPgVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
