import { createHash } from 'node:crypto';

import { EXAM_DERIVATIVE_VERSION_MAX, EXAM_MAX_QUESTION_CANDIDATES } from '@/lib/zhongkao/exam';
import {
  serializeConfirmedExamReviewFacts,
  validateConfirmedExamReviewFacts,
  type ConfirmedExamReviewFactsV1,
} from '@/lib/zhongkao/exam-human-review';
import {
  deriveConfirmedExamObservationId,
  deriveExamObservationOccasionId,
  serializeConfirmedExamObservation,
  validateConfirmedExamObservation,
  type ConfirmedExamObservationV1,
} from '@/lib/zhongkao/exam-observation';
import {
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  validateIsoDateTime,
  type DomainValidationIssue,
  type DomainValidationResult,
} from '@/lib/zhongkao/validation';

import {
  deriveExamAnswerKeyRef,
  deriveExamAssessmentRef,
  serializeExamQuestionAssessmentsArtifact,
  validateExamQuestionAssessmentsArtifact,
  type ExamConfirmedReviewSourceV1,
  type ExamQuestionAssessmentV1,
  type ExamQuestionAssessmentsArtifactV1,
} from './exam-grading-private';

export const EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION = 1 as const;
export const EXAM_KNOWLEDGE_MAPPING_ARTIFACT_VERSION = 1 as const;
export const EXAM_KNOWLEDGE_MAPPING_VERSION = 1 as const;
export const EXAM_OBSERVATIONS_ARTIFACT_VERSION = 1 as const;
export const EXAM_OBSERVATION_PROJECTION_VERSION = 1 as const;
export const EXAM_KNOWLEDGE_MAPPING_AUTHORITY_SOURCE = 'owner_confirmed_manual_mapping' as const;
export const EXAM_KNOWLEDGE_UNMAPPED_REASONS = [
  'unknown',
  'not_applicable',
  'unsupported',
] as const;

export const EXAM_PRIVATE_KNOWLEDGE_MAPPING_LIMITS = Object.freeze({
  maxEntries: EXAM_MAX_QUESTION_CANDIDATES,
  maxKnowledgePointIdsPerQuestion: 32,
  maxMappingArtifactBytes: 4 * 1024 * 1024,
  maxObservationsArtifactBytes: 4 * 1024 * 1024,
});

export type ExamKnowledgeUnmappedReason = (typeof EXAM_KNOWLEDGE_UNMAPPED_REASONS)[number];

export type ExamKnowledgeMappingEntryV1 =
  | {
      confirmedQuestionId: string;
      decision: 'mapped';
      knowledgePointIds: string[];
    }
  | {
      confirmedQuestionId: string;
      decision: 'unmapped';
      reason: ExamKnowledgeUnmappedReason;
    };

export interface ExamKnowledgeMappingRequestV1 {
  schemaVersion: typeof EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION;
  entries: ExamKnowledgeMappingEntryV1[];
}

export interface ExamAssessmentSourceV1 {
  assessmentRef: string;
  assessmentArtifactSha256: string;
  assessmentVersion: number;
  assessmentArtifactVersion: number;
  gradingAlgorithmVersion: string;
  semanticFingerprint: string;
  answerKeyRef: string;
  answerKeySemanticFingerprint: string;
}

export interface ConfirmedExamKnowledgeMappingArtifactV1 {
  schemaVersion: typeof EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION;
  artifactVersion: typeof EXAM_KNOWLEDGE_MAPPING_ARTIFACT_VERSION;
  mappingVersion: typeof EXAM_KNOWLEDGE_MAPPING_VERSION;
  examSessionId: string;
  profileId: string;
  subjectId: string;
  mappingRef: string;
  sourceReview: ExamConfirmedReviewSourceV1;
  sourceAssessments: ExamAssessmentSourceV1;
  authoritySource: typeof EXAM_KNOWLEDGE_MAPPING_AUTHORITY_SOURCE;
  semanticFingerprint: string;
  entryCount: number;
  mappedQuestionCount: number;
  unmappedQuestionCount: number;
  entries: ExamKnowledgeMappingEntryV1[];
}

export interface ExamKnowledgeMappingSourceV1 {
  mappingRef: string;
  mappingArtifactSha256: string;
  mappingVersion: number;
  mappingArtifactVersion: number;
  semanticFingerprint: string;
  authoritySource: typeof EXAM_KNOWLEDGE_MAPPING_AUTHORITY_SOURCE;
}

export interface ConfirmedExamObservationsArtifactV1 {
  schemaVersion: typeof EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION;
  artifactVersion: typeof EXAM_OBSERVATIONS_ARTIFACT_VERSION;
  observationVersion: typeof EXAM_OBSERVATION_PROJECTION_VERSION;
  examSessionId: string;
  profileId: string;
  subjectId: string;
  observedAt: string;
  observationRef: string;
  sourceReview: ExamConfirmedReviewSourceV1;
  sourceAssessments: ExamAssessmentSourceV1;
  sourceMapping: ExamKnowledgeMappingSourceV1;
  semanticFingerprint: string;
  observationCount: number;
  evaluatedCount: number;
  correctCount: number;
  incorrectCount: number;
  unassessedCount: number;
  observations: ConfirmedExamObservationV1[];
}

export type ConfirmedExamObservationArtifactV1 = ConfirmedExamObservationsArtifactV1;

export type ExamKnowledgeMappingPrivateErrorCode =
  | 'EXAM_KNOWLEDGE_MAPPING_INPUT_INVALID'
  | 'EXAM_KNOWLEDGE_MAPPING_INCOMPLETE'
  | 'EXAM_KNOWLEDGE_MAPPING_SOURCE_INVALID'
  | 'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT'
  | 'EXAM_OBSERVATION_SOURCE_INVALID'
  | 'EXAM_OBSERVATION_ARTIFACT_CORRUPT';

export class ExamKnowledgeMappingPrivateError extends Error {
  override readonly name = 'ExamKnowledgeMappingPrivateError';

