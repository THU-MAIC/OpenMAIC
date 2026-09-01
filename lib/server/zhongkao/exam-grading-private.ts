import { createHash } from 'node:crypto';

import {
  serializeConfirmedExamReviewFacts,
  validateConfirmedExamReviewFacts,
  type ConfirmedExamReviewFactsV1,
  type ConfirmedStudentResponseV1,
} from '@/lib/zhongkao/exam-human-review';
import {
  EXAM_MAX_ANSWER_KEY_ARTIFACT_BYTES,
  EXAM_MAX_ASSESSMENT_ARTIFACT_BYTES,
  EXAM_MAX_QUESTION_CANDIDATES,
  EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
} from '@/lib/zhongkao/exam';
import {
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  type DomainValidationIssue,
  type DomainValidationResult,
} from '@/lib/zhongkao/validation';

import { canonicalizeTransferDecimal, evaluateTransferAnswer } from './transfer-answer-evaluator';
import {
  normalizeTransferExactAnswer,
  validateTransferQuestionGradingSpec,
  type TransferQuestionGradingSpec,
  type TransferShortAnswerCaseMode,
} from './transfer-question-private';

export const EXAM_ANSWER_KEY_SCHEMA_VERSION = 1 as const;
export const EXAM_ANSWER_KEY_ARTIFACT_VERSION = 1 as const;
export const EXAM_ANSWER_KEY_VERSION = 1 as const;
export const EXAM_ASSESSMENT_SCHEMA_VERSION = 1 as const;
export const EXAM_ASSESSMENT_ARTIFACT_VERSION = 1 as const;
export const EXAM_ASSESSMENT_VERSION = 1 as const;
export const EXAM_ANSWER_KEY_AUTHORITY_SOURCE = 'owner_confirmed_manual_key' as const;
export const EXAM_CHOICE_OPTION_IDS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export const EXAM_UNASSESSED_REASONS = ['unsupported_question_type'] as const;

export { EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION };

export const EXAM_PRIVATE_GRADING_LIMITS = Object.freeze({
  maxEntries: EXAM_MAX_QUESTION_CANDIDATES,
  maxExpectedNumericLength: 128,
  maxAcceptedAnswers: 16,
  maxAcceptedAnswerLength: 256,
  maxAnswerKeyArtifactBytes: EXAM_MAX_ANSWER_KEY_ARTIFACT_BYTES,
  maxAssessmentArtifactBytes: EXAM_MAX_ASSESSMENT_ARTIFACT_BYTES,
});

export type ExamUnassessedReason = (typeof EXAM_UNASSESSED_REASONS)[number];
export type ExamObjectiveGradingType =
  | 'single_choice'
  | 'multiple_choice'
  | 'numeric'
  | 'exact_short_answer';

export type ExamAnswerKeyEntryV1 =
  | {
      confirmedQuestionId: string;
      type: 'single_choice';
      expectedOptionId: string;
    }
  | {
      confirmedQuestionId: string;
      type: 'multiple_choice';
      expectedOptionIds: string[];
    }
  | {
      confirmedQuestionId: string;
      type: 'numeric';
      expectedValue: string;
    }
  | {
      confirmedQuestionId: string;
      type: 'exact_short_answer';
      acceptedAnswers: string[];
    }
  | {
      confirmedQuestionId: string;
      type: 'unassessed';
      reason: ExamUnassessedReason;
    };

export interface ExamAnswerKeyRequestV1 {
  schemaVersion: typeof EXAM_ANSWER_KEY_SCHEMA_VERSION;
  entries: ExamAnswerKeyEntryV1[];
}

export interface ExamConfirmedReviewSourceV1 {
  reviewRef: string;
  reviewArtifactRef: string;
  reviewArtifactSha256: string;
  reviewVersion: number;
  reviewArtifactVersion: number;
  decisionSemanticFingerprint: string;
}

interface PrivateExamGradingSpecBaseV1 {
  schemaVersion: typeof EXAM_ANSWER_KEY_SCHEMA_VERSION;
  answerKeyVersion: typeof EXAM_ANSWER_KEY_VERSION;
  gradingAlgorithmVersion: typeof EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION;
  examSessionId: string;
  confirmedQuestionId: string;
  answerKeyRef: string;
  gradingSpecRef: string;
  sourceReview: ExamConfirmedReviewSourceV1;
  authoritySource: typeof EXAM_ANSWER_KEY_AUTHORITY_SOURCE;
}

export type PrivateExamGradingSpecV1 =
  | (PrivateExamGradingSpecBaseV1 & {
      type: 'single_choice';
      optionIds: string[];
      correctOptionId: string;
    })
  | (PrivateExamGradingSpecBaseV1 & {
      type: 'multiple_choice';
      optionIds: string[];
      correctOptionIds: string[];
    })
  | (PrivateExamGradingSpecBaseV1 & {
      type: 'numeric';
      expectedValue: string;
      expectedNumericValue: number;
      tolerance: 0;
    })
  | (PrivateExamGradingSpecBaseV1 & {
      type: 'exact_short_answer';
      acceptedAnswers: string[];
      caseMode: TransferShortAnswerCaseMode;
    })
  | (PrivateExamGradingSpecBaseV1 & {
      type: 'unassessed';
      reason: ExamUnassessedReason;
    });

export interface AuthoritativeExamAnswerKeyArtifactV1 {
  schemaVersion: typeof EXAM_ANSWER_KEY_SCHEMA_VERSION;
  artifactVersion: typeof EXAM_ANSWER_KEY_ARTIFACT_VERSION;
  answerKeyVersion: typeof EXAM_ANSWER_KEY_VERSION;
  gradingAlgorithmVersion: typeof EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION;
  examSessionId: string;
  subjectId: string;
  answerKeyRef: string;
  sourceReview: ExamConfirmedReviewSourceV1;
  authoritySource: typeof EXAM_ANSWER_KEY_AUTHORITY_SOURCE;
  semanticFingerprint: string;
  entryCount: number;
  entries: PrivateExamGradingSpecV1[];
}

interface ExamQuestionAssessmentBaseV1 {
  schemaVersion: typeof EXAM_ASSESSMENT_SCHEMA_VERSION;
  assessmentVersion: typeof EXAM_ASSESSMENT_VERSION;
  assessmentId: string;
  assessmentRef: string;
  examSessionId: string;
  confirmedQuestionId: string;
  responseRef: string;
  sourceReviewRef: string;
  answerKeyRef: string;
  answerKeySemanticFingerprint: string;
  gradingSpecRef: string;
  gradingAlgorithmVersion: typeof EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION;
}

export type ExamQuestionAssessmentV1 =
  | (ExamQuestionAssessmentBaseV1 & {
      status: 'evaluated';
      outcome: 'correct' | 'incorrect';
      gradingType: ExamObjectiveGradingType;
    })
  | (ExamQuestionAssessmentBaseV1 & {
      status: 'unassessed';
      reason: ExamUnassessedReason;
    });

export interface ExamQuestionAssessmentsArtifactV1 {
  schemaVersion: typeof EXAM_ASSESSMENT_SCHEMA_VERSION;
  artifactVersion: typeof EXAM_ASSESSMENT_ARTIFACT_VERSION;
  assessmentVersion: typeof EXAM_ASSESSMENT_VERSION;
  gradingAlgorithmVersion: typeof EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION;
  examSessionId: string;
  assessmentRef: string;
  sourceReview: ExamConfirmedReviewSourceV1;
  answerKeyRef: string;
  answerKeySemanticFingerprint: string;
  answerKeyArtifactSha256: string;
  semanticFingerprint: string;
  assessmentCount: number;
  evaluatedCount: number;
  correctCount: number;
  incorrectCount: number;
  unassessedCount: number;
  assessments: ExamQuestionAssessmentV1[];
}

export type ExamPrivateGradingErrorCode =
  | 'EXAM_ANSWER_KEY_INPUT_INVALID'
  | 'EXAM_ANSWER_KEY_INCOMPLETE'
  | 'EXAM_ANSWER_KEY_SOURCE_INVALID'
  | 'EXAM_ANSWER_KEY_ARTIFACT_CORRUPT'
  | 'EXAM_GRADING_SOURCE_INVALID'
  | 'EXAM_GRADING_FAILED'
  | 'EXAM_ASSESSMENT_ARTIFACT_CORRUPT';

