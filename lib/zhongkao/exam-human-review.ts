import { createHash } from 'node:crypto';

import { EXAM_DERIVATIVE_VERSION_MAX, EXAM_MAX_HUMAN_REVIEW_ARTIFACT_BYTES } from './exam';
import {
  EXAM_QUESTION_SEGMENTATION_LIMITS,
  serializeExamQuestionCandidatesArtifact,
  validateExamQuestionCandidatesArtifact,
  type ExamQuestionCandidateV1,
  type ExamQuestionCandidatesArtifactV1,
  type ExamQuestionSourceBbox,
  type ExamQuestionSourceSpan,
} from './exam-question-candidate';
import {
  examQuestionLocatorKey,
  normalizeExamQuestionMarker,
  parseExamQuestionResponseLabel,
  type ExamQuestionLocator,
} from './exam-question-locator';
import {
  buildExamQuestionResponseMatchesArtifact,
  serializeExamQuestionResponseMatchesArtifact,
  serializeStudentResponseCandidatesArtifact,
  validateExamQuestionResponseMatchesArtifact,
  validateStudentResponseCandidatesArtifact,
  type ExamQuestionResponseMatchesArtifactV1,
  type StudentResponseCandidateV1,
  type StudentResponseCandidatesArtifactV1,
} from './exam-student-response';
import {
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  type DomainValidationIssue,
  type DomainValidationResult,
} from './validation';

export const EXAM_HUMAN_REVIEW_SCHEMA_VERSION = 1 as const;
export const EXAM_HUMAN_REVIEW_ARTIFACT_VERSION = 1 as const;
export const EXAM_HUMAN_REVIEW_VERSION = 1 as const;

export const EXAM_HUMAN_REVIEW_LIMITS = Object.freeze({
  maxDecisions: 1_000,
  maxQuestionTextBytes: EXAM_QUESTION_SEGMENTATION_LIMITS.maxQuestionTextBytes,
  maxAnswerBytes: 16 * 1024,
  maxLabelLength: 64,
  maxSectionHeadingLength: 160,
  maxSerializedBytes: EXAM_MAX_HUMAN_REVIEW_ARTIFACT_BYTES,
});

export type ExamQuestionRejectionReason =
  | 'not_a_question'
  | 'duplicate_extraction'
  | 'segmentation_error'
  | 'wrong_question_boundary'
  | 'other';

export type ExamResponseRejectionReason =
  | 'input_mistake'
  | 'duplicate_entry'
  | 'wrong_label'
  | 'not_student_response'
  | 'other';

export type ExamHumanReviewDecision =
  | { decisionType: 'confirm_question'; questionCandidateId: string }
  | {
      decisionType: 'correct_question';
      questionCandidateId: string;
      correctedQuestionText?: string;
      correctedRawLabel?: string;
      correctedSectionHeading?: string;
    }
  | {
      decisionType: 'reject_question';
      questionCandidateId: string;
      reason: ExamQuestionRejectionReason;
    }
  | {
      decisionType: 'confirm_response';
      responseCandidateId: string;
      questionCandidateId: string;
    }
  | {
      decisionType: 'correct_response';
      responseCandidateId: string;
      questionCandidateId: string;
      responseOverride: { status: 'text'; rawAnswerText: string } | { status: 'blank' };
    }
  | {
      decisionType: 'reject_response';
      responseCandidateId: string;
      reason: ExamResponseRejectionReason;
    }
  | { decisionType: 'confirm_no_response'; questionCandidateId: string };

export interface ExamHumanReviewRequest {
  schemaVersion: typeof EXAM_HUMAN_REVIEW_SCHEMA_VERSION;
  decisions: readonly ExamHumanReviewDecision[];
}

export interface ConfirmedExamQuestionV1 {
  confirmedQuestionId: string;
  sourceQuestionCandidateId: string;
  rawLabel: string;
  locator: ExamQuestionLocator;
  questionText: string;
  textSource: 'extracted_confirmed' | 'owner_corrected';
  locatorSource: 'extracted_confirmed' | 'owner_corrected';
  sourceSpans: readonly ExamQuestionSourceSpan[];
  parentSourceCandidateId?: string;
  parentContext?: {
    sourceQuestionCandidateId: string;
    rawLabel: string;
    locator: ExamQuestionLocator;
    questionText: string;
    contextSource: 'extracted_confirmed';
    sourceSpans: readonly ExamQuestionSourceSpan[];
  };
}

export interface ConfirmedStudentResponseV1 {
  confirmedResponseId: string;
  confirmedQuestionId: string;
  sourceResponseCandidateId?: string;
  answerStatus: 'text' | 'blank' | 'no_response';
  rawAnswerText?: string;
  answerSource: 'captured_confirmed' | 'owner_corrected' | 'owner_no_response';
}

export interface ConfirmedQuestionResponseMatchV1 {
  confirmedMatchId: string;
  confirmedQuestionId: string;
  confirmedResponseId: string;
  relationSource: 'deterministic_match_confirmed' | 'owner_manual_link';
}

export interface RejectedExamQuestionCandidateV1 {
  sourceQuestionCandidateId: string;
  reason: ExamQuestionRejectionReason;
}

export interface RejectedStudentResponseCandidateV1 {
  sourceResponseCandidateId: string;
  reason: ExamResponseRejectionReason;
}

export interface ConfirmedExamReviewFactsV1 {
  schemaVersion: typeof EXAM_HUMAN_REVIEW_SCHEMA_VERSION;
  artifactVersion: typeof EXAM_HUMAN_REVIEW_ARTIFACT_VERSION;
  reviewVersion: typeof EXAM_HUMAN_REVIEW_VERSION;
  examSessionId: string;
  reviewRef: string;
  reviewArtifactRef: string;
  questionArtifactRef: string;
  questionArtifactSha256: string;
  questionExtractionVersion: number;
  questionSegmentationVersion: number;
  responseArtifactRef: string;
  responseArtifactSha256: string;
  responseCaptureVersion: number;
  matchingArtifactRef: string;
  matchingArtifactSha256: string;
  matchingVersion: number;
  decisionSemanticFingerprint: string;
  decisions: readonly ExamHumanReviewDecision[];
  confirmedQuestionCount: number;
  confirmedResponseCount: number;
  confirmedMatchCount: number;
  rejectedQuestionCount: number;
  rejectedResponseCount: number;
  confirmedQuestions: readonly ConfirmedExamQuestionV1[];
  confirmedResponses: readonly ConfirmedStudentResponseV1[];
  confirmedMatches: readonly ConfirmedQuestionResponseMatchV1[];
  rejectedQuestionCandidates: readonly RejectedExamQuestionCandidateV1[];
  rejectedResponseCandidates: readonly RejectedStudentResponseCandidateV1[];
}

export interface BuildConfirmedExamReviewFactsInput {
  examSessionId: string;
  reviewRef: string;
  reviewArtifactRef: string;
  questionArtifactRef: string;
  questionArtifactSha256: string;
  questionExtractionVersion: number;
  questionSegmentationVersion: number;
  responseArtifactRef: string;
  responseArtifactSha256: string;
  responseCaptureVersion: number;
  matchingArtifactRef: string;
  matchingArtifactSha256: string;
  matchingVersion: number;
  questionCandidatesArtifact: ExamQuestionCandidatesArtifactV1;
  responseCandidatesArtifact: StudentResponseCandidatesArtifactV1;
  questionResponseMatchesArtifact: ExamQuestionResponseMatchesArtifactV1;
  request: unknown;
}

