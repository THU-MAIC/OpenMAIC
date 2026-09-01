import { createHash } from 'node:crypto';

import {
  EXAM_DOCUMENT_ARTIFACT_LIMITS,
  parseExamDocumentArtifact,
  serializeExamDocumentArtifact,
  validateExamDocumentArtifact,
  type ExamDocumentArtifactV1,
  type ExamDocumentBboxV1,
  type ExamDocumentBlockKind,
  type ExamDocumentBlockV1,
  type ExamDocumentPageV1,
} from './exam-document-artifact';
import { EXAM_MAX_CANDIDATE_ARTIFACT_BYTES, EXAM_MAX_QUESTION_CANDIDATES } from './exam';
import {
  EXAM_QUESTION_MARKER_MAX_SECTION_LABEL_LENGTH,
  examQuestionLocatorKey,
  normalizeExamQuestionMarker,
  sameExamQuestionTopLevel,
  type ExamQuestionLocator,
  type ExamQuestionSectionRef,
  type NormalizedExamQuestionMarker,
} from './exam-question-locator';
import {
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  type DomainValidationIssue,
  type DomainValidationResult,
} from './validation';

export const EXAM_QUESTION_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const EXAM_QUESTION_CANDIDATES_ARTIFACT_VERSION = 1 as const;
export const EXAM_QUESTION_SEGMENTATION_VERSION = 1 as const;

export const EXAM_QUESTION_SEGMENTATION_LIMITS = Object.freeze({
  maxPages: EXAM_DOCUMENT_ARTIFACT_LIMITS.maxPages,
  maxBlocks: EXAM_DOCUMENT_ARTIFACT_LIMITS.maxBlocks,
  maxBlockTextBytes: EXAM_DOCUMENT_ARTIFACT_LIMITS.maxBlockTextBytes,
  maxTotalTextBytes: EXAM_DOCUMENT_ARTIFACT_LIMITS.maxTotalTextBytes,
  maxCandidates: EXAM_MAX_QUESTION_CANDIDATES,
  maxDiagnostics: EXAM_MAX_QUESTION_CANDIDATES * 4 + 1,
  maxSourceSpansPerCandidate: EXAM_DOCUMENT_ARTIFACT_LIMITS.maxPages,
  maxQuestionTextBytes: 100_000,
  maxSectionLabelLength: EXAM_QUESTION_MARKER_MAX_SECTION_LABEL_LENGTH,
  maxRawLabelLength: 64,
  maxSerializedBytes: EXAM_MAX_CANDIDATE_ARTIFACT_BYTES,
});

export type ExamQuestionSourceBlockKind = ExamDocumentBlockKind;
export type ExamQuestionSourceBbox = ExamDocumentBboxV1;
export type ExamQuestionSourceBlock = ExamDocumentBlockV1;
export type ExamQuestionSourcePage = ExamDocumentPageV1;
export type SegmentableExamDocumentArtifact = ExamDocumentArtifactV1;

export {
  normalizeExamQuestionMarker,
  type ExamQuestionLocator,
  type ExamQuestionSectionRef,
  type NormalizedExamQuestionMarker,
} from './exam-question-locator';

export interface ExamQuestionSourceSpan {
  pageNumber: number;
  startBlockIndex: number;
  endBlockIndex: number;
  /** UTF-16 code-unit offset into startBlockIndex text. */
  startOffset?: number;
  /** Exclusive UTF-16 code-unit offset into endBlockIndex text. */
  endOffset?: number;
  bbox?: ExamQuestionSourceBbox;
}

export type ExamQuestionCandidateKind = 'group' | 'leaf';
export type ExamQuestionCandidateContentStatus = 'complete' | 'oversized';
export type ExamQuestionCandidateConfidenceBand = 'high' | 'medium' | 'low';
export type ExamQuestionCandidateConfidenceReasonCode =
  | 'unique_explicit_top_level_label'
  | 'explicit_group_with_subquestions'
  | 'subquestion_hierarchy_inferred'
  | 'cross_page_span'
  | 'duplicate_locator'
  | 'empty_body'
  | 'oversized_content';

export interface ExamQuestionCandidateV1 {
  schemaVersion: typeof EXAM_QUESTION_CANDIDATE_SCHEMA_VERSION;
  candidateId: string;
  candidateStatus: 'candidate';
  candidateKind: ExamQuestionCandidateKind;
  rawLabel: string;
  locator: ExamQuestionLocator;
  ordinalDiscriminator: number;
  parentCandidateId?: string;
  text: string;
  sourceSpans: readonly ExamQuestionSourceSpan[];
  contentStatus: ExamQuestionCandidateContentStatus;
  candidateQuestionType: 'unknown';
  confidenceBand: ExamQuestionCandidateConfidenceBand;
  confidenceReasonCodes: readonly ExamQuestionCandidateConfidenceReasonCode[];
  ambiguousLocator: boolean;
}

export type ExamQuestionExtractionDiagnosticCode =
  | 'duplicate_locator'
  | 'possible_number_gap'
  | 'number_regression'
  | 'orphan_subquestion'
  | 'empty_question'
  | 'oversized_question'
  | 'excessive_candidate_count'
  | 'excessive_structure_diagnostics'
  | 'low_text_coverage';

export interface ExamQuestionExtractionDiagnostic {
  code: ExamQuestionExtractionDiagnosticCode;
  severity: 'info' | 'needs_review';
  pageNumber?: number;
  blockIndex?: number;
  locator?: ExamQuestionLocator;
  candidateIds?: readonly string[];
  subquestionPath?: readonly string[];
  previousPrintedNumber?: string;
  currentPrintedNumber?: string;
}

export interface ExamQuestionCandidatesArtifactV1 {
  schemaVersion: typeof EXAM_QUESTION_CANDIDATE_SCHEMA_VERSION;
  artifactVersion: typeof EXAM_QUESTION_CANDIDATES_ARTIFACT_VERSION;
  segmentationVersion: typeof EXAM_QUESTION_SEGMENTATION_VERSION;
  examSessionId: string;
  examDocumentId: string;
  sourceArtifactFingerprint: string;
  candidateCount: number;
  candidates: readonly ExamQuestionCandidateV1[];
  diagnostics: readonly ExamQuestionExtractionDiagnostic[];
  needsReview: boolean;
}

