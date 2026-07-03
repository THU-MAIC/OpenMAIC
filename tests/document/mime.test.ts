import { describe, expect, it } from 'vitest';
import { DOCUMENT_MIME_TYPES, normalizeDocumentMimeType } from '@/lib/document/mime';

describe('document MIME normalization', () => {
  it('uses Office filename extensions when browsers report generic ZIP MIME types', () => {
    expect(
      normalizeDocumentMimeType({
        mimeType: 'application/zip',
        fileName: 'lesson.docx',
      }),
    ).toBe(DOCUMENT_MIME_TYPES.docx);

    expect(
      normalizeDocumentMimeType({
        mimeType: 'application/x-zip-compressed',
        fileName: 'slides.pptx',
      }),
    ).toBe(DOCUMENT_MIME_TYPES.pptx);
  });

  it('keeps specific MIME types when they are not generic upload fallbacks', () => {
    expect(
      normalizeDocumentMimeType({
        mimeType: 'text/plain',
        fileName: 'lesson.docx',
      }),
    ).toBe(DOCUMENT_MIME_TYPES.txt);
  });
});