export class ExamHumanReviewError extends Error {
  constructor(
    readonly code:
      | 'EXAM_REVIEW_INPUT_INVALID'
      | 'EXAM_REVIEW_INCOMPLETE'
      | 'EXAM_REVIEW_ARTIFACT_INVALID',
  ) {
    super(code);
    this.name = 'ExamHumanReviewError';
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const CANONICAL_NUMBER = /^[1-9]\d{0,2}$/u;
const SECTION_ID = /^section:[1-9]\d*$/u;
const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const UNICODE_LINE_SEPARATOR = /[\u0085\u2028\u2029]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const REQUEST_KEYS = new Set(['schemaVersion', 'decisions']);
const QUESTION_REJECTION_REASONS = new Set<ExamQuestionRejectionReason>([
  'not_a_question',
  'duplicate_extraction',
  'segmentation_error',
  'wrong_question_boundary',
  'other',
]);
const RESPONSE_REJECTION_REASONS = new Set<ExamResponseRejectionReason>([
  'input_mistake',
  'duplicate_entry',
  'wrong_label',
  'not_student_response',
  'other',
]);

const ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactVersion',
  'reviewVersion',
  'examSessionId',
  'reviewRef',
  'reviewArtifactRef',
  'questionArtifactRef',
  'questionArtifactSha256',
  'questionExtractionVersion',
  'questionSegmentationVersion',
  'responseArtifactRef',
  'responseArtifactSha256',
  'responseCaptureVersion',
  'matchingArtifactRef',
  'matchingArtifactSha256',
  'matchingVersion',
  'decisionSemanticFingerprint',
  'decisions',
  'confirmedQuestionCount',
  'confirmedResponseCount',
  'confirmedMatchCount',
  'rejectedQuestionCount',
  'rejectedResponseCount',
  'confirmedQuestions',
  'confirmedResponses',
  'confirmedMatches',
  'rejectedQuestionCandidates',
  'rejectedResponseCandidates',
]);
const CONFIRMED_QUESTION_KEYS = new Set([
  'confirmedQuestionId',
  'sourceQuestionCandidateId',
  'rawLabel',
  'locator',
  'questionText',
  'textSource',
  'locatorSource',
  'sourceSpans',
  'parentSourceCandidateId',
  'parentContext',
]);
const CONFIRMED_QUESTION_PARENT_CONTEXT_KEYS = new Set([
  'sourceQuestionCandidateId',
  'rawLabel',
  'locator',
  'questionText',
  'contextSource',
  'sourceSpans',
]);
const CONFIRMED_RESPONSE_KEYS = new Set([
  'confirmedResponseId',
  'confirmedQuestionId',
  'sourceResponseCandidateId',
  'answerStatus',
  'rawAnswerText',
  'answerSource',
]);
const CONFIRMED_MATCH_KEYS = new Set([
  'confirmedMatchId',
  'confirmedQuestionId',
  'confirmedResponseId',
  'relationSource',
]);
const REJECTED_QUESTION_KEYS = new Set(['sourceQuestionCandidateId', 'reason']);
const REJECTED_RESPONSE_KEYS = new Set(['sourceResponseCandidateId', 'reason']);
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

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function sha256(value: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprint(domain: string, value: unknown): string {
  return sha256(`${domain}\0${JSON.stringify(canonicalize(value))}`);
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function validVersion(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= EXAM_DERIVATIVE_VERSION_MAX
  );
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function safeSingleLine(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !value.includes('\r') &&
    !value.includes('\n') &&
    !UNSAFE_CONTROL_CHARACTER.test(value) &&
    !UNICODE_LINE_SEPARATOR.test(value) &&
    !UNPAIRED_SURROGATE.test(value)
  );
}

function safeText(value: unknown, maxBytes: number, requireNonBlank = true): value is string {
  return (
    typeof value === 'string' &&
    (!requireNonBlank || value.trim().length > 0) &&
    utf8Length(value) <= maxBytes &&
    !UNSAFE_CONTROL_CHARACTER.test(value) &&
    !UNICODE_LINE_SEPARATOR.test(value) &&
    !UNPAIRED_SURROGATE.test(value)
  );
}

function compareCanonical(left: unknown, right: unknown): number {
  const leftKey = JSON.stringify(canonicalize(left));
  const rightKey = JSON.stringify(canonicalize(right));
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function cloneDecision(decision: ExamHumanReviewDecision): ExamHumanReviewDecision {
  switch (decision.decisionType) {
    case 'confirm_question':
      return {
        decisionType: decision.decisionType,
        questionCandidateId: decision.questionCandidateId,
      };
    case 'correct_question':
      return {
        decisionType: decision.decisionType,
        questionCandidateId: decision.questionCandidateId,
        ...(decision.correctedQuestionText === undefined
          ? {}
          : { correctedQuestionText: decision.correctedQuestionText }),
        ...(decision.correctedRawLabel === undefined
          ? {}
          : { correctedRawLabel: decision.correctedRawLabel }),
        ...(decision.correctedSectionHeading === undefined
          ? {}
          : { correctedSectionHeading: decision.correctedSectionHeading }),
      };
    case 'reject_question':
      return {
        decisionType: decision.decisionType,
        questionCandidateId: decision.questionCandidateId,
        reason: decision.reason,
      };
    case 'confirm_response':
      return {
        decisionType: decision.decisionType,
        responseCandidateId: decision.responseCandidateId,
        questionCandidateId: decision.questionCandidateId,
      };
    case 'correct_response':
      return {
        decisionType: decision.decisionType,
        responseCandidateId: decision.responseCandidateId,
        questionCandidateId: decision.questionCandidateId,
        responseOverride:
          decision.responseOverride.status === 'text'
            ? { status: 'text', rawAnswerText: decision.responseOverride.rawAnswerText }
            : { status: 'blank' },
      };
    case 'reject_response':
      return {
        decisionType: decision.decisionType,
        responseCandidateId: decision.responseCandidateId,
        reason: decision.reason,
      };
    case 'confirm_no_response':
      return {
        decisionType: decision.decisionType,
        questionCandidateId: decision.questionCandidateId,
      };
  }
}

function canonicalDecisions(
  decisions: readonly ExamHumanReviewDecision[],
): ExamHumanReviewDecision[] {
  return decisions.map(cloneDecision).sort(compareCanonical);
}

function parseCorrectedLabel(value: unknown): {
  rawLabel: string;
  printedNumber?: string;
  subquestionPath: readonly string[];
} | null {
  if (!safeSingleLine(value, EXAM_HUMAN_REVIEW_LIMITS.maxLabelLength)) return null;
  const responseLabel = parseExamQuestionResponseLabel(value);
  if (responseLabel) {
    return {
      rawLabel: value,
      printedNumber: responseLabel.printedNumber,
      subquestionPath: responseLabel.subquestionPath,
    };
  }
  const marker = normalizeExamQuestionMarker(value);
  if (!marker || marker.kind === 'section' || marker.rawLabel !== value) return null;
  if (marker.kind === 'question') {
    return { rawLabel: marker.rawLabel, printedNumber: marker.printedNumber, subquestionPath: [] };
  }
  if (marker.kind === 'question_subquestion') {
    return {
      rawLabel: marker.rawLabel,
      printedNumber: marker.printedNumber,
      subquestionPath: [marker.subquestionNumber],
    };
  }
  return { rawLabel: marker.rawLabel, subquestionPath: [marker.subquestionNumber] };
}

function validateCorrectedLabel(value: unknown): boolean {
  return parseCorrectedLabel(value) !== null;
}

function validateCorrectedSection(value: unknown): boolean {
  if (!safeSingleLine(value, EXAM_HUMAN_REVIEW_LIMITS.maxSectionHeadingLength)) return false;
  const marker = normalizeExamQuestionMarker(value);
  return marker !== null && marker.kind === 'section' && marker.rawLabel === value;
}

function validateDecision(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamHumanReviewDecision {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected review decision object');
    return false;
  }
  switch (value.decisionType) {
    case 'confirm_question':
      rejectUnknownKeys(value, new Set(['decisionType', 'questionCandidateId']), path, errors);
      validateIdentifier(value.questionCandidateId, `${path}/questionCandidateId`, errors);
      break;
    case 'correct_question': {
      rejectUnknownKeys(
        value,
        new Set([
          'decisionType',
          'questionCandidateId',
          'correctedQuestionText',
          'correctedRawLabel',
          'correctedSectionHeading',
        ]),
        path,
        errors,
      );
      validateIdentifier(value.questionCandidateId, `${path}/questionCandidateId`, errors);
      const correctionFields = [
        'correctedQuestionText',
        'correctedRawLabel',
        'correctedSectionHeading',
      ].filter((field) => Object.hasOwn(value, field));
      if (correctionFields.length === 0) pushIssue(errors, path, 'question correction is empty');
      if (
        Object.hasOwn(value, 'correctedQuestionText') &&
        !safeText(value.correctedQuestionText, EXAM_HUMAN_REVIEW_LIMITS.maxQuestionTextBytes)
      ) {
        pushIssue(errors, `${path}/correctedQuestionText`, 'invalid corrected question text');
      }
      if (
        Object.hasOwn(value, 'correctedRawLabel') &&
        !validateCorrectedLabel(value.correctedRawLabel)
      ) {
        pushIssue(errors, `${path}/correctedRawLabel`, 'invalid corrected question label');
      }
      if (
        Object.hasOwn(value, 'correctedSectionHeading') &&
        !validateCorrectedSection(value.correctedSectionHeading)
      ) {
        pushIssue(errors, `${path}/correctedSectionHeading`, 'invalid corrected section heading');
      }
      break;
    }
    case 'reject_question':
      rejectUnknownKeys(
        value,
        new Set(['decisionType', 'questionCandidateId', 'reason']),
        path,
        errors,
      );
      validateIdentifier(value.questionCandidateId, `${path}/questionCandidateId`, errors);
      if (!QUESTION_REJECTION_REASONS.has(value.reason as ExamQuestionRejectionReason)) {
        pushIssue(errors, `${path}/reason`, 'unknown question rejection reason');
      }
      break;
    case 'confirm_response':
      rejectUnknownKeys(
        value,
        new Set(['decisionType', 'responseCandidateId', 'questionCandidateId']),
        path,
        errors,
      );
      validateIdentifier(value.responseCandidateId, `${path}/responseCandidateId`, errors);
      validateIdentifier(value.questionCandidateId, `${path}/questionCandidateId`, errors);
      break;
    case 'correct_response':
      rejectUnknownKeys(
        value,
        new Set(['decisionType', 'responseCandidateId', 'questionCandidateId', 'responseOverride']),
        path,
        errors,
      );
      validateIdentifier(value.responseCandidateId, `${path}/responseCandidateId`, errors);
      validateIdentifier(value.questionCandidateId, `${path}/questionCandidateId`, errors);
      if (!isPlainRecord(value.responseOverride)) {
        pushIssue(errors, `${path}/responseOverride`, 'expected response override object');
      } else if (value.responseOverride.status === 'text') {
        rejectUnknownKeys(
          value.responseOverride,
          new Set(['status', 'rawAnswerText']),
          `${path}/responseOverride`,
          errors,
        );
        if (
          !safeText(value.responseOverride.rawAnswerText, EXAM_HUMAN_REVIEW_LIMITS.maxAnswerBytes)
        ) {
          pushIssue(
            errors,
            `${path}/responseOverride/rawAnswerText`,
            'invalid corrected answer text',
          );
        }
      } else if (value.responseOverride.status === 'blank') {
        rejectUnknownKeys(
          value.responseOverride,
          new Set(['status']),
          `${path}/responseOverride`,
          errors,
        );
      } else {
        pushIssue(errors, `${path}/responseOverride/status`, 'unknown response override status');
      }
      break;
    case 'reject_response':
      rejectUnknownKeys(
        value,
        new Set(['decisionType', 'responseCandidateId', 'reason']),
        path,
        errors,
      );
      validateIdentifier(value.responseCandidateId, `${path}/responseCandidateId`, errors);
      if (!RESPONSE_REJECTION_REASONS.has(value.reason as ExamResponseRejectionReason)) {
        pushIssue(errors, `${path}/reason`, 'unknown response rejection reason');
      }
      break;
    case 'confirm_no_response':
      rejectUnknownKeys(value, new Set(['decisionType', 'questionCandidateId']), path, errors);
      validateIdentifier(value.questionCandidateId, `${path}/questionCandidateId`, errors);
      break;
    default:
      pushIssue(errors, `${path}/decisionType`, 'unknown review decision type');
  }
  return errors.length === before;
}

export function validateExamHumanReviewRequest(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected human review request object');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, REQUEST_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_HUMAN_REVIEW_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'unexpected schema version');
  }
  if (
    !Array.isArray(value.decisions) ||
    value.decisions.length > EXAM_HUMAN_REVIEW_LIMITS.maxDecisions
  ) {
    pushIssue(errors, '/decisions', 'expected bounded decision array');
  } else {
    value.decisions.forEach((decision, index) =>
      validateDecision(decision, `/decisions/${index}`, errors),
    );
  }
  return finishValidation(errors);
}

export function parseExamHumanReviewRequest(value: unknown): ExamHumanReviewRequest {
  if (!validateExamHumanReviewRequest(value).valid) {
    throw new ExamHumanReviewError('EXAM_REVIEW_INPUT_INVALID');
  }
  const request = value as unknown as ExamHumanReviewRequest;
  return {
    schemaVersion: EXAM_HUMAN_REVIEW_SCHEMA_VERSION,
    decisions: canonicalDecisions(request.decisions),
  };
}

export function createExamHumanReviewDecisionSemanticFingerprint(value: unknown): string {
  const request = parseExamHumanReviewRequest(value);
  return fingerprint('openmaic:zhongkao-exam-human-review-decisions:v1', request);
}

export function deriveConfirmedExamQuestionId(
  reviewRef: string,
  sourceQuestionCandidateId: string,
): string {
  return `exam-confirmed-question:v1:${fingerprint('openmaic:zhongkao-exam-confirmed-question:v1', {
    reviewRef,
    sourceQuestionCandidateId,
  })}`;
}

export function deriveConfirmedStudentResponseId(
  reviewRef: string,
  confirmedQuestionId: string,
  sourceResponseCandidateId?: string,
): string {
  return `exam-confirmed-response:v1:${fingerprint('openmaic:zhongkao-exam-confirmed-response:v1', {
    reviewRef,
    confirmedQuestionId,
    responseSource: sourceResponseCandidateId ?? 'no_response',
  })}`;
}

export function deriveConfirmedQuestionResponseMatchId(
  reviewRef: string,
  confirmedQuestionId: string,
  confirmedResponseId: string,
): string {
  return `exam-confirmed-match:v1:${fingerprint('openmaic:zhongkao-exam-confirmed-match:v1', {
    reviewRef,
    confirmedQuestionId,
    confirmedResponseId,
  })}`;
}

function cloneLocator(locator: ExamQuestionLocator): ExamQuestionLocator {
  return {
    sectionPath: locator.sectionPath.map((section) => ({ ...section })),
    printedNumber: locator.printedNumber,
    subquestionPath: [...locator.subquestionPath],
  };
}

function cloneBbox(bbox: ExamQuestionSourceBbox | undefined): ExamQuestionSourceBbox | undefined {
  return bbox === undefined ? undefined : { ...bbox };
}

function cloneSpans(spans: readonly ExamQuestionSourceSpan[]): ExamQuestionSourceSpan[] {
  return spans.map((span) => ({
    pageNumber: span.pageNumber,
    startBlockIndex: span.startBlockIndex,
    endBlockIndex: span.endBlockIndex,
    ...(span.startOffset === undefined ? {} : { startOffset: span.startOffset }),
    ...(span.endOffset === undefined ? {} : { endOffset: span.endOffset }),
    ...(span.bbox === undefined ? {} : { bbox: cloneBbox(span.bbox)! }),
  }));
}

function correctedLocator(
  candidate: ExamQuestionCandidateV1,
  decision: Extract<ExamHumanReviewDecision, { decisionType: 'correct_question' }>,
): { rawLabel: string; locator: ExamQuestionLocator } {
  const locator = cloneLocator(candidate.locator);
  let rawLabel = candidate.rawLabel;
  if (decision.correctedSectionHeading !== undefined) {
    const section = normalizeExamQuestionMarker(decision.correctedSectionHeading);
    if (!section || section.kind !== 'section') {
      throw new ExamHumanReviewError('EXAM_REVIEW_INPUT_INVALID');
    }
    locator.sectionPath = [
      { normalizedId: section.normalizedSectionId, rawLabel: section.rawLabel },
    ];
  }
  if (decision.correctedRawLabel !== undefined) {
    const marker = parseCorrectedLabel(decision.correctedRawLabel);
    if (!marker) {
      throw new ExamHumanReviewError('EXAM_REVIEW_INPUT_INVALID');
    }
    rawLabel = marker.rawLabel;
    if (marker.printedNumber !== undefined) {
      locator.printedNumber = marker.printedNumber;
    }
    locator.subquestionPath = [...marker.subquestionPath];
  }
  return { rawLabel, locator };
}

function assertSources(input: BuildConfirmedExamReviewFactsInput): void {
  const errors: DomainValidationIssue[] = [];
  for (const [field, value] of [
    ['examSessionId', input.examSessionId],
    ['reviewRef', input.reviewRef],
    ['reviewArtifactRef', input.reviewArtifactRef],
    ['questionArtifactRef', input.questionArtifactRef],
    ['responseArtifactRef', input.responseArtifactRef],
    ['matchingArtifactRef', input.matchingArtifactRef],
  ] as const) {
    validateIdentifier(value, `/${field}`, errors);
  }
  for (const [field, value] of [
    ['questionArtifactSha256', input.questionArtifactSha256],
    ['responseArtifactSha256', input.responseArtifactSha256],
    ['matchingArtifactSha256', input.matchingArtifactSha256],
  ] as const) {
    if (!validSha256(value)) pushIssue(errors, `/${field}`, 'expected lowercase SHA-256');
  }
  for (const [field, value] of [
    ['questionExtractionVersion', input.questionExtractionVersion],
    ['questionSegmentationVersion', input.questionSegmentationVersion],
    ['responseCaptureVersion', input.responseCaptureVersion],
    ['matchingVersion', input.matchingVersion],
  ] as const) {
    if (!validVersion(value)) pushIssue(errors, `/${field}`, 'expected positive bounded version');
  }
  if (
    !validateExamQuestionCandidatesArtifact(input.questionCandidatesArtifact).valid ||
    !validateStudentResponseCandidatesArtifact(input.responseCandidatesArtifact).valid ||
    !validateExamQuestionResponseMatchesArtifact(input.questionResponseMatchesArtifact).valid
  ) {
    pushIssue(errors, '/sources', 'invalid upstream artifact');
  }
  if (errors.length > 0) throw new ExamHumanReviewError('EXAM_REVIEW_ARTIFACT_INVALID');

  let questionBytes: Buffer;
  let responseBytes: Buffer;
  let matchingBytes: Buffer;
  try {
    questionBytes = serializeExamQuestionCandidatesArtifact(input.questionCandidatesArtifact);
    responseBytes = serializeStudentResponseCandidatesArtifact(input.responseCandidatesArtifact);
    matchingBytes = serializeExamQuestionResponseMatchesArtifact(
      input.questionResponseMatchesArtifact,
    );
  } catch {
    throw new ExamHumanReviewError('EXAM_REVIEW_ARTIFACT_INVALID');
  }
  const question = input.questionCandidatesArtifact;
  const response = input.responseCandidatesArtifact;
  const matching = input.questionResponseMatchesArtifact;
  if (
    question.examSessionId !== input.examSessionId ||
    response.examSessionId !== input.examSessionId ||
    matching.examSessionId !== input.examSessionId ||
    sha256(questionBytes) !== input.questionArtifactSha256 ||
    sha256(responseBytes) !== input.responseArtifactSha256 ||
    sha256(matchingBytes) !== input.matchingArtifactSha256 ||
    question.segmentationVersion !== input.questionSegmentationVersion ||
    response.questionSegmentationVersion !== input.questionSegmentationVersion ||
    response.captureVersion !== input.responseCaptureVersion ||
    response.questionCandidateArtifactRef !== input.questionArtifactRef ||
    response.questionCandidateArtifactSha256 !== input.questionArtifactSha256 ||
    response.responseArtifactRef !== input.responseArtifactRef ||
    matching.questionSegmentationVersion !== input.questionSegmentationVersion ||
    matching.responseCaptureVersion !== input.responseCaptureVersion ||
    matching.matchingVersion !== input.matchingVersion ||
    matching.questionCandidateArtifactRef !== input.questionArtifactRef ||
    matching.questionCandidateArtifactSha256 !== input.questionArtifactSha256 ||
    matching.responseArtifactRef !== input.responseArtifactRef ||
    matching.responseArtifactSha256 !== input.responseArtifactSha256 ||
    matching.matchingArtifactRef !== input.matchingArtifactRef
  ) {
    throw new ExamHumanReviewError('EXAM_REVIEW_ARTIFACT_INVALID');
  }
  try {
    const expected = buildExamQuestionResponseMatchesArtifact({
      examSessionId: input.examSessionId,
      matchingArtifactRef: input.matchingArtifactRef,
      questionCandidateArtifactRef: input.questionArtifactRef,
      questionCandidateArtifactSha256: input.questionArtifactSha256,
      responseArtifactRef: input.responseArtifactRef,
      questionCandidatesArtifact: question,
      responseCandidatesArtifact: response,
    });
    if (!serializeExamQuestionResponseMatchesArtifact(expected).equals(matchingBytes)) {
      throw new Error('match mismatch');
    }
  } catch {
    throw new ExamHumanReviewError('EXAM_REVIEW_ARTIFACT_INVALID');
  }
}

type QuestionDecision = Extract<
  ExamHumanReviewDecision,
  { decisionType: 'confirm_question' | 'correct_question' | 'reject_question' }
>;
type ResponseDecision = Extract<
  ExamHumanReviewDecision,
  { decisionType: 'confirm_response' | 'correct_response' | 'reject_response' }
>;

function incomplete(): never {
  throw new ExamHumanReviewError('EXAM_REVIEW_INCOMPLETE');
}

function confirmedQuestion(
  reviewRef: string,
  candidate: ExamQuestionCandidateV1,
  decision: Exclude<QuestionDecision, { decisionType: 'reject_question' }>,
  parent: ExamQuestionCandidateV1 | undefined,
): ConfirmedExamQuestionV1 {
  const corrected =
    decision.decisionType === 'correct_question'
      ? correctedLocator(candidate, decision)
      : { rawLabel: candidate.rawLabel, locator: cloneLocator(candidate.locator) };
  return {
    confirmedQuestionId: deriveConfirmedExamQuestionId(reviewRef, candidate.candidateId),
    sourceQuestionCandidateId: candidate.candidateId,
    rawLabel: corrected.rawLabel,
    locator: corrected.locator,
    questionText:
      decision.decisionType === 'correct_question' && decision.correctedQuestionText !== undefined
        ? decision.correctedQuestionText
        : candidate.text,
    textSource:
      decision.decisionType === 'correct_question' && decision.correctedQuestionText !== undefined
        ? 'owner_corrected'
        : 'extracted_confirmed',
    locatorSource:
      decision.decisionType === 'correct_question' &&
      (decision.correctedRawLabel !== undefined || decision.correctedSectionHeading !== undefined)
        ? 'owner_corrected'
        : 'extracted_confirmed',
    sourceSpans: cloneSpans(candidate.sourceSpans),
    ...(parent === undefined
      ? {}
      : {
          parentSourceCandidateId: parent.candidateId,
          parentContext: {
            sourceQuestionCandidateId: parent.candidateId,
            rawLabel: parent.rawLabel,
            locator: cloneLocator(parent.locator),
            questionText: parent.text,
            contextSource: 'extracted_confirmed' as const,
            sourceSpans: cloneSpans(parent.sourceSpans),
          },
        }),
  };
}

function relationSource(
  matches: ExamQuestionResponseMatchesArtifactV1,
  responseCandidateId: string,
  questionCandidateId: string,
): ConfirmedQuestionResponseMatchV1['relationSource'] {
  const match = matches.matches.find((item) => item.responseCandidateId === responseCandidateId);
  return match?.status === 'matched' &&
    match.questionCandidateIds.length === 1 &&
    match.questionCandidateIds[0] === questionCandidateId
    ? 'deterministic_match_confirmed'
    : 'owner_manual_link';
}

export function buildConfirmedExamReviewFacts(
  input: BuildConfirmedExamReviewFactsInput,
): ConfirmedExamReviewFactsV1 {
  assertSources(input);
  const request = parseExamHumanReviewRequest(input.request);
  const questionsById = new Map(
    input.questionCandidatesArtifact.candidates.map((candidate) => [
      candidate.candidateId,
      candidate,
    ]),
  );
  const responsesById = new Map(
    input.responseCandidatesArtifact.candidates.map((candidate) => [
      candidate.candidateId,
      candidate,
    ]),
  );
  const questionDecisions = new Map<string, QuestionDecision>();
  const responseDecisions = new Map<string, ResponseDecision>();
  const noResponseQuestions = new Set<string>();

  for (const decision of request.decisions) {
    if (
      decision.decisionType === 'confirm_question' ||
      decision.decisionType === 'correct_question' ||
      decision.decisionType === 'reject_question'
    ) {
      const candidate = questionsById.get(decision.questionCandidateId);
      if (
        !candidate ||
        questionDecisions.has(candidate.candidateId) ||
        (candidate.candidateKind === 'group' && decision.decisionType !== 'reject_question')
      ) {
        incomplete();
      }
      questionDecisions.set(candidate.candidateId, decision);
    } else if (
      decision.decisionType === 'confirm_response' ||
      decision.decisionType === 'correct_response' ||
      decision.decisionType === 'reject_response'
    ) {
      if (
        !responsesById.has(decision.responseCandidateId) ||
        responseDecisions.has(decision.responseCandidateId)
      ) {
        incomplete();
      }
      responseDecisions.set(decision.responseCandidateId, decision);
    } else {
      if (
        !questionsById.has(decision.questionCandidateId) ||
        noResponseQuestions.has(decision.questionCandidateId)
      ) {
        incomplete();
      }
      noResponseQuestions.add(decision.questionCandidateId);
    }
  }

  if (
    input.questionCandidatesArtifact.candidates.some(
      (candidate) => !questionDecisions.has(candidate.candidateId),
    ) ||
    input.responseCandidatesArtifact.candidates.some(
      (candidate) => !responseDecisions.has(candidate.candidateId),
    )
  ) {
    incomplete();
  }

  const confirmedQuestions: ConfirmedExamQuestionV1[] = [];
  const confirmedBySourceId = new Map<string, ConfirmedExamQuestionV1>();
  const rejectedQuestionCandidates: RejectedExamQuestionCandidateV1[] = [];
  for (const candidate of input.questionCandidatesArtifact.candidates) {
    const decision = questionDecisions.get(candidate.candidateId)!;
    if (decision.decisionType === 'reject_question') {
      rejectedQuestionCandidates.push({
        sourceQuestionCandidateId: candidate.candidateId,
        reason: decision.reason,
      });
      continue;
    }
    if (candidate.candidateKind !== 'leaf') incomplete();
    const parent = candidate.parentCandidateId
      ? questionsById.get(candidate.parentCandidateId)
      : undefined;
    const fact = confirmedQuestion(input.reviewRef, candidate, decision, parent);
    if (
      !safeSingleLine(fact.rawLabel, EXAM_HUMAN_REVIEW_LIMITS.maxLabelLength) ||
      !safeText(fact.questionText, EXAM_HUMAN_REVIEW_LIMITS.maxQuestionTextBytes)
    ) {
      incomplete();
    }
    confirmedQuestions.push(fact);
    confirmedBySourceId.set(candidate.candidateId, fact);
  }

  const locatorKeys = new Set<string>();
  for (const question of confirmedQuestions) {
    const key = examQuestionLocatorKey(question.locator);
    if (locatorKeys.has(key)) incomplete();
    locatorKeys.add(key);
  }

  const confirmedResponses: ConfirmedStudentResponseV1[] = [];
  const confirmedMatches: ConfirmedQuestionResponseMatchV1[] = [];
  const rejectedResponseCandidates: RejectedStudentResponseCandidateV1[] = [];
  const answeredQuestionIds = new Set<string>();

  function addResponse(
    question: ConfirmedExamQuestionV1,
    source: StudentResponseCandidateV1 | undefined,
    answerStatus: ConfirmedStudentResponseV1['answerStatus'],
    answerSource: ConfirmedStudentResponseV1['answerSource'],
    rawAnswerText?: string,
  ): void {
    if (answeredQuestionIds.has(question.confirmedQuestionId)) incomplete();
    answeredQuestionIds.add(question.confirmedQuestionId);
    const confirmedResponseId = deriveConfirmedStudentResponseId(
      input.reviewRef,
      question.confirmedQuestionId,
      source?.candidateId,
    );
    const response: ConfirmedStudentResponseV1 = {
      confirmedResponseId,
      confirmedQuestionId: question.confirmedQuestionId,
      ...(source === undefined ? {} : { sourceResponseCandidateId: source.candidateId }),
      answerStatus,
      ...(answerStatus === 'text' ? { rawAnswerText: rawAnswerText! } : {}),
      answerSource,
    };
    confirmedResponses.push(response);
    confirmedMatches.push({
      confirmedMatchId: deriveConfirmedQuestionResponseMatchId(
        input.reviewRef,
        question.confirmedQuestionId,
        confirmedResponseId,
      ),
      confirmedQuestionId: question.confirmedQuestionId,
      confirmedResponseId,
      relationSource:
        source === undefined
          ? 'owner_manual_link'
          : relationSource(
              input.questionResponseMatchesArtifact,
              source.candidateId,
              question.sourceQuestionCandidateId,
            ),
    });
  }

  for (const candidate of input.responseCandidatesArtifact.candidates) {
    const decision = responseDecisions.get(candidate.candidateId)!;
    if (decision.decisionType === 'reject_response') {
      rejectedResponseCandidates.push({
        sourceResponseCandidateId: candidate.candidateId,
        reason: decision.reason,
      });
      continue;
    }
    const question = confirmedBySourceId.get(decision.questionCandidateId);
    if (!question) incomplete();
    if (decision.decisionType === 'confirm_response') {
      addResponse(
        question,
        candidate,
        candidate.answerStatus,
        'captured_confirmed',
        candidate.answerStatus === 'text' ? candidate.rawAnswerText : undefined,
      );
    } else {
      addResponse(
        question,
        candidate,
        decision.responseOverride.status,
        'owner_corrected',
        decision.responseOverride.status === 'text'
          ? decision.responseOverride.rawAnswerText
          : undefined,
      );
    }
  }

  for (const sourceQuestionCandidateId of noResponseQuestions) {
    const question = confirmedBySourceId.get(sourceQuestionCandidateId);
    if (!question) incomplete();
    addResponse(question, undefined, 'no_response', 'owner_no_response');
  }
  if (answeredQuestionIds.size !== confirmedQuestions.length) incomplete();

  const sortById = <T>(values: T[], id: (value: T) => string): T[] =>
    values.sort((left, right) => {
      const leftId = id(left);
      const rightId = id(right);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
  sortById(confirmedQuestions, (value) => value.confirmedQuestionId);
  sortById(confirmedResponses, (value) => value.confirmedResponseId);
  sortById(confirmedMatches, (value) => value.confirmedMatchId);
  sortById(rejectedQuestionCandidates, (value) => value.sourceQuestionCandidateId);
  sortById(rejectedResponseCandidates, (value) => value.sourceResponseCandidateId);

  const artifact: ConfirmedExamReviewFactsV1 = {
    schemaVersion: EXAM_HUMAN_REVIEW_SCHEMA_VERSION,
    artifactVersion: EXAM_HUMAN_REVIEW_ARTIFACT_VERSION,
    reviewVersion: EXAM_HUMAN_REVIEW_VERSION,
    examSessionId: input.examSessionId,
    reviewRef: input.reviewRef,
    reviewArtifactRef: input.reviewArtifactRef,
    questionArtifactRef: input.questionArtifactRef,
    questionArtifactSha256: input.questionArtifactSha256,
    questionExtractionVersion: input.questionExtractionVersion,
    questionSegmentationVersion: input.questionSegmentationVersion,
    responseArtifactRef: input.responseArtifactRef,
    responseArtifactSha256: input.responseArtifactSha256,
    responseCaptureVersion: input.responseCaptureVersion,
    matchingArtifactRef: input.matchingArtifactRef,
    matchingArtifactSha256: input.matchingArtifactSha256,
    matchingVersion: input.matchingVersion,
    decisionSemanticFingerprint: createExamHumanReviewDecisionSemanticFingerprint(request),
    decisions: request.decisions,
    confirmedQuestionCount: confirmedQuestions.length,
    confirmedResponseCount: confirmedResponses.length,
    confirmedMatchCount: confirmedMatches.length,
    rejectedQuestionCount: rejectedQuestionCandidates.length,
    rejectedResponseCount: rejectedResponseCandidates.length,
    confirmedQuestions,
    confirmedResponses,
    confirmedMatches,
    rejectedQuestionCandidates,
    rejectedResponseCandidates,
  };
  if (!validateConfirmedExamReviewFacts(artifact).valid) {
    throw new ExamHumanReviewError('EXAM_REVIEW_ARTIFACT_INVALID');
  }
  return artifact;
}

function validateLocator(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamQuestionLocator {
  const before = errors.length;
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
        pushIssue(errors, `${sectionPath}/normalizedId`, 'invalid normalized section id');
      }
      if (!safeSingleLine(section.rawLabel, EXAM_HUMAN_REVIEW_LIMITS.maxSectionHeadingLength)) {
        pushIssue(errors, `${sectionPath}/rawLabel`, 'invalid section label');
      } else {
        const marker = normalizeExamQuestionMarker(section.rawLabel);
        if (
          !marker ||
          marker.kind !== 'section' ||
          marker.normalizedSectionId !== section.normalizedId
        ) {
          pushIssue(errors, sectionPath, 'section label does not match normalized id');
        }
      }
    });
  }
  if (typeof value.printedNumber !== 'string' || !CANONICAL_NUMBER.test(value.printedNumber)) {
    pushIssue(errors, `${path}/printedNumber`, 'invalid printed number');
  }
  if (!Array.isArray(value.subquestionPath) || value.subquestionPath.length > 8) {
    pushIssue(errors, `${path}/subquestionPath`, 'expected bounded subquestion path');
  } else {
    value.subquestionPath.forEach((part, index) => {
      if (typeof part !== 'string' || !CANONICAL_NUMBER.test(part)) {
        pushIssue(errors, `${path}/subquestionPath/${index}`, 'invalid subquestion number');
      }
    });
  }
  return errors.length === before;
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
      pushIssue(errors, `${path}/${field}`, 'invalid page-relative coordinate');
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

function validateSpan(value: unknown, path: string, errors: DomainValidationIssue[]): void {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected source span object');
    return;
  }
  rejectUnknownKeys(value, SPAN_KEYS, path, errors);
  for (const field of ['pageNumber', 'startBlockIndex', 'endBlockIndex'] as const) {
    if (
      !Number.isSafeInteger(value[field]) ||
      (value[field] as number) < (field === 'pageNumber' ? 1 : 0)
    ) {
      pushIssue(errors, `${path}/${field}`, 'invalid source position');
    }
  }
  for (const field of ['startOffset', 'endOffset'] as const) {
    if (
      Object.hasOwn(value, field) &&
      (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0)
    ) {
      pushIssue(errors, `${path}/${field}`, 'invalid source offset');
    }
  }
  if (
    Number.isSafeInteger(value.startBlockIndex) &&
    Number.isSafeInteger(value.endBlockIndex) &&
    (value.startBlockIndex as number) > (value.endBlockIndex as number)
  ) {
    pushIssue(errors, path, 'source block order is reversed');
  }
  if (
    value.startBlockIndex === value.endBlockIndex &&
    Number.isSafeInteger(value.startOffset) &&
    Number.isSafeInteger(value.endOffset) &&
    (value.startOffset as number) >= (value.endOffset as number)
  ) {
    pushIssue(errors, path, 'source offsets are empty or reversed');
  }
  if (Object.hasOwn(value, 'bbox')) validateBbox(value.bbox, `${path}/bbox`, errors);
}