export class ExamPrivateGradingError extends Error {
  override readonly name = 'ExamPrivateGradingError';

  constructor(readonly code: ExamPrivateGradingErrorCode) {
    super(code);
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const REQUEST_KEYS = new Set(['schemaVersion', 'entries']);
const SOURCE_REVIEW_KEYS = new Set([
  'reviewRef',
  'reviewArtifactRef',
  'reviewArtifactSha256',
  'reviewVersion',
  'reviewArtifactVersion',
  'decisionSemanticFingerprint',
]);
const PRIVATE_SPEC_BASE_KEYS = [
  'schemaVersion',
  'answerKeyVersion',
  'gradingAlgorithmVersion',
  'examSessionId',
  'confirmedQuestionId',
  'answerKeyRef',
  'gradingSpecRef',
  'sourceReview',
  'authoritySource',
] as const;
const ANSWER_KEY_ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactVersion',
  'answerKeyVersion',
  'gradingAlgorithmVersion',
  'examSessionId',
  'subjectId',
  'answerKeyRef',
  'sourceReview',
  'authoritySource',
  'semanticFingerprint',
  'entryCount',
  'entries',
]);
const ASSESSMENT_BASE_KEYS = [
  'schemaVersion',
  'assessmentVersion',
  'assessmentId',
  'assessmentRef',
  'examSessionId',
  'confirmedQuestionId',
  'responseRef',
  'sourceReviewRef',
  'answerKeyRef',
  'answerKeySemanticFingerprint',
  'gradingSpecRef',
  'gradingAlgorithmVersion',
] as const;
const ASSESSMENT_ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactVersion',
  'assessmentVersion',
  'gradingAlgorithmVersion',
  'examSessionId',
  'assessmentRef',
  'sourceReview',
  'answerKeyRef',
  'answerKeySemanticFingerprint',
  'answerKeyArtifactSha256',
  'semanticFingerprint',
  'assessmentCount',
  'evaluatedCount',
  'correctCount',
  'incorrectCount',
  'unassessedCount',
  'assessments',
]);

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

function compareId(left: { confirmedQuestionId: string }, right: { confirmedQuestionId: string }) {
  return left.confirmedQuestionId < right.confirmedQuestionId
    ? -1
    : left.confirmedQuestionId > right.confirmedQuestionId
      ? 1
      : 0;
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function validPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 9_999;
}

function normalizeChoiceOptionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().toUpperCase();
  return (EXAM_CHOICE_OPTION_IDS as readonly string[]).includes(normalized) ? normalized : null;
}

function compareChoiceOptionId(left: string, right: string): number {
  const universe = EXAM_CHOICE_OPTION_IDS as readonly string[];
  return universe.indexOf(left) - universe.indexOf(right);
}

function shortAnswerCaseMode(subjectId: string): TransferShortAnswerCaseMode {
  return subjectId === 'english' ? 'ascii_case_insensitive' : 'case_sensitive';
}

function normalizedAcceptedAnswer(
  value: unknown,
  caseMode: TransferShortAnswerCaseMode,
): string | null {
  if (
    typeof value !== 'string' ||
    UNSAFE_CONTROL_CHARACTER.test(value) ||
    UNPAIRED_SURROGATE.test(value)
  ) {
    return null;
  }
  const normalized = normalizeTransferExactAnswer(value, caseMode);
  return normalized.length > 0 &&
    normalized.length <= EXAM_PRIVATE_GRADING_LIMITS.maxAcceptedAnswerLength
    ? normalized
    : null;
}

function normalizedExpectedNumeric(value: unknown): {
  expectedValue: string;
  expectedNumericValue: number;
} | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > EXAM_PRIVATE_GRADING_LIMITS.maxExpectedNumericLength
  ) {
    return null;
  }
  const parsed = canonicalizeTransferDecimal(value);
  if (!parsed) return null;
  if (Number.isInteger(parsed.numericValue) && !Number.isSafeInteger(parsed.numericValue)) {
    return null;
  }
  const roundTrip = canonicalizeTransferDecimal(parsed.numericValue.toString());
  if (!roundTrip || roundTrip.canonicalValue !== parsed.canonicalValue) return null;
  return {
    expectedValue: parsed.canonicalValue,
    expectedNumericValue: parsed.numericValue,
  };
}

function requestEntryKeys(type: unknown): ReadonlySet<string> {
  if (type === 'single_choice') {
    return new Set(['confirmedQuestionId', 'type', 'expectedOptionId']);
  }
  if (type === 'multiple_choice') {
    return new Set(['confirmedQuestionId', 'type', 'expectedOptionIds']);
  }
  if (type === 'numeric') return new Set(['confirmedQuestionId', 'type', 'expectedValue']);
  if (type === 'exact_short_answer') {
    return new Set(['confirmedQuestionId', 'type', 'acceptedAnswers']);
  }
  if (type === 'unassessed') return new Set(['confirmedQuestionId', 'type', 'reason']);
  return new Set(['confirmedQuestionId', 'type']);
}

function parseRequestEntry(
  value: unknown,
  index: number,
  caseMode: TransferShortAnswerCaseMode,
  errors: DomainValidationIssue[],
): ExamAnswerKeyEntryV1 | null {
  const path = `/entries/${index}`;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected answer-key entry object');
    return null;
  }
  rejectUnknownKeys(value, requestEntryKeys(value.type), path, errors);
  const before = errors.length;
  validateIdentifier(value.confirmedQuestionId, `${path}/confirmedQuestionId`, errors);

  if (value.type === 'single_choice') {
    const expectedOptionId = normalizeChoiceOptionId(value.expectedOptionId);
    if (!expectedOptionId) pushIssue(errors, `${path}/expectedOptionId`, 'unknown option id');
    return errors.length === before
      ? {
          confirmedQuestionId: value.confirmedQuestionId as string,
          type: value.type,
          expectedOptionId: expectedOptionId!,
        }
      : null;
  }

  if (value.type === 'multiple_choice') {
    if (
      !Array.isArray(value.expectedOptionIds) ||
      value.expectedOptionIds.length < 1 ||
      value.expectedOptionIds.length >= EXAM_CHOICE_OPTION_IDS.length
    ) {
      pushIssue(errors, `${path}/expectedOptionIds`, 'expected one to five option ids');
      return null;
    }
    const expectedOptionIds: string[] = [];
    for (const [optionIndex, raw] of value.expectedOptionIds.entries()) {
      const normalized = normalizeChoiceOptionId(raw);
      if (!normalized) {
        pushIssue(errors, `${path}/expectedOptionIds/${optionIndex}`, 'unknown option id');
      } else {
        expectedOptionIds.push(normalized);
      }
    }
    if (new Set(expectedOptionIds).size !== expectedOptionIds.length) {
      pushIssue(errors, `${path}/expectedOptionIds`, 'duplicate option id');
    }
    expectedOptionIds.sort(compareChoiceOptionId);
    return errors.length === before
      ? {
          confirmedQuestionId: value.confirmedQuestionId as string,
          type: value.type,
          expectedOptionIds,
        }
      : null;
  }

  if (value.type === 'numeric') {
    const expected = normalizedExpectedNumeric(value.expectedValue);
    if (!expected) pushIssue(errors, `${path}/expectedValue`, 'expected round-trip-safe decimal');
    return errors.length === before
      ? {
          confirmedQuestionId: value.confirmedQuestionId as string,
          type: value.type,
          expectedValue: expected!.expectedValue,
        }
      : null;
  }

  if (value.type === 'exact_short_answer') {
    if (
      !Array.isArray(value.acceptedAnswers) ||
      value.acceptedAnswers.length < 1 ||
      value.acceptedAnswers.length > EXAM_PRIVATE_GRADING_LIMITS.maxAcceptedAnswers
    ) {
      pushIssue(errors, `${path}/acceptedAnswers`, 'expected a bounded non-empty answer set');
      return null;
    }
    const acceptedAnswers: string[] = [];
    for (const [answerIndex, raw] of value.acceptedAnswers.entries()) {
      const normalized = normalizedAcceptedAnswer(raw, caseMode);
      if (!normalized) {
        pushIssue(errors, `${path}/acceptedAnswers/${answerIndex}`, 'invalid accepted answer');
      } else {
        acceptedAnswers.push(normalized);
      }
    }
    if (new Set(acceptedAnswers).size !== acceptedAnswers.length) {
      pushIssue(errors, `${path}/acceptedAnswers`, 'duplicate normalized accepted answer');
    }
    acceptedAnswers.sort();
    return errors.length === before
      ? {
          confirmedQuestionId: value.confirmedQuestionId as string,
          type: value.type,
          acceptedAnswers,
        }
      : null;
  }

  if (value.type === 'unassessed') {
    if (value.reason !== 'unsupported_question_type') {
      pushIssue(errors, `${path}/reason`, 'unknown unassessed reason');
    }
    return errors.length === before
      ? {
          confirmedQuestionId: value.confirmedQuestionId as string,
          type: value.type,
          reason: 'unsupported_question_type',
        }
      : null;
  }

  pushIssue(errors, `${path}/type`, 'unknown answer-key entry type');
  return null;
}

