import Graphemer from 'graphemer';

const splitter = new Graphemer();

/** Prefer word boundaries; CJK and overlong tokens break only between graphemes. */
export function wrapShareText(value: string, width: number, measure: (text: string) => number) {
  const lines: string[] = [];
  let line = '';
  for (const word of value.trim().replace(/\s+/g, ' ').split(' ')) {
    if (!word) continue;
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= width) {
      line = candidate;
      continue;
    }
    // CJK has break opportunities within a chunk, so use the remaining line space.
    // Keep whitespace-separated Latin words intact when they fit on a fresh line.
    if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)) {
      if (line) lines.push(line);
      line = '';
    }
    let separator = line ? ' ' : '';
    for (const grapheme of splitter.iterateGraphemes(word)) {
      if (line && measure(line + separator + grapheme) > width) {
        lines.push(line);
        line = '';
        separator = '';
      }
      line += separator + grapheme;
      separator = '';
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function ellipsizeShareText(
  value: string,
  width: number,
  measure: (text: string) => number,
) {
  const parts = splitter.splitGraphemes(value.trimEnd());
  while (parts.length && measure(parts.join('') + '…') > width) parts.pop();
  return parts.join('') + '…';
}