function canonicalOrder<T>(values: readonly T[], id: (value: T) => string): boolean {
  return values.every((value, index) => index === 0 || id(values[index - 1]!) < id(value));
}

function validateConfirmedQuestion(
  value: unknown,
  path: string,
  reviewRef: string,
  errors: DomainValidationIssue[],
): value is ConfirmedExamQuestionV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected confirmed question object');
    return false;
  }
  rejectUnknownKeys(value, CONFIRMED_QUESTION_KEYS, path, errors);
  validateIdentifier(value.confirmedQuestionId, `${path}/confirmedQuestionId`, errors);
  validateIdentifier(value.sourceQuestionCandidateId, `${path}/sourceQuestionCandidateId`, errors);
  if (!safeSingleLine(value.rawLabel, EXAM_HUMAN_REVIEW_LIMITS.maxLabelLength)) {
    pushIssue(errors, `${path}/rawLabel`, 'invalid question label');
  }
  validateLocator(value.locator, `${path}/locator`, errors);
  if (!safeText(value.questionText, EXAM_HUMAN_REVIEW_LIMITS.maxQuestionTextBytes)) {
    pushIssue(errors, `${path}/questionText`, 'invalid question text');
  }
  if (value.textSource !== 'extracted_confirmed' && value.textSource !== 'owner_corrected') {
    pushIssue(errors, `${path}/textSource`, 'unknown question text source');
  }
  if (value.locatorSource !== 'extracted_confirmed' && value.locatorSource !== 'owner_corrected') {
    pushIssue(errors, `${path}/locatorSource`, 'unknown question locator source');
  }
  if (!Array.isArray(value.sourceSpans) || value.sourceSpans.length < 1) {
    pushIssue(errors, `${path}/sourceSpans`, 'expected source spans');
  } else {
    value.sourceSpans.forEach((span, index) =>
      validateSpan(span, `${path}/sourceSpans/${index}`, errors),
    );
  }
  if (Object.hasOwn(value, 'parentSourceCandidateId')) {
    validateIdentifier(value.parentSourceCandidateId, `${path}/parentSourceCandidateId`, errors);
  }
  const hasParentId = Object.hasOwn(value, 'parentSourceCandidateId');
  const hasParentContext = Object.hasOwn(value, 'parentContext');
  if (hasParentId !== hasParentContext) {
    pushIssue(errors, `${path}/parentContext`, 'parent context binding is incomplete');
  } else if (hasParentContext) {
    const parentPath = `${path}/parentContext`;
    if (!isPlainRecord(value.parentContext)) {
      pushIssue(errors, parentPath, 'expected parent question context object');
    } else {
      const parent = value.parentContext;
      rejectUnknownKeys(parent, CONFIRMED_QUESTION_PARENT_CONTEXT_KEYS, parentPath, errors);
      validateIdentifier(
        parent.sourceQuestionCandidateId,
        `${parentPath}/sourceQuestionCandidateId`,
        errors,
      );
      if (parent.sourceQuestionCandidateId !== value.parentSourceCandidateId) {
        pushIssue(errors, `${parentPath}/sourceQuestionCandidateId`, 'parent source mismatch');
      }
      if (!safeSingleLine(parent.rawLabel, EXAM_HUMAN_REVIEW_LIMITS.maxLabelLength)) {
        pushIssue(errors, `${parentPath}/rawLabel`, 'invalid parent question label');
      }
      validateLocator(parent.locator, `${parentPath}/locator`, errors);
      if (!safeText(parent.questionText, EXAM_HUMAN_REVIEW_LIMITS.maxQuestionTextBytes)) {
        pushIssue(errors, `${parentPath}/questionText`, 'invalid parent question text');
      }
      if (parent.contextSource !== 'extracted_confirmed') {
        pushIssue(errors, `${parentPath}/contextSource`, 'unknown parent context source');
      }
      if (!Array.isArray(parent.sourceSpans) || parent.sourceSpans.length < 1) {
        pushIssue(errors, `${parentPath}/sourceSpans`, 'expected parent source spans');
      } else {
        parent.sourceSpans.forEach((span, index) =>
          validateSpan(span, `${parentPath}/sourceSpans/${index}`, errors),
        );
      }
    }
  }
  if (
    typeof value.sourceQuestionCandidateId === 'string' &&
    value.confirmedQuestionId !==
      deriveConfirmedExamQuestionId(reviewRef, value.sourceQuestionCandidateId)
  ) {
    pushIssue(errors, `${path}/confirmedQuestionId`, 'confirmed question id mismatch');
  }
  return errors.length === before;
}

