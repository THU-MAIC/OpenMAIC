import { EXAM_MAX_DOCUMENT_ARTIFACT_BYTES, EXAM_MAX_EXTRACTED_PAGES } from './exam';
import { ExamError } from './exam-errors';
import {
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  type DomainValidationIssue,
  type DomainValidationResult,
} from './validation';

export const EXAM_EXTRACTION_VERSION = 1 as const;
export const EXAM_DOCUMENT_ARTIFACT_VERSION = 1 as const;
export const EXAM_PDF_EXTRACTOR_ID = 'unpdf' as const;
export const EXAM_PDF_EXTRACTOR_VERSION = 'exam-pdf-text:v1' as const;
export const EXAM_DOCUMENT_NORMALIZATION_VERSION = 'exam-document-normalization:v1' as const;

export const EXAM_DOCUMENT_ARTIFACT_LIMITS = Object.freeze({
  maxPages: EXAM_MAX_EXTRACTED_PAGES,
  maxBlocks: 10_000,
  maxBlocksPerPage: 1_000,
  maxBlockTextBytes: 512 * 1024,
  maxTotalTextBytes: 8 * 1024 * 1024,
  maxSerializedBytes: EXAM_MAX_DOCUMENT_ARTIFACT_BYTES,
  maxPageDimension: 1_000_000,
});

export const EXAM_DOCUMENT_BLOCK_KINDS = [
  'text',
  'formula',
  'table',
  'image_marker',
  'other',
] as const;

export type ExamDocumentBlockKind = (typeof EXAM_DOCUMENT_BLOCK_KINDS)[number];

/**
 * Internal bbox contract for artifact v1. Values are page-relative ratios,
 * with (0, 0) at the top-left and both axes increasing toward the bottom-right.
 * Extractors without a stable coordinate transform must omit this field.
 */
export interface ExamDocumentBboxV1 {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExamDocumentBlockV1 {
  blockIndex: number;
  kind: ExamDocumentBlockKind;
  text?: string;
  bbox?: ExamDocumentBboxV1;
}

export interface ExamDocumentPageV1 {
  pageNumber: number;
  width?: number;
  height?: number;
  blocks: ExamDocumentBlockV1[];
}

export interface ExamDocumentArtifactV1 {
  schemaVersion: typeof EXAM_EXTRACTION_VERSION;
  artifactVersion: typeof EXAM_DOCUMENT_ARTIFACT_VERSION;
  examSessionId: string;
  examDocumentId: string;
  sourceSnapshotFingerprint: string;
  mimeType: 'application/pdf';
  pageCount: number;
  pages: ExamDocumentPageV1[];
}

const SHA256 = /^[a-f0-9]{64}$/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactVersion',
  'examSessionId',
  'examDocumentId',
  'sourceSnapshotFingerprint',
  'mimeType',
  'pageCount',
  'pages',
]);
const PAGE_KEYS = new Set(['pageNumber', 'width', 'height', 'blocks']);
const BLOCK_KEYS = new Set(['blockIndex', 'kind', 'text', 'bbox']);
const BBOX_KEYS = new Set(['x', 'y', 'width', 'height']);
const BLOCK_KINDS = new Set<string>(EXAM_DOCUMENT_BLOCK_KINDS);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function validPositiveDimension(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= EXAM_DOCUMENT_ARTIFACT_LIMITS.maxPageDimension
  );
}

function validateBbox(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamDocumentBboxV1 {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected bbox object');
    return false;
  }
  rejectUnknownKeys(value, BBOX_KEYS, path, errors);
  const fields = ['x', 'y', 'width', 'height'] as const;
  let valid = true;
  for (const field of fields) {
    const coordinate = value[field];
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || coordinate < 0) {
      pushIssue(errors, `${path}/${field}`, 'expected a finite non-negative number');
      valid = false;
    }
  }
  if (!valid) return false;
  const bbox = value as unknown as ExamDocumentBboxV1;
  if (bbox.x > 1 || bbox.y > 1 || bbox.width > 1 || bbox.height > 1) {
    pushIssue(errors, path, 'bbox values must be page-relative ratios in the range 0..1');
    valid = false;
  }
  if (bbox.x + bbox.width > 1 || bbox.y + bbox.height > 1) {
    pushIssue(errors, path, 'bbox must fit within its page');
    valid = false;
  }
  return valid;
}

export function normalizeExamDocumentText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').normalize('NFC');
}

