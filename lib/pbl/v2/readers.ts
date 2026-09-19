/** Read a possibly malformed persisted leaf as trimmed text. */
export function trimmedPBLText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