function validateConfirmedResponse(
  value: unknown,
  path: string,
  reviewRef: string,
  errors: DomainValidationIssue[],
): value is ConfirmedStudentResponseV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected confirmed response object');
    return false;
  }
  rejectUnknownKeys(value, CONFIRMED_RESPONSE_KEYS, path, errors);
  validateIdentifier(value.confirmedResponseId, `${path}/confirmedResponseId`, errors);
  validateIdentifier(value.confirmedQuestionId, `${path}/confirmedQuestionId`, errors);
  const hasSource = Object.hasOwn(value, 'sourceResponseCandidateId');
  if (hasSource)
    validateIdentifier(
      value.sourceResponseCandidateId,
      `${path}/sourceResponseCandidateId`,
      errors,
    );
  if (
    value.answerStatus !== 'text' &&
    value.answerStatus !== 'blank' &&
    value.answerStatus !== 'no_response'
  ) {
    pushIssue(errors, `${path}/answerStatus`, 'unknown answer status');
  }
  if (value.answerStatus === 'text') {
    if (!safeText(value.rawAnswerText, EXAM_HUMAN_REVIEW_LIMITS.maxAnswerBytes)) {
      pushIssue(errors, `${path}/rawAnswerText`, 'invalid answer text');
    }
  } else if (Object.hasOwn(value, 'rawAnswerText')) {
    pushIssue(errors, `${path}/rawAnswerText`, 'raw answer is only valid for text');
  }
  if (
    value.answerSource !== 'captured_confirmed' &&
    value.answerSource !== 'owner_corrected' &&
    value.answerSource !== 'owner_no_response'
  ) {
    pushIssue(errors, `${path}/answerSource`, 'unknown answer source');
  }
  if (
    (value.answerStatus === 'no_response') !== (value.answerSource === 'owner_no_response') ||
    (value.answerStatus === 'no_response') === hasSource
  ) {
    pushIssue(errors, path, 'response provenance mismatch');
  }
  if (
    typeof value.confirmedQuestionId === 'string' &&
    (!hasSource || typeof value.sourceResponseCandidateId === 'string') &&
    value.confirmedResponseId !==
      deriveConfirmedStudentResponseId(
        reviewRef,
        value.confirmedQuestionId,
        hasSource ? (value.sourceResponseCandidateId as string) : undefined,
      )
  ) {
    pushIssue(errors, `${path}/confirmedResponseId`, 'confirmed response id mismatch');
  }
  return errors.length === before;
}