function canonicalRequest(
  value: unknown,
  subjectId: string,
): { request?: ExamAnswerKeyRequestV1; result: DomainValidationResult } {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected answer-key request object');
    return { result: finishValidation(errors) };
  }
  rejectUnknownKeys(value, REQUEST_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_ANSWER_KEY_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', `expected schemaVersion ${EXAM_ANSWER_KEY_SCHEMA_VERSION}`);
  }
  validateIdentifier(subjectId, '/subjectId', errors);
  if (
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > EXAM_PRIVATE_GRADING_LIMITS.maxEntries
  ) {
    pushIssue(errors, '/entries', 'expected a bounded non-empty entry array');
    return { result: finishValidation(errors) };
  }
  const caseMode = shortAnswerCaseMode(subjectId);
  const entries = value.entries
    .map((entry, index) => parseRequestEntry(entry, index, caseMode, errors))
    .filter((entry): entry is ExamAnswerKeyEntryV1 => entry !== null);
  const ids = entries.map((entry) => entry.confirmedQuestionId);
  if (new Set(ids).size !== ids.length)
    pushIssue(errors, '/entries', 'duplicate confirmed question id');
  const result = finishValidation(errors);
  return result.valid
    ? {
        result,
        request: {
          schemaVersion: EXAM_ANSWER_KEY_SCHEMA_VERSION,
          entries: entries.sort(compareId),
        },
      }
    : { result };
}

export function validateExamAnswerKeyRequest(
  value: unknown,
  subjectId: string,
): DomainValidationResult {
  return canonicalRequest(value, subjectId).result;
}

export function parseExamAnswerKeyRequest(
  value: unknown,
  subjectId: string,
): ExamAnswerKeyRequestV1 {
  const parsed = canonicalRequest(value, subjectId);
  if (!parsed.result.valid || !parsed.request) {
    throw new ExamPrivateGradingError('EXAM_ANSWER_KEY_INPUT_INVALID');
  }
  return parsed.request;
}

function cloneSourceReview(source: ExamConfirmedReviewSourceV1): ExamConfirmedReviewSourceV1 {
  return {
    reviewRef: source.reviewRef,
    reviewArtifactRef: source.reviewArtifactRef,
    reviewArtifactSha256: source.reviewArtifactSha256,
    reviewVersion: source.reviewVersion,
    reviewArtifactVersion: source.reviewArtifactVersion,
    decisionSemanticFingerprint: source.decisionSemanticFingerprint,
  };
}

function sourceReviewFromFacts(
  review: ConfirmedExamReviewFactsV1,
  reviewArtifactSha256: string,
): ExamConfirmedReviewSourceV1 {
  return {
    reviewRef: review.reviewRef,
    reviewArtifactRef: review.reviewArtifactRef,
    reviewArtifactSha256,
    reviewVersion: review.reviewVersion,
    reviewArtifactVersion: review.artifactVersion,
    decisionSemanticFingerprint: review.decisionSemanticFingerprint,
  };
}

function validateSourceReview(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamConfirmedReviewSourceV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected confirmed review source object');
    return false;
  }
  rejectUnknownKeys(value, SOURCE_REVIEW_KEYS, path, errors);
  validateIdentifier(value.reviewRef, `${path}/reviewRef`, errors);
  validateIdentifier(value.reviewArtifactRef, `${path}/reviewArtifactRef`, errors);
  if (!validSha256(value.reviewArtifactSha256)) {
    pushIssue(errors, `${path}/reviewArtifactSha256`, 'expected lowercase SHA-256');
  }
  if (!validPositiveVersion(value.reviewVersion)) {
    pushIssue(errors, `${path}/reviewVersion`, 'expected positive version');
  }
  if (!validPositiveVersion(value.reviewArtifactVersion)) {
    pushIssue(errors, `${path}/reviewArtifactVersion`, 'expected positive artifact version');
  }
  if (!validSha256(value.decisionSemanticFingerprint)) {
    pushIssue(errors, `${path}/decisionSemanticFingerprint`, 'expected lowercase SHA-256');
  }
  return errors.length === before;
}

export function deriveExamAnswerKeyRef(input: {
  examSessionId: string;
  sourceReview: ExamConfirmedReviewSourceV1;
}): string {
  return `exam-answer-key:v${EXAM_ANSWER_KEY_VERSION}:${fingerprint(
    'openmaic:zhongkao-exam-answer-key:v1',
    {
      examSessionId: input.examSessionId,
      answerKeyVersion: EXAM_ANSWER_KEY_VERSION,
      reviewVersion: input.sourceReview.reviewVersion,
      reviewArtifactRef: input.sourceReview.reviewArtifactRef,
      sourceReviewArtifactFingerprint: input.sourceReview.reviewArtifactSha256,
    },
  )}`;
}

export function derivePrivateExamGradingSpecRef(
  answerKeyRef: string,
  confirmedQuestionId: string,
): string {
  return `exam-grading-spec:v1:${fingerprint('openmaic:zhongkao-exam-grading-spec:v1', {
    answerKeyRef,
    confirmedQuestionId,
  })}`;
}

function privateSpecFromEntry(
  entry: ExamAnswerKeyEntryV1,
  common: Pick<PrivateExamGradingSpecBaseV1, 'examSessionId' | 'answerKeyRef' | 'sourceReview'>,
  subjectId: string,
): PrivateExamGradingSpecV1 {
  const base: PrivateExamGradingSpecBaseV1 = {
    schemaVersion: EXAM_ANSWER_KEY_SCHEMA_VERSION,
    answerKeyVersion: EXAM_ANSWER_KEY_VERSION,
    gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
    examSessionId: common.examSessionId,
    confirmedQuestionId: entry.confirmedQuestionId,
    answerKeyRef: common.answerKeyRef,
    gradingSpecRef: derivePrivateExamGradingSpecRef(common.answerKeyRef, entry.confirmedQuestionId),
    sourceReview: cloneSourceReview(common.sourceReview),
    authoritySource: EXAM_ANSWER_KEY_AUTHORITY_SOURCE,
  };
  if (entry.type === 'single_choice') {
    return {
      ...base,
      type: entry.type,
      optionIds: [...EXAM_CHOICE_OPTION_IDS],
      correctOptionId: entry.expectedOptionId,
    };
  }
  if (entry.type === 'multiple_choice') {
    return {
      ...base,
      type: entry.type,
      optionIds: [...EXAM_CHOICE_OPTION_IDS],
      correctOptionIds: [...entry.expectedOptionIds],
    };
  }
  if (entry.type === 'numeric') {
    const numeric = normalizedExpectedNumeric(entry.expectedValue)!;
    return {
      ...base,
      type: entry.type,
      expectedValue: numeric.expectedValue,
      expectedNumericValue: numeric.expectedNumericValue,
      tolerance: 0,
    };
  }
  if (entry.type === 'exact_short_answer') {
    return {
      ...base,
      type: entry.type,
      acceptedAnswers: [...entry.acceptedAnswers],
      caseMode: shortAnswerCaseMode(subjectId),
    };
  }
  return { ...base, type: entry.type, reason: entry.reason };
}