export class ExamQuestionCandidateError extends Error {
  constructor(
    readonly code:
      | 'EXAM_QUESTION_SEGMENTATION_FAILED'
      | 'EXAM_QUESTION_SEGMENTATION_LIMIT_EXCEEDED'
      | 'EXAM_QUESTION_CANDIDATES_ARTIFACT_INVALID',
  ) {
    super(code);
    this.name = 'ExamQuestionCandidateError';
  }
}

const SOURCE_BLOCK_KINDS = new Set<ExamQuestionSourceBlockKind>([
  'text',
  'formula',
  'table',
  'image_marker',
  'other',
]);
const CONFIDENCE_REASON_CODES = new Set<ExamQuestionCandidateConfidenceReasonCode>([
  'unique_explicit_top_level_label',
  'explicit_group_with_subquestions',
  'subquestion_hierarchy_inferred',
  'cross_page_span',
  'duplicate_locator',
  'empty_body',
  'oversized_content',
]);
const DIAGNOSTIC_CODES = new Set<ExamQuestionExtractionDiagnosticCode>([
  'duplicate_locator',
  'possible_number_gap',
  'number_regression',
  'orphan_subquestion',
  'empty_question',
  'oversized_question',
  'excessive_candidate_count',
  'excessive_structure_diagnostics',
  'low_text_coverage',
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const SECTION_ID = /^section:[1-9]\d*$/u;
const CANONICAL_NUMBER = /^[1-9]\d{0,2}$/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactVersion',
  'segmentationVersion',
  'examSessionId',
  'examDocumentId',
  'sourceArtifactFingerprint',
  'candidateCount',
  'candidates',
  'diagnostics',
  'needsReview',
]);
const CANDIDATE_KEYS = new Set([
  'schemaVersion',
  'candidateId',
  'candidateStatus',
  'candidateKind',
  'rawLabel',
  'locator',
  'ordinalDiscriminator',
  'parentCandidateId',
  'text',
  'sourceSpans',
  'contentStatus',
  'candidateQuestionType',
  'confidenceBand',
  'confidenceReasonCodes',
  'ambiguousLocator',
]);
const LOCATOR_KEYS = new Set(['sectionPath', 'printedNumber', 'subquestionPath']);
const SECTION_REF_KEYS = new Set(['normalizedId', 'rawLabel']);
const SPAN_KEYS = new Set([
  'pageNumber',
  'startBlockIndex',
  'endBlockIndex',
  'startOffset',
  'endOffset',
  'bbox',
]);
const BBOX_KEYS = new Set(['x', 'y', 'width', 'height']);
const DIAGNOSTIC_KEYS = new Set([
  'code',
  'severity',
  'pageNumber',
  'blockIndex',
  'locator',
  'candidateIds',
  'subquestionPath',
  'previousPrintedNumber',
  'currentPrintedNumber',
]);

interface SourceUnit {
  pageNumber: number;
  blockIndex: number;
  kind: ExamQuestionSourceBlockKind;
  text?: string;
  blockTextLength?: number;
  startOffset?: number;
  endOffset?: number;
  bbox?: ExamQuestionSourceBbox;
}

