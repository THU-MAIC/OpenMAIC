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
    if (line) lines.push(line);
    line = '';
    for (const grapheme of splitter.iterateGraphemes(word)) {
      if (line && measure(line + grapheme) > width) {
        lines.push(line);
        line = '';
      }
      line += grapheme;
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
