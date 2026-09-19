/**
 * Resolution of the ordered document sources a generation session carries.
 *
 * Sessions written before part 0 of RFC #1153 stored each source's bytes under
 * a session-scoped blob-stash `storageKey` (and the single-document legacy
 * shape stored `pdfStorageKey`); new sessions additionally carry an allocated
 * asset-pool `assetId` per source. This resolver keeps an in-flight old session
 * working: it prefers the structured `documentSources` list and only falls
 * back to the legacy single-document fields when that list is absent.
 */
import type { SessionDocumentSource } from '@/lib/types/generation';

/** The session fields this resolver reads; narrower than the full session. */
export interface LegacySessionSourceFields {
  documentSources?: SessionDocumentSource[];
  pdfStorageKey?: string;
  pdfFileName?: string;
  documentMimeType?: string;
  pdfProviderId?: string;
}

export function resolveSessionDocumentSources(
  session: LegacySessionSourceFields,
): SessionDocumentSource[] {
  if (session.documentSources?.length) return session.documentSources;
  if (!session.pdfStorageKey) return [];
  return [
    {
      id: 'source_1',
      name: session.pdfFileName || 'document.pdf',
      size: 0,
      mimeType: session.documentMimeType || 'application/pdf',
      order: 1,
      storageKey: session.pdfStorageKey,
      providerId: session.pdfProviderId,
    },
  ];
}