  constructor(readonly code: ExamKnowledgeMappingPrivateErrorCode) {
    super(code);
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const REQUEST_KEYS = new Set(['schemaVersion', 'entries']);
const MAPPED_ENTRY_KEYS = new Set(['confirmedQuestionId', 'decision', 'knowledgePointIds']);
const UNMAPPED_ENTRY_KEYS = new Set(['confirmedQuestionId', 'decision', 'reason']);
const UNKNOWN_ENTRY_KEYS = new Set(['confirmedQuestionId', 'decision']);
const REVIEW_SOURCE_KEYS = new Set([
  'reviewRef',
  'reviewArtifactRef',
  'reviewArtifactSha256',
  'reviewVersion',
  'reviewArtifactVersion',
  'decisionSemanticFingerprint',
]);
const ASSESSMENT_SOURCE_KEYS = new Set([
  'assessmentRef',
  'assessmentArtifactSha256',
  'assessmentVersion',
  'assessmentArtifactVersion',
  'gradingAlgorithmVersion',
  'semanticFingerprint',
  'answerKeyRef',
  'answerKeySemanticFingerprint',
]);
const MAPPING_SOURCE_KEYS = new Set([
  'mappingRef',
  'mappingArtifactSha256',
  'mappingVersion',
  'mappingArtifactVersion',
  'semanticFingerprint',
  'authoritySource',
]);
const MAPPING_ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactVersion',
  'mappingVersion',
  'examSessionId',
  'profileId',
  'subjectId',
  'mappingRef',
  'sourceReview',
  'sourceAssessments',
  'authoritySource',
  'semanticFingerprint',
  'entryCount',
  'mappedQuestionCount',
  'unmappedQuestionCount',
  'entries',
]);
const OBSERVATIONS_ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactVersion',
  'observationVersion',
  'examSessionId',
  'profileId',
  'subjectId',
  'observedAt',
  'observationRef',
  'sourceReview',
  'sourceAssessments',
  'sourceMapping',
  'semanticFingerprint',
  'observationCount',
  'evaluatedCount',
  'correctCount',
  'incorrectCount',
  'unassessedCount',
  'observations',
]);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

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

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function validPositiveVersion(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= EXAM_DERIVATIVE_VERSION_MAX
  );
}

function validCount(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function compareQuestionId(
  left: { confirmedQuestionId: string },
  right: { confirmedQuestionId: string },
): number {
  return left.confirmedQuestionId < right.confirmedQuestionId
    ? -1
    : left.confirmedQuestionId > right.confirmedQuestionId
      ? 1
      : 0;
}

function entryKeys(decision: unknown): ReadonlySet<string> {
  if (decision === 'mapped') return MAPPED_ENTRY_KEYS;
  if (decision === 'unmapped') return UNMAPPED_ENTRY_KEYS;
  return UNKNOWN_ENTRY_KEYS;
}

function parseEntry(
  value: unknown,
  index: number,
  errors: DomainValidationIssue[],
): ExamKnowledgeMappingEntryV1 | null {
  const path = `/entries/${index}`;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected knowledge mapping entry object');
    return null;
  }
  rejectUnknownKeys(value, entryKeys(value.decision), path, errors);
  const before = errors.length;
  validateIdentifier(value.confirmedQuestionId, `${path}/confirmedQuestionId`, errors);

  if (value.decision === 'mapped') {
    if (
      !Array.isArray(value.knowledgePointIds) ||
      value.knowledgePointIds.length < 1 ||
      value.knowledgePointIds.length >
        EXAM_PRIVATE_KNOWLEDGE_MAPPING_LIMITS.maxKnowledgePointIdsPerQuestion
    ) {
      pushIssue(errors, `${path}/knowledgePointIds`, 'expected 1 to 32 knowledge point ids');
      return null;
    }
    const knowledgePointIds: string[] = [];
    for (const [knowledgeIndex, raw] of value.knowledgePointIds.entries()) {
      if (validateIdentifier(raw, `${path}/knowledgePointIds/${knowledgeIndex}`, errors)) {
        knowledgePointIds.push(raw);
      }
    }
    if (new Set(knowledgePointIds).size !== knowledgePointIds.length) {
      pushIssue(errors, `${path}/knowledgePointIds`, 'duplicate knowledge point id');
    }
    knowledgePointIds.sort();
    return errors.length === before
      ? {
          confirmedQuestionId: value.confirmedQuestionId as string,
          decision: 'mapped',
          knowledgePointIds,
        }
      : null;
  }

  if (value.decision === 'unmapped') {
    if (!(EXAM_KNOWLEDGE_UNMAPPED_REASONS as readonly unknown[]).includes(value.reason)) {
      pushIssue(errors, `${path}/reason`, 'unknown unmapped reason');
    }
    return errors.length === before
      ? {
          confirmedQuestionId: value.confirmedQuestionId as string,
          decision: 'unmapped',
          reason: value.reason as ExamKnowledgeUnmappedReason,
        }
      : null;
  }

  pushIssue(errors, `${path}/decision`, 'unknown knowledge mapping decision');
  return null;
}

function canonicalRequest(value: unknown): {
  request?: ExamKnowledgeMappingRequestV1;
  result: DomainValidationResult;
} {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected knowledge mapping request object');
    return { result: finishValidation(errors) };
  }
  rejectUnknownKeys(value, REQUEST_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION) {
    pushIssue(
      errors,
      '/schemaVersion',
      `expected schemaVersion ${EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION}`,
    );
  }
  if (
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > EXAM_PRIVATE_KNOWLEDGE_MAPPING_LIMITS.maxEntries
  ) {
    pushIssue(errors, '/entries', 'expected a bounded non-empty entry array');
    return { result: finishValidation(errors) };
  }
  const entries = value.entries
    .map((entry, index) => parseEntry(entry, index, errors))
    .filter((entry): entry is ExamKnowledgeMappingEntryV1 => entry !== null);
  const questionIds = entries.map((entry) => entry.confirmedQuestionId);
  if (new Set(questionIds).size !== questionIds.length) {
    pushIssue(errors, '/entries', 'duplicate confirmed question id');
  }
  const result = finishValidation(errors);
  return result.valid
    ? {
        result,
        request: {
          schemaVersion: EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION,
          entries: entries.sort(compareQuestionId),
        },
      }
    : { result };
}

export function validateExamKnowledgeMappingRequest(value: unknown): DomainValidationResult {
  return canonicalRequest(value).result;
}

export const validateExamKnowledgeMapRequest = validateExamKnowledgeMappingRequest;

export function parseExamKnowledgeMappingRequest(value: unknown): ExamKnowledgeMappingRequestV1 {
  const parsed = canonicalRequest(value);
  if (!parsed.result.valid || !parsed.request) {
    throw new ExamKnowledgeMappingPrivateError('EXAM_KNOWLEDGE_MAPPING_INPUT_INVALID');
  }
  return parsed.request;
}

export const parseExamKnowledgeMapRequest = parseExamKnowledgeMappingRequest;

function cloneEntry(entry: ExamKnowledgeMappingEntryV1): ExamKnowledgeMappingEntryV1 {
  return entry.decision === 'mapped'
    ? {
        confirmedQuestionId: entry.confirmedQuestionId,
        decision: entry.decision,
        knowledgePointIds: [...entry.knowledgePointIds],
      }
    : {
        confirmedQuestionId: entry.confirmedQuestionId,
        decision: entry.decision,
        reason: entry.reason,
      };
}

