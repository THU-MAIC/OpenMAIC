import type {
  KnowledgeChunk,
  KnowledgeFilterValue,
  KnowledgeHit,
  KnowledgeIndex,
  KnowledgeIndexDeleteRequest,
  KnowledgeIndexQuery,
} from '../types';

const TOKEN_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+/gu;

function tokenize(value: string): readonly string[] {
  return value.toLowerCase().match(TOKEN_PATTERN) ?? [];
}

function filterMatches(
  chunk: KnowledgeChunk,
  filters: Readonly<Record<string, KnowledgeFilterValue>> | undefined,
): boolean {
  if (!filters) return true;
  return Object.entries(filters).every(([key, value]) => chunk.metadata[key] === value);
}

function lexicalScore(text: string, queryTokens: ReadonlySet<string>, phrase: string): number {
  const chunkTokens = new Set(tokenize(text));
  const matchedTokens = Array.from(queryTokens).filter((token) => chunkTokens.has(token)).length;
  if (matchedTokens === 0) return 0;
  const coverage = matchedTokens / queryTokens.size;
  const phraseBonus = text.toLowerCase().includes(phrase) ? 0.25 : 0;
  return coverage + phraseBonus;
}

function compareHits(left: KnowledgeHit, right: KnowledgeHit): number {
  const scoreDifference = right.score - left.score;
  if (scoreDifference) return scoreDifference;
  if (left.chunk.id < right.chunk.id) return -1;
  if (left.chunk.id > right.chunk.id) return 1;
  return 0;
}

function chunkKey(chunk: Pick<KnowledgeChunk, 'workspaceId' | 'id'>): string {
  return JSON.stringify([chunk.workspaceId, chunk.id]);
}

function snapshotChunk(chunk: KnowledgeChunk): KnowledgeChunk {
  return structuredClone(chunk);
}

export class InMemoryLexicalIndex implements KnowledgeIndex {
  readonly id = 'in-memory-lexical';
  readonly capabilities = { lexical: true, vector: false, metadataFilter: true } as const;
  private readonly chunks = new Map<string, KnowledgeChunk>();

  async upsert(chunks: readonly KnowledgeChunk[]): Promise<void> {
    for (const chunk of chunks) this.chunks.set(chunkKey(chunk), snapshotChunk(chunk));
  }

  async delete(request: KnowledgeIndexDeleteRequest): Promise<void> {
    const resources = new Set(request.resourceIds);
    for (const [chunkId, chunk] of this.chunks) {
      if (chunk.workspaceId === request.workspaceId && resources.has(chunk.resourceId)) {
        this.chunks.delete(chunkId);
      }
    }
  }

  async query(request: KnowledgeIndexQuery): Promise<readonly KnowledgeHit[]> {
    const normalizedQuery = request.text.trim().toLowerCase();
    const queryTokens = new Set(tokenize(normalizedQuery));
    if (!normalizedQuery || queryTokens.size === 0 || request.topK <= 0) return [];

    return Array.from(this.chunks.values())
      .filter((chunk) => chunk.workspaceId === request.workspaceId)
      .filter((chunk) => filterMatches(chunk, request.filters))
      .map((chunk) => ({
        chunk: snapshotChunk(chunk),
        score: lexicalScore(chunk.text, queryTokens, normalizedQuery),
        method: 'lexical' as const,
      }))
      .filter((hit) => hit.score > 0)
      .sort(compareHits)
      .slice(0, Math.floor(request.topK));
  }
}