function transferSpecFromPrivate(
  spec: PrivateExamGradingSpecV1,
): TransferQuestionGradingSpec | null {
  if (spec.type === 'single_choice') {
    return {
      schemaVersion: 1,
      type: spec.type,
      optionIds: [...spec.optionIds],
      correctOptionId: spec.correctOptionId,
    };
  }
  if (spec.type === 'multiple_choice') {
    return {
      schemaVersion: 1,
      type: spec.type,
      optionIds: [...spec.optionIds],
      correctOptionIds: [...spec.correctOptionIds],
    };
  }
  if (spec.type === 'numeric') {
    return {
      schemaVersion: 1,
      type: spec.type,
      expectedNumericValue: spec.expectedNumericValue,
      tolerance: 0,
    };
  }
  if (spec.type === 'exact_short_answer') {
    return {
      schemaVersion: 1,
      type: spec.type,
      acceptedAnswers: [...spec.acceptedAnswers],
      caseMode: spec.caseMode,
    };
  }
  return null;
}

function privateSpecKeys(type: unknown): ReadonlySet<string> {
  const base = [...PRIVATE_SPEC_BASE_KEYS, 'type'];
  if (type === 'single_choice') return new Set([...base, 'optionIds', 'correctOptionId']);
  if (type === 'multiple_choice') return new Set([...base, 'optionIds', 'correctOptionIds']);
  if (type === 'numeric') {
    return new Set([...base, 'expectedValue', 'expectedNumericValue', 'tolerance']);
  }
  if (type === 'exact_short_answer') return new Set([...base, 'acceptedAnswers', 'caseMode']);
  if (type === 'unassessed') return new Set([...base, 'reason']);
  return new Set(base);
}

function validatePrivateSpecInto(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is PrivateExamGradingSpecV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected private grading spec object');
    return false;
  }
  rejectUnknownKeys(value, privateSpecKeys(value.type), path, errors);
  if (value.schemaVersion !== EXAM_ANSWER_KEY_SCHEMA_VERSION) {
    pushIssue(errors, `${path}/schemaVersion`, 'unexpected grading spec schema version');
  }
  if (value.answerKeyVersion !== EXAM_ANSWER_KEY_VERSION) {
    pushIssue(errors, `${path}/answerKeyVersion`, 'unexpected answer-key version');
  }
  if (value.gradingAlgorithmVersion !== EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION) {
    pushIssue(errors, `${path}/gradingAlgorithmVersion`, 'unexpected grading algorithm version');
  }
  validateIdentifier(value.examSessionId, `${path}/examSessionId`, errors);
  validateIdentifier(value.confirmedQuestionId, `${path}/confirmedQuestionId`, errors);
  validateIdentifier(value.answerKeyRef, `${path}/answerKeyRef`, errors);
  validateIdentifier(value.gradingSpecRef, `${path}/gradingSpecRef`, errors);
  validateSourceReview(value.sourceReview, `${path}/sourceReview`, errors);
  if (value.authoritySource !== EXAM_ANSWER_KEY_AUTHORITY_SOURCE) {
    pushIssue(errors, `${path}/authoritySource`, 'unexpected answer-key authority source');
  }

  if (value.type === 'unassessed') {
    if (value.reason !== 'unsupported_question_type') {
      pushIssue(errors, `${path}/reason`, 'unknown unassessed reason');
    }
  } else if (
    value.type === 'single_choice' ||
    value.type === 'multiple_choice' ||
    value.type === 'numeric' ||
    value.type === 'exact_short_answer'
  ) {
    const spec = value as unknown as PrivateExamGradingSpecV1;
    const transfer = transferSpecFromPrivate(spec);
    if (!transfer || !validateTransferQuestionGradingSpec(transfer)) {
      pushIssue(errors, path, 'invalid objective grading spec');
    }
    if (
      (value.type === 'single_choice' || value.type === 'multiple_choice') &&
      JSON.stringify(value.optionIds) !== JSON.stringify(EXAM_CHOICE_OPTION_IDS)
    ) {
      pushIssue(errors, `${path}/optionIds`, 'expected canonical A-F option universe');
    }
    if (value.type === 'multiple_choice' && Array.isArray(value.correctOptionIds)) {
      const correctOptionIds = value.correctOptionIds;
      if (
        [...correctOptionIds]
          .sort(compareChoiceOptionId)
          .some((optionId, index) => optionId !== correctOptionIds[index])
      ) {
        pushIssue(errors, `${path}/correctOptionIds`, 'correct option ids are not canonical');
      }
    }
    if (value.type === 'numeric') {
      const numeric = normalizedExpectedNumeric(value.expectedValue);
      if (
        !numeric ||
        numeric.expectedValue !== value.expectedValue ||
        numeric.expectedNumericValue !== value.expectedNumericValue ||
        value.tolerance !== 0
      ) {
        pushIssue(errors, path, 'numeric grading spec is not canonical');
      }
    }
    if (value.type === 'exact_short_answer' && Array.isArray(value.acceptedAnswers)) {
      const acceptedAnswers = value.acceptedAnswers;
      const canonical = acceptedAnswers.map((answer) =>
        normalizedAcceptedAnswer(answer, value.caseMode as TransferShortAnswerCaseMode),
      );
      if (
        canonical.some((answer, index) => answer === null || answer !== acceptedAnswers[index]) ||
        new Set(acceptedAnswers).size !== acceptedAnswers.length ||
        [...acceptedAnswers].sort().some((answer, index) => answer !== acceptedAnswers[index])
      ) {
        pushIssue(errors, `${path}/acceptedAnswers`, 'accepted answers are not canonical');
      }
    }
  } else {
    pushIssue(errors, `${path}/type`, 'unknown private grading spec type');
  }

  if (
    typeof value.answerKeyRef === 'string' &&
    typeof value.confirmedQuestionId === 'string' &&
    value.gradingSpecRef !==
      derivePrivateExamGradingSpecRef(value.answerKeyRef, value.confirmedQuestionId)
  ) {
    pushIssue(errors, `${path}/gradingSpecRef`, 'grading spec reference mismatch');
  }
  if (
    typeof value.examSessionId === 'string' &&
    validateSourceReview(value.sourceReview, `${path}/sourceReview`, []) &&
    value.answerKeyRef !==
      deriveExamAnswerKeyRef({
        examSessionId: value.examSessionId,
        sourceReview: value.sourceReview as unknown as ExamConfirmedReviewSourceV1,
      })
  ) {
    pushIssue(errors, `${path}/answerKeyRef`, 'answer-key reference mismatch');
  }
  return errors.length === before;
}

export function validatePrivateExamGradingSpec(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  validatePrivateSpecInto(value, '', errors);
  return finishValidation(errors);
}

function canonicalPrivateSpec(spec: PrivateExamGradingSpecV1): PrivateExamGradingSpecV1 {
  const base: PrivateExamGradingSpecBaseV1 = {
    schemaVersion: EXAM_ANSWER_KEY_SCHEMA_VERSION,
    answerKeyVersion: EXAM_ANSWER_KEY_VERSION,
    gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
    examSessionId: spec.examSessionId,
    confirmedQuestionId: spec.confirmedQuestionId,
    answerKeyRef: spec.answerKeyRef,
    gradingSpecRef: spec.gradingSpecRef,
    sourceReview: cloneSourceReview(spec.sourceReview),
    authoritySource: EXAM_ANSWER_KEY_AUTHORITY_SOURCE,
  };
  if (spec.type === 'single_choice') {
    return {
      ...base,
      type: spec.type,
      optionIds: [...spec.optionIds],
      correctOptionId: spec.correctOptionId,
    };
  }
  if (spec.type === 'multiple_choice') {
    return {
      ...base,
      type: spec.type,
      optionIds: [...spec.optionIds],
      correctOptionIds: [...spec.correctOptionIds],
    };
  }
  if (spec.type === 'numeric') {
    return {
      ...base,
      type: spec.type,
      expectedValue: spec.expectedValue,
      expectedNumericValue: spec.expectedNumericValue,
      tolerance: 0,
    };
  }
  if (spec.type === 'exact_short_answer') {
    return {
      ...base,
      type: spec.type,
      acceptedAnswers: [...spec.acceptedAnswers],
      caseMode: spec.caseMode,
    };
  }
  return { ...base, type: spec.type, reason: spec.reason };
}

