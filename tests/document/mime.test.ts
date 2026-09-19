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
    expect(
      normalizeDocumentMimeType({
        mimeType: 'application/wps-office.pptx',
        fileName: 'slides.pptx',
      }),
    ).toBe(DOCUMENT_MIME_TYPES.pptx);
    expect(
      normalizeDocumentMimeType({
        mimeType: 'application/wps-office.docx',
        fileName: 'lesson.docx',
      }),
    ).toBe(DOCUMENT_MIME_TYPES.docx);
    expect(
      normalizeDocumentMimeType({
        mimeType: 'application/wps-office.xlsx',
        fileName: 'grades.xlsx',
      }),
    ).toBe(DOCUMENT_MIME_TYPES.xlsx);
    expect(
      isMimeSupportedByProviders(
        { mimeType: 'application/wps-office.pptx', fileName: 'slides.pptx' },
        ['mineru'],
      ),
    ).toBe(true);
  });

  it('falls back to the extension when a browser reports an unknown MIME', () => {
    // Some Windows setups report application/x-msword for .doc — this alias
    // is now curated in the registry so it round-trips to the canonical MIME.
    expect(
      normalizeDocumentMimeType({ mimeType: 'application/x-msword', fileName: 'legacy.doc' }),
    ).toBe(DOCUMENT_MIME_TYPES.doc);
  });

  it('registers the workbench-only formats while keeping them provider-rejected', () => {
    // csv and webm are workbench-material formats (#1589): registered so the
    // shared extension table resolves them, but no document provider handles
    // them, so classic mode keeps rejecting them.
    expect(
      normalizeDocumentMimeType({ mimeType: 'application/octet-stream', fileName: 'grades.csv' }),
    ).toBe(DOCUMENT_MIME_TYPES.csv);
    expect(normalizeDocumentMimeType({ mimeType: '', fileName: 'clip.webm' })).toBe(
      DOCUMENT_MIME_TYPES.webm,
    );
    expect(
      isMimeSupportedByProviders({ mimeType: 'text/csv', fileName: 'grades.csv' }, ['plain-text']),
    ).toBe(false);
  });

  it('normalizes the audio/x-m4a alias some browsers report for .m4a', () => {
    expect(normalizeDocumentMimeType({ mimeType: 'audio/x-m4a', fileName: 'clip.m4a' })).toBe(
      DOCUMENT_MIME_TYPES.m4a,
    );
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
    expect(
      isMimeSupportedByProviders(
        { mimeType: 'application/wps-office.unknown', fileName: 'lesson.pptx' },
        ['mineru'],
      ),
    ).toBe(false);
  });

  describe('generic Office container MIME (application/vnd.ms-office)', () => {
    // Older Linux XDG shared-mime-info databases (e.g. Kylin OS V10) report
    // every OOXML file as the generic Office container instead of the
    // concrete format MIME. Like the zip family, the extension must decide.
    // (#1497)
    it('resolves OOXML extensions through the extension fallback', () => {
      expect(
        normalizeDocumentMimeType({
          mimeType: 'application/vnd.ms-office',
          fileName: 'slides.pptx',
        }),
      ).toBe(DOCUMENT_MIME_TYPES.pptx);
      expect(
        normalizeDocumentMimeType({
          mimeType: 'application/vnd.ms-office',
          fileName: 'lesson.docx',
        }),
      ).toBe(DOCUMENT_MIME_TYPES.docx);
      expect(
        normalizeDocumentMimeType({
          mimeType: 'application/vnd.ms-office',
          fileName: 'grades.xlsx',
        }),
      ).toBe(DOCUMENT_MIME_TYPES.xlsx);
    });

    it('resolves legacy Office extensions to their own canonical MIME', () => {
      expect(
        normalizeDocumentMimeType({
          mimeType: 'application/vnd.ms-office',
          fileName: 'deck.ppt',
        }),
      ).toBe(DOCUMENT_MIME_TYPES.ppt);
    });

    it('keeps the provider capability split for resolved legacy .ppt', () => {
      // Self-host MinerU does not support legacy OLE formats; only the cloud
      // provider does. Resolution must not blur that line.
      const input = { mimeType: 'application/vnd.ms-office', fileName: 'deck.ppt' };
      expect(isMimeSupportedByProviders(input, ['mineru'])).toBe(false);
      expect(isMimeSupportedByProviders(input, ['mineru-cloud'])).toBe(true);
    });

    it('passes provider whitelists for providers that support the format', () => {
      expect(
        isMimeSupportedByProviders(
          { mimeType: 'application/vnd.ms-office', fileName: 'slides.pptx' },
          ['mineru'],
        ),
      ).toBe(true);
    });

    it('still rejects the generic MIME when the extension is unknown', () => {
      expect(
        normalizeDocumentMimeType({
          mimeType: 'application/vnd.ms-office',
          fileName: 'blob.bin',
        }),
      ).toBe('application/vnd.ms-office');
      expect(
        isMimeSupportedByProviders(
          { mimeType: 'application/vnd.ms-office', fileName: 'blob.bin' },
          ['mineru-cloud'],
        ),
      ).toBe(false);
    });
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
