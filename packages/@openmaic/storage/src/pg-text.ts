/** Normalize descriptive TEXT values, never identifiers or ownership keys. */
export function sanitizePgText(value: string): string {
  // Unicode mode keeps valid surrogate pairs together; only lone units match.
  return value.replace(/\u0000|[\uD800-\uDFFF]/gu, (character) =>
    character === '\u0000' ? '' : '\uFFFD',
  );
}