interface CandidateDraft {
  candidateKind: ExamQuestionCandidateKind;
  rawLabel: string;
  rawLabelLength: number;
  locator: ExamQuestionLocator;
  startUnit: number;
  endUnit: number;
  parentDraftIndex?: number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function fingerprint(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sourceUnits(rawArtifact: SegmentableExamDocumentArtifact): {
  artifact: ExamDocumentArtifactV1;
  units: SourceUnit[];
} {
  const artifact = rawArtifact;
  const rawPages = (artifact as { pages?: unknown }).pages;
  if (Array.isArray(rawPages)) {
    if (rawPages.length > EXAM_QUESTION_SEGMENTATION_LIMITS.maxPages) {
      throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_LIMIT_EXCEEDED');
    }
    let preflightBlocks = 0;
    let preflightTextBytes = 0;
    for (const rawPage of rawPages) {
      if (!isPlainRecord(rawPage) || !Array.isArray(rawPage.blocks)) continue;
      preflightBlocks += rawPage.blocks.length;
      if (preflightBlocks > EXAM_QUESTION_SEGMENTATION_LIMITS.maxBlocks) {
        throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_LIMIT_EXCEEDED');
      }
      for (const rawBlock of rawPage.blocks) {
        if (!isPlainRecord(rawBlock) || typeof rawBlock.text !== 'string') continue;
        const blockBytes = utf8Length(rawBlock.text);
        if (blockBytes > EXAM_QUESTION_SEGMENTATION_LIMITS.maxBlockTextBytes) {
          throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_LIMIT_EXCEEDED');
        }
        preflightTextBytes += blockBytes;
        if (preflightTextBytes > EXAM_QUESTION_SEGMENTATION_LIMITS.maxTotalTextBytes) {
          throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_LIMIT_EXCEEDED');
        }
      }
    }
  }
  if (!validateExamDocumentArtifact(artifact).valid) {
    throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_FAILED');
  }
  const canonicalArtifact = parseExamDocumentArtifact(artifact);
  if (artifact.pages.length > EXAM_QUESTION_SEGMENTATION_LIMITS.maxPages) {
    throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_LIMIT_EXCEEDED');
  }

  const units: SourceUnit[] = [];
  let blockCount = 0;
  let textBytes = 0;
  let previousPage = 0;
  for (const page of canonicalArtifact.pages) {
    if (!Number.isSafeInteger(page.pageNumber) || page.pageNumber <= previousPage) {
      throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_FAILED');
    }
    previousPage = page.pageNumber;
    if (!Array.isArray(page.blocks)) {
      throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_FAILED');
    }
    for (let index = 0; index < page.blocks.length; index += 1) {
      const block = page.blocks[index]!;
      if (block.blockIndex !== index || !SOURCE_BLOCK_KINDS.has(block.kind)) {
        throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_FAILED');
      }
      blockCount += 1;
      if (blockCount > EXAM_QUESTION_SEGMENTATION_LIMITS.maxBlocks) {
        throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_LIMIT_EXCEEDED');
      }
      if (block.text === undefined) {
        units.push({
          pageNumber: page.pageNumber,
          blockIndex: block.blockIndex,
          kind: block.kind,
          ...(block.bbox ? { bbox: { ...block.bbox } } : {}),
        });
        continue;
      }
      if (typeof block.text !== 'string') {
        throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_FAILED');
      }
      const blockBytes = utf8Length(block.text);
      if (blockBytes > EXAM_QUESTION_SEGMENTATION_LIMITS.maxBlockTextBytes) {
        throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_LIMIT_EXCEEDED');
      }
      textBytes += blockBytes;
      if (textBytes > EXAM_QUESTION_SEGMENTATION_LIMITS.maxTotalTextBytes) {
        throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_LIMIT_EXCEEDED');
      }

      const lineBreak = /\r\n|\r|\n/gu;
      let startOffset = 0;
      let match: RegExpExecArray | null;
      while ((match = lineBreak.exec(block.text)) !== null) {
        units.push({
          pageNumber: page.pageNumber,
          blockIndex: block.blockIndex,
          kind: block.kind,
          text: block.text.slice(startOffset, match.index),
          blockTextLength: block.text.length,
          startOffset,
          endOffset: match.index + match[0].length,
          ...(block.bbox ? { bbox: { ...block.bbox } } : {}),
        });
        startOffset = match.index + match[0].length;
      }
      units.push({
        pageNumber: page.pageNumber,
        blockIndex: block.blockIndex,
        kind: block.kind,
        text: block.text.slice(startOffset),
        blockTextLength: block.text.length,
        startOffset,
        endOffset: block.text.length,
        ...(block.bbox ? { bbox: { ...block.bbox } } : {}),
      });
    }
  }
  return { artifact: canonicalArtifact, units };
}

function sourceText(units: readonly SourceUnit[]): string {
  return units
    .map((unit) => unit.text)
    .filter((text): text is string => text !== undefined)
    .join('\n')
    .trim();
}

function hasBody(draft: CandidateDraft, units: readonly SourceUnit[]): boolean {
  const candidateUnits = units.slice(draft.startUnit, draft.endUnit + 1);
  const textual = candidateUnits
    .map((unit, index) => {
      if (unit.text === undefined) return '';
      if (index !== 0) return unit.text;
      const labelStart = unit.text.indexOf(draft.rawLabel);
      return labelStart < 0
        ? unit.text.slice(draft.rawLabelLength)
        : unit.text.slice(labelStart + draft.rawLabelLength);
    })
    .join('\n')
    .trim();
  return (
    textual.length > 0 ||
    candidateUnits.some(
      (unit) => unit.kind === 'formula' || unit.kind === 'table' || unit.kind === 'image_marker',
    )
  );
}

function unionBbox(units: readonly SourceUnit[]): ExamQuestionSourceBbox | undefined {
  if (
    units.length === 0 ||
    units.some(
      (unit) =>
        !unit.bbox ||
        (unit.startOffset !== undefined &&
          (unit.startOffset !== 0 || unit.endOffset !== unit.blockTextLength)),
    )
  ) {
    return undefined;
  }
  const boxes = units.map((unit) => unit.bbox!);
  const x = Math.min(...boxes.map((bbox) => bbox.x));
  const y = Math.min(...boxes.map((bbox) => bbox.y));
  const right = Math.max(...boxes.map((bbox) => bbox.x + bbox.width));
  const bottom = Math.max(...boxes.map((bbox) => bbox.y + bbox.height));
  return { x, y, width: right - x, height: bottom - y };
}

function sourceSpans(units: readonly SourceUnit[]): ExamQuestionSourceSpan[] {
  const spans: ExamQuestionSourceSpan[] = [];
  let start = 0;
  while (start < units.length) {
    const pageNumber = units[start]!.pageNumber;
    let end = start;
    while (end + 1 < units.length && units[end + 1]!.pageNumber === pageNumber) end += 1;
    const pageUnits = units.slice(start, end + 1);
    const first = pageUnits[0]!;
    const last = pageUnits.at(-1)!;
    const partialStart = first.startOffset !== undefined && first.startOffset > 0;
    const partialEnd =
      last.endOffset !== undefined && last.endOffset !== (last.blockTextLength ?? last.endOffset);
    const bbox = unionBbox(pageUnits);
    spans.push({
      pageNumber,
      startBlockIndex: first.blockIndex,
      endBlockIndex: last.blockIndex,
      ...(partialStart ? { startOffset: first.startOffset } : {}),
      ...(partialEnd ? { endOffset: last.endOffset } : {}),
      ...(bbox ? { bbox } : {}),
    });
    start = end + 1;
  }
  if (spans.length > EXAM_QUESTION_SEGMENTATION_LIMITS.maxSourceSpansPerCandidate) {
    throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_LIMIT_EXCEEDED');
  }
  return spans;
}

function candidateId(input: {
  examSessionId: string;
  examDocumentId: string;
  sourceArtifactSchemaVersion: number;
  sourceArtifactVersion: number;
  locator: ExamQuestionLocator;
  ordinalDiscriminator: number;
}): string {
  return `exam-question-candidate:v1:${fingerprint('openmaic:zhongkao-exam-question-candidate:v1', {
    schemaVersion: EXAM_QUESTION_CANDIDATE_SCHEMA_VERSION,
    segmentationVersion: EXAM_QUESTION_SEGMENTATION_VERSION,
    ...input,
  })}`;
}

function confidenceFor(input: {
  candidateKind: ExamQuestionCandidateKind;
  hasSubquestion: boolean;
  crossPage: boolean;
  empty: boolean;
  oversized: boolean;
  duplicate: boolean;
}): {
  band: ExamQuestionCandidateConfidenceBand;
  reasons: ExamQuestionCandidateConfidenceReasonCode[];
} {
  const reasons: ExamQuestionCandidateConfidenceReasonCode[] = [];
  if (input.candidateKind === 'group') reasons.push('explicit_group_with_subquestions');
  else if (input.hasSubquestion) reasons.push('subquestion_hierarchy_inferred');
  else reasons.push('unique_explicit_top_level_label');
  if (input.crossPage) reasons.push('cross_page_span');
  if (input.duplicate) reasons.push('duplicate_locator');
  if (input.empty) reasons.push('empty_body');
  if (input.oversized) reasons.push('oversized_content');
  const low = input.duplicate || input.empty || input.oversized;
  const medium = input.candidateKind === 'group' || input.hasSubquestion || input.crossPage;
  return { band: low ? 'low' : medium ? 'medium' : 'high', reasons };
}

export function segmentExamQuestionCandidates(input: {
  artifact: SegmentableExamDocumentArtifact;
  examSessionId: string;
  examDocumentId: string;
}): ExamQuestionCandidatesArtifactV1 {
  if (
    !validateIdentifierValue(input.examSessionId) ||
    !validateIdentifierValue(input.examDocumentId)
  ) {
    throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_FAILED');
  }
  const artifactRecord = input.artifact as SegmentableExamDocumentArtifact &
    Record<string, unknown>;
  if (
    (typeof artifactRecord.examSessionId === 'string' &&
      artifactRecord.examSessionId !== input.examSessionId) ||
    (typeof artifactRecord.examDocumentId === 'string' &&
      artifactRecord.examDocumentId !== input.examDocumentId)
  ) {
    throw new ExamQuestionCandidateError('EXAM_QUESTION_SEGMENTATION_FAILED');
  }

  const { artifact, units } = sourceUnits(input.artifact);
  const drafts: CandidateDraft[] = [];
  const diagnostics: ExamQuestionExtractionDiagnostic[] = [];
  let diagnosticsTruncated = false;
  const addDiagnostic = (diagnostic: ExamQuestionExtractionDiagnostic): void => {
    if (diagnosticsTruncated) return;
    if (diagnostics.length < EXAM_QUESTION_SEGMENTATION_LIMITS.maxDiagnostics - 1) {
      diagnostics.push(diagnostic);
      return;
    }
    diagnostics.push({
      code: 'excessive_structure_diagnostics',
      severity: 'needs_review',
    });
    diagnosticsTruncated = true;
  };
  let sectionPath: ExamQuestionSectionRef[] = [];
  let activeDraftIndex: number | undefined;
  let candidateLimitReached = false;

  const closeActive = (endUnit: number, asGroup = false): number | undefined => {
    if (activeDraftIndex === undefined) return undefined;
    const draft = drafts[activeDraftIndex]!;
    draft.endUnit = Math.max(draft.startUnit, endUnit);
    if (asGroup) draft.candidateKind = 'group';
    const closed = activeDraftIndex;
    activeDraftIndex = undefined;
    return closed;
  };

  const startDraft = (
    unitIndex: number,
    marker: Extract<
      NormalizedExamQuestionMarker,
      { kind: 'question' | 'question_subquestion' | 'subquestion' }
    >,
    printedNumber: string,
    subquestionPath: string[],
    parentDraftIndex?: number,
  ): boolean => {
    if (drafts.length >= EXAM_QUESTION_SEGMENTATION_LIMITS.maxCandidates) {
      addDiagnostic({ code: 'excessive_candidate_count', severity: 'needs_review' });
      candidateLimitReached = true;
      return false;
    }
    drafts.push({
      candidateKind: 'leaf',
      rawLabel: marker.rawLabel,
      rawLabelLength: marker.rawLabel.length,
      locator: {
        sectionPath: sectionPath.map((section) => ({ ...section })),
        printedNumber,
        subquestionPath,
      },
      startUnit: unitIndex,
      endUnit: unitIndex,
      ...(parentDraftIndex === undefined ? {} : { parentDraftIndex }),
    });
    activeDraftIndex = drafts.length - 1;
    return true;
  };

  for (let unitIndex = 0; unitIndex < units.length && !candidateLimitReached; unitIndex += 1) {
    const unit = units[unitIndex]!;
    const marker =
      unit.kind === 'text' && unit.text !== undefined
        ? normalizeExamQuestionMarker(unit.text)
        : null;
    if (!marker) continue;

    if (marker.kind === 'section') {
      const repeatedSectionHeader =
        sectionPath.length === 1 &&
        sectionPath[0]!.normalizedId === marker.normalizedSectionId &&
        sectionPath[0]!.rawLabel === marker.rawLabel;
      if (repeatedSectionHeader) continue;
      closeActive(unitIndex - 1);
      sectionPath = [{ normalizedId: marker.normalizedSectionId, rawLabel: marker.rawLabel }];
      continue;
    }

    if (marker.kind === 'question') {
      closeActive(unitIndex - 1);
      startDraft(unitIndex, marker, marker.printedNumber, []);
      continue;
    }

    if (marker.kind === 'question_subquestion') {
      let parentDraftIndex: number | undefined;
      if (activeDraftIndex !== undefined) {
        const active = drafts[activeDraftIndex]!;
        if (
          active.locator.subquestionPath.length === 0 &&
          active.locator.printedNumber === marker.printedNumber
        ) {
          parentDraftIndex = closeActive(unitIndex - 1, true);
        } else {
          const activeParent = active.parentDraftIndex;
          const sameQuestion = active.locator.printedNumber === marker.printedNumber;
          closeActive(unitIndex - 1);
          if (sameQuestion) parentDraftIndex = activeParent;
        }
      }
      startDraft(
        unitIndex,
        marker,
        marker.printedNumber,
        [marker.subquestionNumber],
        parentDraftIndex,
      );
      continue;
    }

    if (activeDraftIndex === undefined) {
      addDiagnostic({
        code: 'orphan_subquestion',
        severity: 'needs_review',
        pageNumber: unit.pageNumber,
        blockIndex: unit.blockIndex,
        subquestionPath: [marker.subquestionNumber],
      });
      continue;
    }
    const active = drafts[activeDraftIndex]!;
    let parentDraftIndex = active.parentDraftIndex;
    if (active.locator.subquestionPath.length === 0) {
      parentDraftIndex = closeActive(unitIndex - 1, true);
    } else {
      closeActive(unitIndex - 1);
    }
    startDraft(
      unitIndex,
      marker,
      active.locator.printedNumber,
      [marker.subquestionNumber],
      parentDraftIndex,
    );
  }
  if (!candidateLimitReached) closeActive(units.length - 1);

  const occurrence = new Map<string, number>();
  const draftIds: string[] = [];
  for (const draft of drafts) {
    const key = examQuestionLocatorKey(draft.locator);
    const ordinalDiscriminator = (occurrence.get(key) ?? 0) + 1;
    occurrence.set(key, ordinalDiscriminator);
    draftIds.push(
      candidateId({
        examSessionId: input.examSessionId,
        examDocumentId: input.examDocumentId,
        sourceArtifactSchemaVersion: artifact.schemaVersion,
        sourceArtifactVersion: artifact.artifactVersion,
        locator: draft.locator,
        ordinalDiscriminator,
      }),
    );
  }

  const duplicateKeys = new Set(
    [...occurrence.entries()].filter(([, count]) => count > 1).map(([key]) => key),
  );
  const occurrenceCursor = new Map<string, number>();
  const candidates: ExamQuestionCandidateV1[] = drafts.map((draft, index) => {
    const key = examQuestionLocatorKey(draft.locator);
    const ordinalDiscriminator = (occurrenceCursor.get(key) ?? 0) + 1;
    occurrenceCursor.set(key, ordinalDiscriminator);
    const candidateUnits = units.slice(draft.startUnit, draft.endUnit + 1);
    const text = sourceText(candidateUnits);
    const spans = sourceSpans(candidateUnits);
    const empty = !hasBody(draft, units);
    const oversized = utf8Length(text) > EXAM_QUESTION_SEGMENTATION_LIMITS.maxQuestionTextBytes;
    const duplicate = duplicateKeys.has(key);
    const confidence = confidenceFor({
      candidateKind: draft.candidateKind,
      hasSubquestion: draft.locator.subquestionPath.length > 0,
      crossPage: spans.length > 1,
      empty,
      oversized,
      duplicate,
    });
    return {
      schemaVersion: EXAM_QUESTION_CANDIDATE_SCHEMA_VERSION,
      candidateId: draftIds[index]!,
      candidateStatus: 'candidate',
      candidateKind: draft.candidateKind,
      rawLabel: draft.rawLabel,
      locator: {
        sectionPath: draft.locator.sectionPath.map((section) => ({ ...section })),
        printedNumber: draft.locator.printedNumber,
        subquestionPath: [...draft.locator.subquestionPath],
      },
      ordinalDiscriminator,
      ...(draft.parentDraftIndex === undefined
        ? {}
        : { parentCandidateId: draftIds[draft.parentDraftIndex] }),
      text,
      sourceSpans: spans,
      contentStatus: oversized ? 'oversized' : 'complete',
      candidateQuestionType: 'unknown',
      confidenceBand: confidence.band,
      confidenceReasonCodes: confidence.reasons,
      ambiguousLocator: duplicate,
    };
  });

  for (const candidate of candidates) {
    if (candidate.confidenceReasonCodes.includes('empty_body')) {
      addDiagnostic({
        code: 'empty_question',
        severity: 'needs_review',
        locator: candidate.locator,
        candidateIds: [candidate.candidateId],
      });
    }
    if (candidate.contentStatus === 'oversized') {
      addDiagnostic({
        code: 'oversized_question',
        severity: 'needs_review',
        locator: candidate.locator,
        candidateIds: [candidate.candidateId],
      });
    }
  }

  const firstCandidateForLocator = new Map<string, ExamQuestionCandidateV1[]>();
  for (const candidate of candidates) {
    const key = examQuestionLocatorKey(candidate.locator);
    const related = firstCandidateForLocator.get(key) ?? [];
    related.push(candidate);
    firstCandidateForLocator.set(key, related);
  }
  for (const related of firstCandidateForLocator.values()) {
    if (related.length < 2) continue;
    addDiagnostic({
      code: 'duplicate_locator',
      severity: 'needs_review',
      locator: related[0]!.locator,
      candidateIds: related.map((candidate) => candidate.candidateId),
    });
  }

  let previousTop:
    | { locator: ExamQuestionLocator; value: number; printedNumber: string }
    | undefined;
  for (const candidate of candidates) {
    const value = Number(candidate.locator.printedNumber);
    if (previousTop && sameExamQuestionTopLevel(previousTop.locator, candidate.locator)) continue;
    if (
      previousTop &&
      JSON.stringify(previousTop.locator.sectionPath.map((section) => section.normalizedId)) ===
        JSON.stringify(candidate.locator.sectionPath.map((section) => section.normalizedId))
    ) {
      if (value > previousTop.value + 1) {
        addDiagnostic({
          code: 'possible_number_gap',
          severity: 'info',
          previousPrintedNumber: previousTop.printedNumber,
          currentPrintedNumber: candidate.locator.printedNumber,
        });
      } else if (value < previousTop.value) {
        addDiagnostic({
          code: 'number_regression',
          severity: 'needs_review',
          previousPrintedNumber: previousTop.printedNumber,
          currentPrintedNumber: candidate.locator.printedNumber,
        });
      }
    }
    previousTop = {
      locator: candidate.locator,
      value,
      printedNumber: candidate.locator.printedNumber,
    };
  }

  if (candidates.length === 0 && units.some((unit) => unit.text?.trim())) {
    addDiagnostic({ code: 'low_text_coverage', severity: 'needs_review' });
  }

  const sourceArtifactFingerprint = createHash('sha256')
    .update(serializeExamDocumentArtifact(artifact))
    .digest('hex');
  return {
    schemaVersion: EXAM_QUESTION_CANDIDATE_SCHEMA_VERSION,
    artifactVersion: EXAM_QUESTION_CANDIDATES_ARTIFACT_VERSION,
    segmentationVersion: EXAM_QUESTION_SEGMENTATION_VERSION,
    examSessionId: input.examSessionId,
    examDocumentId: input.examDocumentId,
    sourceArtifactFingerprint,
    candidateCount: candidates.length,
    candidates,
    diagnostics,
    needsReview: diagnostics.some((diagnostic) => diagnostic.severity === 'needs_review'),
  };
}

function validateIdentifierValue(value: unknown): value is string {
  const errors: DomainValidationIssue[] = [];
  return validateIdentifier(value, '', errors) && errors.length === 0;
}

function validateSafeText(
  value: unknown,
  path: string,
  maxBytes: number,
  errors: DomainValidationIssue[],
  allowNewlines = true,
): value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    pushIssue(errors, path, 'expected non-empty trimmed text');
    return false;
  }
  if (utf8Length(value) > maxBytes) pushIssue(errors, path, 'text exceeds byte limit');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    pushIssue(errors, path, 'text contains unsafe control character');
  }
  if (value.includes('\r') || (!allowNewlines && value.includes('\n'))) {
    pushIssue(errors, path, 'text contains a non-canonical line ending');
  }
  if (UNPAIRED_SURROGATE.test(value) || value.normalize('NFC') !== value) {
    pushIssue(errors, path, 'text is not canonical Unicode');
  }
  return true;
}