function cloneReviewSource(source: ExamConfirmedReviewSourceV1): ExamConfirmedReviewSourceV1 {
  return {
    reviewRef: source.reviewRef,
    reviewArtifactRef: source.reviewArtifactRef,
    reviewArtifactSha256: source.reviewArtifactSha256,
    reviewVersion: source.reviewVersion,
    reviewArtifactVersion: source.reviewArtifactVersion,
    decisionSemanticFingerprint: source.decisionSemanticFingerprint,
  };
}

function cloneAssessmentSource(source: ExamAssessmentSourceV1): ExamAssessmentSourceV1 {
  return {
    assessmentRef: source.assessmentRef,
    assessmentArtifactSha256: source.assessmentArtifactSha256,
    assessmentVersion: source.assessmentVersion,
    assessmentArtifactVersion: source.assessmentArtifactVersion,
    gradingAlgorithmVersion: source.gradingAlgorithmVersion,
    semanticFingerprint: source.semanticFingerprint,
    answerKeyRef: source.answerKeyRef,
    answerKeySemanticFingerprint: source.answerKeySemanticFingerprint,
  };
}

function cloneMappingSource(source: ExamKnowledgeMappingSourceV1): ExamKnowledgeMappingSourceV1 {
  return {
    mappingRef: source.mappingRef,
    mappingArtifactSha256: source.mappingArtifactSha256,
    mappingVersion: source.mappingVersion,
    mappingArtifactVersion: source.mappingArtifactVersion,
    semanticFingerprint: source.semanticFingerprint,
    authoritySource: source.authoritySource,
  };
}

function reviewSourcesEqual(
  left: ExamConfirmedReviewSourceV1,
  right: ExamConfirmedReviewSourceV1,
): boolean {
  return (
    left.reviewRef === right.reviewRef &&
    left.reviewArtifactRef === right.reviewArtifactRef &&
    left.reviewArtifactSha256 === right.reviewArtifactSha256 &&
    left.reviewVersion === right.reviewVersion &&
    left.reviewArtifactVersion === right.reviewArtifactVersion &&
    left.decisionSemanticFingerprint === right.decisionSemanticFingerprint
  );
}

function assessmentSourcesEqual(
  left: ExamAssessmentSourceV1,
  right: ExamAssessmentSourceV1,
): boolean {
  return (
    left.assessmentRef === right.assessmentRef &&
    left.assessmentArtifactSha256 === right.assessmentArtifactSha256 &&
    left.assessmentVersion === right.assessmentVersion &&
    left.assessmentArtifactVersion === right.assessmentArtifactVersion &&
    left.gradingAlgorithmVersion === right.gradingAlgorithmVersion &&
    left.semanticFingerprint === right.semanticFingerprint &&
    left.answerKeyRef === right.answerKeyRef &&
    left.answerKeySemanticFingerprint === right.answerKeySemanticFingerprint
  );
}

function reviewSourceFromFacts(
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

function assessmentSourceFromFacts(
  assessments: ExamQuestionAssessmentsArtifactV1,
  assessmentArtifactSha256: string,
): ExamAssessmentSourceV1 {
  return {
    assessmentRef: assessments.assessmentRef,
    assessmentArtifactSha256,
    assessmentVersion: assessments.assessmentVersion,
    assessmentArtifactVersion: assessments.artifactVersion,
    gradingAlgorithmVersion: assessments.gradingAlgorithmVersion,
    semanticFingerprint: assessments.semanticFingerprint,
    answerKeyRef: assessments.answerKeyRef,
    answerKeySemanticFingerprint: assessments.answerKeySemanticFingerprint,
  };
}

function mappingSourceFromArtifact(
  mapping: ConfirmedExamKnowledgeMappingArtifactV1,
  mappingArtifactSha256: string,
): ExamKnowledgeMappingSourceV1 {
  return {
    mappingRef: mapping.mappingRef,
    mappingArtifactSha256,
    mappingVersion: mapping.mappingVersion,
    mappingArtifactVersion: mapping.artifactVersion,
    semanticFingerprint: mapping.semanticFingerprint,
    authoritySource: mapping.authoritySource,
  };
}

function validateReviewSource(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamConfirmedReviewSourceV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected confirmed review source');
    return false;
  }
  rejectUnknownKeys(value, REVIEW_SOURCE_KEYS, path, errors);
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

function validateAssessmentSource(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamAssessmentSourceV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected assessment source');
    return false;
  }
  rejectUnknownKeys(value, ASSESSMENT_SOURCE_KEYS, path, errors);
  validateIdentifier(value.assessmentRef, `${path}/assessmentRef`, errors);
  validateIdentifier(value.gradingAlgorithmVersion, `${path}/gradingAlgorithmVersion`, errors);
  validateIdentifier(value.answerKeyRef, `${path}/answerKeyRef`, errors);
  for (const field of [
    'assessmentArtifactSha256',
    'semanticFingerprint',
    'answerKeySemanticFingerprint',
  ] as const) {
    if (!validSha256(value[field])) {
      pushIssue(errors, `${path}/${field}`, 'expected lowercase SHA-256');
    }
  }
  if (!validPositiveVersion(value.assessmentVersion)) {
    pushIssue(errors, `${path}/assessmentVersion`, 'expected positive version');
  }
  if (!validPositiveVersion(value.assessmentArtifactVersion)) {
    pushIssue(errors, `${path}/assessmentArtifactVersion`, 'expected positive artifact version');
  }
  return errors.length === before;
}

function validateMappingSource(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamKnowledgeMappingSourceV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected knowledge mapping source');
    return false;
  }
  rejectUnknownKeys(value, MAPPING_SOURCE_KEYS, path, errors);
  validateIdentifier(value.mappingRef, `${path}/mappingRef`, errors);
  for (const field of ['mappingArtifactSha256', 'semanticFingerprint'] as const) {
    if (!validSha256(value[field])) {
      pushIssue(errors, `${path}/${field}`, 'expected lowercase SHA-256');
    }
  }
  if (!validPositiveVersion(value.mappingVersion)) {
    pushIssue(errors, `${path}/mappingVersion`, 'expected positive version');
  }
  if (!validPositiveVersion(value.mappingArtifactVersion)) {
    pushIssue(errors, `${path}/mappingArtifactVersion`, 'expected positive artifact version');
  }
  if (value.authoritySource !== EXAM_KNOWLEDGE_MAPPING_AUTHORITY_SOURCE) {
    pushIssue(errors, `${path}/authoritySource`, 'unexpected mapping authority source');
  }
  return errors.length === before;
}

