export const KNOWLEDGE_CHUNK_SIZE = 1200;
export const KNOWLEDGE_CHUNK_OVERLAP = 160;

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkKnowledgeText(
  text: string,
  chunkSize = KNOWLEDGE_CHUNK_SIZE,
  overlap = KNOWLEDGE_CHUNK_OVERLAP,
): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  if (chunkSize <= overlap) throw new Error('chunkSize must be greater than overlap');

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf('\n', end);
      if (boundary > start + chunkSize * 0.6) end = boundary;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
