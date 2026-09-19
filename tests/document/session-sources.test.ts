import { describe, expect, it } from 'vitest';

import { resolveSessionDocumentSources } from '@/lib/document/session-sources';
import type { SessionDocumentSource } from '@/lib/types/generation';

describe('resolveSessionDocumentSources', () => {
  it('prefers the structured documentSources list when present', () => {
    const sources: SessionDocumentSource[] = [
      {
        id: 'doc_1',
        name: 'lesson.pdf',
        size: 2048,
        mimeType: 'application/pdf',
        order: 1,
        storageKey: 'pdf_abc',
        assetId: 'ast_abc',
      },
    ];

    expect(
      resolveSessionDocumentSources({
        documentSources: sources,
        pdfStorageKey: 'pdf_legacy',
      }),
    ).toBe(sources);
  });

  it('still loads a legacy single-document session from its storageKey fields', () => {
    const sources = resolveSessionDocumentSources({
      pdfStorageKey: 'pdf_legacy_key',
      pdfFileName: 'legacy.pdf',
      documentMimeType: 'application/pdf',
      pdfProviderId: 'mineru-cloud',
    });

    expect(sources).toEqual([
      {
        id: 'source_1',
        name: 'legacy.pdf',
        size: 0,
        mimeType: 'application/pdf',
        order: 1,
        storageKey: 'pdf_legacy_key',
        providerId: 'mineru-cloud',
      },
    ]);
  });

  it('defaults a legacy session without a file name or MIME type to a PDF document', () => {
    expect(resolveSessionDocumentSources({ pdfStorageKey: 'pdf_key' })).toEqual([
      {
        id: 'source_1',
        name: 'document.pdf',
        size: 0,
        mimeType: 'application/pdf',
        order: 1,
        storageKey: 'pdf_key',
      },
    ]);
  });

  it('returns an empty list when no sources are recorded', () => {
    expect(resolveSessionDocumentSources({})).toEqual([]);
  });
});