function answerKeySemanticFacts(
  artifact: Omit<AuthoritativeExamAnswerKeyArtifactV1, 'semanticFingerprint'>,
): unknown {
  return artifact;
}

export function createExamAnswerKeySemanticFingerprint(
  artifact: Omit<AuthoritativeExamAnswerKeyArtifactV1, 'semanticFingerprint'>,
): string {
  return fingerprint(
    'openmaic:zhongkao-exam-answer-key-semantic:v1',
    answerKeySemanticFacts(artifact),
  );
}

export interface BuildAuthoritativeExamAnswerKeyArtifactInput {
  examSessionId: string;
  subjectId: string;
  confirmedReview: ConfirmedExamReviewFactsV1;
  confirmedReviewArtifactSha256: string;
  request: unknown;
}

export function buildAuthoritativeExamAnswerKeyArtifact(
  input: BuildAuthoritativeExamAnswerKeyArtifactInput,
): AuthoritativeExamAnswerKeyArtifactV1 {
  if (
    !validateConfirmedExamReviewFacts(input.confirmedReview).valid ||
    input.confirmedReview.examSessionId !== input.examSessionId ||
    !validSha256(input.confirmedReviewArtifactSha256) ||
    sha256(serializeConfirmedExamReviewFacts(input.confirmedReview)) !==
      input.confirmedReviewArtifactSha256
  ) {
    throw new ExamPrivateGradingError('EXAM_ANSWER_KEY_SOURCE_INVALID');
  }
  const request = parseExamAnswerKeyRequest(input.request, input.subjectId);
  const expectedIds = input.confirmedReview.confirmedQuestions
    .map((question) => question.confirmedQuestionId)
    .sort();
  const actualIds = request.entries.map((entry) => entry.confirmedQuestionId);
  if (
    expectedIds.length !== actualIds.length ||
    expectedIds.some((confirmedQuestionId, index) => confirmedQuestionId !== actualIds[index])
  ) {
    throw new ExamPrivateGradingError('EXAM_ANSWER_KEY_INCOMPLETE');
  }

  const sourceReview = sourceReviewFromFacts(
    input.confirmedReview,
    input.confirmedReviewArtifactSha256,
  );
  const answerKeyRef = deriveExamAnswerKeyRef({ examSessionId: input.examSessionId, sourceReview });
  const entries = request.entries.map((entry) =>
    privateSpecFromEntry(
      entry,
      { examSessionId: input.examSessionId, answerKeyRef, sourceReview },
      input.subjectId,
    ),
  );
  const withoutFingerprint: Omit<AuthoritativeExamAnswerKeyArtifactV1, 'semanticFingerprint'> = {
    schemaVersion: EXAM_ANSWER_KEY_SCHEMA_VERSION,
    artifactVersion: EXAM_ANSWER_KEY_ARTIFACT_VERSION,
    answerKeyVersion: EXAM_ANSWER_KEY_VERSION,
    gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
    examSessionId: input.examSessionId,
    subjectId: input.subjectId,
    answerKeyRef,
    sourceReview,
    authoritySource: EXAM_ANSWER_KEY_AUTHORITY_SOURCE,
    entryCount: entries.length,
    entries,
  };
  const artifact: AuthoritativeExamAnswerKeyArtifactV1 = {
    ...withoutFingerprint,
    semanticFingerprint: createExamAnswerKeySemanticFingerprint(withoutFingerprint),
  };
  if (!validateAuthoritativeExamAnswerKeyArtifact(artifact).valid) {
    throw new ExamPrivateGradingError('EXAM_ANSWER_KEY_ARTIFACT_CORRUPT');
  }
  return artifact;
}

export function validateAuthoritativeExamAnswerKeyArtifact(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected authoritative answer-key artifact object');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, ANSWER_KEY_ARTIFACT_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_ANSWER_KEY_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'unexpected answer-key schema version');
  }
  if (value.artifactVersion !== EXAM_ANSWER_KEY_ARTIFACT_VERSION) {
    pushIssue(errors, '/artifactVersion', 'unexpected answer-key artifact version');
  }
  if (value.answerKeyVersion !== EXAM_ANSWER_KEY_VERSION) {
    pushIssue(errors, '/answerKeyVersion', 'unexpected answer-key version');
  }
  if (value.gradingAlgorithmVersion !== EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION) {
    pushIssue(errors, '/gradingAlgorithmVersion', 'unexpected grading algorithm version');
  }
  validateIdentifier(value.examSessionId, '/examSessionId', errors);
  validateIdentifier(value.subjectId, '/subjectId', errors);
  validateIdentifier(value.answerKeyRef, '/answerKeyRef', errors);
  const sourceValid = validateSourceReview(value.sourceReview, '/sourceReview', errors);
  if (value.authoritySource !== EXAM_ANSWER_KEY_AUTHORITY_SOURCE) {
    pushIssue(errors, '/authoritySource', 'unexpected answer-key authority source');
  }
  if (!validSha256(value.semanticFingerprint)) {
    pushIssue(errors, '/semanticFingerprint', 'expected lowercase SHA-256');
  }
  if (!Array.isArray(value.entries)) {
    pushIssue(errors, '/entries', 'expected grading-spec array');
    return finishValidation(errors);
  }
  if (
    value.entries.length < 1 ||
    value.entries.length > EXAM_PRIVATE_GRADING_LIMITS.maxEntries ||
    value.entryCount !== value.entries.length
  ) {
    pushIssue(errors, '/entryCount', 'entry count mismatch or out of range');
  }
  value.entries.forEach((entry, index) =>
    validatePrivateSpecInto(entry, `/entries/${index}`, errors),
  );
  const ids = value.entries
    .filter(isPlainRecord)
    .map((entry) => entry.confirmedQuestionId)
    .filter((id): id is string => typeof id === 'string');
  if (new Set(ids).size !== ids.length) pushIssue(errors, '/entries', 'duplicate grading spec');
  if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    pushIssue(errors, '/entries', 'grading specs must be sorted by confirmed question id');
  }
  if (sourceValid && typeof value.examSessionId === 'string') {
    const expectedRef = deriveExamAnswerKeyRef({
      examSessionId: value.examSessionId,
      sourceReview: value.sourceReview as unknown as ExamConfirmedReviewSourceV1,
    });
    if (value.answerKeyRef !== expectedRef)
      pushIssue(errors, '/answerKeyRef', 'answer-key ref mismatch');
    for (const [index, entry] of value.entries.entries()) {
      if (!isPlainRecord(entry)) continue;
      if (entry.examSessionId !== value.examSessionId) {
        pushIssue(errors, `/entries/${index}/examSessionId`, 'grading spec Exam mismatch');
      }
      if (entry.answerKeyRef !== value.answerKeyRef) {
        pushIssue(errors, `/entries/${index}/answerKeyRef`, 'grading spec answer-key mismatch');
      }
      if (JSON.stringify(entry.sourceReview) !== JSON.stringify(value.sourceReview)) {
        pushIssue(errors, `/entries/${index}/sourceReview`, 'grading spec source mismatch');
      }
      if (
        entry.type === 'exact_short_answer' &&
        typeof value.subjectId === 'string' &&
        entry.caseMode !== shortAnswerCaseMode(value.subjectId)
      ) {
        pushIssue(errors, `/entries/${index}/caseMode`, 'short-answer case mode mismatch');
      }
    }
  }
  if (errors.length === 0) {
    const artifact = value as unknown as AuthoritativeExamAnswerKeyArtifactV1;
    const { semanticFingerprint: _ignored, ...withoutFingerprint } = artifact;
    if (
      createExamAnswerKeySemanticFingerprint(withoutFingerprint) !== artifact.semanticFingerprint
    ) {
      pushIssue(errors, '/semanticFingerprint', 'answer-key semantic fingerprint mismatch');
    }
  }
  return finishValidation(errors);
}