function validateBbox(value: unknown, path: string, errors: DomainValidationIssue[]): void {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected bbox object');
    return;
  }
  rejectUnknownKeys(value, BBOX_KEYS, path, errors);
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    if (
      typeof value[field] !== 'number' ||
      !Number.isFinite(value[field]) ||
      (value[field] as number) < 0 ||
      (value[field] as number) > 1
    ) {
      pushIssue(errors, `${path}/${field}`, 'expected page-relative coordinate from 0 to 1');
    }
  }
  if (typeof value.x === 'number' && typeof value.width === 'number' && value.x + value.width > 1) {
    pushIssue(errors, path, 'bbox exceeds page width');
  }
  if (
    typeof value.y === 'number' &&
    typeof value.height === 'number' &&
    value.y + value.height > 1
  ) {
    pushIssue(errors, path, 'bbox exceeds page height');
  }
}

function validateLocator(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamQuestionLocator {
  const errorCount = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected locator object');
    return false;
  }
  rejectUnknownKeys(value, LOCATOR_KEYS, path, errors);
  if (!Array.isArray(value.sectionPath) || value.sectionPath.length > 16) {
    pushIssue(errors, `${path}/sectionPath`, 'expected bounded section path');
  } else {
    value.sectionPath.forEach((section, index) => {
      const sectionPath = `${path}/sectionPath/${index}`;
      if (!isPlainRecord(section)) {
        pushIssue(errors, sectionPath, 'expected section ref object');
        return;
      }
      rejectUnknownKeys(section, SECTION_REF_KEYS, sectionPath, errors);
      if (typeof section.normalizedId !== 'string' || !SECTION_ID.test(section.normalizedId)) {
        pushIssue(errors, `${sectionPath}/normalizedId`, 'expected normalized section id');
      }
      validateSafeText(
        section.rawLabel,
        `${sectionPath}/rawLabel`,
        EXAM_QUESTION_SEGMENTATION_LIMITS.maxSectionLabelLength * 4,
        errors,
        false,
      );
    });
  }
  if (typeof value.printedNumber !== 'string' || !CANONICAL_NUMBER.test(value.printedNumber)) {
    pushIssue(errors, `${path}/printedNumber`, 'expected canonical printed number');
  }
  if (!Array.isArray(value.subquestionPath) || value.subquestionPath.length > 8) {
    pushIssue(errors, `${path}/subquestionPath`, 'expected bounded subquestion path');
  } else {
    value.subquestionPath.forEach((part, index) => {
      if (typeof part !== 'string' || !CANONICAL_NUMBER.test(part)) {
        pushIssue(errors, `${path}/subquestionPath/${index}`, 'expected canonical subquestion');
      }
    });
  }
  return errors.length === errorCount;
}

