/**
 * Split a stream that concatenates multiple top-level JSON objects with no
 * delimiter between them (as some TTS providers emit) into the individual
 * `{...}` substrings, in order.
 *
 * Brace counting is **string-aware**: a `{` or `}` inside a JSON string literal
 * — including past an escaped quote — is ignored, so an object whose value
 * contains a brace, e.g. `{"message":"bad {input}"}`, is not split in the
 * middle. Unbalanced trailing input (a half-received object) is dropped.
 */
export function splitConcatenatedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return objects;
}
