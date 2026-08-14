import type {
  KnowledgeChunk,
  KnowledgeExactScope,
  KnowledgeFilterValue,
  KnowledgeHit,
  KnowledgeIndex,
  KnowledgeIndexDeleteRequest,
  KnowledgeIndexQuery,
  KnowledgeIndexReplaceRequest,
  KnowledgeIndexScope,
} from '../types';

const TOKEN_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+/gu;

function normalizeLexicalText(value: string): string {
  return value.toLowerCase().normalize('NFC');
}

function tokenize(value: string): readonly string[] {
  return normalizeLexicalText(value).match(TOKEN_PATTERN) ?? [];
}

function filterMatches(
  chunk: KnowledgeChunk,
  filters: Readonly<Record<string, KnowledgeFilterValue>> | undefined,
): boolean {
  if (!filters) return true;
  return Object.entries(filters).every(([key, value]) => {
    const metadataValue = chunk.metadata[key];
    return Array.isArray(metadataValue)
      ? typeof value === 'string' && metadataValue.includes(value)
      : metadataValue === value;
  });
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected knowledge index scope: ${JSON.stringify(value)}`);
}

function matchesScope(chunk: KnowledgeChunk, scope: KnowledgeIndexScope): boolean {
  if (chunk.workspaceId !== scope.workspaceId) return false;
  switch (scope.courseScope) {
    case 'exact':
      return chunk.courseId === scope.courseId;
    case 'all':
      return true;
    default:
      return assertNever(scope);
  }
}

function matchesExactScope(chunk: KnowledgeChunk, scope: KnowledgeExactScope): boolean {
  return chunk.workspaceId === scope.workspaceId && chunk.courseId === scope.courseId;
}

class InvalidKnowledgeIndexReplaceError extends Error {
  readonly name = 'InvalidKnowledgeIndexReplaceError';

  constructor(message: string) {
    super(message);
  }
}

function validateReplacement(request: KnowledgeIndexReplaceRequest): void {
  const chunkIds = new Set<string>();
  for (const chunk of request.chunks) {
    if (
      chunk.workspaceId !== request.workspaceId ||
      chunk.courseId !== request.courseId ||
      chunk.resourceId !== request.resourceId ||
      chunk.resourceVersionId !== request.resourceVersionId
    ) {
      throw new InvalidKnowledgeIndexReplaceError(
        `Chunk "${chunk.id}" does not match the replacement scope or resource version.`,
      );
    }
    if (chunkIds.has(chunk.id)) {
      throw new InvalidKnowledgeIndexReplaceError(
        `Replacement contains duplicate chunk ID "${chunk.id}".`,
      );
    }
    chunkIds.add(chunk.id);
  }
}

function lexicalScore(text: string, queryTokens: ReadonlySet<string>, phrase: string): number {
  const normalizedText = normalizeLexicalText(text);
  const chunkTokens = new Set(tokenize(normalizedText));
  const matchedTokens = Array.from(queryTokens).filter((token) => chunkTokens.has(token)).length;
  if (matchedTokens === 0) return 0;
  const coverage = matchedTokens / queryTokens.size;
  const phraseBonus = normalizedText.includes(phrase) ? 0.25 : 0;
  return coverage + phraseBonus;
}

function compareHits(left: KnowledgeHit, right: KnowledgeHit): number {
  const scoreDifference = right.score - left.score;
  if (scoreDifference) return scoreDifference;
  if (left.chunk.id < right.chunk.id) return -1;
  if (left.chunk.id > right.chunk.id) return 1;
  return 0;
}

function chunkKey(
  chunk: Pick<KnowledgeChunk, 'workspaceId' | 'courseId' | 'resourceId' | 'id'>,
): string {
  return JSON.stringify([chunk.workspaceId, chunk.courseId ?? null, chunk.resourceId, chunk.id]);
}

function snapshotChunk(chunk: KnowledgeChunk): KnowledgeChunk {
  return structuredClone(chunk);
}

export class InMemoryLexicalIndex implements KnowledgeIndex {
  readonly id = 'in-memory-lexical';
  readonly capabilities = { lexical: true, vector: false, metadataFilter: true } as const;
  private chunks = new Map<string, KnowledgeChunk>();

  async replaceResourceVersion(request: KnowledgeIndexReplaceRequest): Promise<void> {
    validateReplacement(request);

    const nextChunks = new Map(this.chunks);
    for (const [chunkId, chunk] of nextChunks) {
      if (matchesExactScope(chunk, request) && chunk.resourceId === request.resourceId) {
        nextChunks.delete(chunkId);
      }
    }
    for (const chunk of request.chunks) {
      nextChunks.set(chunkKey(chunk), snapshotChunk(chunk));
    }
    this.chunks = nextChunks;
  }

  async delete(request: KnowledgeIndexDeleteRequest): Promise<void> {
    const resources = new Set(request.resourceIds);
    for (const [chunkId, chunk] of this.chunks) {
      if (matchesScope(chunk, request) && resources.has(chunk.resourceId)) {
        this.chunks.delete(chunkId);
      }
    }
  }

  async query(request: KnowledgeIndexQuery): Promise<readonly KnowledgeHit[]> {
    const normalizedQuery = normalizeLexicalText(request.text.trim());
    const queryTokens = new Set(tokenize(normalizedQuery));
    if (!normalizedQuery || queryTokens.size === 0 || request.topK <= 0) return [];

    return Array.from(this.chunks.values())
      .filter((chunk) => matchesScope(chunk, request))
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