function validateSpan(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamQuestionSourceSpan {
  const errorCount = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected source span object');
    return false;
  }
  rejectUnknownKeys(value, SPAN_KEYS, path, errors);
  for (const field of ['pageNumber', 'startBlockIndex', 'endBlockIndex'] as const) {
    if (
      !Number.isSafeInteger(value[field]) ||
      (value[field] as number) < (field === 'pageNumber' ? 1 : 0)
    ) {
      pushIssue(errors, `${path}/${field}`, 'expected non-negative safe integer');
    }
  }
  if (
    Number.isSafeInteger(value.startBlockIndex) &&
    Number.isSafeInteger(value.endBlockIndex) &&
    (value.startBlockIndex as number) > (value.endBlockIndex as number)
  ) {
    pushIssue(errors, path, 'source span block order is reversed');
  }
  for (const field of ['startOffset', 'endOffset'] as const) {
    if (
      Object.hasOwn(value, field) &&
      (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0)
    ) {
      pushIssue(errors, `${path}/${field}`, 'expected non-negative safe offset');
    }
  }
  if (
    value.startBlockIndex === value.endBlockIndex &&
    Number.isSafeInteger(value.startOffset) &&
    Number.isSafeInteger(value.endOffset) &&
    (value.startOffset as number) >= (value.endOffset as number)
  ) {
    pushIssue(errors, path, 'source span offsets are empty or reversed');
  }
  if (Object.hasOwn(value, 'bbox')) validateBbox(value.bbox, `${path}/bbox`, errors);
  return errors.length === errorCount;
}

