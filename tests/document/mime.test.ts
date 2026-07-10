import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MIME_TYPES,
  getAcceptStringForProviders,
  getFormatLabelsForProviders,
  isMimeSupportedByProviders,
  normalizeDocumentMimeType,
  SUPPORTED_MEDIA_MIME_TYPES,
} from '@/lib/document/mime';

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

  it('maps aliased MIMEs to the canonical form', () => {
    // Some browsers report image/jpeg2000 for .jp2, image/x-ms-bmp for .bmp,
    // text/x-markdown for .md — these must round-trip to the canonical MIME
    // so provider whitelists and downstream lookups all agree.
    expect(normalizeDocumentMimeType({ mimeType: 'image/jpeg2000', fileName: 'photo.jp2' })).toBe(
      DOCUMENT_MIME_TYPES.jp2,
    );
    expect(normalizeDocumentMimeType({ mimeType: 'image/x-ms-bmp', fileName: 'chart.bmp' })).toBe(
      DOCUMENT_MIME_TYPES.bmp,
    );
    expect(normalizeDocumentMimeType({ mimeType: 'text/x-markdown', fileName: 'notes.md' })).toBe(
      DOCUMENT_MIME_TYPES.markdown,
    );
  });

  it('falls back to the extension when a browser reports an unknown MIME', () => {
    // Some Windows setups report application/x-msword for .doc — this alias
    // is now curated in the registry so it round-trips to the canonical MIME.
    expect(
      normalizeDocumentMimeType({ mimeType: 'application/x-msword', fileName: 'legacy.doc' }),
    ).toBe(DOCUMENT_MIME_TYPES.doc);
  });

  it('does not let an unknown MIME masquerade as a supported format via the filename extension', () => {
    // Security regression: previously any unknown MIME with a matching
    // extension was normalized to the extension's canonical MIME, so a
    // `{application/x-msdownload, lesson.pdf}` upload would pass the unpdf
    // whitelist. Curated aliases go through aliasMimes; everything else
    // keeps its reported MIME so provider whitelists can reject it.
    expect(
      normalizeDocumentMimeType({
        mimeType: 'application/x-msdownload',
        fileName: 'lesson.pdf',
      }),
    ).toBe('application/x-msdownload');
    expect(
      isMimeSupportedByProviders({ mimeType: 'application/x-msdownload', fileName: 'lesson.pdf' }, [
        'unpdf',
      ]),
    ).toBe(false);
  });

  it('accepts a non-canonical browser MIME for a provider that supports the format', () => {
    // Regression: previously the raw non-canonical MIME leaked through and
    // failed the provider whitelist despite the file being valid.
    expect(
      isMimeSupportedByProviders({ mimeType: 'image/jpeg2000', fileName: 'photo.jp2' }, [
        'mineru-cloud',
      ]),
    ).toBe(true);
  });

  describe('media (audio/video) support', () => {
    it('accepts audio/video for a provider that handles media (AliDocMind)', () => {
      expect(
        isMimeSupportedByProviders({ mimeType: 'video/mp4', fileName: 'lesson.mp4' }, [
          'alidocmind',
        ]),
      ).toBe(true);
      expect(
        isMimeSupportedByProviders({ mimeType: 'audio/mpeg', fileName: 'lecture.mp3' }, [
          'alidocmind',
        ]),
      ).toBe(true);
    });

    it('rejects audio/video for document-only providers', () => {
      expect(
        isMimeSupportedByProviders({ mimeType: 'video/mp4', fileName: 'lesson.mp4' }, ['mineru']),
      ).toBe(false);
      expect(
        isMimeSupportedByProviders({ mimeType: 'video/mp4', fileName: 'lesson.mp4' }, ['unpdf']),
      ).toBe(false);
    });

    it('includes media extensions in the accept string when the provider supports media', () => {
      const accept = getAcceptStringForProviders(['alidocmind']);
      expect(accept).toContain('.mp4');
      expect(accept).toContain('.mp3');
      expect(accept).toContain('video/mp4');
      // still includes documents
      expect(accept).toContain('.pdf');
    });

    it('surfaces media format badges for media-capable providers', () => {
      const labels = getFormatLabelsForProviders(['alidocmind']);
      expect(labels).toContain('MP4');
      expect(labels).toContain('MP3');
    });

    it('exposes the union of media MIME types', () => {
      expect(SUPPORTED_MEDIA_MIME_TYPES).toContain('video/mp4');
      expect(SUPPORTED_MEDIA_MIME_TYPES).toContain('audio/wav');
      expect(SUPPORTED_MEDIA_MIME_TYPES).not.toContain('application/pdf');
    });

    it('normalizes a browser-reported audio/mp3 alias to canonical audio/mpeg', () => {
      expect(normalizeDocumentMimeType({ mimeType: 'audio/mp3', fileName: 'lecture.mp3' })).toBe(
        'audio/mpeg',
      );
    });
  });
});