function validateAssessmentReviewBinding(
  examSessionId: unknown,
  reviewSource: unknown,
  assessmentSource: unknown,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (
    typeof examSessionId !== 'string' ||
    !isPlainRecord(reviewSource) ||
    !isPlainRecord(assessmentSource)
  ) {
    return;
  }
  const expectedAnswerKeyRef = deriveExamAnswerKeyRef({
    examSessionId,
    sourceReview: reviewSource as unknown as ExamConfirmedReviewSourceV1,
  });
  const expectedAssessmentRef = deriveExamAssessmentRef({
    examSessionId,
    sourceReviewSemanticFingerprint: String(reviewSource.decisionSemanticFingerprint),
    answerKeySemanticFingerprint: String(assessmentSource.answerKeySemanticFingerprint),
  });
  if (assessmentSource.answerKeyRef !== expectedAnswerKeyRef) {
    pushIssue(errors, `${path}/answerKeyRef`, 'answer-key source is not bound to review');
  }
  if (assessmentSource.assessmentRef !== expectedAssessmentRef) {
    pushIssue(errors, `${path}/assessmentRef`, 'assessment source is not bound to review');
  }
}

function validIdentifier(value: unknown): value is string {
  const errors: DomainValidationIssue[] = [];
  return validateIdentifier(value, '', errors) && errors.length === 0;
}

function equalStringSets(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length
  );
}

function assertMappingSources(input: {
  examSessionId: string;
  profileId: string;
  subjectId: string;
  confirmedReview: ConfirmedExamReviewFactsV1;
  confirmedReviewArtifactSha256: string;
  assessments: ExamQuestionAssessmentsArtifactV1;
  assessmentArtifactSha256: string;
}): void {
  const expectedReviewSource = reviewSourceFromFacts(
    input.confirmedReview,
    input.confirmedReviewArtifactSha256,
  );
  if (
    !validIdentifier(input.examSessionId) ||
    !validIdentifier(input.profileId) ||
    !validIdentifier(input.subjectId) ||
    !validateConfirmedExamReviewFacts(input.confirmedReview).valid ||
    !validateExamQuestionAssessmentsArtifact(input.assessments).valid ||
    input.confirmedReview.examSessionId !== input.examSessionId ||
    input.assessments.examSessionId !== input.examSessionId ||
    !validSha256(input.confirmedReviewArtifactSha256) ||
    !validSha256(input.assessmentArtifactSha256) ||
    sha256(serializeConfirmedExamReviewFacts(input.confirmedReview)) !==
      input.confirmedReviewArtifactSha256 ||
    sha256(serializeExamQuestionAssessmentsArtifact(input.assessments)) !==
      input.assessmentArtifactSha256 ||
    !reviewSourcesEqual(input.assessments.sourceReview, expectedReviewSource)
  ) {
    throw new ExamKnowledgeMappingPrivateError('EXAM_KNOWLEDGE_MAPPING_SOURCE_INVALID');
  }
  const reviewQuestionIds = input.confirmedReview.confirmedQuestions.map(
    (question) => question.confirmedQuestionId,
  );
  const assessmentQuestionIds = input.assessments.assessments.map(
    (assessment) => assessment.confirmedQuestionId,
  );
  if (!equalStringSets(reviewQuestionIds, assessmentQuestionIds)) {
    throw new ExamKnowledgeMappingPrivateError('EXAM_KNOWLEDGE_MAPPING_SOURCE_INVALID');
  }
}

export function deriveExamKnowledgeMappingRef(input: {
  examSessionId: string;
  profileId: string;
  subjectId: string;
  sourceReviewSemanticFingerprint: string;
  sourceAssessmentSemanticFingerprint: string;
}): string {
  return `exam-knowledge-mapping:v${EXAM_KNOWLEDGE_MAPPING_VERSION}:${fingerprint(
    'openmaic:zhongkao-exam-knowledge-mapping:v1',
    {
      mappingVersion: EXAM_KNOWLEDGE_MAPPING_VERSION,
      ...input,
    },
  )}`;
}

function mappingSemanticFacts(
  artifact: Omit<ConfirmedExamKnowledgeMappingArtifactV1, 'semanticFingerprint'>,
): unknown {
  return artifact;
}

export function createExamKnowledgeMappingSemanticFingerprint(
  artifact: Omit<ConfirmedExamKnowledgeMappingArtifactV1, 'semanticFingerprint'>,
): string {
  return fingerprint(
    'openmaic:zhongkao-exam-knowledge-mapping-semantic:v1',
    mappingSemanticFacts(artifact),
  );
}

export interface BuildConfirmedExamKnowledgeMappingArtifactInput {
  examSessionId: string;
  profileId: string;
  subjectId: string;
  confirmedReview: ConfirmedExamReviewFactsV1;
  confirmedReviewArtifactSha256: string;
  assessments: ExamQuestionAssessmentsArtifactV1;
  assessmentArtifactSha256: string;
  request: ExamKnowledgeMappingRequestV1;
}

export function buildConfirmedExamKnowledgeMappingArtifact(
  input: BuildConfirmedExamKnowledgeMappingArtifactInput,
): ConfirmedExamKnowledgeMappingArtifactV1 {
  assertMappingSources(input);
  const request = parseExamKnowledgeMappingRequest(input.request);
  const reviewQuestionIds = input.confirmedReview.confirmedQuestions.map(
    (question) => question.confirmedQuestionId,
  );
  const requestQuestionIds = request.entries.map((entry) => entry.confirmedQuestionId);
  if (!equalStringSets(reviewQuestionIds, requestQuestionIds)) {
    throw new ExamKnowledgeMappingPrivateError('EXAM_KNOWLEDGE_MAPPING_INCOMPLETE');
  }

  const sourceReview = reviewSourceFromFacts(
    input.confirmedReview,
    input.confirmedReviewArtifactSha256,
  );
  const sourceAssessments = assessmentSourceFromFacts(
    input.assessments,
    input.assessmentArtifactSha256,
  );
  const entries = request.entries.map(cloneEntry).sort(compareQuestionId);
  const mappedQuestionCount = entries.filter((entry) => entry.decision === 'mapped').length;
  const withoutFingerprint: Omit<ConfirmedExamKnowledgeMappingArtifactV1, 'semanticFingerprint'> = {
    schemaVersion: EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION,
    artifactVersion: EXAM_KNOWLEDGE_MAPPING_ARTIFACT_VERSION,
    mappingVersion: EXAM_KNOWLEDGE_MAPPING_VERSION,
    examSessionId: input.examSessionId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    mappingRef: deriveExamKnowledgeMappingRef({
      examSessionId: input.examSessionId,
      profileId: input.profileId,
      subjectId: input.subjectId,
      sourceReviewSemanticFingerprint: sourceReview.decisionSemanticFingerprint,
      sourceAssessmentSemanticFingerprint: sourceAssessments.semanticFingerprint,
    }),
    sourceReview,
    sourceAssessments,
    authoritySource: EXAM_KNOWLEDGE_MAPPING_AUTHORITY_SOURCE,
    entryCount: entries.length,
    mappedQuestionCount,
    unmappedQuestionCount: entries.length - mappedQuestionCount,
    entries,
  };
  const artifact: ConfirmedExamKnowledgeMappingArtifactV1 = {
    ...withoutFingerprint,
    semanticFingerprint: createExamKnowledgeMappingSemanticFingerprint(withoutFingerprint),
  };
  if (!validateConfirmedExamKnowledgeMappingArtifact(artifact).valid) {
    throw new ExamKnowledgeMappingPrivateError('EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT');
  }
  return artifact;
}