function validateCandidate(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamQuestionCandidateV1 {
  const errorCount = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected candidate object');
    return false;
  }
  rejectUnknownKeys(value, CANDIDATE_KEYS, path, errors);
  if (value.schemaVersion !== EXAM_QUESTION_CANDIDATE_SCHEMA_VERSION) {
    pushIssue(errors, `${path}/schemaVersion`, 'unexpected candidate schema version');
  }
  validateIdentifier(value.candidateId, `${path}/candidateId`, errors);
  if (value.candidateStatus !== 'candidate') {
    pushIssue(errors, `${path}/candidateStatus`, 'unexpected candidate status');
  }
  if (value.candidateKind !== 'group' && value.candidateKind !== 'leaf') {
    pushIssue(errors, `${path}/candidateKind`, 'unknown candidate kind');
  }
  validateSafeText(
    value.rawLabel,
    `${path}/rawLabel`,
    EXAM_QUESTION_SEGMENTATION_LIMITS.maxRawLabelLength * 4,
    errors,
    false,
  );
  validateLocator(value.locator, `${path}/locator`, errors);
  if (
    !Number.isSafeInteger(value.ordinalDiscriminator) ||
    (value.ordinalDiscriminator as number) < 1
  ) {
    pushIssue(errors, `${path}/ordinalDiscriminator`, 'expected positive ordinal discriminator');
  }
  if (Object.hasOwn(value, 'parentCandidateId')) {
    validateIdentifier(value.parentCandidateId, `${path}/parentCandidateId`, errors);
  }
  validateSafeText(
    value.text,
    `${path}/text`,
    EXAM_QUESTION_SEGMENTATION_LIMITS.maxTotalTextBytes,
    errors,
  );
  if (
    !Array.isArray(value.sourceSpans) ||
    value.sourceSpans.length < 1 ||
    value.sourceSpans.length > EXAM_QUESTION_SEGMENTATION_LIMITS.maxSourceSpansPerCandidate
  ) {
    pushIssue(errors, `${path}/sourceSpans`, 'expected bounded non-empty source spans');
  } else {
    let previous: ExamQuestionSourceSpan | undefined;
    value.sourceSpans.forEach((span, index) => {
      if (validateSpan(span, `${path}/sourceSpans/${index}`, errors)) {
        if (
          previous &&
          (span.pageNumber < previous.pageNumber ||
            (span.pageNumber === previous.pageNumber &&
              span.startBlockIndex <= previous.endBlockIndex))
        ) {
          pushIssue(
            errors,
            `${path}/sourceSpans/${index}`,
            'source spans are not strictly ordered',
          );
        }
        previous = span;
      }
    });
  }
  if (value.contentStatus !== 'complete' && value.contentStatus !== 'oversized') {
    pushIssue(errors, `${path}/contentStatus`, 'unknown content status');
  }
  if (value.candidateQuestionType !== 'unknown') {
    pushIssue(errors, `${path}/candidateQuestionType`, 'question type must remain unknown');
  }
  if (
    value.confidenceBand !== 'high' &&
    value.confidenceBand !== 'medium' &&
    value.confidenceBand !== 'low'
  ) {
    pushIssue(errors, `${path}/confidenceBand`, 'unknown confidence band');
  }
  if (!Array.isArray(value.confidenceReasonCodes) || value.confidenceReasonCodes.length < 1) {
    pushIssue(errors, `${path}/confidenceReasonCodes`, 'expected confidence reason codes');
  } else {
    const seen = new Set<string>();
    value.confidenceReasonCodes.forEach((reason, index) => {
      if (
        typeof reason !== 'string' ||
        !CONFIDENCE_REASON_CODES.has(reason as ExamQuestionCandidateConfidenceReasonCode)
      ) {
        pushIssue(
          errors,
          `${path}/confidenceReasonCodes/${index}`,
          'unknown confidence reason code',
        );
      } else if (seen.has(reason)) {
        pushIssue(
          errors,
          `${path}/confidenceReasonCodes/${index}`,
          'duplicate confidence reason code',
        );
      }
      if (typeof reason === 'string') seen.add(reason);
    });
  }
  if (typeof value.ambiguousLocator !== 'boolean') {
    pushIssue(errors, `${path}/ambiguousLocator`, 'expected ambiguity boolean');
  }
  return errors.length === errorCount;
}