export function validateExamDocumentArtifact(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected exam document artifact object');
    return finishValidation(errors);
  }

  rejectUnknownKeys(value, ARTIFACT_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_EXTRACTION_VERSION) {
    pushIssue(errors, '/schemaVersion', `expected schemaVersion ${EXAM_EXTRACTION_VERSION}`);
  }
  if (value.artifactVersion !== EXAM_DOCUMENT_ARTIFACT_VERSION) {
    pushIssue(
      errors,
      '/artifactVersion',
      `expected artifactVersion ${EXAM_DOCUMENT_ARTIFACT_VERSION}`,
    );
  }
  validateIdentifier(value.examSessionId, '/examSessionId', errors);
  validateIdentifier(value.examDocumentId, '/examDocumentId', errors);
  if (
    typeof value.sourceSnapshotFingerprint !== 'string' ||
    !SHA256.test(value.sourceSnapshotFingerprint)
  ) {
    pushIssue(errors, '/sourceSnapshotFingerprint', 'expected lowercase SHA-256 fingerprint');
  }
  if (value.mimeType !== 'application/pdf') {
    pushIssue(errors, '/mimeType', 'expected application/pdf');
  }

  const pageCount = value.pageCount;
  if (
    !Number.isSafeInteger(pageCount) ||
    (pageCount as number) < 1 ||
    (pageCount as number) > EXAM_DOCUMENT_ARTIFACT_LIMITS.maxPages
  ) {
    pushIssue(
      errors,
      '/pageCount',
      `expected 1 to ${EXAM_DOCUMENT_ARTIFACT_LIMITS.maxPages} pages`,
    );
  }
  if (!Array.isArray(value.pages)) {
    pushIssue(errors, '/pages', 'expected pages array');
    return finishValidation(errors);
  }
  if (Number.isSafeInteger(pageCount) && value.pages.length !== pageCount) {
    pushIssue(errors, '/pages', 'page array length must equal pageCount');
  }

  let totalBlocks = 0;
  let totalTextBytes = 0;
  let hasExtractedText = false;
  value.pages.forEach((rawPage, pageIndex) => {
    const pagePath = `/pages/${pageIndex}`;
    if (!isPlainRecord(rawPage)) {
      pushIssue(errors, pagePath, 'expected page object');
      return;
    }
    rejectUnknownKeys(rawPage, PAGE_KEYS, pagePath, errors);
    if (rawPage.pageNumber !== pageIndex + 1) {
      pushIssue(errors, `${pagePath}/pageNumber`, 'pages must be unique and ordered from 1');
    }
    const hasWidth = Object.hasOwn(rawPage, 'width');
    const hasHeight = Object.hasOwn(rawPage, 'height');
    if (hasWidth !== hasHeight) {
      pushIssue(errors, pagePath, 'page width and height must be supplied together');
    }
    if (hasWidth && !validPositiveDimension(rawPage.width)) {
      pushIssue(errors, `${pagePath}/width`, 'expected a finite positive page dimension');
    }
    if (hasHeight && !validPositiveDimension(rawPage.height)) {
      pushIssue(errors, `${pagePath}/height`, 'expected a finite positive page dimension');
    }
    if (!Array.isArray(rawPage.blocks)) {
      pushIssue(errors, `${pagePath}/blocks`, 'expected blocks array');
      return;
    }
    if (rawPage.blocks.length > EXAM_DOCUMENT_ARTIFACT_LIMITS.maxBlocksPerPage) {
      pushIssue(
        errors,
        `${pagePath}/blocks`,
        `page exceeds ${EXAM_DOCUMENT_ARTIFACT_LIMITS.maxBlocksPerPage} blocks`,
      );
    }
    totalBlocks += rawPage.blocks.length;

    rawPage.blocks.forEach((rawBlock, blockIndex) => {
      const blockPath = `${pagePath}/blocks/${blockIndex}`;
      if (!isPlainRecord(rawBlock)) {
        pushIssue(errors, blockPath, 'expected block object');
        return;
      }
      rejectUnknownKeys(rawBlock, BLOCK_KEYS, blockPath, errors);
      if (rawBlock.blockIndex !== blockIndex) {
        pushIssue(errors, `${blockPath}/blockIndex`, 'blocks must be uniquely ordered from 0');
      }
      if (typeof rawBlock.kind !== 'string' || !BLOCK_KINDS.has(rawBlock.kind)) {
        pushIssue(errors, `${blockPath}/kind`, 'unknown document block kind');
      }
      const requiresText =
        rawBlock.kind === 'text' || rawBlock.kind === 'formula' || rawBlock.kind === 'table';
      if (Object.hasOwn(rawBlock, 'text')) {
        if (typeof rawBlock.text !== 'string') {
          pushIssue(errors, `${blockPath}/text`, 'expected block text string');
        } else {
          const normalized = normalizeExamDocumentText(rawBlock.text);
          const bytes = utf8Length(normalized);
          totalTextBytes += bytes;
          if (bytes > EXAM_DOCUMENT_ARTIFACT_LIMITS.maxBlockTextBytes) {
            pushIssue(
              errors,
              `${blockPath}/text`,
              `block text exceeds ${EXAM_DOCUMENT_ARTIFACT_LIMITS.maxBlockTextBytes} bytes`,
            );
          }
          if (UNPAIRED_SURROGATE.test(normalized)) {
            pushIssue(errors, `${blockPath}/text`, 'block text contains an unpaired surrogate');
          }
          if (UNSAFE_CONTROL_CHARACTER.test(normalized)) {
            pushIssue(
              errors,
              `${blockPath}/text`,
              'block text contains an unsafe control character',
            );
          }
          if (normalized.trim().length > 0) hasExtractedText = true;
          if (requiresText && normalized.trim().length === 0) {
            pushIssue(errors, `${blockPath}/text`, 'text-bearing block must not be empty');
          }
        }
      } else if (requiresText) {
        pushIssue(errors, `${blockPath}/text`, 'text-bearing block requires text');
      }
      if (Object.hasOwn(rawBlock, 'bbox')) {
        validateBbox(rawBlock.bbox, `${blockPath}/bbox`, errors);
      }
    });
  });

  if (totalBlocks > EXAM_DOCUMENT_ARTIFACT_LIMITS.maxBlocks) {
    pushIssue(
      errors,
      '/pages',
      `artifact exceeds ${EXAM_DOCUMENT_ARTIFACT_LIMITS.maxBlocks} blocks`,
    );
  }
  if (totalTextBytes > EXAM_DOCUMENT_ARTIFACT_LIMITS.maxTotalTextBytes) {
    pushIssue(
      errors,
      '/pages',
      `artifact text exceeds ${EXAM_DOCUMENT_ARTIFACT_LIMITS.maxTotalTextBytes} bytes`,
    );
  }
  if (!hasExtractedText) {
    pushIssue(errors, '/pages', 'artifact contains no extracted text');
  }
  return finishValidation(errors);
}

