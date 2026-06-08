import type { RagRetrievalConfig } from '@/lib/types/rag';

export const RAG_CONFIG_STORAGE_KEY = 'ragRetrievalConfig';

export const RAG_CONFIG_LIMITS = {
  topK: { min: 1, max: 20 },
  minSimilarity: { min: 0, max: 0.95 },
  maxContextChars: { min: 2000, max: 30000 },
} as const;

export const DEFAULT_RAG_RETRIEVAL_CONFIG: RagRetrievalConfig = {
  topK: 6,
  minSimilarity: 0,
  maxContextChars: 12000,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function normalizeRagRetrievalConfig(input?: unknown): RagRetrievalConfig {
  const raw =
    input && typeof input === 'object' ? (input as Partial<RagRetrievalConfig>) : undefined;
  const topK = finiteNumber(raw?.topK, DEFAULT_RAG_RETRIEVAL_CONFIG.topK);
  const minSimilarity = finiteNumber(
    raw?.minSimilarity,
    DEFAULT_RAG_RETRIEVAL_CONFIG.minSimilarity,
  );
  const maxContextChars = finiteNumber(
    raw?.maxContextChars,
    DEFAULT_RAG_RETRIEVAL_CONFIG.maxContextChars,
  );

  return {
    topK: Math.round(clamp(topK, RAG_CONFIG_LIMITS.topK.min, RAG_CONFIG_LIMITS.topK.max)),
    minSimilarity: Number(
      clamp(
        minSimilarity,
        RAG_CONFIG_LIMITS.minSimilarity.min,
        RAG_CONFIG_LIMITS.minSimilarity.max,
      ).toFixed(2),
    ),
    maxContextChars: Math.round(
      clamp(
        maxContextChars,
        RAG_CONFIG_LIMITS.maxContextChars.min,
        RAG_CONFIG_LIMITS.maxContextChars.max,
      ),
    ),
  };
}

export function readStoredRagRetrievalConfig(
  storage: Pick<Storage, 'getItem'>,
): RagRetrievalConfig {
  try {
    const stored = storage.getItem(RAG_CONFIG_STORAGE_KEY);
    return normalizeRagRetrievalConfig(stored ? JSON.parse(stored) : undefined);
  } catch {
    return DEFAULT_RAG_RETRIEVAL_CONFIG;
  }
}