function validateConfirmedMatch(
  value: unknown,
  path: string,
  reviewRef: string,
  errors: DomainValidationIssue[],
): value is ConfirmedQuestionResponseMatchV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected confirmed match object');
    return false;
  }
  rejectUnknownKeys(value, CONFIRMED_MATCH_KEYS, path, errors);
  validateIdentifier(value.confirmedMatchId, `${path}/confirmedMatchId`, errors);
  validateIdentifier(value.confirmedQuestionId, `${path}/confirmedQuestionId`, errors);
  validateIdentifier(value.confirmedResponseId, `${path}/confirmedResponseId`, errors);
  if (
    value.relationSource !== 'deterministic_match_confirmed' &&
    value.relationSource !== 'owner_manual_link'
  ) {
    pushIssue(errors, `${path}/relationSource`, 'unknown relation source');
  }
  if (
    typeof value.confirmedQuestionId === 'string' &&
    typeof value.confirmedResponseId === 'string' &&
    value.confirmedMatchId !==
      deriveConfirmedQuestionResponseMatchId(
        reviewRef,
        value.confirmedQuestionId,
        value.confirmedResponseId,
      )
  ) {
    pushIssue(errors, `${path}/confirmedMatchId`, 'confirmed match id mismatch');
  }
  return errors.length === before;
}

