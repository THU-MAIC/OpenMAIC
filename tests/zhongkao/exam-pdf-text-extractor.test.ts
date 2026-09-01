import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXAM_PDF_TEXT_EXTRACTION_LIMITS,
  extractExamPdfTextArtifact,
} from '@/lib/server/zhongkao/exam-pdf-text-extractor';

const FINGERPRINT = 'b'.repeat(64);

async function textPdf(pageTexts: Array<string | undefined>): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = pdf.addPage([300, 400]);
    if (text) page.drawText(text, { x: 24, y: 350, size: 12, font });
  }
  return Buffer.from(await pdf.save());
}

function input(bytes: Buffer) {
  return {
    examSessionId: 'exm_fixture',
    examDocumentId: 'doc_question_paper',
    sourceSnapshotFingerprint: FINGERPRINT,
    mimeType: 'application/pdf',
    bytes,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractExamPdfTextArtifact', () => {
  it('extracts a valid text-native PDF with stable 1-based page lineage', async () => {
    const result = await extractExamPdfTextArtifact(
      input(await textPdf(['PAGE_ONE_ALPHA', 'PAGE_TWO_BETA'])),
    );

    expect(result.pageCount).toBe(2);
    expect(result.pages).toEqual([
      {
        pageNumber: 1,
        blocks: [{ blockIndex: 0, kind: 'text', text: 'PAGE_ONE_ALPHA' }],
      },
      {
        pageNumber: 2,
        blocks: [{ blockIndex: 0, kind: 'text', text: 'PAGE_TWO_BETA' }],
      },
    ]);
    expect(result.pages[0]?.blocks[0]).not.toHaveProperty('bbox');
    expect(result.pages.flatMap((page) => page.blocks).map((block) => block.kind)).toEqual([
      'text',
      'text',
    ]);
  });

  it('preserves an empty page between text pages without guessing page separators', async () => {
    const result = await extractExamPdfTextArtifact(
      input(await textPdf(['FIRST_PAGE', undefined, 'THIRD_PAGE'])),
    );

    expect(result.pageCount).toBe(3);
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(result.pages[1]?.blocks).toEqual([]);
    expect(result.pages[2]?.blocks[0]?.text).toBe('THIRD_PAGE');
  });

  it('splits only real newlines into ordered non-empty page-local blocks', async () => {
    const result = await extractExamPdfTextArtifact(
      input(await textPdf(['1. QUESTION_ONE\n  SHARED BODY  \n\n2. QUESTION_TWO'])),
    );

    expect(result.pages[0]?.blocks).toEqual([
      { blockIndex: 0, kind: 'text', text: '1. QUESTION_ONE' },
      { blockIndex: 1, kind: 'text', text: 'SHARED BODY' },
      { blockIndex: 2, kind: 'text', text: '2. QUESTION_TWO' },
    ]);
  });

  it('rejects a PDF with pages but no text layer and never attempts a network/OCR fallback', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network/provider fallback must not run');
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      extractExamPdfTextArtifact(input(await textPdf([undefined]))),
    ).rejects.toMatchObject({ code: 'EXAM_TEXT_EXTRACTION_UNAVAILABLE' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects page labels and stray characters as an unreliable text layer', async () => {
    await expect(
      extractExamPdfTextArtifact(input(await textPdf(['Page 1', 'Page 2']))),
    ).rejects.toMatchObject({ code: 'EXAM_TEXT_EXTRACTION_UNAVAILABLE' });
  });

  it('maps malformed PDF parser details to one closed extraction error', async () => {
    let error: unknown;
    try {
      await extractExamPdfTextArtifact(input(Buffer.from('%PDF malformed private parser detail')));
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: 'EXAM_DOCUMENT_EXTRACTION_FAILED' });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('EXAM_DOCUMENT_EXTRACTION_FAILED');
  });

  it('rejects PDFs above the page limit before extracting their text', async () => {
    const pages = Array.from(
      { length: EXAM_PDF_TEXT_EXTRACTION_LIMITS.maxPages + 1 },
      () => undefined,
    );

    await expect(extractExamPdfTextArtifact(input(await textPdf(pages)))).rejects.toMatchObject({
      code: 'EXAM_DOCUMENT_ARTIFACT_INVALID',
    });
  });

  it('rejects non-PDF MIME without invoking provider selection', async () => {
    await expect(
      extractExamPdfTextArtifact({
        ...input(await textPdf(['QUESTION_ONE'])),
        mimeType: 'text/plain',
      }),
    ).rejects.toMatchObject({ code: 'EXAM_DOCUMENT_ARTIFACT_INVALID' });
  });
});