function canonicalMappingArtifact(
  artifact: ConfirmedExamKnowledgeMappingArtifactV1,
): ConfirmedExamKnowledgeMappingArtifactV1 {
  return {
    schemaVersion: EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION,
    artifactVersion: EXAM_KNOWLEDGE_MAPPING_ARTIFACT_VERSION,
    mappingVersion: EXAM_KNOWLEDGE_MAPPING_VERSION,
    examSessionId: artifact.examSessionId,
    profileId: artifact.profileId,
    subjectId: artifact.subjectId,
    mappingRef: artifact.mappingRef,
    sourceReview: cloneReviewSource(artifact.sourceReview),
    sourceAssessments: cloneAssessmentSource(artifact.sourceAssessments),
    authoritySource: EXAM_KNOWLEDGE_MAPPING_AUTHORITY_SOURCE,
    semanticFingerprint: artifact.semanticFingerprint,
    entryCount: artifact.entryCount,
    mappedQuestionCount: artifact.mappedQuestionCount,
    unmappedQuestionCount: artifact.unmappedQuestionCount,
    entries: artifact.entries.map(cloneEntry).sort(compareQuestionId),
  };
}

export function validateConfirmedExamKnowledgeMappingArtifact(
  value: unknown,
): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected confirmed knowledge mapping artifact object');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, MAPPING_ARTIFACT_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'unexpected mapping schema version');
  }
  if (value.artifactVersion !== EXAM_KNOWLEDGE_MAPPING_ARTIFACT_VERSION) {
    pushIssue(errors, '/artifactVersion', 'unexpected mapping artifact version');
  }
  if (value.mappingVersion !== EXAM_KNOWLEDGE_MAPPING_VERSION) {
    pushIssue(errors, '/mappingVersion', 'unexpected mapping version');
  }
  for (const field of ['examSessionId', 'profileId', 'subjectId', 'mappingRef'] as const) {
    validateIdentifier(value[field], `/${field}`, errors);
  }
  const reviewSourceValid = validateReviewSource(value.sourceReview, '/sourceReview', errors);
  const assessmentSourceValid = validateAssessmentSource(
    value.sourceAssessments,
    '/sourceAssessments',
    errors,
  );
  if (reviewSourceValid && assessmentSourceValid) {
    validateAssessmentReviewBinding(
      value.examSessionId,
      value.sourceReview,
      value.sourceAssessments,
      '/sourceAssessments',
      errors,
    );
  }
  if (value.authoritySource !== EXAM_KNOWLEDGE_MAPPING_AUTHORITY_SOURCE) {
    pushIssue(errors, '/authoritySource', 'unexpected mapping authority source');
  }
  if (!validSha256(value.semanticFingerprint)) {
    pushIssue(errors, '/semanticFingerprint', 'expected lowercase SHA-256');
  }
  const parsedEntries = canonicalRequest({
    schemaVersion: EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION,
    entries: value.entries,
  });
  if (!parsedEntries.result.valid || !parsedEntries.request) {
    pushIssue(errors, '/entries', 'invalid canonical knowledge mapping entries');
  }
  if (!validCount(value.entryCount, EXAM_PRIVATE_KNOWLEDGE_MAPPING_LIMITS.maxEntries)) {
    pushIssue(errors, '/entryCount', 'invalid mapping entry count');
  }
  if (!validCount(value.mappedQuestionCount, EXAM_PRIVATE_KNOWLEDGE_MAPPING_LIMITS.maxEntries)) {
    pushIssue(errors, '/mappedQuestionCount', 'invalid mapped question count');
  }
  if (!validCount(value.unmappedQuestionCount, EXAM_PRIVATE_KNOWLEDGE_MAPPING_LIMITS.maxEntries)) {
    pushIssue(errors, '/unmappedQuestionCount', 'invalid unmapped question count');
  }
  if (parsedEntries.request) {
    const entries = parsedEntries.request.entries;
    const mapped = entries.filter((entry) => entry.decision === 'mapped').length;
    if (
      value.entryCount !== entries.length ||
      value.mappedQuestionCount !== mapped ||
      value.unmappedQuestionCount !== entries.length - mapped
    ) {
      pushIssue(errors, '/entryCount', 'mapping counts do not match entries');
    }
    if (JSON.stringify(value.entries) !== JSON.stringify(entries)) {
      pushIssue(errors, '/entries', 'mapping entries are not canonical');
    }
  }
  if (
    isPlainRecord(value.sourceReview) &&
    isPlainRecord(value.sourceAssessments) &&
    typeof value.examSessionId === 'string' &&
    typeof value.profileId === 'string' &&
    typeof value.subjectId === 'string' &&
    value.mappingRef !==
      deriveExamKnowledgeMappingRef({
        examSessionId: value.examSessionId,
        profileId: value.profileId,
        subjectId: value.subjectId,
        sourceReviewSemanticFingerprint: String(value.sourceReview.decisionSemanticFingerprint),
        sourceAssessmentSemanticFingerprint: String(value.sourceAssessments.semanticFingerprint),
      })
  ) {
    pushIssue(errors, '/mappingRef', 'mapping reference mismatch');
  }
  if (errors.length === 0) {
    const artifact = value as unknown as ConfirmedExamKnowledgeMappingArtifactV1;
    const { semanticFingerprint: _ignored, ...withoutFingerprint } = artifact;
    if (
      createExamKnowledgeMappingSemanticFingerprint(withoutFingerprint) !==
      artifact.semanticFingerprint
    ) {
      pushIssue(errors, '/semanticFingerprint', 'mapping semantic fingerprint mismatch');
    }
  }
  return finishValidation(errors);
}

function decodeArtifact(
  value: unknown,
  maxBytes: number,
  code: 'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT' | 'EXAM_OBSERVATION_ARTIFACT_CORRUPT',
): unknown {
  if (Buffer.isBuffer(value)) {
    if (value.byteLength > maxBytes) throw new ExamKnowledgeMappingPrivateError(code);
    try {
      return JSON.parse(UTF8_DECODER.decode(value)) as unknown;
    } catch {
      throw new ExamKnowledgeMappingPrivateError(code);
    }
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > maxBytes) throw new ExamKnowledgeMappingPrivateError(code);
    try {
      return JSON.parse(UTF8_DECODER.decode(value)) as unknown;
    } catch {
      throw new ExamKnowledgeMappingPrivateError(code);
    }
  }
  return value;
}

