import Graphemer from 'graphemer';

const GRAPHEME_SPLITTER = new Graphemer();

export type GraphemeChunk = {
  readonly text: string;
  readonly length: number;
};

function trimGraphemeSegments(segments: readonly string[]): GraphemeChunk | undefined {
  let start = 0;
  let end = segments.length;
  while (start < end && /^\s$/u.test(segments[start] ?? '')) start += 1;
  while (end > start && /^\s$/u.test(segments[end - 1] ?? '')) end -= 1;
  if (start === end) return undefined;
  return {
    text: segments.slice(start, end).join(''),
    length: end - start,
  };
}

export function splitGraphemeText(value: string, maxChars: number): GraphemeChunk[] {
  const chunks: GraphemeChunk[] = [];
  const iterator = GRAPHEME_SPLITTER.iterateGraphemes(value.trim());
  const pending: string[] = [];
  let done = false;

  while (true) {
    while (pending.length < maxChars && !done) {
      const next = iterator.next();
      if (next.done) {
        done = true;
      } else {
        pending.push(next.value);
      }
    }

    if (pending.length === maxChars && !done) {
      const lookahead = iterator.next();
      if (lookahead.done) {
        done = true;
      } else {
        pending.push(lookahead.value);
      }
    }

    if (pending.length === 0) break;
    if (done) {
      const finalChunk = trimGraphemeSegments(pending);
      if (finalChunk) chunks.push(finalChunk);
      break;
    }

    const whitespaceBoundary = pending.findLastIndex((segment) => /^\s$/u.test(segment));
    const boundary = whitespaceBoundary > Math.floor(maxChars / 2) ? whitespaceBoundary : maxChars;
    const chunk = trimGraphemeSegments(pending.splice(0, boundary));
    if (chunk) chunks.push(chunk);
  }

  return chunks;
}