export function validateConfirmedExamReviewFacts(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected confirmed review facts artifact object');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, ARTIFACT_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_HUMAN_REVIEW_SCHEMA_VERSION)
    pushIssue(errors, '/schemaVersion', 'unexpected schema version');
  if (value.artifactVersion !== EXAM_HUMAN_REVIEW_ARTIFACT_VERSION)
    pushIssue(errors, '/artifactVersion', 'unexpected artifact version');
  if (value.reviewVersion !== EXAM_HUMAN_REVIEW_VERSION)
    pushIssue(errors, '/reviewVersion', 'unexpected review version');
  for (const field of [
    'examSessionId',
    'reviewRef',
    'reviewArtifactRef',
    'questionArtifactRef',
    'responseArtifactRef',
    'matchingArtifactRef',
  ] as const)
    validateIdentifier(value[field], `/${field}`, errors);
  for (const field of [
    'questionArtifactSha256',
    'responseArtifactSha256',
    'matchingArtifactSha256',
    'decisionSemanticFingerprint',
  ] as const)
    if (!validSha256(value[field])) pushIssue(errors, `/${field}`, 'expected lowercase SHA-256');
  for (const field of [
    'questionExtractionVersion',
    'questionSegmentationVersion',
    'responseCaptureVersion',
    'matchingVersion',
  ] as const)
    if (!validVersion(value[field]))
      pushIssue(errors, `/${field}`, 'expected positive bounded version');

  let decisions: readonly ExamHumanReviewDecision[] = [];
  if (Array.isArray(value.decisions)) {
    const result = validateExamHumanReviewRequest({ schemaVersion: 1, decisions: value.decisions });
    if (!result.valid)
      errors.push(
        ...result.errors.map((error) => ({
          path: `/decisions${error.path.replace('/decisions', '')}`,
          message: error.message,
        })),
      );
    else {
      decisions = value.decisions as ExamHumanReviewDecision[];
      const canonical = canonicalDecisions(decisions);
      if (JSON.stringify(canonicalize(decisions)) !== JSON.stringify(canonicalize(canonical)))
        pushIssue(errors, '/decisions', 'decisions are not canonically sorted');
      const expected = fingerprint('openmaic:zhongkao-exam-human-review-decisions:v1', {
        schemaVersion: 1,
        decisions: canonical,
      });
      if (value.decisionSemanticFingerprint !== expected)
        pushIssue(errors, '/decisionSemanticFingerprint', 'decision fingerprint mismatch');
    }
  } else pushIssue(errors, '/decisions', 'expected decision array');

  const reviewRef = typeof value.reviewRef === 'string' ? value.reviewRef : '';
  const questions: ConfirmedExamQuestionV1[] = [];
  if (
    !Array.isArray(value.confirmedQuestions) ||
    value.confirmedQuestions.length > EXAM_HUMAN_REVIEW_LIMITS.maxDecisions
  ) {
    pushIssue(errors, '/confirmedQuestions', 'expected bounded confirmed question array');
  } else
    value.confirmedQuestions.forEach((item, index) => {
      if (validateConfirmedQuestion(item, `/confirmedQuestions/${index}`, reviewRef, errors))
        questions.push(item);
    });
  const responses: ConfirmedStudentResponseV1[] = [];
  if (
    !Array.isArray(value.confirmedResponses) ||
    value.confirmedResponses.length > EXAM_HUMAN_REVIEW_LIMITS.maxDecisions
  ) {
    pushIssue(errors, '/confirmedResponses', 'expected bounded confirmed response array');
  } else
    value.confirmedResponses.forEach((item, index) => {
      if (validateConfirmedResponse(item, `/confirmedResponses/${index}`, reviewRef, errors))
        responses.push(item);
    });
  const matches: ConfirmedQuestionResponseMatchV1[] = [];
  if (
    !Array.isArray(value.confirmedMatches) ||
    value.confirmedMatches.length > EXAM_HUMAN_REVIEW_LIMITS.maxDecisions
  ) {
    pushIssue(errors, '/confirmedMatches', 'expected bounded confirmed match array');
  } else
    value.confirmedMatches.forEach((item, index) => {
      if (validateConfirmedMatch(item, `/confirmedMatches/${index}`, reviewRef, errors))
        matches.push(item);
    });

  const rejectedQuestions: RejectedExamQuestionCandidateV1[] = [];
  if (
    !Array.isArray(value.rejectedQuestionCandidates) ||
    value.rejectedQuestionCandidates.length > EXAM_HUMAN_REVIEW_LIMITS.maxDecisions
  ) {
    pushIssue(errors, '/rejectedQuestionCandidates', 'expected bounded rejected question array');
  } else
    value.rejectedQuestionCandidates.forEach((item, index) => {
      const path = `/rejectedQuestionCandidates/${index}`;
      if (!isPlainRecord(item)) pushIssue(errors, path, 'expected rejected question object');
      else {
        const before = errors.length;
        rejectUnknownKeys(item, REJECTED_QUESTION_KEYS, path, errors);
        validateIdentifier(
          item.sourceQuestionCandidateId,
          `${path}/sourceQuestionCandidateId`,
          errors,
        );
        if (!QUESTION_REJECTION_REASONS.has(item.reason as ExamQuestionRejectionReason))
          pushIssue(errors, `${path}/reason`, 'unknown question rejection reason');
        if (errors.length === before)
          rejectedQuestions.push(item as unknown as RejectedExamQuestionCandidateV1);
      }
    });
  const rejectedResponses: RejectedStudentResponseCandidateV1[] = [];
  if (
    !Array.isArray(value.rejectedResponseCandidates) ||
    value.rejectedResponseCandidates.length > EXAM_HUMAN_REVIEW_LIMITS.maxDecisions
  ) {
    pushIssue(errors, '/rejectedResponseCandidates', 'expected bounded rejected response array');
  } else
    value.rejectedResponseCandidates.forEach((item, index) => {
      const path = `/rejectedResponseCandidates/${index}`;
      if (!isPlainRecord(item)) pushIssue(errors, path, 'expected rejected response object');
      else {
        const before = errors.length;
        rejectUnknownKeys(item, REJECTED_RESPONSE_KEYS, path, errors);
        validateIdentifier(
          item.sourceResponseCandidateId,
          `${path}/sourceResponseCandidateId`,
          errors,
        );
        if (!RESPONSE_REJECTION_REASONS.has(item.reason as ExamResponseRejectionReason))
          pushIssue(errors, `${path}/reason`, 'unknown response rejection reason');
        if (errors.length === before)
          rejectedResponses.push(item as unknown as RejectedStudentResponseCandidateV1);
      }
    });

  for (const [field, expected] of [
    ['confirmedQuestionCount', questions.length],
    ['confirmedResponseCount', responses.length],
    ['confirmedMatchCount', matches.length],
    ['rejectedQuestionCount', rejectedQuestions.length],
    ['rejectedResponseCount', rejectedResponses.length],
  ] as const)
    if (value[field] !== expected) pushIssue(errors, `/${field}`, 'count mismatch');

  if (!canonicalOrder(questions, (item) => item.confirmedQuestionId))
    pushIssue(
      errors,
      '/confirmedQuestions',
      'questions are not canonically sorted or contain duplicate ids',
    );
  if (!canonicalOrder(responses, (item) => item.confirmedResponseId))
    pushIssue(
      errors,
      '/confirmedResponses',
      'responses are not canonically sorted or contain duplicate ids',
    );
  if (!canonicalOrder(matches, (item) => item.confirmedMatchId))
    pushIssue(
      errors,
      '/confirmedMatches',
      'matches are not canonically sorted or contain duplicate ids',
    );
  if (!canonicalOrder(rejectedQuestions, (item) => item.sourceQuestionCandidateId))
    pushIssue(
      errors,
      '/rejectedQuestionCandidates',
      'rejections are not canonically sorted or contain duplicate ids',
    );
  if (!canonicalOrder(rejectedResponses, (item) => item.sourceResponseCandidateId))
    pushIssue(
      errors,
      '/rejectedResponseCandidates',
      'rejections are not canonically sorted or contain duplicate ids',
    );

  const questionIds = new Set(questions.map((item) => item.confirmedQuestionId));
  const responseIds = new Set(responses.map((item) => item.confirmedResponseId));
  const responseQuestionIds = new Set<string>();
  for (const response of responses) {
    if (
      !questionIds.has(response.confirmedQuestionId) ||
      responseQuestionIds.has(response.confirmedQuestionId)
    )
      pushIssue(errors, '/confirmedResponses', 'response coverage mismatch');
    responseQuestionIds.add(response.confirmedQuestionId);
  }
  const matchQuestionIds = new Set<string>();
  const matchResponseIds = new Set<string>();
  const responsesById = new Map(responses.map((item) => [item.confirmedResponseId, item]));
  for (const match of matches) {
    if (
      !questionIds.has(match.confirmedQuestionId) ||
      !responseIds.has(match.confirmedResponseId) ||
      responsesById.get(match.confirmedResponseId)?.confirmedQuestionId !==
        match.confirmedQuestionId ||
      matchQuestionIds.has(match.confirmedQuestionId) ||
      matchResponseIds.has(match.confirmedResponseId)
    )
      pushIssue(errors, '/confirmedMatches', 'match coverage mismatch');
    matchQuestionIds.add(match.confirmedQuestionId);
    matchResponseIds.add(match.confirmedResponseId);
  }
  if (
    responseQuestionIds.size !== questionIds.size ||
    matchQuestionIds.size !== questionIds.size ||
    matchResponseIds.size !== responseIds.size
  )
    pushIssue(errors, '', 'confirmed coverage is incomplete');
  const locatorKeys = questions.map((item) => examQuestionLocatorKey(item.locator));
  if (new Set(locatorKeys).size !== locatorKeys.length)
    pushIssue(errors, '/confirmedQuestions', 'confirmed locator collision');
  if (
    Buffer.byteLength(JSON.stringify(canonicalize(value)), 'utf8') >
    EXAM_HUMAN_REVIEW_LIMITS.maxSerializedBytes
  ) {
    pushIssue(errors, '', 'review artifact exceeds byte limit');
  }
  return finishValidation(errors);
}