function validateDiagnostic(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamQuestionExtractionDiagnostic {
  const errorCount = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected diagnostic object');
    return false;
  }
  rejectUnknownKeys(value, DIAGNOSTIC_KEYS, path, errors);
  if (
    typeof value.code !== 'string' ||
    !DIAGNOSTIC_CODES.has(value.code as ExamQuestionExtractionDiagnosticCode)
  ) {
    pushIssue(errors, `${path}/code`, 'unknown diagnostic code');
  }
  if (value.severity !== 'info' && value.severity !== 'needs_review') {
    pushIssue(errors, `${path}/severity`, 'unknown diagnostic severity');
  } else if (
    typeof value.code === 'string' &&
    DIAGNOSTIC_CODES.has(value.code as ExamQuestionExtractionDiagnosticCode) &&
    value.severity !== (value.code === 'possible_number_gap' ? 'info' : 'needs_review')
  ) {
    pushIssue(errors, `${path}/severity`, 'diagnostic severity does not match code');
  }
  for (const field of ['pageNumber', 'blockIndex'] as const) {
    if (
      Object.hasOwn(value, field) &&
      (!Number.isSafeInteger(value[field]) ||
        (value[field] as number) < (field === 'pageNumber' ? 1 : 0))
    ) {
      pushIssue(errors, `${path}/${field}`, 'expected safe source position');
    }
  }
  if (Object.hasOwn(value, 'locator')) validateLocator(value.locator, `${path}/locator`, errors);
  for (const field of ['candidateIds', 'subquestionPath'] as const) {
    if (Object.hasOwn(value, field)) {
      if (!Array.isArray(value[field]) || (value[field] as unknown[]).length < 1) {
        pushIssue(errors, `${path}/${field}`, 'expected non-empty array');
      } else {
        (value[field] as unknown[]).forEach((item, index) => {
          if (typeof item !== 'string' || !item) {
            pushIssue(errors, `${path}/${field}/${index}`, 'expected non-empty string');
          }
        });
      }
    }
  }
  for (const field of ['previousPrintedNumber', 'currentPrintedNumber'] as const) {
    if (
      Object.hasOwn(value, field) &&
      (typeof value[field] !== 'string' || !CANONICAL_NUMBER.test(value[field] as string))
    ) {
      pushIssue(errors, `${path}/${field}`, 'expected canonical printed number');
    }
  }
  return errors.length === errorCount;
}

