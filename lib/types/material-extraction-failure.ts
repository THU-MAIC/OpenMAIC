import { MEDIA_MAX_DURATION_SEC } from './media-limits';

/** Public, user-facing extraction reasons. Missing/unknown codes mean generic failure. */
export const MATERIAL_EXTRACTION_REASON_CODES = [
  'storage_full',
  'source_unavailable',
  'service_unavailable',
  'media_too_long',
  'no_text_extracted',
  'processing_interrupted',
  'too_many_pages',
] as const;

export type MaterialExtractionReasonCode = (typeof MATERIAL_EXTRACTION_REASON_CODES)[number];

export function extractionReasonCodeOf(value: unknown): MaterialExtractionReasonCode | undefined {
  return typeof value === 'string' &&
    (MATERIAL_EXTRACTION_REASON_CODES as readonly string[]).includes(value)
    ? (value as MaterialExtractionReasonCode)
    : undefined;
}

/**
 * The numbers a failure's explanation states, when the service that refused
 * the source said them: `too_many_pages` carries the document's page count
 * and the service's page limit. Only counts, never provider text.
 */
export interface MaterialExtractionReasonValues {
  pages?: number;
  maxPages?: number;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A stored or received value as the reason's values: positive counts of a reason that has them. */
export function extractionReasonValuesOf(
  code: MaterialExtractionReasonCode | undefined,
  value: unknown,
): MaterialExtractionReasonValues | undefined {
  if (code !== 'too_many_pages' || !value || typeof value !== 'object') return undefined;
  const pages = count((value as { pages?: unknown }).pages);
  const maxPages = count((value as { maxPages?: unknown }).maxPages);
  if (pages === undefined && maxPages === undefined) return undefined;
  return { ...(pages ? { pages } : {}), ...(maxPages ? { maxPages } : {}) };
}

/**
 * Which explanation of a failure to show, and the values it interpolates:
 * the copy key under `workspace.knowledgeBase.failure.<code>`. A page limit
 * the service did not state picks wording without the missing number.
 */
export function extractionFailureDescription(
  code: MaterialExtractionReasonCode,
  values?: MaterialExtractionReasonValues,
): {
  key: 'description' | 'descriptionWithoutCount' | 'descriptionWithoutLimit';
  values: Record<string, number>;
} {
  if (code === 'media_too_long') {
    // The extractor's own limit, so the explanation cannot drift from it.
    return { key: 'description', values: { minutes: MEDIA_MAX_DURATION_SEC / 60 } };
  }
  if (code === 'too_many_pages') {
    const { pages, maxPages } = values ?? {};
    if (!maxPages) return { key: 'descriptionWithoutLimit', values: {} };
    if (!pages || pages <= maxPages)
      return { key: 'descriptionWithoutCount', values: { maxPages } };
    return { key: 'description', values: { pages, maxPages } };
  }
  return { key: 'description', values: {} };
}