function canonicalAnswerKeyArtifact(
  artifact: AuthoritativeExamAnswerKeyArtifactV1,
): AuthoritativeExamAnswerKeyArtifactV1 {
  return {
    schemaVersion: EXAM_ANSWER_KEY_SCHEMA_VERSION,
    artifactVersion: EXAM_ANSWER_KEY_ARTIFACT_VERSION,
    answerKeyVersion: EXAM_ANSWER_KEY_VERSION,
    gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
    examSessionId: artifact.examSessionId,
    subjectId: artifact.subjectId,
    answerKeyRef: artifact.answerKeyRef,
    sourceReview: cloneSourceReview(artifact.sourceReview),
    authoritySource: EXAM_ANSWER_KEY_AUTHORITY_SOURCE,
    semanticFingerprint: artifact.semanticFingerprint,
    entryCount: artifact.entryCount,
    entries: artifact.entries.map(canonicalPrivateSpec),
  };
}

function decodeArtifact(
  value: unknown,
  maxBytes: number,
  code: ExamPrivateGradingErrorCode,
): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new ExamPrivateGradingError(code);
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new ExamPrivateGradingError(code);
    }
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > maxBytes) throw new ExamPrivateGradingError(code);
    try {
      return JSON.parse(UTF8_DECODER.decode(value)) as unknown;
    } catch {
      throw new ExamPrivateGradingError(code);
    }
  }
  return value;
}

export function parseAuthoritativeExamAnswerKeyArtifact(
  value: unknown,
): AuthoritativeExamAnswerKeyArtifactV1 {
  const decoded = decodeArtifact(
    value,
    EXAM_PRIVATE_GRADING_LIMITS.maxAnswerKeyArtifactBytes,
    'EXAM_ANSWER_KEY_ARTIFACT_CORRUPT',
  );
  if (!validateAuthoritativeExamAnswerKeyArtifact(decoded).valid) {
    throw new ExamPrivateGradingError('EXAM_ANSWER_KEY_ARTIFACT_CORRUPT');
  }
  return canonicalAnswerKeyArtifact(decoded as AuthoritativeExamAnswerKeyArtifactV1);
}

export function serializeAuthoritativeExamAnswerKeyArtifact(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(parseAuthoritativeExamAnswerKeyArtifact(value)), 'utf8');
  if (bytes.byteLength > EXAM_PRIVATE_GRADING_LIMITS.maxAnswerKeyArtifactBytes) {
    throw new ExamPrivateGradingError('EXAM_ANSWER_KEY_ARTIFACT_CORRUPT');
  }
  return bytes;
}

export function deriveExamAssessmentRef(input: {
  examSessionId: string;
  sourceReviewSemanticFingerprint: string;
  answerKeySemanticFingerprint: string;
}): string {
  return `exam-assessments:v${EXAM_ASSESSMENT_VERSION}:${fingerprint(
    'openmaic:zhongkao-exam-assessments:v1',
    {
      examSessionId: input.examSessionId,
      sourceReviewSemanticFingerprint: input.sourceReviewSemanticFingerprint,
      answerKeySemanticFingerprint: input.answerKeySemanticFingerprint,
      gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
      assessmentVersion: EXAM_ASSESSMENT_VERSION,
    },
  )}`;
}

export function deriveExamQuestionAssessmentId(input: {
  assessmentRef: string;
  confirmedQuestionId: string;
  responseRef: string;
}): string {
  return `exam-question-assessment:v1:${fingerprint(
    'openmaic:zhongkao-exam-question-assessment:v1',
    input,
  )}`;
}

function compactMultipleChoiceAnswer(rawAnswer: string): string {
  const normalized = rawAnswer.normalize('NFKC').trim();
  return /^[A-Fa-f]{1,6}$/u.test(normalized) ? [...normalized].join(',') : rawAnswer;
}

export interface EvaluateExamQuestionResponseInput {
  gradingSpec: PrivateExamGradingSpecV1;
  response: ConfirmedStudentResponseV1;
  answerKeySemanticFingerprint: string;
}

export function evaluateExamQuestionResponse(
  input: EvaluateExamQuestionResponseInput,
): ExamQuestionAssessmentV1 {
  if (
    !validatePrivateExamGradingSpec(input.gradingSpec).valid ||
    !validSha256(input.answerKeySemanticFingerprint) ||
    input.response.confirmedQuestionId !== input.gradingSpec.confirmedQuestionId ||
    typeof input.response.confirmedResponseId !== 'string'
  ) {
    throw new ExamPrivateGradingError('EXAM_GRADING_SOURCE_INVALID');
  }
  const assessmentRef = deriveExamAssessmentRef({
    examSessionId: input.gradingSpec.examSessionId,
    sourceReviewSemanticFingerprint: input.gradingSpec.sourceReview.decisionSemanticFingerprint,
    answerKeySemanticFingerprint: input.answerKeySemanticFingerprint,
  });
  const base: ExamQuestionAssessmentBaseV1 = {
    schemaVersion: EXAM_ASSESSMENT_SCHEMA_VERSION,
    assessmentVersion: EXAM_ASSESSMENT_VERSION,
    assessmentId: deriveExamQuestionAssessmentId({
      assessmentRef,
      confirmedQuestionId: input.gradingSpec.confirmedQuestionId,
      responseRef: input.response.confirmedResponseId,
    }),
    assessmentRef,
    examSessionId: input.gradingSpec.examSessionId,
    confirmedQuestionId: input.gradingSpec.confirmedQuestionId,
    responseRef: input.response.confirmedResponseId,
    sourceReviewRef: input.gradingSpec.sourceReview.reviewRef,
    answerKeyRef: input.gradingSpec.answerKeyRef,
    answerKeySemanticFingerprint: input.answerKeySemanticFingerprint,
    gradingSpecRef: input.gradingSpec.gradingSpecRef,
    gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
  };
  if (input.gradingSpec.type === 'unassessed') {
    return { ...base, status: 'unassessed', reason: input.gradingSpec.reason };
  }
  if (
    input.response.answerStatus !== 'text' &&
    input.response.answerStatus !== 'blank' &&
    input.response.answerStatus !== 'no_response'
  ) {
    throw new ExamPrivateGradingError('EXAM_GRADING_SOURCE_INVALID');
  }
  if (input.response.answerStatus !== 'text') {
    return {
      ...base,
      status: 'evaluated',
      outcome: 'incorrect',
      gradingType: input.gradingSpec.type,
    };
  }
  if (typeof input.response.rawAnswerText !== 'string') {
    throw new ExamPrivateGradingError('EXAM_GRADING_SOURCE_INVALID');
  }
  const transferSpec = transferSpecFromPrivate(input.gradingSpec);
  if (!transferSpec) throw new ExamPrivateGradingError('EXAM_GRADING_FAILED');
  const rawAnswer =
    input.gradingSpec.type === 'multiple_choice'
      ? compactMultipleChoiceAnswer(input.response.rawAnswerText)
      : input.response.rawAnswerText;
  try {
    const evaluation = evaluateTransferAnswer(transferSpec, rawAnswer);
    return {
      ...base,
      status: 'evaluated',
      outcome: evaluation.outcome,
      gradingType: input.gradingSpec.type,
    };
  } catch {
    throw new ExamPrivateGradingError('EXAM_GRADING_FAILED');
  }
}

function assessmentKeys(status: unknown): ReadonlySet<string> {
  if (status === 'evaluated') {
    return new Set([...ASSESSMENT_BASE_KEYS, 'status', 'outcome', 'gradingType']);
  }
  if (status === 'unassessed') {
    return new Set([...ASSESSMENT_BASE_KEYS, 'status', 'reason']);
  }
  return new Set([...ASSESSMENT_BASE_KEYS, 'status']);
}

