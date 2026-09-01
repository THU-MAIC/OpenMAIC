import { getDocumentProxy } from 'unpdf';

import { EXAM_MAX_DOCUMENT_BYTES } from '@/lib/zhongkao/exam';
import {
  EXAM_DOCUMENT_ARTIFACT_LIMITS,
  EXAM_DOCUMENT_ARTIFACT_VERSION,
  EXAM_DOCUMENT_NORMALIZATION_VERSION,
  EXAM_EXTRACTION_VERSION,
  EXAM_PDF_EXTRACTOR_ID,
  EXAM_PDF_EXTRACTOR_VERSION,
  normalizeExamDocumentText,
  parseExamDocumentArtifact,
  type ExamDocumentArtifactV1,
} from '@/lib/zhongkao/exam-document-artifact';
import { ExamError, isExamError } from '@/lib/zhongkao/exam-errors';

export {
  EXAM_DOCUMENT_ARTIFACT_VERSION,
  EXAM_DOCUMENT_NORMALIZATION_VERSION,
  EXAM_EXTRACTION_VERSION,
  EXAM_PDF_EXTRACTOR_ID,
  EXAM_PDF_EXTRACTOR_VERSION,
};

export const EXAM_PDF_TEXT_EXTRACTION_LIMITS = Object.freeze({
  maxSourceBytes: EXAM_MAX_DOCUMENT_BYTES,
  maxPages: EXAM_DOCUMENT_ARTIFACT_LIMITS.maxPages,
  maxBlocks: EXAM_DOCUMENT_ARTIFACT_LIMITS.maxBlocks,
  maxTextItems: EXAM_DOCUMENT_ARTIFACT_LIMITS.maxBlocks * 10,
  maxBlockTextBytes: EXAM_DOCUMENT_ARTIFACT_LIMITS.maxBlockTextBytes,
  maxTotalTextBytes: EXAM_DOCUMENT_ARTIFACT_LIMITS.maxTotalTextBytes,
  maxImageSize: 16_000_000,
  minTotalNonWhitespaceCharacters: 16,
  minPageNonWhitespaceCharacters: 8,
});

export interface ExtractExamPdfTextArtifactInput {
  examSessionId: string;
  examDocumentId: string;
  sourceSnapshotFingerprint: string;
  mimeType: string;
  bytes: Buffer;
}

const IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const WHITESPACE = /\s/u;

function countNonWhitespaceCharacters(value: string, stopAt: number): number {
  let count = 0;
  for (const character of value) {
    if (!WHITESPACE.test(character)) count += 1;
    if (count >= stopAt) break;
  }
  return count;
}

function assertInput(input: ExtractExamPdfTextArtifactInput): void {
  if (
    !input ||
    !IDENTIFIER.test(input.examSessionId) ||
    input.examSessionId !== input.examSessionId.trim() ||
    !IDENTIFIER.test(input.examDocumentId) ||
    input.examDocumentId !== input.examDocumentId.trim() ||
    !SHA256.test(input.sourceSnapshotFingerprint) ||
    input.mimeType !== 'application/pdf' ||
    !Buffer.isBuffer(input.bytes) ||
    input.bytes.byteLength < 1 ||
    input.bytes.byteLength > EXAM_PDF_TEXT_EXTRACTION_LIMITS.maxSourceBytes
  ) {
    throw new ExamError('EXAM_DOCUMENT_ARTIFACT_INVALID');
  }
}

/**
 * Extract the text layer of an immutable Exam PDF into an Exam-owned artifact.
 * This path is deliberately local and text-only: it has no provider selection,
 * network, OCR, image, formula, table, or model fallback.
 */