function canonicalArtifact(value: ExamDocumentArtifactV1): ExamDocumentArtifactV1 {
  return {
    schemaVersion: EXAM_EXTRACTION_VERSION,
    artifactVersion: EXAM_DOCUMENT_ARTIFACT_VERSION,
    examSessionId: value.examSessionId,
    examDocumentId: value.examDocumentId,
    sourceSnapshotFingerprint: value.sourceSnapshotFingerprint,
    mimeType: 'application/pdf',
    pageCount: value.pageCount,
    pages: value.pages.map((page) => ({
      pageNumber: page.pageNumber,
      ...(page.width === undefined ? {} : { width: page.width }),
      ...(page.height === undefined ? {} : { height: page.height }),
      blocks: page.blocks.map((block) => ({
        blockIndex: block.blockIndex,
        kind: block.kind,
        ...(block.text === undefined ? {} : { text: normalizeExamDocumentText(block.text) }),
        ...(block.bbox === undefined
          ? {}
          : {
              bbox: {
                x: block.bbox.x,
                y: block.bbox.y,
                width: block.bbox.width,
                height: block.bbox.height,
              },
            }),
      })),
    })),
  };
}

function invalidArtifact(): never {
  throw new ExamError('EXAM_DOCUMENT_ARTIFACT_INVALID');
}

function decodeArtifactInput(value: unknown): unknown {
  if (typeof value === 'string') {
    if (utf8Length(value) > EXAM_DOCUMENT_ARTIFACT_LIMITS.maxSerializedBytes) invalidArtifact();
    try {
      return JSON.parse(value) as unknown;
    } catch {
      invalidArtifact();
    }
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > EXAM_DOCUMENT_ARTIFACT_LIMITS.maxSerializedBytes) invalidArtifact();
    try {
      return JSON.parse(UTF8_DECODER.decode(value)) as unknown;
    } catch {
      invalidArtifact();
    }
  }
  return value;
}

export function parseExamDocumentArtifact(value: unknown): ExamDocumentArtifactV1 {
  const decoded = decodeArtifactInput(value);
  if (!validateExamDocumentArtifact(decoded).valid) invalidArtifact();
  return canonicalArtifact(decoded as ExamDocumentArtifactV1);
}

export function serializeExamDocumentArtifact(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(parseExamDocumentArtifact(value)), 'utf8');
  if (bytes.byteLength > EXAM_DOCUMENT_ARTIFACT_LIMITS.maxSerializedBytes) invalidArtifact();
  return bytes;
}