function validateAssessmentInto(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamQuestionAssessmentV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected question assessment object');
    return false;
  }
  rejectUnknownKeys(value, assessmentKeys(value.status), path, errors);
  if (value.schemaVersion !== EXAM_ASSESSMENT_SCHEMA_VERSION) {
    pushIssue(errors, `${path}/schemaVersion`, 'unexpected assessment schema version');
  }
  if (value.assessmentVersion !== EXAM_ASSESSMENT_VERSION) {
    pushIssue(errors, `${path}/assessmentVersion`, 'unexpected assessment version');
  }
  for (const field of [
    'assessmentId',
    'assessmentRef',
    'examSessionId',
    'confirmedQuestionId',
    'responseRef',
    'sourceReviewRef',
    'answerKeyRef',
    'gradingSpecRef',
  ] as const) {
    validateIdentifier(value[field], `${path}/${field}`, errors);
  }
  if (!validSha256(value.answerKeySemanticFingerprint)) {
    pushIssue(errors, `${path}/answerKeySemanticFingerprint`, 'expected lowercase SHA-256');
  }
  if (value.gradingAlgorithmVersion !== EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION) {
    pushIssue(errors, `${path}/gradingAlgorithmVersion`, 'unexpected grading algorithm version');
  }
  if (value.status === 'evaluated') {
    if (value.outcome !== 'correct' && value.outcome !== 'incorrect') {
      pushIssue(errors, `${path}/outcome`, 'unknown evaluated outcome');
    }
    if (
      value.gradingType !== 'single_choice' &&
      value.gradingType !== 'multiple_choice' &&
      value.gradingType !== 'numeric' &&
      value.gradingType !== 'exact_short_answer'
    ) {
      pushIssue(errors, `${path}/gradingType`, 'unknown objective grading type');
    }
  } else if (value.status === 'unassessed') {
    if (value.reason !== 'unsupported_question_type') {
      pushIssue(errors, `${path}/reason`, 'unknown unassessed reason');
    }
  } else {
    pushIssue(errors, `${path}/status`, 'unknown assessment status');
  }
  if (
    typeof value.assessmentRef === 'string' &&
    typeof value.confirmedQuestionId === 'string' &&
    typeof value.responseRef === 'string' &&
    value.assessmentId !==
      deriveExamQuestionAssessmentId({
        assessmentRef: value.assessmentRef,
        confirmedQuestionId: value.confirmedQuestionId,
        responseRef: value.responseRef,
      })
  ) {
    pushIssue(errors, `${path}/assessmentId`, 'assessment id mismatch');
  }
  return errors.length === before;
}

export function validateExamQuestionAssessment(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  validateAssessmentInto(value, '', errors);
  return finishValidation(errors);
}

function canonicalAssessment(assessment: ExamQuestionAssessmentV1): ExamQuestionAssessmentV1 {
  const base: ExamQuestionAssessmentBaseV1 = {
    schemaVersion: EXAM_ASSESSMENT_SCHEMA_VERSION,
    assessmentVersion: EXAM_ASSESSMENT_VERSION,
    assessmentId: assessment.assessmentId,
    assessmentRef: assessment.assessmentRef,
    examSessionId: assessment.examSessionId,
    confirmedQuestionId: assessment.confirmedQuestionId,
    responseRef: assessment.responseRef,
    sourceReviewRef: assessment.sourceReviewRef,
    answerKeyRef: assessment.answerKeyRef,
    answerKeySemanticFingerprint: assessment.answerKeySemanticFingerprint,
    gradingSpecRef: assessment.gradingSpecRef,
    gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
  };
  return assessment.status === 'evaluated'
    ? {
        ...base,
        status: assessment.status,
        outcome: assessment.outcome,
        gradingType: assessment.gradingType,
      }
    : { ...base, status: assessment.status, reason: assessment.reason };
}

function assessmentSemanticFacts(
  artifact: Omit<ExamQuestionAssessmentsArtifactV1, 'semanticFingerprint'>,
): unknown {
  return artifact;
}

export function createExamAssessmentsSemanticFingerprint(
  artifact: Omit<ExamQuestionAssessmentsArtifactV1, 'semanticFingerprint'>,
): string {
  return fingerprint(
    'openmaic:zhongkao-exam-assessments-semantic:v1',
    assessmentSemanticFacts(artifact),
  );
}

export interface BuildExamQuestionAssessmentsArtifactInput {
  confirmedReview: ConfirmedExamReviewFactsV1;
  answerKey: AuthoritativeExamAnswerKeyArtifactV1;
}

export function buildExamQuestionAssessmentsArtifact(
  input: BuildExamQuestionAssessmentsArtifactInput,
): ExamQuestionAssessmentsArtifactV1 {
  if (
    !validateConfirmedExamReviewFacts(input.confirmedReview).valid ||
    !validateAuthoritativeExamAnswerKeyArtifact(input.answerKey).valid ||
    input.confirmedReview.examSessionId !== input.answerKey.examSessionId
  ) {
    throw new ExamPrivateGradingError('EXAM_GRADING_SOURCE_INVALID');
  }
  const reviewBytes = serializeConfirmedExamReviewFacts(input.confirmedReview);
  const expectedReviewSource = sourceReviewFromFacts(input.confirmedReview, sha256(reviewBytes));
  if (JSON.stringify(expectedReviewSource) !== JSON.stringify(input.answerKey.sourceReview)) {
    throw new ExamPrivateGradingError('EXAM_GRADING_SOURCE_INVALID');
  }
  const specsByQuestionId = new Map(
    input.answerKey.entries.map((entry) => [entry.confirmedQuestionId, entry]),
  );
  const responsesByQuestionId = new Map(
    input.confirmedReview.confirmedResponses.map((response) => [
      response.confirmedQuestionId,
      response,
    ]),
  );
  const assessmentRef = deriveExamAssessmentRef({
    examSessionId: input.answerKey.examSessionId,
    sourceReviewSemanticFingerprint: input.answerKey.sourceReview.decisionSemanticFingerprint,
    answerKeySemanticFingerprint: input.answerKey.semanticFingerprint,
  });
  const assessments = input.confirmedReview.confirmedQuestions
    .map((question) => {
      const gradingSpec = specsByQuestionId.get(question.confirmedQuestionId);
      const response = responsesByQuestionId.get(question.confirmedQuestionId);
      if (!gradingSpec || !response) {
        throw new ExamPrivateGradingError('EXAM_GRADING_SOURCE_INVALID');
      }
      const assessment = evaluateExamQuestionResponse({
        gradingSpec,
        response,
        answerKeySemanticFingerprint: input.answerKey.semanticFingerprint,
      });
      if (assessment.assessmentRef !== assessmentRef) {
        throw new ExamPrivateGradingError('EXAM_GRADING_SOURCE_INVALID');
      }
      return assessment;
    })
    .sort(compareId);
  const evaluated = assessments.filter(
    (assessment): assessment is Extract<ExamQuestionAssessmentV1, { status: 'evaluated' }> =>
      assessment.status === 'evaluated',
  );
  const answerKeyArtifactSha256 = sha256(
    serializeAuthoritativeExamAnswerKeyArtifact(input.answerKey),
  );
  const withoutFingerprint: Omit<ExamQuestionAssessmentsArtifactV1, 'semanticFingerprint'> = {
    schemaVersion: EXAM_ASSESSMENT_SCHEMA_VERSION,
    artifactVersion: EXAM_ASSESSMENT_ARTIFACT_VERSION,
    assessmentVersion: EXAM_ASSESSMENT_VERSION,
    gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
    examSessionId: input.answerKey.examSessionId,
    assessmentRef,
    sourceReview: cloneSourceReview(input.answerKey.sourceReview),
    answerKeyRef: input.answerKey.answerKeyRef,
    answerKeySemanticFingerprint: input.answerKey.semanticFingerprint,
    answerKeyArtifactSha256,
    assessmentCount: assessments.length,
    evaluatedCount: evaluated.length,
    correctCount: evaluated.filter((assessment) => assessment.outcome === 'correct').length,
    incorrectCount: evaluated.filter((assessment) => assessment.outcome === 'incorrect').length,
    unassessedCount: assessments.length - evaluated.length,
    assessments,
  };
  const artifact: ExamQuestionAssessmentsArtifactV1 = {
    ...withoutFingerprint,
    semanticFingerprint: createExamAssessmentsSemanticFingerprint(withoutFingerprint),
  };
  if (!validateExamQuestionAssessmentsArtifact(artifact).valid) {
    throw new ExamPrivateGradingError('EXAM_ASSESSMENT_ARTIFACT_CORRUPT');
  }
  return artifact;
}