export async function extractExamPdfTextArtifact(
  input: ExtractExamPdfTextArtifactInput,
): Promise<ExamDocumentArtifactV1> {
  assertInput(input);
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    pdf = await getDocumentProxy(new Uint8Array(input.bytes), {
      isEvalSupported: false,
      maxImageSize: EXAM_PDF_TEXT_EXTRACTION_LIMITS.maxImageSize,
    });
    if (
      !Number.isSafeInteger(pdf.numPages) ||
      pdf.numPages < 1 ||
      pdf.numPages > EXAM_PDF_TEXT_EXTRACTION_LIMITS.maxPages
    ) {
      throw new ExamError('EXAM_DOCUMENT_ARTIFACT_INVALID');
    }

    let totalTextBytes = 0;
    let totalRawTextBytes = 0;
    let totalBlocks = 0;
    let totalTextItems = 0;
    let totalNonWhitespaceCharacters = 0;
    let maxPageNonWhitespaceCharacters = 0;
    const pages: ExamDocumentArtifactV1['pages'][number][] = [];
    for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
      const page = await pdf.getPage(pageIndex + 1);
      let rawText: string;
      try {
        const pieces: string[] = [];
        const reader = page.streamTextContent().getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const item of value.items) {
              if (!('str' in item) || typeof item.str !== 'string') continue;
              totalTextItems += 1;
              if (totalTextItems > EXAM_PDF_TEXT_EXTRACTION_LIMITS.maxTextItems) {
                throw new ExamError('EXAM_DOCUMENT_ARTIFACT_INVALID');
              }
              const piece = `${item.str}${'hasEOL' in item && item.hasEOL === true ? '\n' : ''}`;
              totalRawTextBytes += Buffer.byteLength(piece, 'utf8');
              if (totalRawTextBytes > EXAM_PDF_TEXT_EXTRACTION_LIMITS.maxTotalTextBytes) {
                throw new ExamError('EXAM_DOCUMENT_ARTIFACT_INVALID');
              }
              pieces.push(piece);
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        rawText = pieces.join('');
      } finally {
        page.cleanup();
      }
      const text = normalizeExamDocumentText(rawText);
      const textBytes = Buffer.byteLength(text, 'utf8');
      totalTextBytes += textBytes;
      if (totalTextBytes > EXAM_PDF_TEXT_EXTRACTION_LIMITS.maxTotalTextBytes) {
        throw new ExamError('EXAM_DOCUMENT_ARTIFACT_INVALID');
      }
      const pageNonWhitespaceCharacters = countNonWhitespaceCharacters(
        text,
        EXAM_PDF_TEXT_EXTRACTION_LIMITS.minTotalNonWhitespaceCharacters,
      );
      totalNonWhitespaceCharacters = Math.min(
        EXAM_PDF_TEXT_EXTRACTION_LIMITS.minTotalNonWhitespaceCharacters,
        totalNonWhitespaceCharacters + pageNonWhitespaceCharacters,
      );
      maxPageNonWhitespaceCharacters = Math.max(
        maxPageNonWhitespaceCharacters,
        pageNonWhitespaceCharacters,
      );
      const blocks = text
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line, blockIndex) => {
          if (Buffer.byteLength(line, 'utf8') > EXAM_PDF_TEXT_EXTRACTION_LIMITS.maxBlockTextBytes) {
            throw new ExamError('EXAM_DOCUMENT_ARTIFACT_INVALID');
          }
          return { blockIndex, kind: 'text' as const, text: line };
        });
      if (blocks.length > EXAM_DOCUMENT_ARTIFACT_LIMITS.maxBlocksPerPage) {
        throw new ExamError('EXAM_DOCUMENT_ARTIFACT_INVALID');
      }
      totalBlocks += blocks.length;
      if (totalBlocks > EXAM_PDF_TEXT_EXTRACTION_LIMITS.maxBlocks) {
        throw new ExamError('EXAM_DOCUMENT_ARTIFACT_INVALID');
      }
      pages.push({
        pageNumber: pageIndex + 1,
        blocks,
      });
    }

    if (
      totalNonWhitespaceCharacters <
        EXAM_PDF_TEXT_EXTRACTION_LIMITS.minTotalNonWhitespaceCharacters ||
      maxPageNonWhitespaceCharacters <
        EXAM_PDF_TEXT_EXTRACTION_LIMITS.minPageNonWhitespaceCharacters
    ) {
      throw new ExamError('EXAM_TEXT_EXTRACTION_UNAVAILABLE');
    }

    return parseExamDocumentArtifact({
      schemaVersion: EXAM_EXTRACTION_VERSION,
      artifactVersion: EXAM_DOCUMENT_ARTIFACT_VERSION,
      examSessionId: input.examSessionId,
      examDocumentId: input.examDocumentId,
      sourceSnapshotFingerprint: input.sourceSnapshotFingerprint,
      mimeType: 'application/pdf',
      pageCount: pdf.numPages,
      pages,
    });
  } catch (error) {
    if (isExamError(error)) throw error;
    throw new ExamError('EXAM_DOCUMENT_EXTRACTION_FAILED');
  } finally {
    await pdf?.destroy().catch(() => undefined);
  }
}