export function parseConfirmedExamKnowledgeMappingArtifact(
  value: unknown,
): ConfirmedExamKnowledgeMappingArtifactV1 {
  const decoded = decodeArtifact(
    value,
    EXAM_PRIVATE_KNOWLEDGE_MAPPING_LIMITS.maxMappingArtifactBytes,
    'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT',
  );
  if (!validateConfirmedExamKnowledgeMappingArtifact(decoded).valid) {
    throw new ExamKnowledgeMappingPrivateError('EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT');
  }
  return canonicalMappingArtifact(decoded as ConfirmedExamKnowledgeMappingArtifactV1);
}

export function serializeConfirmedExamKnowledgeMappingArtifact(value: unknown): Buffer {
  const bytes = Buffer.from(
    JSON.stringify(parseConfirmedExamKnowledgeMappingArtifact(value)),
    'utf8',
  );
  if (bytes.byteLength > EXAM_PRIVATE_KNOWLEDGE_MAPPING_LIMITS.maxMappingArtifactBytes) {
    throw new ExamKnowledgeMappingPrivateError('EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT');
  }
  return bytes;
}

export function deriveExamObservationProjectionRef(input: {
  examSessionId: string;
  sourceAssessmentSemanticFingerprint: string;
  sourceMappingSemanticFingerprint: string;
}): string {
  return `exam-observations:v${EXAM_OBSERVATION_PROJECTION_VERSION}:${fingerprint(
    'openmaic:zhongkao-confirmed-exam-observations:v1',
    {
      observationVersion: EXAM_OBSERVATION_PROJECTION_VERSION,
      ...input,
    },
  )}`;
}

function observationsSemanticFacts(
  artifact: Omit<ConfirmedExamObservationsArtifactV1, 'semanticFingerprint'>,
): unknown {
  return artifact;
}

export function createConfirmedExamObservationsSemanticFingerprint(
  artifact: Omit<ConfirmedExamObservationsArtifactV1, 'semanticFingerprint'>,
): string {
  return fingerprint(
    'openmaic:zhongkao-confirmed-exam-observations-semantic:v1',
    observationsSemanticFacts(artifact),
  );
}

function assessmentForQuestion(
  assessments: ExamQuestionAssessmentsArtifactV1,
  confirmedQuestionId: string,
): ExamQuestionAssessmentV1 {
  const matches = assessments.assessments.filter(
    (assessment) => assessment.confirmedQuestionId === confirmedQuestionId,
  );
  if (matches.length !== 1) {
    throw new ExamKnowledgeMappingPrivateError('EXAM_OBSERVATION_SOURCE_INVALID');
  }
  return matches[0]!;
}

function createObservation(input: {
  profileId: string;
  subjectId: string;
  observedAt: string;
  mapping: ConfirmedExamKnowledgeMappingArtifactV1;
  assessment: ExamQuestionAssessmentV1;
  entry: Extract<ExamKnowledgeMappingEntryV1, { decision: 'mapped' }>;
}): ConfirmedExamObservationV1 {
  const common = {
    schemaVersion: 1 as const,
    observationId: deriveConfirmedExamObservationId({
      examSessionId: input.mapping.examSessionId,
      confirmedQuestionId: input.entry.confirmedQuestionId,
      mappingFingerprint: input.mapping.semanticFingerprint,
      assessmentFingerprint: input.mapping.sourceAssessments.semanticFingerprint,
    }),
    profileId: input.profileId,
    examSessionId: input.mapping.examSessionId,
    confirmedQuestionId: input.entry.confirmedQuestionId,
    subjectId: input.subjectId,
    knowledgePointIds: [...input.entry.knowledgePointIds],
    occasionId: deriveExamObservationOccasionId(input.mapping.examSessionId),
    observedAt: input.observedAt,
    mappingSource: EXAM_KNOWLEDGE_MAPPING_AUTHORITY_SOURCE,
  };
  const observation: ConfirmedExamObservationV1 =
    input.assessment.status === 'evaluated'
      ? {
          ...common,
          assessmentStatus: 'evaluated',
          outcome: input.assessment.outcome,
        }
      : {
          ...common,
          assessmentStatus: 'unassessed',
          reason: input.assessment.reason,
        };
  if (!validateConfirmedExamObservation(observation).valid) {
    throw new ExamKnowledgeMappingPrivateError('EXAM_OBSERVATION_SOURCE_INVALID');
  }
  return observation;
}

export interface BuildConfirmedExamObservationsArtifactInput {
  profileId: string;
  subjectId: string;
  observedAt: string;
  confirmedReview: ConfirmedExamReviewFactsV1;
  confirmedReviewArtifactSha256: string;
  assessments: ExamQuestionAssessmentsArtifactV1;
  assessmentArtifactSha256: string;
  mapping: ConfirmedExamKnowledgeMappingArtifactV1;
  mappingArtifactSha256: string;
}

function assertObservationSources(input: BuildConfirmedExamObservationsArtifactInput): void {
  try {
    assertMappingSources({
      examSessionId: input.mapping.examSessionId,
      profileId: input.profileId,
      subjectId: input.subjectId,
      confirmedReview: input.confirmedReview,
      confirmedReviewArtifactSha256: input.confirmedReviewArtifactSha256,
      assessments: input.assessments,
      assessmentArtifactSha256: input.assessmentArtifactSha256,
    });
  } catch {
    throw new ExamKnowledgeMappingPrivateError('EXAM_OBSERVATION_SOURCE_INVALID');
  }
  const timeErrors: DomainValidationIssue[] = [];
  validateIsoDateTime(input.observedAt, '/observedAt', timeErrors);
  const expectedReviewSource = reviewSourceFromFacts(
    input.confirmedReview,
    input.confirmedReviewArtifactSha256,
  );
  const expectedAssessmentSource = assessmentSourceFromFacts(
    input.assessments,
    input.assessmentArtifactSha256,
  );
  const reviewQuestionIds = input.confirmedReview.confirmedQuestions.map(
    (question) => question.confirmedQuestionId,
  );
  const mappingQuestionIds = input.mapping.entries.map((entry) => entry.confirmedQuestionId);
  if (
    timeErrors.length > 0 ||
    !validateConfirmedExamKnowledgeMappingArtifact(input.mapping).valid ||
    input.mapping.profileId !== input.profileId ||
    input.mapping.subjectId !== input.subjectId ||
    input.mapping.sourceReview.reviewArtifactSha256 !== input.confirmedReviewArtifactSha256 ||
    input.mapping.sourceReview.decisionSemanticFingerprint !==
      input.confirmedReview.decisionSemanticFingerprint ||
    input.mapping.sourceAssessments.assessmentArtifactSha256 !== input.assessmentArtifactSha256 ||
    input.mapping.sourceAssessments.semanticFingerprint !== input.assessments.semanticFingerprint ||
    !reviewSourcesEqual(input.mapping.sourceReview, expectedReviewSource) ||
    !assessmentSourcesEqual(input.mapping.sourceAssessments, expectedAssessmentSource) ||
    !equalStringSets(reviewQuestionIds, mappingQuestionIds) ||
    !validSha256(input.mappingArtifactSha256) ||
    sha256(serializeConfirmedExamKnowledgeMappingArtifact(input.mapping)) !==
      input.mappingArtifactSha256
  ) {
    throw new ExamKnowledgeMappingPrivateError('EXAM_OBSERVATION_SOURCE_INVALID');
  }
}