export function validateExamQuestionAssessmentsArtifact(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected assessment artifact object');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, ASSESSMENT_ARTIFACT_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_ASSESSMENT_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'unexpected assessment schema version');
  }
  if (value.artifactVersion !== EXAM_ASSESSMENT_ARTIFACT_VERSION) {
    pushIssue(errors, '/artifactVersion', 'unexpected assessment artifact version');
  }
  if (value.assessmentVersion !== EXAM_ASSESSMENT_VERSION) {
    pushIssue(errors, '/assessmentVersion', 'unexpected assessment version');
  }
  if (value.gradingAlgorithmVersion !== EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION) {
    pushIssue(errors, '/gradingAlgorithmVersion', 'unexpected grading algorithm version');
  }
  validateIdentifier(value.examSessionId, '/examSessionId', errors);
  validateIdentifier(value.assessmentRef, '/assessmentRef', errors);
  validateIdentifier(value.answerKeyRef, '/answerKeyRef', errors);
  const sourceValid = validateSourceReview(value.sourceReview, '/sourceReview', errors);
  for (const field of [
    'answerKeySemanticFingerprint',
    'answerKeyArtifactSha256',
    'semanticFingerprint',
  ] as const) {
    if (!validSha256(value[field])) pushIssue(errors, `/${field}`, 'expected lowercase SHA-256');
  }
  if (!Array.isArray(value.assessments)) {
    pushIssue(errors, '/assessments', 'expected assessment array');
    return finishValidation(errors);
  }
  if (
    value.assessments.length < 1 ||
    value.assessments.length > EXAM_PRIVATE_GRADING_LIMITS.maxEntries ||
    value.assessmentCount !== value.assessments.length
  ) {
    pushIssue(errors, '/assessmentCount', 'assessment count mismatch or out of range');
  }
  value.assessments.forEach((assessment, index) =>
    validateAssessmentInto(assessment, `/assessments/${index}`, errors),
  );
  const typed = value.assessments.filter(isPlainRecord);
  const ids = typed
    .map((assessment) => assessment.confirmedQuestionId)
    .filter((id): id is string => typeof id === 'string');
  if (new Set(ids).size !== ids.length) pushIssue(errors, '/assessments', 'duplicate assessment');
  if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    pushIssue(errors, '/assessments', 'assessments must be sorted by confirmed question id');
  }
  const evaluated = typed.filter((assessment) => assessment.status === 'evaluated');
  const correct = evaluated.filter((assessment) => assessment.outcome === 'correct');
  const incorrect = evaluated.filter((assessment) => assessment.outcome === 'incorrect');
  const unassessed = typed.filter((assessment) => assessment.status === 'unassessed');
  if (
    value.evaluatedCount !== evaluated.length ||
    value.correctCount !== correct.length ||
    value.incorrectCount !== incorrect.length ||
    value.unassessedCount !== unassessed.length ||
    evaluated.length + unassessed.length !== typed.length
  ) {
    pushIssue(errors, '', 'assessment summary counts mismatch');
  }
  if (
    sourceValid &&
    typeof value.examSessionId === 'string' &&
    validSha256(value.answerKeySemanticFingerprint)
  ) {
    const sourceReview = value.sourceReview as unknown as ExamConfirmedReviewSourceV1;
    const expectedAnswerKeyRef = deriveExamAnswerKeyRef({
      examSessionId: value.examSessionId,
      sourceReview,
    });
    if (value.answerKeyRef !== expectedAnswerKeyRef) {
      pushIssue(errors, '/answerKeyRef', 'assessment answer-key reference mismatch');
    }
    const expectedRef = deriveExamAssessmentRef({
      examSessionId: value.examSessionId,
      sourceReviewSemanticFingerprint: sourceReview.decisionSemanticFingerprint,
      answerKeySemanticFingerprint: value.answerKeySemanticFingerprint,
    });
    if (value.assessmentRef !== expectedRef) {
      pushIssue(errors, '/assessmentRef', 'assessment artifact reference mismatch');
    }
    for (const [index, assessment] of typed.entries()) {
      if (
        assessment.assessmentRef !== value.assessmentRef ||
        assessment.examSessionId !== value.examSessionId ||
        assessment.sourceReviewRef !== sourceReview.reviewRef ||
        assessment.answerKeyRef !== value.answerKeyRef ||
        assessment.answerKeySemanticFingerprint !== value.answerKeySemanticFingerprint ||
        (typeof assessment.confirmedQuestionId === 'string' &&
          assessment.gradingSpecRef !==
            derivePrivateExamGradingSpecRef(
              value.answerKeyRef as string,
              assessment.confirmedQuestionId,
            ))
      ) {
        pushIssue(errors, `/assessments/${index}`, 'assessment source binding mismatch');
      }
    }
  }
  if (errors.length === 0) {
    const artifact = value as unknown as ExamQuestionAssessmentsArtifactV1;
    const { semanticFingerprint: _ignored, ...withoutFingerprint } = artifact;
    if (
      createExamAssessmentsSemanticFingerprint(withoutFingerprint) !== artifact.semanticFingerprint
    ) {
      pushIssue(errors, '/semanticFingerprint', 'assessment semantic fingerprint mismatch');
    }
  }
  return finishValidation(errors);
}

function canonicalAssessmentsArtifact(
  artifact: ExamQuestionAssessmentsArtifactV1,
): ExamQuestionAssessmentsArtifactV1 {
  return {
    schemaVersion: EXAM_ASSESSMENT_SCHEMA_VERSION,
    artifactVersion: EXAM_ASSESSMENT_ARTIFACT_VERSION,
    assessmentVersion: EXAM_ASSESSMENT_VERSION,
    gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
    examSessionId: artifact.examSessionId,
    assessmentRef: artifact.assessmentRef,
    sourceReview: cloneSourceReview(artifact.sourceReview),
    answerKeyRef: artifact.answerKeyRef,
    answerKeySemanticFingerprint: artifact.answerKeySemanticFingerprint,
    answerKeyArtifactSha256: artifact.answerKeyArtifactSha256,
    semanticFingerprint: artifact.semanticFingerprint,
    assessmentCount: artifact.assessmentCount,
    evaluatedCount: artifact.evaluatedCount,
    correctCount: artifact.correctCount,
    incorrectCount: artifact.incorrectCount,
    unassessedCount: artifact.unassessedCount,
    assessments: artifact.assessments.map(canonicalAssessment),
  };
}

export function parseExamQuestionAssessmentsArtifact(
  value: unknown,
): ExamQuestionAssessmentsArtifactV1 {
  const decoded = decodeArtifact(
    value,
    EXAM_PRIVATE_GRADING_LIMITS.maxAssessmentArtifactBytes,
    'EXAM_ASSESSMENT_ARTIFACT_CORRUPT',
  );
  if (!validateExamQuestionAssessmentsArtifact(decoded).valid) {
    throw new ExamPrivateGradingError('EXAM_ASSESSMENT_ARTIFACT_CORRUPT');
  }
  return canonicalAssessmentsArtifact(decoded as ExamQuestionAssessmentsArtifactV1);
}

export function serializeExamQuestionAssessmentsArtifact(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(parseExamQuestionAssessmentsArtifact(value)), 'utf8');
  if (bytes.byteLength > EXAM_PRIVATE_GRADING_LIMITS.maxAssessmentArtifactBytes) {
    throw new ExamPrivateGradingError('EXAM_ASSESSMENT_ARTIFACT_CORRUPT');
  }
  return bytes;
}
