import { describe, expect, it } from 'vitest';

import {
  getDocumentExtractorProvider,
  getDocumentExtractorProviders,
  selectDocumentExtractorProvider,
} from '@/lib/document';

describe('document extractor registry', () => {
  it('exposes existing PDF providers through the document extractor boundary', () => {
    const providers = getDocumentExtractorProviders();

    expect(providers.map((provider) => provider.id)).toEqual([
      'plain-text',
      'unpdf',
      'mineru',
      'mineru-cloud',
    ]);
    expect(providers.every((provider) => provider.supportedMimeTypes)).toBe(true);
    expect(
      providers
        .filter((provider) => provider.id !== 'plain-text')
        .every((provider) => provider.supportedMimeTypes.includes('application/pdf')),
    ).toBe(true);
  });

  it('exposes a local plain-text extractor for TXT and Markdown', () => {
    const plainText = getDocumentExtractorProvider('plain-text');

    expect(plainText).toBeDefined();
    expect(plainText?.supportedMimeTypes).toEqual([
      'text/plain',
      'text/markdown',
      'text/x-markdown',
    ]);
    expect(plainText?.capabilities).toMatchObject({
      text: true,
      images: false,
      tables: false,
      formulas: false,
      layout: false,
      ocr: false,
      async: false,
    });
  });

  it('declares MinerU capabilities and supported course material formats', () => {
    const mineru = getDocumentExtractorProvider('mineru');
    const mineruCloud = getDocumentExtractorProvider('mineru-cloud');

    expect(mineru).toBeDefined();
    expect(mineru?.displayName).toBe('MinerU');
    expect(mineru?.supportedMimeTypes).toEqual([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ]);
    expect(mineru?.capabilities).toMatchObject({
      text: true,
      images: true,
      tables: true,
      formulas: true,
      layout: true,
      ocr: true,
      async: false,
    });
    expect(mineruCloud).toBeDefined();
    expect(mineruCloud?.supportedMimeTypes).toEqual(mineru?.supportedMimeTypes);
    expect(mineruCloud?.capabilities).toMatchObject({
      text: true,
      images: true,
      tables: true,
      formulas: true,
      layout: true,
      ocr: true,
      async: true,
    });
  });

  it('selects a preferred provider only when it supports the requested MIME type', () => {
    expect(
      selectDocumentExtractorProvider({
        mimeType: 'application/pdf',
        preferredProviderId: 'mineru-cloud',
      }).id,
    ).toBe('mineru-cloud');

    expect(
      selectDocumentExtractorProvider({
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        preferredProviderId: 'mineru',
      }).id,
    ).toBe('mineru');

    expect(() =>
      selectDocumentExtractorProvider({
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        preferredProviderId: 'unpdf',
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
        mimeType: 'application/vnd.ms-excel',
      }),
    ).toThrow(/No document extractor supports MIME type/);
  });

  it('can capability-match Office course material to MinerU', () => {
    expect(
      selectDocumentExtractorProvider({
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        requiredCapabilities: { text: true },
      }).id,
    ).toBe('mineru');

    expect(
      selectDocumentExtractorProvider({
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        preferredProviderId: 'mineru-cloud',
        requiredCapabilities: { text: true },
      }).id,
    ).toBe('mineru-cloud');
  });

  it('can capability-match text course material locally', () => {
    expect(
      selectDocumentExtractorProvider({
        mimeType: 'text/markdown',
        requiredCapabilities: { text: true },
      }).id,
    ).toBe('plain-text');
  });
});