export function buildConfirmedExamObservationsArtifact(
  input: BuildConfirmedExamObservationsArtifactInput,
): ConfirmedExamObservationsArtifactV1 {
  assertObservationSources(input);
  const observations = input.mapping.entries
    .filter(
      (entry): entry is Extract<ExamKnowledgeMappingEntryV1, { decision: 'mapped' }> =>
        entry.decision === 'mapped',
    )
    .map((entry) =>
      createObservation({
        profileId: input.profileId,
        subjectId: input.subjectId,
        observedAt: input.observedAt,
        mapping: input.mapping,
        assessment: assessmentForQuestion(input.assessments, entry.confirmedQuestionId),
        entry,
      }),
    )
    .sort(compareQuestionId);
  const evaluated = observations.filter(
    (
      observation,
    ): observation is Extract<ConfirmedExamObservationV1, { assessmentStatus: 'evaluated' }> =>
      observation.assessmentStatus === 'evaluated',
  );
  const sourceReview = reviewSourceFromFacts(
    input.confirmedReview,
    input.confirmedReviewArtifactSha256,
  );
  const sourceAssessments = assessmentSourceFromFacts(
    input.assessments,
    input.assessmentArtifactSha256,
  );
  const sourceMapping = mappingSourceFromArtifact(input.mapping, input.mappingArtifactSha256);
  const withoutFingerprint: Omit<ConfirmedExamObservationsArtifactV1, 'semanticFingerprint'> = {
    schemaVersion: EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION,
    artifactVersion: EXAM_OBSERVATIONS_ARTIFACT_VERSION,
    observationVersion: EXAM_OBSERVATION_PROJECTION_VERSION,
    examSessionId: input.mapping.examSessionId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    observedAt: input.observedAt,
    observationRef: deriveExamObservationProjectionRef({
      examSessionId: input.mapping.examSessionId,
      sourceAssessmentSemanticFingerprint: sourceAssessments.semanticFingerprint,
      sourceMappingSemanticFingerprint: sourceMapping.semanticFingerprint,
    }),
    sourceReview,
    sourceAssessments,
    sourceMapping,
    observationCount: observations.length,
    evaluatedCount: evaluated.length,
    correctCount: evaluated.filter((observation) => observation.outcome === 'correct').length,
    incorrectCount: evaluated.filter((observation) => observation.outcome === 'incorrect').length,
    unassessedCount: observations.length - evaluated.length,
    observations,
  };
  const artifact: ConfirmedExamObservationsArtifactV1 = {
    ...withoutFingerprint,
    semanticFingerprint: createConfirmedExamObservationsSemanticFingerprint(withoutFingerprint),
  };
  if (!validateConfirmedExamObservationsArtifact(artifact).valid) {
    throw new ExamKnowledgeMappingPrivateError('EXAM_OBSERVATION_ARTIFACT_CORRUPT');
  }
  return artifact;
}

function canonicalObservation(observation: ConfirmedExamObservationV1): ConfirmedExamObservationV1 {
  return JSON.parse(
    serializeConfirmedExamObservation(observation).toString('utf8'),
  ) as ConfirmedExamObservationV1;
}

function canonicalObservationsArtifact(
  artifact: ConfirmedExamObservationsArtifactV1,
): ConfirmedExamObservationsArtifactV1 {
  return {
    schemaVersion: EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION,
    artifactVersion: EXAM_OBSERVATIONS_ARTIFACT_VERSION,
    observationVersion: EXAM_OBSERVATION_PROJECTION_VERSION,
    examSessionId: artifact.examSessionId,
    profileId: artifact.profileId,
    subjectId: artifact.subjectId,
    observedAt: artifact.observedAt,
    observationRef: artifact.observationRef,
    sourceReview: cloneReviewSource(artifact.sourceReview),
    sourceAssessments: cloneAssessmentSource(artifact.sourceAssessments),
    sourceMapping: cloneMappingSource(artifact.sourceMapping),
    semanticFingerprint: artifact.semanticFingerprint,
    observationCount: artifact.observationCount,
    evaluatedCount: artifact.evaluatedCount,
    correctCount: artifact.correctCount,
    incorrectCount: artifact.incorrectCount,
    unassessedCount: artifact.unassessedCount,
    observations: artifact.observations.map(canonicalObservation).sort(compareQuestionId),
  };
}

