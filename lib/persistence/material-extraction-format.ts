import type { OwnerMaterialRecord } from './owner-materials';

/** Existing result/queue format owns retries; retention is not a processing mode. */
export function usesClassicExtraction(
  record: Pick<OwnerMaterialRecord, 'assetId' | 'extraction' | 'extractionResult'>,
): boolean {
  const status = record.extraction?.status;
  if (record.extraction?.resultKey || status === 'ready' || status === 'extracting') return true;
  return (
    !record.assetId &&
    !record.extractionResult &&
    status !== 'pending' &&
    status !== 'running' &&
    status !== 'done'
  );
}

/** The same format dispatch at the atomic queue write and backfill boundary. */
export const CLASSIC_EXTRACTION_SQL = `(extraction->>'resultKey' IS NOT NULL
  OR extraction->>'status' IN ('ready', 'extracting')
  OR (asset_id IS NULL AND extraction_result IS NULL
    AND COALESCE(extraction->>'status', 'idle') NOT IN ('pending', 'running', 'done')))`;

export function libraryExtractionStatus(
  status: string | undefined,
): 'idle' | 'pending' | 'running' | 'done' | 'failed' {
  if (status === 'extracting') return 'running';
  if (status === 'ready') return 'done';
  return status === 'pending' || status === 'running' || status === 'done' || status === 'failed'
    ? status
    : 'idle';
}

export function hasClassicText(record: Pick<OwnerMaterialRecord, 'extraction'>): boolean {
  return record.extraction?.status === 'ready' && Boolean(record.extraction.resultKey);
}
