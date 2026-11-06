import { sandboxInvalid } from '@/lib/sandbox/errors';

// Bound each excerpt before it enters the active, verbatim tool history.
const EXCERPT_BYTES = 8192;

interface FileReadRange {
  offset?: number;
  startLine?: number;
  endLine?: number;
}

/** Lines are one-based and inclusive. Offsets are UTF-16 indices into the original source. */
export function readProjectFileExcerpt(source: string, range: FileReadRange = {}) {
  const { offset, startLine, endLine } = range;
  if (offset !== undefined && startLine !== undefined)
    throw sandboxInvalid('Use either startLine or the offset returned by read_file.');

  let start = offset ?? 0;
  let end = source.length;
  if (startLine !== undefined || endLine !== undefined) {
    const starts = [0, ...Array.from(source.matchAll(/\n/g), (match) => match.index + 1)];
    const requestedStart = starts[(startLine ?? 1) - 1];
    if (requestedStart === undefined || (endLine !== undefined && endLine < (startLine ?? 1)))
      throw sandboxInvalid('Use a valid startLine and endLine within the file.');
    start = offset ?? requestedStart;
    end = endLine === undefined ? end : (starts[endLine] ?? end);
  }
  if (start > end || /[\uDC00-\uDFFF]/.test(source.charAt(start)))
    throw sandboxInvalid('Use a valid file offset returned by read_file.');

  const remaining = source.slice(start, end);
  if (Buffer.byteLength(remaining) <= EXCERPT_BYTES)
    return start ? { text: remaining, offset: start } : { text: remaining };

  // Decode only complete UTF-8 code points. Prefer ending at a line boundary,
  // but still make progress on a long single line (for example minified HTML).
  const prefix = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
    Buffer.from(remaining).subarray(0, EXCERPT_BYTES),
    { stream: true },
  );
  const newline = prefix.lastIndexOf('\n') + 1;
  const text = newline >= prefix.length / 2 ? prefix.slice(0, newline) : prefix;
  return { text, offset: start, nextOffset: start + text.length };
}
