import { sandboxInvalid } from '@/lib/sandbox/errors';

// A read-only asset can be much larger than the source a teaching turn needs.
// Bound each tool result before it enters the active, verbatim tool history.
const EXCERPT_BYTES = 8192;

/** Offsets are UTF-16 indices into the original source, so excerpts can be joined losslessly. */
export function readProjectFileExcerpt(source: string, offset = 0) {
  if (offset > source.length || /[\uDC00-\uDFFF]/.test(source.charAt(offset)))
    throw sandboxInvalid('Use a valid file offset returned by read_file.');

  const remaining = source.slice(offset);
  if (Buffer.byteLength(remaining) <= EXCERPT_BYTES)
    return offset ? { text: remaining, offset } : { text: remaining };

  // Decode only complete UTF-8 code points. Prefer ending at a line boundary,
  // but still make progress on a long single line (for example minified HTML).
  const prefix = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
    Buffer.from(remaining).subarray(0, EXCERPT_BYTES),
    { stream: true },
  );
  const newline = prefix.lastIndexOf('\n') + 1;
  const text = newline >= prefix.length / 2 ? prefix.slice(0, newline) : prefix;
  return { text, offset, nextOffset: offset + text.length };
}
