import { createHash } from 'node:crypto';

import { EXAM_DERIVATIVE_VERSION_MAX, EXAM_MAX_QUESTION_CANDIDATES } from './exam';
import {
  serializeExamQuestionCandidatesArtifact,
  validateExamQuestionCandidatesArtifact,
  type ExamQuestionCandidateV1,
  type ExamQuestionCandidatesArtifactV1,
} from './exam-question-candidate';
import {
  examQuestionLocatorKey,
  examQuestionTopLevelLocatorKey,
  normalizeExamQuestionLocator,
  normalizeExamQuestionMarker,
  parseExamQuestionResponseLabel,
  type ExamQuestionLocator,
  type ExamQuestionSectionRef,
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

export const EXAM_STUDENT_RESPONSE_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const EXAM_STUDENT_RESPONSE_CANDIDATES_ARTIFACT_VERSION = 1 as const;
export const EXAM_STUDENT_RESPONSE_CAPTURE_VERSION = 1 as const;
export const EXAM_QUESTION_RESPONSE_MATCH_SCHEMA_VERSION = 1 as const;
export const EXAM_QUESTION_RESPONSE_MATCHES_ARTIFACT_VERSION = 1 as const;
export const EXAM_QUESTION_RESPONSE_MATCHING_VERSION = 1 as const;
export const EXAM_STUDENT_RESPONSE_CAPTURE_FORMAT = 'numbered_text_v1' as const;

export const EXAM_STUDENT_RESPONSE_LIMITS = Object.freeze({
  maxCandidates: 500,
  maxInputBytes: 1024 * 1024,
  maxLines: 2_000,
  maxSectionHeadings: 100,
  maxLabelLength: 64,
  maxAnswerBytes: 16 * 1024,
  maxSectionHeadingLength: 160,
  maxSerializedBytes: 4 * 1024 * 1024,
});

export interface ExamStudentResponseCaptureRequest {
  format: typeof EXAM_STUDENT_RESPONSE_CAPTURE_FORMAT;
  text: string;
}

export type ExamStudentResponseAnswerStatus = 'text' | 'blank';

export interface StudentResponseCandidateV1 {
  schemaVersion: typeof EXAM_STUDENT_RESPONSE_CANDIDATE_SCHEMA_VERSION;
  candidateId: string;
  candidateStatus: 'candidate';
  rawLabel: string;
  locator: ExamQuestionLocator;
  ordinalDiscriminator: number;
  answerStatus: ExamStudentResponseAnswerStatus;
  rawAnswerText: string;
}

export interface StudentResponseCandidatesArtifactV1 {
  schemaVersion: typeof EXAM_STUDENT_RESPONSE_CANDIDATE_SCHEMA_VERSION;
  artifactVersion: typeof EXAM_STUDENT_RESPONSE_CANDIDATES_ARTIFACT_VERSION;
  captureVersion: typeof EXAM_STUDENT_RESPONSE_CAPTURE_VERSION;
  examSessionId: string;
  captureFormat: typeof EXAM_STUDENT_RESPONSE_CAPTURE_FORMAT;
  captureRef: string;
  responseArtifactRef: string;
  inputSemanticFingerprint: string;
  questionCandidateArtifactRef: string;
  questionCandidateArtifactSha256: string;
  questionSegmentationVersion: number;
  candidateCount: number;
  candidates: readonly StudentResponseCandidateV1[];
}

export type ExamQuestionResponseMatchStatus = 'matched' | 'unmatched' | 'ambiguous';
export type ExamQuestionResponseAmbiguityReason =
  | 'duplicate_response_locator'
  | 'duplicate_question_locator'
  | 'group_has_subquestions';

export interface ExamQuestionResponseMatchV1 {
  schemaVersion: typeof EXAM_QUESTION_RESPONSE_MATCH_SCHEMA_VERSION;
  responseCandidateId: string;
  locator: ExamQuestionLocator;
  status: ExamQuestionResponseMatchStatus;
  questionCandidateIds: readonly string[];
  reasonCodes: readonly ExamQuestionResponseAmbiguityReason[];
}

export interface ExamQuestionResponseMatchesArtifactV1 {
  schemaVersion: typeof EXAM_QUESTION_RESPONSE_MATCH_SCHEMA_VERSION;
  artifactVersion: typeof EXAM_QUESTION_RESPONSE_MATCHES_ARTIFACT_VERSION;
  matchingVersion: typeof EXAM_QUESTION_RESPONSE_MATCHING_VERSION;
  examSessionId: string;
  matchingArtifactRef: string;
  inputSemanticFingerprint: string;
  questionCandidateArtifactRef: string;
  questionCandidateArtifactSha256: string;
  questionSegmentationVersion: number;
  responseArtifactRef: string;
  responseArtifactSha256: string;
  responseCaptureVersion: number;
  matchCount: number;
  matchedCount: number;
  unmatchedCount: number;
  ambiguousCount: number;
  needsReview: true;
  matches: readonly ExamQuestionResponseMatchV1[];
}

export class ExamStudentResponseError extends Error {
  constructor(
    readonly code:
      | 'EXAM_STUDENT_RESPONSE_INPUT_INVALID'
      | 'EXAM_STUDENT_RESPONSE_LIMIT_EXCEEDED'
      | 'EXAM_STUDENT_RESPONSE_ARTIFACT_INVALID'
      | 'EXAM_QUESTION_RESPONSE_MATCHING_FAILED'
      | 'EXAM_QUESTION_RESPONSE_MATCHES_ARTIFACT_INVALID',
  ) {
    super(code);
    this.name = 'ExamStudentResponseError';
  }
}

export interface BuildStudentResponseCandidatesArtifactInput {
  examSessionId: string;
  captureVersion: typeof EXAM_STUDENT_RESPONSE_CAPTURE_VERSION;
  captureRef: string;
  responseArtifactRef: string;
  questionCandidateArtifactRef: string;
  questionCandidateArtifactSha256: string;
  questionSegmentationVersion: number;
  request: unknown;
}

export interface BuildExamQuestionResponseMatchesArtifactInput {
  examSessionId: string;
  matchingArtifactRef: string;
  questionCandidateArtifactRef: string;
  questionCandidateArtifactSha256: string;
  responseArtifactRef: string;
  questionCandidatesArtifact: ExamQuestionCandidatesArtifactV1;
  responseCandidatesArtifact: StudentResponseCandidatesArtifactV1;
}

interface StudentResponseCandidateDraft {
  rawLabel: string;
  locator: ExamQuestionLocator;
  answerStatus: ExamStudentResponseAnswerStatus;
  rawAnswerText: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const CANONICAL_NUMBER = /^[1-9]\d{0,2}$/u;
const SECTION_ID = /^section:[1-9]\d*$/u;
const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const UNICODE_LINE_SEPARATOR = /[\u0085\u2028\u2029]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const REQUEST_KEYS = new Set(['format', 'text']);
const RESPONSE_ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactVersion',
  'captureVersion',
  'examSessionId',
  'captureFormat',
  'captureRef',
  'responseArtifactRef',
  'inputSemanticFingerprint',
  'questionCandidateArtifactRef',
  'questionCandidateArtifactSha256',
  'questionSegmentationVersion',
  'candidateCount',
  'candidates',
]);
const RESPONSE_CANDIDATE_KEYS = new Set([
  'schemaVersion',
  'candidateId',
  'candidateStatus',
  'rawLabel',
  'locator',
  'ordinalDiscriminator',
  'answerStatus',
  'rawAnswerText',
]);
const MATCH_ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactVersion',
  'matchingVersion',
  'examSessionId',
  'matchingArtifactRef',
  'inputSemanticFingerprint',
  'questionCandidateArtifactRef',
  'questionCandidateArtifactSha256',
  'questionSegmentationVersion',
  'responseArtifactRef',
  'responseArtifactSha256',
  'responseCaptureVersion',
  'matchCount',
  'matchedCount',
  'unmatchedCount',
  'ambiguousCount',
  'needsReview',
  'matches',
]);
const MATCH_KEYS = new Set([
  'schemaVersion',
  'responseCandidateId',
  'locator',
  'status',
  'questionCandidateIds',
  'reasonCodes',
]);
const LOCATOR_KEYS = new Set(['sectionPath', 'printedNumber', 'subquestionPath']);
const SECTION_REF_KEYS = new Set(['normalizedId', 'rawLabel']);
const AMBIGUITY_REASON_ORDER: readonly ExamQuestionResponseAmbiguityReason[] = [
  'duplicate_response_locator',
  'duplicate_question_locator',
  'group_has_subquestions',
];
const AMBIGUITY_REASONS = new Set<string>(AMBIGUITY_REASON_ORDER);

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