export function serializeConfirmedExamReviewFacts(artifact: ConfirmedExamReviewFactsV1): Buffer {
  if (!validateConfirmedExamReviewFacts(artifact).valid) {
    throw new ExamHumanReviewError('EXAM_REVIEW_ARTIFACT_INVALID');
  }
  const bytes = Buffer.from(JSON.stringify(canonicalize(artifact)), 'utf8');
  if (bytes.byteLength > EXAM_HUMAN_REVIEW_LIMITS.maxSerializedBytes) {
    throw new ExamHumanReviewError('EXAM_REVIEW_ARTIFACT_INVALID');
  }
  return bytes;
}

export function parseConfirmedExamReviewFacts(
  bytes: Buffer | Uint8Array | string,
): ConfirmedExamReviewFactsV1 {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  if (buffer.byteLength > EXAM_HUMAN_REVIEW_LIMITS.maxSerializedBytes) {
    throw new ExamHumanReviewError('EXAM_REVIEW_ARTIFACT_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(typeof bytes === 'string' ? bytes : UTF8_DECODER.decode(buffer));
  } catch {
    throw new ExamHumanReviewError('EXAM_REVIEW_ARTIFACT_INVALID');
  }
  if (!validateConfirmedExamReviewFacts(value).valid) {
    throw new ExamHumanReviewError('EXAM_REVIEW_ARTIFACT_INVALID');
  }
  return value as ConfirmedExamReviewFactsV1;
}