export function validateConfirmedExamObservationsArtifact(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected confirmed observations artifact object');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, OBSERVATIONS_ARTIFACT_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_KNOWLEDGE_MAPPING_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'unexpected observations schema version');
  }
  if (value.artifactVersion !== EXAM_OBSERVATIONS_ARTIFACT_VERSION) {
    pushIssue(errors, '/artifactVersion', 'unexpected observations artifact version');
  }
  if (value.observationVersion !== EXAM_OBSERVATION_PROJECTION_VERSION) {
    pushIssue(errors, '/observationVersion', 'unexpected observation version');
  }
  for (const field of ['examSessionId', 'profileId', 'subjectId', 'observationRef'] as const) {
    validateIdentifier(value[field], `/${field}`, errors);
  }
  validateIsoDateTime(value.observedAt, '/observedAt', errors);
  const sourceReview = value.sourceReview;
  const sourceAssessments = value.sourceAssessments;
  const sourceMapping = value.sourceMapping;
  const reviewSourceValid = validateReviewSource(sourceReview, '/sourceReview', errors);
  const assessmentSourceValid = validateAssessmentSource(
    sourceAssessments,
    '/sourceAssessments',
    errors,
  );
  const mappingSourceValid = validateMappingSource(sourceMapping, '/sourceMapping', errors);
  if (reviewSourceValid && assessmentSourceValid) {
    validateAssessmentReviewBinding(
      value.examSessionId,
      sourceReview,
      sourceAssessments,
      '/sourceAssessments',
      errors,
    );
  }
  if (
    reviewSourceValid &&
    assessmentSourceValid &&
    mappingSourceValid &&
    typeof value.examSessionId === 'string' &&
    typeof value.profileId === 'string' &&
    typeof value.subjectId === 'string' &&
    (sourceMapping as ExamKnowledgeMappingSourceV1).mappingRef !==
      deriveExamKnowledgeMappingRef({
        examSessionId: value.examSessionId,
        profileId: value.profileId,
        subjectId: value.subjectId,
        sourceReviewSemanticFingerprint: (sourceReview as ExamConfirmedReviewSourceV1)
          .decisionSemanticFingerprint,
        sourceAssessmentSemanticFingerprint: (sourceAssessments as ExamAssessmentSourceV1)
          .semanticFingerprint,
      })
  ) {
    pushIssue(errors, '/sourceMapping/mappingRef', 'mapping source partition mismatch');
  }
  if (!validSha256(value.semanticFingerprint)) {
    pushIssue(errors, '/semanticFingerprint', 'expected lowercase SHA-256');
  }
  if (!Array.isArray(value.observations)) {
    pushIssue(errors, '/observations', 'expected observations array');
    return finishValidation(errors);
  }
  if (value.observations.length > EXAM_PRIVATE_KNOWLEDGE_MAPPING_LIMITS.maxEntries) {
    pushIssue(errors, '/observations', 'too many observations');
  }
  value.observations.forEach((observation, index) => {
    const result = validateConfirmedExamObservation(observation);
    if (!result.valid) pushIssue(errors, `/observations/${index}`, 'invalid observation');
  });
  const typed = value.observations.filter(
    (observation): observation is ConfirmedExamObservationV1 =>
      validateConfirmedExamObservation(observation).valid,
  );
  const questionIds = typed.map((observation) => observation.confirmedQuestionId);
  const observationIds = typed.map((observation) => observation.observationId);
  if (new Set(questionIds).size !== questionIds.length) {
    pushIssue(errors, '/observations', 'duplicate confirmed question observation');
  }
  if (new Set(observationIds).size !== observationIds.length) {
    pushIssue(errors, '/observations', 'duplicate observation id');
  }
  for (const observation of typed) {
    if (
      observation.examSessionId !== value.examSessionId ||
      observation.profileId !== value.profileId ||
      observation.subjectId !== value.subjectId ||
      observation.observedAt !== value.observedAt ||
      observation.mappingSource !== EXAM_KNOWLEDGE_MAPPING_AUTHORITY_SOURCE
    ) {
      pushIssue(errors, '/observations', 'observation partition mismatch');
      break;
    }
    if (
      isPlainRecord(value.sourceAssessments) &&
      isPlainRecord(value.sourceMapping) &&
      observation.observationId !==
        deriveConfirmedExamObservationId({
          examSessionId: observation.examSessionId,
          confirmedQuestionId: observation.confirmedQuestionId,
          mappingFingerprint: String(value.sourceMapping.semanticFingerprint),
          assessmentFingerprint: String(value.sourceAssessments.semanticFingerprint),
        })
    ) {
      pushIssue(errors, '/observations', 'observation id source binding mismatch');
      break;
    }
  }
  for (const field of [
    'observationCount',
    'evaluatedCount',
    'correctCount',
    'incorrectCount',
    'unassessedCount',
  ] as const) {
    if (!validCount(value[field], EXAM_PRIVATE_KNOWLEDGE_MAPPING_LIMITS.maxEntries)) {
      pushIssue(errors, `/${field}`, 'invalid observation count');
    }
  }
  const evaluated = typed.filter((observation) => observation.assessmentStatus === 'evaluated');
  if (
    value.observationCount !== typed.length ||
    value.evaluatedCount !== evaluated.length ||
    value.correctCount !==
      evaluated.filter(
        (observation) =>
          observation.assessmentStatus === 'evaluated' && observation.outcome === 'correct',
      ).length ||
    value.incorrectCount !==
      evaluated.filter(
        (observation) =>
          observation.assessmentStatus === 'evaluated' && observation.outcome === 'incorrect',
      ).length ||
    value.unassessedCount !== typed.length - evaluated.length
  ) {
    pushIssue(errors, '/observationCount', 'observation counts do not match observations');
  }
  if (
    isPlainRecord(value.sourceAssessments) &&
    isPlainRecord(value.sourceMapping) &&
    typeof value.examSessionId === 'string' &&
    value.observationRef !==
      deriveExamObservationProjectionRef({
        examSessionId: value.examSessionId,
        sourceAssessmentSemanticFingerprint: String(value.sourceAssessments.semanticFingerprint),
        sourceMappingSemanticFingerprint: String(value.sourceMapping.semanticFingerprint),
      })
  ) {
    pushIssue(errors, '/observationRef', 'observation reference mismatch');
  }
  const canonicalObservations = typed.map(canonicalObservation).sort(compareQuestionId);
  if (JSON.stringify(value.observations) !== JSON.stringify(canonicalObservations)) {
    pushIssue(errors, '/observations', 'observations are not canonical');
  }
  if (errors.length === 0) {
    const artifact = value as unknown as ConfirmedExamObservationsArtifactV1;
    const { semanticFingerprint: _ignored, ...withoutFingerprint } = artifact;
    if (
      createConfirmedExamObservationsSemanticFingerprint(withoutFingerprint) !==
      artifact.semanticFingerprint
    ) {
      pushIssue(errors, '/semanticFingerprint', 'observations semantic fingerprint mismatch');
    }
  }
  return finishValidation(errors);
}

export const validateConfirmedExamObservationArtifact = validateConfirmedExamObservationsArtifact;

export function parseConfirmedExamObservationsArtifact(
  value: unknown,
): ConfirmedExamObservationsArtifactV1 {
  const decoded = decodeArtifact(
    value,
    EXAM_PRIVATE_KNOWLEDGE_MAPPING_LIMITS.maxObservationsArtifactBytes,
    'EXAM_OBSERVATION_ARTIFACT_CORRUPT',
  );
  if (!validateConfirmedExamObservationsArtifact(decoded).valid) {
    throw new ExamKnowledgeMappingPrivateError('EXAM_OBSERVATION_ARTIFACT_CORRUPT');
  }
  return canonicalObservationsArtifact(decoded as ConfirmedExamObservationsArtifactV1);
}

export const parseConfirmedExamObservationArtifact = parseConfirmedExamObservationsArtifact;

export function serializeConfirmedExamObservationsArtifact(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(parseConfirmedExamObservationsArtifact(value)), 'utf8');
  if (bytes.byteLength > EXAM_PRIVATE_KNOWLEDGE_MAPPING_LIMITS.maxObservationsArtifactBytes) {
    throw new ExamKnowledgeMappingPrivateError('EXAM_OBSERVATION_ARTIFACT_CORRUPT');
  }
  return bytes;
}

export const serializeConfirmedExamObservationArtifact = serializeConfirmedExamObservationsArtifact;
