export const EXACT_CONTENT_RAW_CAP = 30000;
export const EXACT_CONTENT_SERIALIZED_CAP = 60000;

/** Keep exact whole-field replacements bounded in both source and JSON form. */
export function isExactContentEditable(content: string): boolean {
  return (
    content.length <= EXACT_CONTENT_RAW_CAP &&
    JSON.stringify(content).length <= EXACT_CONTENT_SERIALIZED_CAP
  );
}