function sha256(bytes: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
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

function pushSha256Issue(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is string {
  if (validSha256(value)) return true;
  pushIssue(errors, path, 'expected lowercase SHA-256');
  return false;
}

function safeSingleLine(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= maxLength &&
    !value.includes('\r') &&
    !value.includes('\n') &&
    !UNSAFE_CONTROL_CHARACTER.test(value) &&
    !UNICODE_LINE_SEPARATOR.test(value) &&
    !UNPAIRED_SURROGATE.test(value)
  );
}

function responseCandidateId(input: {
  examSessionId: string;
  captureVersion: number;
  locator: ExamQuestionLocator;
  ordinalDiscriminator: number;
}): string {
  return `exam-student-response-candidate:v1:${fingerprint(
    'openmaic:zhongkao-exam-student-response-candidate:v1',
    {
      schemaVersion: EXAM_STUDENT_RESPONSE_CANDIDATE_SCHEMA_VERSION,
      examSessionId: input.examSessionId,
      captureVersion: input.captureVersion,
      locator: normalizeExamQuestionLocator(input.locator),
      ordinalDiscriminator: input.ordinalDiscriminator,
    },
  )}`;
}

function compareNumberArrays(left: readonly string[], right: readonly string[]): number {
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

function compareLocators(left: ExamQuestionLocator, right: ExamQuestionLocator): number {
  const sections = compareNumberArrays(
    left.sectionPath.map((section) => section.normalizedId.slice('section:'.length)),
    right.sectionPath.map((section) => section.normalizedId.slice('section:'.length)),
  );
  if (sections !== 0) return sections;
  const question = Number(left.printedNumber) - Number(right.printedNumber);
  if (question !== 0) return question;
  return compareNumberArrays(left.subquestionPath, right.subquestionPath);
}

function compareResponseCandidates(
  left: StudentResponseCandidateV1,
  right: StudentResponseCandidateV1,
): number {
  return (
    compareLocators(left.locator, right.locator) ||
    compareCandidateSemanticFacts(left, right) ||
    left.ordinalDiscriminator - right.ordinalDiscriminator ||
    (left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0)
  );
}

function candidateSemanticFacts(
  candidate: Pick<
    StudentResponseCandidateV1,
    'rawLabel' | 'locator' | 'answerStatus' | 'rawAnswerText'
  >,
): unknown {
  return {
    rawLabel: candidate.rawLabel,
    locator: cloneLocator(candidate.locator),
    answerStatus: candidate.answerStatus,
    rawAnswerText: candidate.rawAnswerText,
  };
}

function candidateSemanticKey(
  candidate: Pick<
    StudentResponseCandidateV1,
    'rawLabel' | 'locator' | 'answerStatus' | 'rawAnswerText'
  >,
): string {
  return JSON.stringify(canonicalize(candidateSemanticFacts(candidate)));
}

function compareCandidateSemanticFacts(
  left: Pick<StudentResponseCandidateV1, 'rawLabel' | 'locator' | 'answerStatus' | 'rawAnswerText'>,
  right: Pick<
    StudentResponseCandidateV1,
    'rawLabel' | 'locator' | 'answerStatus' | 'rawAnswerText'
  >,
): number {
  const leftKey = candidateSemanticKey(left);
  const rightKey = candidateSemanticKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function cloneLocator(locator: ExamQuestionLocator): ExamQuestionLocator {
  return {
    sectionPath: locator.sectionPath.map((section) => ({ ...section })),
    printedNumber: locator.printedNumber,
    subquestionPath: [...locator.subquestionPath],
  };
}

export function createExamStudentResponseInputSemanticFingerprint(
  input: Pick<
    StudentResponseCandidatesArtifactV1,
    'captureVersion' | 'captureFormat' | 'candidates'
  >,
): string {
  const candidates = input.candidates
    .map((candidate) => candidateSemanticFacts(candidate))
    .sort((left, right) => {
      const leftKey = JSON.stringify(canonicalize(left));
      const rightKey = JSON.stringify(canonicalize(right));
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return fingerprint('openmaic:zhongkao-exam-student-response-input:v1', {
    schemaVersion: EXAM_STUDENT_RESPONSE_CANDIDATE_SCHEMA_VERSION,
    captureVersion: input.captureVersion,
    captureFormat: input.captureFormat,
    candidates,
  });
}

export function validateExamStudentResponseCaptureRequest(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected student response capture request object');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, REQUEST_KEYS, '', errors);
  if (value.format !== EXAM_STUDENT_RESPONSE_CAPTURE_FORMAT) {
    pushIssue(errors, '/format', `expected ${EXAM_STUDENT_RESPONSE_CAPTURE_FORMAT}`);
  }
  if (typeof value.text !== 'string') {
    pushIssue(errors, '/text', 'expected response text string');
  } else {
    if (utf8Length(value.text) > EXAM_STUDENT_RESPONSE_LIMITS.maxInputBytes) {
      pushIssue(errors, '/text', 'response text exceeds byte limit');
    }
    if (
      UNSAFE_CONTROL_CHARACTER.test(value.text) ||
      UNICODE_LINE_SEPARATOR.test(value.text) ||
      UNPAIRED_SURROGATE.test(value.text)
    ) {
      pushIssue(errors, '/text', 'response text contains an unsafe character');
    }
    if (value.text.split(/\r\n|\r|\n/u).length > EXAM_STUDENT_RESPONSE_LIMITS.maxLines) {
      pushIssue(errors, '/text', 'response text exceeds line limit');
    }
  }
  return finishValidation(errors);
}

export function parseExamStudentResponseCaptureRequest(
  value: unknown,
): ExamStudentResponseCaptureRequest {
  if (!validateExamStudentResponseCaptureRequest(value).valid) {
    if (
      isPlainRecord(value) &&
      typeof value.text === 'string' &&
      (utf8Length(value.text) > EXAM_STUDENT_RESPONSE_LIMITS.maxInputBytes ||
        value.text.split(/\r\n|\r|\n/u).length > EXAM_STUDENT_RESPONSE_LIMITS.maxLines)
    ) {
      throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_LIMIT_EXCEEDED');
    }
    throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_INPUT_INVALID');
  }
  const request = value as ExamStudentResponseCaptureRequest;
  return { format: request.format, text: request.text };
}

function assertServerBuildFacts(input: {
  examSessionId: unknown;
  captureVersion?: unknown;
  captureRef?: unknown;
  responseArtifactRef?: unknown;
  matchingArtifactRef?: unknown;
  questionCandidateArtifactRef: unknown;
  questionCandidateArtifactSha256: unknown;
  questionSegmentationVersion?: unknown;
}): void {
  const errors: DomainValidationIssue[] = [];
  validateIdentifier(input.examSessionId, '/examSessionId', errors);
  if (
    input.captureVersion !== undefined &&
    input.captureVersion !== EXAM_STUDENT_RESPONSE_CAPTURE_VERSION
  ) {
    pushIssue(errors, '/captureVersion', 'unexpected capture version');
  }
  if (input.captureRef !== undefined) validateIdentifier(input.captureRef, '/captureRef', errors);
  if (input.responseArtifactRef !== undefined) {
    validateIdentifier(input.responseArtifactRef, '/responseArtifactRef', errors);
  }
  if (input.matchingArtifactRef !== undefined) {
    validateIdentifier(input.matchingArtifactRef, '/matchingArtifactRef', errors);
  }
  validateIdentifier(input.questionCandidateArtifactRef, '/questionCandidateArtifactRef', errors);
  pushSha256Issue(
    input.questionCandidateArtifactSha256,
    '/questionCandidateArtifactSha256',
    errors,
  );
  if (
    input.questionSegmentationVersion !== undefined &&
    !validVersion(input.questionSegmentationVersion)
  ) {
    pushIssue(errors, '/questionSegmentationVersion', 'expected positive bounded version');
  }
  if (errors.length > 0) throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_INPUT_INVALID');
}

export function buildStudentResponseCandidatesArtifact(
  input: BuildStudentResponseCandidatesArtifactInput,
): StudentResponseCandidatesArtifactV1 {
  assertServerBuildFacts(input);
  const request = parseExamStudentResponseCaptureRequest(input.request);
  const lines = request.text.split(/\r\n|\r|\n/u);
  const drafts: StudentResponseCandidateDraft[] = [];
  let sectionPath: ExamQuestionSectionRef[] = [];
  let sectionHeadingCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    const separator = line.indexOf('=');
    if (separator < 0) {
      const heading = line.trim();
      if (heading.length > EXAM_STUDENT_RESPONSE_LIMITS.maxSectionHeadingLength) {
        throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_LIMIT_EXCEEDED');
      }
      const marker = normalizeExamQuestionMarker(heading);
      if (!marker || marker.kind !== 'section') {
        throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_INPUT_INVALID');
      }
      sectionHeadingCount += 1;
      if (sectionHeadingCount > EXAM_STUDENT_RESPONSE_LIMITS.maxSectionHeadings) {
        throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_LIMIT_EXCEEDED');
      }
      sectionPath = [{ normalizedId: marker.normalizedSectionId, rawLabel: marker.rawLabel }];
      continue;
    }

    const rawLabel = line.slice(0, separator).trim();
    if (rawLabel.length > EXAM_STUDENT_RESPONSE_LIMITS.maxLabelLength) {
      throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_LIMIT_EXCEEDED');
    }
    const label = parseExamQuestionResponseLabel(rawLabel);
    if (!label) throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_INPUT_INVALID');
    const rawAnswerText = line.slice(separator + 1);
    if (utf8Length(rawAnswerText) > EXAM_STUDENT_RESPONSE_LIMITS.maxAnswerBytes) {
      throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_LIMIT_EXCEEDED');
    }
    const locator: ExamQuestionLocator = {
      sectionPath: sectionPath.map((section) => ({ ...section })),
      printedNumber: label.printedNumber,
      subquestionPath: [...label.subquestionPath],
    };
    drafts.push({
      rawLabel: label.rawLabel,
      locator,
      answerStatus: rawAnswerText.trim().length === 0 ? 'blank' : 'text',
      rawAnswerText,
    });
    if (drafts.length > EXAM_STUDENT_RESPONSE_LIMITS.maxCandidates) {
      throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_LIMIT_EXCEEDED');
    }
  }

  drafts.sort(
    (left, right) =>
      compareLocators(left.locator, right.locator) || compareCandidateSemanticFacts(left, right),
  );
  const occurrence = new Map<string, number>();
  const candidates = drafts.map((draft): StudentResponseCandidateV1 => {
    const key = examQuestionLocatorKey(draft.locator);
    const ordinalDiscriminator = (occurrence.get(key) ?? 0) + 1;
    occurrence.set(key, ordinalDiscriminator);
    return {
      schemaVersion: EXAM_STUDENT_RESPONSE_CANDIDATE_SCHEMA_VERSION,
      candidateId: responseCandidateId({
        examSessionId: input.examSessionId,
        captureVersion: input.captureVersion,
        locator: draft.locator,
        ordinalDiscriminator,
      }),
      candidateStatus: 'candidate',
      rawLabel: draft.rawLabel,
      locator: cloneLocator(draft.locator),
      ordinalDiscriminator,
      answerStatus: draft.answerStatus,
      rawAnswerText: draft.rawAnswerText,
    };
  });
  const inputSemanticFingerprint = createExamStudentResponseInputSemanticFingerprint({
    captureVersion: input.captureVersion,
    captureFormat: request.format,
    candidates,
  });
  const artifact: StudentResponseCandidatesArtifactV1 = {
    schemaVersion: EXAM_STUDENT_RESPONSE_CANDIDATE_SCHEMA_VERSION,
    artifactVersion: EXAM_STUDENT_RESPONSE_CANDIDATES_ARTIFACT_VERSION,
    captureVersion: input.captureVersion,
    examSessionId: input.examSessionId,
    captureFormat: request.format,
    captureRef: input.captureRef,
    responseArtifactRef: input.responseArtifactRef,
    inputSemanticFingerprint,
    questionCandidateArtifactRef: input.questionCandidateArtifactRef,
    questionCandidateArtifactSha256: input.questionCandidateArtifactSha256,
    questionSegmentationVersion: input.questionSegmentationVersion,
    candidateCount: candidates.length,
    candidates,
  };
  if (!validateStudentResponseCandidatesArtifact(artifact).valid) {
    throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_ARTIFACT_INVALID');
  }
  return artifact;
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
      if (
        !safeSingleLine(section.rawLabel, EXAM_STUDENT_RESPONSE_LIMITS.maxSectionHeadingLength) ||
        (typeof section.rawLabel === 'string' && section.rawLabel !== section.rawLabel.trim())
      ) {
        pushIssue(errors, `${sectionPath}/rawLabel`, 'expected bounded canonical section label');
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

function validateResponseCandidate(
  value: unknown,
  path: string,
  artifact: Pick<StudentResponseCandidatesArtifactV1, 'examSessionId' | 'captureVersion'>,
  errors: DomainValidationIssue[],
): value is StudentResponseCandidateV1 {
  const errorCount = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected response candidate object');
    return false;
  }
  rejectUnknownKeys(value, RESPONSE_CANDIDATE_KEYS, path, errors);
  if (value.schemaVersion !== EXAM_STUDENT_RESPONSE_CANDIDATE_SCHEMA_VERSION) {
    pushIssue(errors, `${path}/schemaVersion`, 'unexpected candidate schema version');
  }
  validateIdentifier(value.candidateId, `${path}/candidateId`, errors);
  if (value.candidateStatus !== 'candidate') {
    pushIssue(errors, `${path}/candidateStatus`, 'unexpected candidate status');
  }
  if (
    !safeSingleLine(value.rawLabel, EXAM_STUDENT_RESPONSE_LIMITS.maxLabelLength) ||
    (typeof value.rawLabel === 'string' && value.rawLabel !== value.rawLabel.trim())
  ) {
    pushIssue(errors, `${path}/rawLabel`, 'expected bounded response label');
  }
  const locatorValid = validateLocator(value.locator, `${path}/locator`, errors);
  if (
    !Number.isSafeInteger(value.ordinalDiscriminator) ||
    (value.ordinalDiscriminator as number) < 1 ||
    (value.ordinalDiscriminator as number) > EXAM_STUDENT_RESPONSE_LIMITS.maxCandidates
  ) {
    pushIssue(errors, `${path}/ordinalDiscriminator`, 'expected bounded positive ordinal');
  }
  if (typeof value.rawAnswerText !== 'string') {
    pushIssue(errors, `${path}/rawAnswerText`, 'expected raw answer string');
  } else {
    if (utf8Length(value.rawAnswerText) > EXAM_STUDENT_RESPONSE_LIMITS.maxAnswerBytes) {
      pushIssue(errors, `${path}/rawAnswerText`, 'raw answer exceeds byte limit');
    }
    if (
      value.rawAnswerText.includes('\r') ||
      value.rawAnswerText.includes('\n') ||
      UNSAFE_CONTROL_CHARACTER.test(value.rawAnswerText) ||
      UNICODE_LINE_SEPARATOR.test(value.rawAnswerText) ||
      UNPAIRED_SURROGATE.test(value.rawAnswerText)
    ) {
      pushIssue(errors, `${path}/rawAnswerText`, 'raw answer contains an unsafe character');
    }
  }
  if (value.answerStatus !== 'text' && value.answerStatus !== 'blank') {
    pushIssue(errors, `${path}/answerStatus`, 'unknown answer status');
  } else if (
    typeof value.rawAnswerText === 'string' &&
    value.answerStatus !== (value.rawAnswerText.trim().length === 0 ? 'blank' : 'text')
  ) {
    pushIssue(errors, `${path}/answerStatus`, 'answer status does not match raw answer');
  }
  const locator = locatorValid ? (value.locator as unknown as ExamQuestionLocator) : undefined;
  if (locator && typeof value.rawLabel === 'string') {
    const parsed = parseExamQuestionResponseLabel(value.rawLabel);
    if (
      !parsed ||
      parsed.printedNumber !== locator.printedNumber ||
      JSON.stringify(parsed.subquestionPath) !== JSON.stringify(locator.subquestionPath)
    ) {
      pushIssue(errors, `${path}/rawLabel`, 'response label does not match locator');
    }
  }
  if (
    locator &&
    Number.isSafeInteger(value.ordinalDiscriminator) &&
    typeof value.candidateId === 'string'
  ) {
    const expectedId = responseCandidateId({
      examSessionId: artifact.examSessionId,
      captureVersion: artifact.captureVersion,
      locator,
      ordinalDiscriminator: value.ordinalDiscriminator as number,
    });
    if (value.candidateId !== expectedId) {
      pushIssue(errors, `${path}/candidateId`, 'response candidate id mismatch');
    }
  }
  return errors.length === errorCount;
}

export function validateStudentResponseCandidatesArtifact(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected student response candidates artifact object');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, RESPONSE_ARTIFACT_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_STUDENT_RESPONSE_CANDIDATE_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'unexpected schema version');
  }
  if (value.artifactVersion !== EXAM_STUDENT_RESPONSE_CANDIDATES_ARTIFACT_VERSION) {
    pushIssue(errors, '/artifactVersion', 'unexpected artifact version');
  }
  if (value.captureVersion !== EXAM_STUDENT_RESPONSE_CAPTURE_VERSION) {
    pushIssue(errors, '/captureVersion', 'unexpected capture version');
  }
  validateIdentifier(value.examSessionId, '/examSessionId', errors);
  if (value.captureFormat !== EXAM_STUDENT_RESPONSE_CAPTURE_FORMAT) {
    pushIssue(errors, '/captureFormat', 'unexpected capture format');
  }
  validateIdentifier(value.captureRef, '/captureRef', errors);
  validateIdentifier(value.responseArtifactRef, '/responseArtifactRef', errors);
  pushSha256Issue(value.inputSemanticFingerprint, '/inputSemanticFingerprint', errors);
  validateIdentifier(value.questionCandidateArtifactRef, '/questionCandidateArtifactRef', errors);
  pushSha256Issue(
    value.questionCandidateArtifactSha256,
    '/questionCandidateArtifactSha256',
    errors,
  );
  if (!validVersion(value.questionSegmentationVersion)) {
    pushIssue(errors, '/questionSegmentationVersion', 'expected positive bounded version');
  }
  if (
    !Number.isSafeInteger(value.candidateCount) ||
    (value.candidateCount as number) < 0 ||
    (value.candidateCount as number) > EXAM_STUDENT_RESPONSE_LIMITS.maxCandidates
  ) {
    pushIssue(errors, '/candidateCount', 'expected bounded candidate count');
  }

  const validCandidates: StudentResponseCandidateV1[] = [];
  if (
    !Array.isArray(value.candidates) ||
    value.candidates.length > EXAM_STUDENT_RESPONSE_LIMITS.maxCandidates
  ) {
    pushIssue(errors, '/candidates', 'expected bounded candidate array');
  } else {
    const artifactIdentity = {
      examSessionId: typeof value.examSessionId === 'string' ? value.examSessionId : '',
      captureVersion:
        value.captureVersion === EXAM_STUDENT_RESPONSE_CAPTURE_VERSION
          ? value.captureVersion
          : EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
    };
    value.candidates.forEach((candidate, index) => {
      if (validateResponseCandidate(candidate, `/candidates/${index}`, artifactIdentity, errors)) {
        validCandidates.push(candidate);
      }
    });
    if (value.candidateCount !== value.candidates.length) {
      pushIssue(errors, '/candidateCount', 'candidate count mismatch');
    }
  }

  const ids = new Set<string>();
  const nextOrdinal = new Map<string, number>();
  validCandidates.forEach((candidate, index) => {
    if (ids.has(candidate.candidateId)) {
      pushIssue(errors, `/candidates/${index}/candidateId`, 'duplicate candidate id');
    }
    ids.add(candidate.candidateId);
    const key = examQuestionLocatorKey(candidate.locator);
    const expectedOrdinal = (nextOrdinal.get(key) ?? 0) + 1;
    nextOrdinal.set(key, expectedOrdinal);
    if (candidate.ordinalDiscriminator !== expectedOrdinal) {
      pushIssue(errors, `/candidates/${index}/ordinalDiscriminator`, 'duplicate ordinal mismatch');
    }
    if (index > 0 && compareResponseCandidates(validCandidates[index - 1]!, candidate) > 0) {
      pushIssue(errors, `/candidates/${index}`, 'candidates are not canonically sorted');
    }
  });
  if (
    validCandidates.length === (Array.isArray(value.candidates) ? value.candidates.length : -1) &&
    value.captureVersion === EXAM_STUDENT_RESPONSE_CAPTURE_VERSION &&
    value.captureFormat === EXAM_STUDENT_RESPONSE_CAPTURE_FORMAT
  ) {
    const expectedFingerprint = createExamStudentResponseInputSemanticFingerprint({
      captureVersion: value.captureVersion,
      captureFormat: value.captureFormat,
      candidates: validCandidates,
    });
    if (value.inputSemanticFingerprint !== expectedFingerprint) {
      pushIssue(errors, '/inputSemanticFingerprint', 'input semantic fingerprint mismatch');
    }
  }
  return finishValidation(errors);
}

export function serializeStudentResponseCandidatesArtifact(
  artifact: StudentResponseCandidatesArtifactV1,
): Buffer {
  if (!validateStudentResponseCandidatesArtifact(artifact).valid) {
    throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_ARTIFACT_INVALID');
  }
  const bytes = Buffer.from(JSON.stringify(canonicalize(artifact)), 'utf8');
  if (bytes.byteLength > EXAM_STUDENT_RESPONSE_LIMITS.maxSerializedBytes) {
    throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_ARTIFACT_INVALID');
  }
  return bytes;
}

export function parseStudentResponseCandidatesArtifact(
  bytes: Buffer | Uint8Array | string,
): StudentResponseCandidatesArtifactV1 {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  if (buffer.byteLength > EXAM_STUDENT_RESPONSE_LIMITS.maxSerializedBytes) {
    throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_ARTIFACT_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(typeof bytes === 'string' ? bytes : UTF8_DECODER.decode(buffer));
  } catch {
    throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_ARTIFACT_INVALID');
  }
  if (!validateStudentResponseCandidatesArtifact(value).valid) {
    throw new ExamStudentResponseError('EXAM_STUDENT_RESPONSE_ARTIFACT_INVALID');
  }
  return value as StudentResponseCandidatesArtifactV1;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sortedReasons(
  values: readonly ExamQuestionResponseAmbiguityReason[],
): ExamQuestionResponseAmbiguityReason[] {
  const present = new Set(values);
  return AMBIGUITY_REASON_ORDER.filter((reason) => present.has(reason));
}

export function createExamQuestionResponseMatchingInputSemanticFingerprint(
  input: Pick<
    ExamQuestionResponseMatchesArtifactV1,
    | 'examSessionId'
    | 'questionCandidateArtifactRef'
    | 'questionCandidateArtifactSha256'
    | 'questionSegmentationVersion'
    | 'responseArtifactRef'
    | 'responseArtifactSha256'
    | 'responseCaptureVersion'
  >,
): string {
  return fingerprint('openmaic:zhongkao-exam-question-response-matching-input:v1', {
    schemaVersion: EXAM_QUESTION_RESPONSE_MATCH_SCHEMA_VERSION,
    matchingVersion: EXAM_QUESTION_RESPONSE_MATCHING_VERSION,
    ...input,
  });
}

function compareMatches(
  left: ExamQuestionResponseMatchV1,
  right: ExamQuestionResponseMatchV1,
): number {
  return (
    compareLocators(left.locator, right.locator) ||
    (left.responseCandidateId < right.responseCandidateId
      ? -1
      : left.responseCandidateId > right.responseCandidateId
        ? 1
        : 0)
  );
}

function questionCandidatesByLocator(
  candidates: readonly ExamQuestionCandidateV1[],
): Map<string, ExamQuestionCandidateV1[]> {
  const result = new Map<string, ExamQuestionCandidateV1[]>();
  for (const candidate of candidates) {
    const key = examQuestionLocatorKey(candidate.locator);
    const group = result.get(key) ?? [];
    group.push(candidate);
    result.set(key, group);
  }
  return result;
}

function responseLocatorCounts(
  candidates: readonly StudentResponseCandidateV1[],
): Map<string, number> {
  const result = new Map<string, number>();
  for (const candidate of candidates) {
    const key = examQuestionLocatorKey(candidate.locator);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function responseMatch(
  response: StudentResponseCandidateV1,
  responseCounts: ReadonlyMap<string, number>,
  questionsByLocator: ReadonlyMap<string, readonly ExamQuestionCandidateV1[]>,
  questionCandidates: readonly ExamQuestionCandidateV1[],
): ExamQuestionResponseMatchV1 {
  const key = examQuestionLocatorKey(response.locator);
  const exact =
    response.locator.sectionPath.length === 0
      ? questionCandidates.filter(
          (candidate) =>
            candidate.locator.printedNumber === response.locator.printedNumber &&
            JSON.stringify(candidate.locator.subquestionPath) ===
              JSON.stringify(response.locator.subquestionPath),
        )
      : [...(questionsByLocator.get(key) ?? [])];
  const reasons: ExamQuestionResponseAmbiguityReason[] = [];
  if ((responseCounts.get(key) ?? 0) > 1) reasons.push('duplicate_response_locator');

  let possible = exact;
  const exactGroups = exact.filter((candidate) => candidate.candidateKind === 'group');
  if (exact.length > 1) reasons.push('duplicate_question_locator');
  if (exactGroups.length > 0) {
    const groupIds = new Set(exactGroups.map((candidate) => candidate.candidateId));
    const children = questionCandidates.filter(
      (candidate) =>
        candidate.candidateKind === 'leaf' &&
        candidate.parentCandidateId !== undefined &&
        groupIds.has(candidate.parentCandidateId),
    );
    possible = children.length > 0 ? children : exactGroups;
    reasons.push('group_has_subquestions');
  } else if (exact.length === 0 && response.locator.subquestionPath.length === 0) {
    const sectionless = response.locator.sectionPath.length === 0;
    const topLevelKey = sectionless ? undefined : examQuestionTopLevelLocatorKey(response.locator);
    const children = questionCandidates.filter(
      (candidate) =>
        candidate.candidateKind === 'leaf' &&
        candidate.locator.subquestionPath.length > 0 &&
        candidate.locator.printedNumber === response.locator.printedNumber &&
        (sectionless || examQuestionTopLevelLocatorKey(candidate.locator) === topLevelKey),
    );
    if (children.length > 0) {
      possible = children;
      reasons.push('group_has_subquestions');
    }
  }

  let status: ExamQuestionResponseMatchStatus;
  if (possible.length === 0) {
    status = 'unmatched';
    reasons.length = 0;
  } else if (reasons.length > 0) status = 'ambiguous';
  else if (possible.length === 1 && possible[0]!.candidateKind === 'leaf') status = 'matched';
  else {
    status = 'ambiguous';
    reasons.push('duplicate_question_locator');
  }
  return {
    schemaVersion: EXAM_QUESTION_RESPONSE_MATCH_SCHEMA_VERSION,
    responseCandidateId: response.candidateId,
    locator: cloneLocator(response.locator),
    status,
    questionCandidateIds: sortedUnique(possible.map((candidate) => candidate.candidateId)),
    reasonCodes: sortedReasons(reasons),
  };
}

export function buildExamQuestionResponseMatchesArtifact(
  input: BuildExamQuestionResponseMatchesArtifactInput,
): ExamQuestionResponseMatchesArtifactV1 {
  assertServerBuildFacts({
    examSessionId: input.examSessionId,
    matchingArtifactRef: input.matchingArtifactRef,
    responseArtifactRef: input.responseArtifactRef,
    questionCandidateArtifactRef: input.questionCandidateArtifactRef,
    questionCandidateArtifactSha256: input.questionCandidateArtifactSha256,
  });
  if (!validateExamQuestionCandidatesArtifact(input.questionCandidatesArtifact).valid) {
    throw new ExamStudentResponseError('EXAM_QUESTION_RESPONSE_MATCHING_FAILED');
  }
  if (!validateStudentResponseCandidatesArtifact(input.responseCandidatesArtifact).valid) {
    throw new ExamStudentResponseError('EXAM_QUESTION_RESPONSE_MATCHING_FAILED');
  }
  let questionBytes: Buffer;
  let responseBytes: Buffer;
  try {
    questionBytes = serializeExamQuestionCandidatesArtifact(input.questionCandidatesArtifact);
    responseBytes = serializeStudentResponseCandidatesArtifact(input.responseCandidatesArtifact);
  } catch {
    throw new ExamStudentResponseError('EXAM_QUESTION_RESPONSE_MATCHING_FAILED');
  }
  if (
    input.questionCandidatesArtifact.examSessionId !== input.examSessionId ||
    input.responseCandidatesArtifact.examSessionId !== input.examSessionId ||
    input.responseCandidatesArtifact.questionCandidateArtifactRef !==
      input.questionCandidateArtifactRef ||
    input.responseCandidatesArtifact.questionCandidateArtifactSha256 !==
      input.questionCandidateArtifactSha256 ||
    input.responseCandidatesArtifact.questionSegmentationVersion !==
      input.questionCandidatesArtifact.segmentationVersion ||
    input.responseCandidatesArtifact.responseArtifactRef !== input.responseArtifactRef ||
    sha256(questionBytes) !== input.questionCandidateArtifactSha256
  ) {
    throw new ExamStudentResponseError('EXAM_QUESTION_RESPONSE_MATCHING_FAILED');
  }

  const questionsByLocator = questionCandidatesByLocator(
    input.questionCandidatesArtifact.candidates,
  );
  const responseCounts = responseLocatorCounts(input.responseCandidatesArtifact.candidates);
  const matches = input.responseCandidatesArtifact.candidates
    .map((candidate) =>
      responseMatch(
        candidate,
        responseCounts,
        questionsByLocator,
        input.questionCandidatesArtifact.candidates,
      ),
    )
    .sort(compareMatches);
  const responseArtifactSha256 = sha256(responseBytes);
  const inputSemanticFingerprint = createExamQuestionResponseMatchingInputSemanticFingerprint({
    examSessionId: input.examSessionId,
    questionCandidateArtifactRef: input.questionCandidateArtifactRef,
    questionCandidateArtifactSha256: input.questionCandidateArtifactSha256,
    questionSegmentationVersion: input.questionCandidatesArtifact.segmentationVersion,
    responseArtifactRef: input.responseArtifactRef,
    responseArtifactSha256,
    responseCaptureVersion: input.responseCandidatesArtifact.captureVersion,
  });
  const artifact: ExamQuestionResponseMatchesArtifactV1 = {
    schemaVersion: EXAM_QUESTION_RESPONSE_MATCH_SCHEMA_VERSION,
    artifactVersion: EXAM_QUESTION_RESPONSE_MATCHES_ARTIFACT_VERSION,
    matchingVersion: EXAM_QUESTION_RESPONSE_MATCHING_VERSION,
    examSessionId: input.examSessionId,
    matchingArtifactRef: input.matchingArtifactRef,
    inputSemanticFingerprint,
    questionCandidateArtifactRef: input.questionCandidateArtifactRef,
    questionCandidateArtifactSha256: input.questionCandidateArtifactSha256,
    questionSegmentationVersion: input.questionCandidatesArtifact.segmentationVersion,
    responseArtifactRef: input.responseArtifactRef,
    responseArtifactSha256,
    responseCaptureVersion: input.responseCandidatesArtifact.captureVersion,
    matchCount: matches.length,
    matchedCount: matches.filter((match) => match.status === 'matched').length,
    unmatchedCount: matches.filter((match) => match.status === 'unmatched').length,
    ambiguousCount: matches.filter((match) => match.status === 'ambiguous').length,
    needsReview: true,
    matches,
  };
  if (!validateExamQuestionResponseMatchesArtifact(artifact).valid) {
    throw new ExamStudentResponseError('EXAM_QUESTION_RESPONSE_MATCHES_ARTIFACT_INVALID');
  }
  return artifact;
}

function validateMatch(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamQuestionResponseMatchV1 {
  const errorCount = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected response match object');
    return false;
  }
  rejectUnknownKeys(value, MATCH_KEYS, path, errors);
  if (value.schemaVersion !== EXAM_QUESTION_RESPONSE_MATCH_SCHEMA_VERSION) {
    pushIssue(errors, `${path}/schemaVersion`, 'unexpected match schema version');
  }
  validateIdentifier(value.responseCandidateId, `${path}/responseCandidateId`, errors);
  validateLocator(value.locator, `${path}/locator`, errors);
  if (value.status !== 'matched' && value.status !== 'unmatched' && value.status !== 'ambiguous') {
    pushIssue(errors, `${path}/status`, 'unknown match status');
  }
  if (!Array.isArray(value.questionCandidateIds)) {
    pushIssue(errors, `${path}/questionCandidateIds`, 'expected candidate id array');
  } else {
    const candidateIds = value.questionCandidateIds as unknown[];
    if (candidateIds.length > EXAM_MAX_QUESTION_CANDIDATES) {
      pushIssue(errors, `${path}/questionCandidateIds`, 'too many question candidate ids');
    }
    const seen = new Set<string>();
    candidateIds.forEach((candidateId, index) => {
      validateIdentifier(candidateId, `${path}/questionCandidateIds/${index}`, errors);
      if (typeof candidateId === 'string') {
        if (seen.has(candidateId)) {
          pushIssue(errors, `${path}/questionCandidateIds/${index}`, 'duplicate candidate id');
        }
        seen.add(candidateId);
      }
    });
    if (
      candidateIds.some(
        (candidateId, index) =>
          index > 0 &&
          typeof candidateId === 'string' &&
          typeof candidateIds[index - 1] === 'string' &&
          candidateId < (candidateIds[index - 1] as string),
      )
    ) {
      pushIssue(errors, `${path}/questionCandidateIds`, 'candidate ids are not canonically sorted');
    }
  }
  if (!Array.isArray(value.reasonCodes)) {
    pushIssue(errors, `${path}/reasonCodes`, 'expected ambiguity reason array');
  } else {
    const expected = value.reasonCodes.filter(
      (reason): reason is ExamQuestionResponseAmbiguityReason =>
        typeof reason === 'string' && AMBIGUITY_REASONS.has(reason),
    );
    if (expected.length !== value.reasonCodes.length) {
      pushIssue(errors, `${path}/reasonCodes`, 'unknown ambiguity reason');
    } else if (JSON.stringify(expected) !== JSON.stringify(sortedReasons(expected))) {
      pushIssue(errors, `${path}/reasonCodes`, 'ambiguity reasons are not canonical');
    }
  }
  if (
    value.status === 'matched' &&
    (Array.isArray(value.questionCandidateIds) ? value.questionCandidateIds.length !== 1 : true)
  ) {
    pushIssue(errors, path, 'matched response requires one question candidate');
  }
  if (
    value.status === 'unmatched' &&
    (Array.isArray(value.questionCandidateIds) ? value.questionCandidateIds.length !== 0 : true)
  ) {
    pushIssue(errors, path, 'unmatched response cannot cite a question candidate');
  }
  if (
    value.status === 'ambiguous' &&
    (Array.isArray(value.questionCandidateIds) ? value.questionCandidateIds.length === 0 : true)
  ) {
    pushIssue(errors, path, 'ambiguous response requires a possible question candidate');
  }
  if (
    (value.status === 'ambiguous') !==
    (Array.isArray(value.reasonCodes) && value.reasonCodes.length > 0)
  ) {
    pushIssue(errors, path, 'ambiguity reasons do not match status');
  }
  return errors.length === errorCount;
}

export function validateExamQuestionResponseMatchesArtifact(
  value: unknown,
): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected question response matches artifact object');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, MATCH_ARTIFACT_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_QUESTION_RESPONSE_MATCH_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'unexpected schema version');
  }
  if (value.artifactVersion !== EXAM_QUESTION_RESPONSE_MATCHES_ARTIFACT_VERSION) {
    pushIssue(errors, '/artifactVersion', 'unexpected artifact version');
  }
  if (value.matchingVersion !== EXAM_QUESTION_RESPONSE_MATCHING_VERSION) {
    pushIssue(errors, '/matchingVersion', 'unexpected matching version');
  }
  validateIdentifier(value.examSessionId, '/examSessionId', errors);
  validateIdentifier(value.matchingArtifactRef, '/matchingArtifactRef', errors);
  pushSha256Issue(value.inputSemanticFingerprint, '/inputSemanticFingerprint', errors);
  validateIdentifier(value.questionCandidateArtifactRef, '/questionCandidateArtifactRef', errors);
  pushSha256Issue(
    value.questionCandidateArtifactSha256,
    '/questionCandidateArtifactSha256',
    errors,
  );
  if (!validVersion(value.questionSegmentationVersion)) {
    pushIssue(errors, '/questionSegmentationVersion', 'expected positive bounded version');
  }
  validateIdentifier(value.responseArtifactRef, '/responseArtifactRef', errors);
  pushSha256Issue(value.responseArtifactSha256, '/responseArtifactSha256', errors);
  if (!validVersion(value.responseCaptureVersion)) {
    pushIssue(errors, '/responseCaptureVersion', 'expected positive bounded version');
  }
  if (value.needsReview !== true) {
    pushIssue(errors, '/needsReview', 'response matches require review');
  }
  for (const field of ['matchCount', 'matchedCount', 'unmatchedCount', 'ambiguousCount'] as const) {
    if (
      !Number.isSafeInteger(value[field]) ||
      (value[field] as number) < 0 ||
      (value[field] as number) > EXAM_STUDENT_RESPONSE_LIMITS.maxCandidates
    ) {
      pushIssue(errors, `/${field}`, 'expected bounded non-negative count');
    }
  }

  const validMatches: ExamQuestionResponseMatchV1[] = [];
  if (
    !Array.isArray(value.matches) ||
    value.matches.length > EXAM_STUDENT_RESPONSE_LIMITS.maxCandidates
  ) {
    pushIssue(errors, '/matches', 'expected bounded match array');
  } else {
    const ids = new Set<string>();
    value.matches.forEach((match, index) => {
      if (validateMatch(match, `/matches/${index}`, errors)) {
        validMatches.push(match);
        if (ids.has(match.responseCandidateId)) {
          pushIssue(errors, `/matches/${index}/responseCandidateId`, 'duplicate response match');
        }
        ids.add(match.responseCandidateId);
      }
    });
    if (value.matchCount !== value.matches.length) {
      pushIssue(errors, '/matchCount', 'match count mismatch');
    }
  }
  if (value.matchedCount !== validMatches.filter((match) => match.status === 'matched').length) {
    pushIssue(errors, '/matchedCount', 'matched count mismatch');
  }
  if (
    value.unmatchedCount !== validMatches.filter((match) => match.status === 'unmatched').length
  ) {
    pushIssue(errors, '/unmatchedCount', 'unmatched count mismatch');
  }
  if (
    value.ambiguousCount !== validMatches.filter((match) => match.status === 'ambiguous').length
  ) {
    pushIssue(errors, '/ambiguousCount', 'ambiguous count mismatch');
  }
  if (
    validMatches.some(
      (match, index) => index > 0 && compareMatches(validMatches[index - 1]!, match) > 0,
    )
  ) {
    pushIssue(errors, '/matches', 'matches are not canonically sorted');
  }
  if (
    typeof value.examSessionId === 'string' &&
    typeof value.questionCandidateArtifactRef === 'string' &&
    typeof value.questionCandidateArtifactSha256 === 'string' &&
    typeof value.responseArtifactRef === 'string' &&
    typeof value.responseArtifactSha256 === 'string' &&
    validVersion(value.questionSegmentationVersion) &&
    validVersion(value.responseCaptureVersion)
  ) {
    const expectedFingerprint = createExamQuestionResponseMatchingInputSemanticFingerprint({
      examSessionId: value.examSessionId,
      questionCandidateArtifactRef: value.questionCandidateArtifactRef,
      questionCandidateArtifactSha256: value.questionCandidateArtifactSha256,
      questionSegmentationVersion: value.questionSegmentationVersion,
      responseArtifactRef: value.responseArtifactRef,
      responseArtifactSha256: value.responseArtifactSha256,
      responseCaptureVersion: value.responseCaptureVersion,
    });
    if (value.inputSemanticFingerprint !== expectedFingerprint) {
      pushIssue(errors, '/inputSemanticFingerprint', 'input semantic fingerprint mismatch');
    }
  }
  return finishValidation(errors);
}

export function serializeExamQuestionResponseMatchesArtifact(
  artifact: ExamQuestionResponseMatchesArtifactV1,
): Buffer {
  if (!validateExamQuestionResponseMatchesArtifact(artifact).valid) {
    throw new ExamStudentResponseError('EXAM_QUESTION_RESPONSE_MATCHES_ARTIFACT_INVALID');
  }
  const bytes = Buffer.from(JSON.stringify(canonicalize(artifact)), 'utf8');
  if (bytes.byteLength > EXAM_STUDENT_RESPONSE_LIMITS.maxSerializedBytes) {
    throw new ExamStudentResponseError('EXAM_QUESTION_RESPONSE_MATCHES_ARTIFACT_INVALID');
  }
  return bytes;
}

export function parseExamQuestionResponseMatchesArtifact(
  bytes: Buffer | Uint8Array | string,
): ExamQuestionResponseMatchesArtifactV1 {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  if (buffer.byteLength > EXAM_STUDENT_RESPONSE_LIMITS.maxSerializedBytes) {
    throw new ExamStudentResponseError('EXAM_QUESTION_RESPONSE_MATCHES_ARTIFACT_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(typeof bytes === 'string' ? bytes : UTF8_DECODER.decode(buffer));
  } catch {
    throw new ExamStudentResponseError('EXAM_QUESTION_RESPONSE_MATCHES_ARTIFACT_INVALID');
  }
  if (!validateExamQuestionResponseMatchesArtifact(value).valid) {
    throw new ExamStudentResponseError('EXAM_QUESTION_RESPONSE_MATCHES_ARTIFACT_INVALID');
  }
  return value as ExamQuestionResponseMatchesArtifactV1;
}
