import { describe, expect, it } from 'vitest';

import {
  getDocumentExtractorProvider,
  getDocumentExtractorProviders,
  selectDocumentExtractorProvider,
} from '@/lib/document';

describe('document extractor registry', () => {
  it('exposes existing PDF providers through the document extractor boundary', () => {
    const providers = getDocumentExtractorProviders();

    expect(providers.map((provider) => provider.id)).toEqual(['unpdf', 'mineru', 'mineru-cloud']);
    expect(providers.every((provider) => provider.supportedMimeTypes)).toBe(true);
    expect(
      providers.every((provider) => provider.supportedMimeTypes.includes('application/pdf')),
    ).toBe(true);
  });

  it('declares MinerU capabilities without exposing unsupported upload formats yet', () => {
    const mineru = getDocumentExtractorProvider('mineru');

    expect(mineru).toBeDefined();
    expect(mineru?.displayName).toBe('MinerU');
    expect(mineru?.supportedMimeTypes).toEqual(['application/pdf']);
    expect(mineru?.capabilities).toMatchObject({
      text: true,
      images: true,
      tables: true,
      formulas: true,
      layout: true,
      ocr: true,
      async: false,
    });
  });

  it('selects a preferred provider only when it supports the requested MIME type', () => {
    expect(
      selectDocumentExtractorProvider({
        mimeType: 'application/pdf',
        preferredProviderId: 'mineru-cloud',
      }).id,
    ).toBe('mineru-cloud');

    expect(() =>
      selectDocumentExtractorProvider({
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        preferredProviderId: 'mineru',
      }),
    ).toThrow(/does not support MIME type/);
  });

  it('can select by required capabilities', () => {
    expect(
      selectDocumentExtractorProvider({
        mimeType: 'application/pdf',
        requiredCapabilities: { tables: true, formulas: true },
      }).id,
    ).toBe('mineru');

    expect(() =>
      selectDocumentExtractorProvider({
        mimeType: 'application/pdf',
        preferredProviderId: 'unpdf',
        requiredCapabilities: { tables: true },
      }),
    ).toThrow(/requested capabilities/);
  });

  it('returns a clear error when no provider supports the MIME type', () => {
    expect(() =>
      selectDocumentExtractorProvider({
        mimeType: 'text/plain',
      }),
    ).toThrow(/No document extractor supports MIME type/);
  });
});
