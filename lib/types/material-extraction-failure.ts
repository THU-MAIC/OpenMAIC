/** Public, user-facing extraction reasons. Missing/unknown codes mean generic failure. */
export const MATERIAL_EXTRACTION_REASON_CODES = [
  'storage_full',
  'source_unavailable',
  'service_unavailable',
  'media_too_long',
  'no_text_extracted',
  'processing_interrupted',
] as const;

export type MaterialExtractionReasonCode = (typeof MATERIAL_EXTRACTION_REASON_CODES)[number];

export function extractionReasonCodeOf(value: unknown): MaterialExtractionReasonCode | undefined {
  return typeof value === 'string' &&
    (MATERIAL_EXTRACTION_REASON_CODES as readonly string[]).includes(value)
    ? (value as MaterialExtractionReasonCode)
    : undefined;
}