export function validateExamQuestionCandidatesArtifact(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected question candidates artifact object');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, ARTIFACT_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_QUESTION_CANDIDATE_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'unexpected schema version');
  }
  if (value.artifactVersion !== EXAM_QUESTION_CANDIDATES_ARTIFACT_VERSION) {
    pushIssue(errors, '/artifactVersion', 'unexpected artifact version');
  }
  if (value.segmentationVersion !== EXAM_QUESTION_SEGMENTATION_VERSION) {
    pushIssue(errors, '/segmentationVersion', 'unexpected segmentation version');
  }
  validateIdentifier(value.examSessionId, '/examSessionId', errors);
  validateIdentifier(value.examDocumentId, '/examDocumentId', errors);
  if (
    typeof value.sourceArtifactFingerprint !== 'string' ||
    !SHA256.test(value.sourceArtifactFingerprint)
  ) {
    pushIssue(errors, '/sourceArtifactFingerprint', 'expected lowercase SHA-256');
  }
  if (!Number.isSafeInteger(value.candidateCount) || (value.candidateCount as number) < 0) {
    pushIssue(errors, '/candidateCount', 'expected non-negative candidate count');
  }

  const validCandidates: ExamQuestionCandidateV1[] = [];
  if (
    !Array.isArray(value.candidates) ||
    value.candidates.length > EXAM_QUESTION_SEGMENTATION_LIMITS.maxCandidates
  ) {
    pushIssue(errors, '/candidates', 'expected bounded candidate array');
  } else {
    const ids = new Set<string>();
    value.candidates.forEach((candidate, index) => {
      if (validateCandidate(candidate, `/candidates/${index}`, errors)) {
        validCandidates.push(candidate);
        if (ids.has(candidate.candidateId)) {
          pushIssue(errors, `/candidates/${index}/candidateId`, 'duplicate candidate id');
        }
        ids.add(candidate.candidateId);
      }
    });
    if (value.candidateCount !== value.candidates.length) {
      pushIssue(errors, '/candidateCount', 'candidate count mismatch');
    }
  }

  const diagnosticValues: ExamQuestionExtractionDiagnostic[] = [];
  if (
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > EXAM_QUESTION_SEGMENTATION_LIMITS.maxDiagnostics
  ) {
    pushIssue(errors, '/diagnostics', 'expected bounded diagnostic array');
  } else {
    value.diagnostics.forEach((diagnostic, index) => {
      if (validateDiagnostic(diagnostic, `/diagnostics/${index}`, errors)) {
        diagnosticValues.push(diagnostic);
      }
    });
  }
  if (typeof value.needsReview !== 'boolean') {
    pushIssue(errors, '/needsReview', 'expected review boolean');
  } else if (
    value.needsReview !==
    diagnosticValues.some((diagnostic) => diagnostic.severity === 'needs_review')
  ) {
    pushIssue(errors, '/needsReview', 'review projection mismatch');
  }

  const byId = new Map(validCandidates.map((candidate) => [candidate.candidateId, candidate]));
  const locatorGroups = new Map<string, ExamQuestionCandidateV1[]>();
  for (const candidate of validCandidates) {
    const key = examQuestionLocatorKey(candidate.locator);
    const group = locatorGroups.get(key) ?? [];
    group.push(candidate);
    locatorGroups.set(key, group);
    const expectedId = candidateId({
      examSessionId: typeof value.examSessionId === 'string' ? value.examSessionId : '',
      examDocumentId: typeof value.examDocumentId === 'string' ? value.examDocumentId : '',
      sourceArtifactSchemaVersion: 1,
      sourceArtifactVersion: 1,
      locator: candidate.locator,
      ordinalDiscriminator: candidate.ordinalDiscriminator,
    });
    // Source artifacts are currently v1. This pins IDs without trusting serialized IDs.
    if (candidate.candidateId !== expectedId) {
      pushIssue(
        errors,
        `/candidates/${validCandidates.indexOf(candidate)}/candidateId`,
        'candidate id mismatch',
      );
    }
    if (candidate.parentCandidateId) {
      const parent = byId.get(candidate.parentCandidateId);
      if (
        !parent ||
        parent.candidateKind !== 'group' ||
        !sameExamQuestionTopLevel(parent.locator, candidate.locator)
      ) {
        pushIssue(
          errors,
          `/candidates/${validCandidates.indexOf(candidate)}/parentCandidateId`,
          'invalid parent candidate',
        );
      }
    }
    const oversized =
      utf8Length(candidate.text) > EXAM_QUESTION_SEGMENTATION_LIMITS.maxQuestionTextBytes;
    if ((candidate.contentStatus === 'oversized') !== oversized) {
      pushIssue(
        errors,
        `/candidates/${validCandidates.indexOf(candidate)}/contentStatus`,
        'content status mismatch',
      );
    }
  }
  for (const group of locatorGroups.values()) {
    const duplicate = group.length > 1;
    group.forEach((candidate) => {
      if (candidate.ambiguousLocator !== duplicate) {
        pushIssue(errors, '/candidates', 'locator ambiguity mismatch');
      }
    });
  }
  return finishValidation(errors);
}

export function serializeExamQuestionCandidatesArtifact(
  artifact: ExamQuestionCandidatesArtifactV1,
): Buffer {
  if (!validateExamQuestionCandidatesArtifact(artifact).valid) {
    throw new ExamQuestionCandidateError('EXAM_QUESTION_CANDIDATES_ARTIFACT_INVALID');
  }
  const bytes = Buffer.from(JSON.stringify(canonicalize(artifact)), 'utf8');
  if (bytes.byteLength > EXAM_QUESTION_SEGMENTATION_LIMITS.maxSerializedBytes) {
    throw new ExamQuestionCandidateError('EXAM_QUESTION_CANDIDATES_ARTIFACT_INVALID');
  }
  return bytes;
}

export function parseExamQuestionCandidatesArtifact(
  bytes: Buffer | Uint8Array | string,
): ExamQuestionCandidatesArtifactV1 {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  if (buffer.byteLength > EXAM_QUESTION_SEGMENTATION_LIMITS.maxSerializedBytes) {
    throw new ExamQuestionCandidateError('EXAM_QUESTION_CANDIDATES_ARTIFACT_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(typeof bytes === 'string' ? bytes : UTF8_DECODER.decode(buffer));
  } catch {
    throw new ExamQuestionCandidateError('EXAM_QUESTION_CANDIDATES_ARTIFACT_INVALID');
  }
  if (!validateExamQuestionCandidatesArtifact(value).valid) {
    throw new ExamQuestionCandidateError('EXAM_QUESTION_CANDIDATES_ARTIFACT_INVALID');
  }
  return value as ExamQuestionCandidatesArtifactV1;
}
