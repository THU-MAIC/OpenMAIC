import { createHash } from 'node:crypto';

import {
  EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS,
  parseExamErrorSuggestionDraft,
  type ExamErrorSuggestionEvidenceV1,
  type ExamErrorSuggestionGenerationSource,
  type ExamErrorSuggestionKind,
} from './exam-error-suggestions';
import {
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  type DomainValidationIssue,
  type DomainValidationResult,
} from './validation';

export const EXAM_ERROR_REVIEW_SCHEMA_VERSION = 1 as const;
export const EXAM_ERROR_REVIEW_ARTIFACT_VERSION = 1 as const;
export const EXAM_ERROR_REVIEW_VERSION = 1 as const;
export const EXAM_ERROR_PATTERN_AUTHORITY_SOURCE = 'owner_confirmed_error_pattern' as const;

export const EXAM_ERROR_REVIEW_LIMITS = Object.freeze({
  maxQuestions: 500,
  maxCandidateDecisions: 1_500,
  maxRequestBytes: 2 * 1024 * 1024,
  maxArtifactBytes: 4 * 1024 * 1024,
});

export type ExamErrorReviewDecision = 'accept' | 'reject';

export interface ExamErrorReviewCandidateDecisionV1 {
  candidateId: string;
  decision: ExamErrorReviewDecision;
}

export interface ExamErrorReviewQuestionDecisionV1 {
  confirmedQuestionId: string;
  candidateDecisions: ExamErrorReviewCandidateDecisionV1[];
}

export interface ExamErrorReviewRequestV1 {
  schemaVersion: typeof EXAM_ERROR_REVIEW_SCHEMA_VERSION;
  questions: ExamErrorReviewQuestionDecisionV1[];
}

export interface ConfirmedExamErrorPatternObservationV1 {
  schemaVersion: typeof EXAM_ERROR_REVIEW_SCHEMA_VERSION;
  observationId: string;
  confirmedQuestionId: string;
  sourceCandidateId: string;
  patternKind: ExamErrorSuggestionKind;
  candidateGenerationSource: ExamErrorSuggestionGenerationSource;
  evidence: ExamErrorSuggestionEvidenceV1[];
  authoritySource: typeof EXAM_ERROR_PATTERN_AUTHORITY_SOURCE;
}

export interface CreateExamErrorReviewDecisionSemanticFingerprintInput {
  sourceCandidateArtifactRef: string;
  sourceCandidateArtifactFingerprint: string;
  sourceCandidateSemanticFingerprint: string;
  reviewVersion: number;
  request: unknown;
}

export interface DeriveConfirmedExamErrorPatternObservationIdInput {
  examSessionId: string;
  sourceCandidateId: string;
  sourceCandidateArtifactFingerprint: string;
  sourceCandidateSemanticFingerprint: string;
  errorReviewVersion: number;
}

export class ExamErrorReviewValidationError extends Error {
  override readonly name = 'ExamErrorReviewValidationError';
  readonly code = 'EXAM_ERROR_REVIEW_INPUT_INVALID' as const;

  constructor() {
    super('EXAM_ERROR_REVIEW_INPUT_INVALID');
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const OBSERVATION_ID = /^exam-error-pattern-observation:v1:[a-f0-9]{64}$/u;
const REQUEST_KEYS = new Set(['schemaVersion', 'questions']);
const QUESTION_KEYS = new Set(['confirmedQuestionId', 'candidateDecisions']);
const CANDIDATE_DECISION_KEYS = new Set(['candidateId', 'decision']);
const OBSERVATION_KEYS = new Set([
  'schemaVersion',
  'observationId',
  'confirmedQuestionId',
  'sourceCandidateId',
  'patternKind',
  'candidateGenerationSource',
  'evidence',
  'authoritySource',
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function fingerprint(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\0')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex');
}

function serializedByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validateSha256(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    pushIssue(errors, path, 'expected lowercase SHA-256 fingerprint');
    return false;
  }
  return true;
}

function validateCandidateDecision(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamErrorReviewCandidateDecisionV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected candidate decision object');
    return false;
  }
  rejectUnknownKeys(value, CANDIDATE_DECISION_KEYS, path, errors);
  validateIdentifier(value.candidateId, `${path}/candidateId`, errors);
  if (value.decision !== 'accept' && value.decision !== 'reject') {
    pushIssue(errors, `${path}/decision`, 'unknown candidate decision');
  }
  return errors.length === before;
}

function parseQuestions(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): ExamErrorReviewQuestionDecisionV1[] {
  if (!Array.isArray(value) || value.length > EXAM_ERROR_REVIEW_LIMITS.maxQuestions) {
    pushIssue(errors, path, 'expected bounded question review array');
    return [];
  }

  const questions: ExamErrorReviewQuestionDecisionV1[] = [];
  const seenQuestions = new Set<string>();
  const seenCandidates = new Set<string>();
  let candidateDecisionCount = 0;

  value.forEach((question, questionIndex) => {
    const questionPath = `${path}/${questionIndex}`;
    if (!isPlainRecord(question)) {
      pushIssue(errors, questionPath, 'expected question review object');
      return;
    }
    rejectUnknownKeys(question, QUESTION_KEYS, questionPath, errors);
    const confirmedQuestionId = question.confirmedQuestionId;
    const validQuestionId = validateIdentifier(
      confirmedQuestionId,
      `${questionPath}/confirmedQuestionId`,
      errors,
    );
    if (validQuestionId) {
      if (seenQuestions.has(confirmedQuestionId)) {
        pushIssue(errors, `${questionPath}/confirmedQuestionId`, 'duplicate confirmed question');
      }
      seenQuestions.add(confirmedQuestionId);
    }

    if (!Array.isArray(question.candidateDecisions)) {
      pushIssue(errors, `${questionPath}/candidateDecisions`, 'expected candidate decision array');
      return;
    }
    candidateDecisionCount += question.candidateDecisions.length;
    const decisions: ExamErrorReviewCandidateDecisionV1[] = [];
    const questionCandidateIds = new Set<string>();
    question.candidateDecisions.forEach((decision, decisionIndex) => {
      const decisionPath = `${questionPath}/candidateDecisions/${decisionIndex}`;
      if (!validateCandidateDecision(decision, decisionPath, errors)) return;
      if (questionCandidateIds.has(decision.candidateId)) {
        pushIssue(errors, `${decisionPath}/candidateId`, 'duplicate candidate decision');
      }
      if (seenCandidates.has(decision.candidateId)) {
        pushIssue(
          errors,
          `${decisionPath}/candidateId`,
          'candidate appears under multiple questions',
        );
      }
      questionCandidateIds.add(decision.candidateId);
      seenCandidates.add(decision.candidateId);
      decisions.push({ candidateId: decision.candidateId, decision: decision.decision });
    });

    if (validQuestionId) {
      questions.push({
        confirmedQuestionId,
        candidateDecisions: decisions.sort((left, right) =>
          left.candidateId.localeCompare(right.candidateId, 'en'),
        ),
      });
    }
  });

  if (candidateDecisionCount > EXAM_ERROR_REVIEW_LIMITS.maxCandidateDecisions) {
    pushIssue(errors, path, 'too many candidate decisions');
  }

  return questions.sort((left, right) =>
    left.confirmedQuestionId.localeCompare(right.confirmedQuestionId, 'en'),
  );
}

export function canonicalizeExamErrorReviewQuestions(
  value: unknown,
): ExamErrorReviewQuestionDecisionV1[] {
  const errors: DomainValidationIssue[] = [];
  const questions = parseQuestions(value, '/questions', errors);
  if (errors.length > 0) throw new ExamErrorReviewValidationError();
  return questions;
}

export function validateExamErrorReviewRequest(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected error review request object');
    return finishValidation(errors);
  }
  if (serializedByteLength(value) > EXAM_ERROR_REVIEW_LIMITS.maxRequestBytes) {
    pushIssue(errors, '', 'error review request exceeds byte limit');
  }
  rejectUnknownKeys(value, REQUEST_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_ERROR_REVIEW_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'unexpected schema version');
  }
  parseQuestions(value.questions, '/questions', errors);
  return finishValidation(errors);
}

export function parseExamErrorReviewRequest(value: unknown): ExamErrorReviewRequestV1 {
  const validation = validateExamErrorReviewRequest(value);
  if (!validation.valid) throw new ExamErrorReviewValidationError();
  const request = value as unknown as ExamErrorReviewRequestV1;
  return {
    schemaVersion: EXAM_ERROR_REVIEW_SCHEMA_VERSION,
    questions: canonicalizeExamErrorReviewQuestions(request.questions),
  };
}

function assertFingerprintInput(
  input: CreateExamErrorReviewDecisionSemanticFingerprintInput,
): void {
  const errors: DomainValidationIssue[] = [];
  validateIdentifier(input.sourceCandidateArtifactRef, '/sourceCandidateArtifactRef', errors);
  validateSha256(
    input.sourceCandidateArtifactFingerprint,
    '/sourceCandidateArtifactFingerprint',
    errors,
  );
  validateSha256(
    input.sourceCandidateSemanticFingerprint,
    '/sourceCandidateSemanticFingerprint',
    errors,
  );
  if (input.reviewVersion !== EXAM_ERROR_REVIEW_VERSION) {
    pushIssue(errors, '/reviewVersion', 'unexpected error review version');
  }
  if (errors.length > 0) throw new ExamErrorReviewValidationError();
}

export function createExamErrorReviewDecisionSemanticFingerprint(
  input: CreateExamErrorReviewDecisionSemanticFingerprintInput,
): string {
  assertFingerprintInput(input);
  const request = parseExamErrorReviewRequest(input.request);
  return fingerprint('openmaic:zhongkao:exam-error-review-decisions:v1', {
    sourceCandidateArtifactRef: input.sourceCandidateArtifactRef,
    sourceCandidateArtifactFingerprint: input.sourceCandidateArtifactFingerprint,
    sourceCandidateSemanticFingerprint: input.sourceCandidateSemanticFingerprint,
    reviewVersion: input.reviewVersion,
    request,
  });
}

export function deriveConfirmedExamErrorPatternObservationId(
  input: DeriveConfirmedExamErrorPatternObservationIdInput,
): string {
  const errors: DomainValidationIssue[] = [];
  validateIdentifier(input.examSessionId, '/examSessionId', errors);
  validateIdentifier(input.sourceCandidateId, '/sourceCandidateId', errors);
  validateSha256(
    input.sourceCandidateArtifactFingerprint,
    '/sourceCandidateArtifactFingerprint',
    errors,
  );
  validateSha256(
    input.sourceCandidateSemanticFingerprint,
    '/sourceCandidateSemanticFingerprint',
    errors,
  );
  if (input.errorReviewVersion !== EXAM_ERROR_REVIEW_VERSION) {
    pushIssue(errors, '/errorReviewVersion', 'unexpected error review version');
  }
  if (errors.length > 0) throw new ExamErrorReviewValidationError();

  const digest = fingerprint('openmaic:zhongkao:confirmed-exam-error-pattern:v1', {
    schemaVersion: EXAM_ERROR_REVIEW_SCHEMA_VERSION,
    errorReviewVersion: input.errorReviewVersion,
    examSessionId: input.examSessionId,
    sourceCandidateId: input.sourceCandidateId,
    sourceCandidateArtifactFingerprint: input.sourceCandidateArtifactFingerprint,
    sourceCandidateSemanticFingerprint: input.sourceCandidateSemanticFingerprint,
  });
  return `exam-error-pattern-observation:v1:${digest}`;
}

function canonicalObservationFacts(
  value: Record<string, unknown>,
  errors: DomainValidationIssue[],
): Pick<
  ConfirmedExamErrorPatternObservationV1,
  'patternKind' | 'candidateGenerationSource' | 'evidence'
> | null {
  try {
    const draft = parseExamErrorSuggestionDraft({
      kind: value.patternKind,
      generationSource: value.candidateGenerationSource,
      candidateStatus: EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS,
      confidenceBand: 'high',
      evidence: value.evidence,
    });
    return {
      patternKind: draft.kind,
      candidateGenerationSource: draft.generationSource,
      evidence: draft.evidence,
    };
  } catch {
    pushIssue(errors, '/evidence', 'invalid observable candidate facts');
    return null;
  }
}

export function validateConfirmedExamErrorPatternObservation(
  value: unknown,
): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected confirmed error pattern observation object');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, OBSERVATION_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_ERROR_REVIEW_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'unexpected schema version');
  }
  if (
    !validateIdentifier(value.observationId, '/observationId', errors) ||
    !OBSERVATION_ID.test(value.observationId)
  ) {
    pushIssue(errors, '/observationId', 'invalid confirmed observation id');
  }
  validateIdentifier(value.confirmedQuestionId, '/confirmedQuestionId', errors);
  validateIdentifier(value.sourceCandidateId, '/sourceCandidateId', errors);
  if (value.authoritySource !== EXAM_ERROR_PATTERN_AUTHORITY_SOURCE) {
    pushIssue(errors, '/authoritySource', 'unknown error pattern authority source');
  }

  const canonicalFacts = canonicalObservationFacts(value, errors);
  if (
    canonicalFacts &&
    JSON.stringify(canonicalFacts.evidence) !== JSON.stringify(value.evidence)
  ) {
    pushIssue(errors, '/evidence', 'error pattern evidence is not canonical');
  }
  return finishValidation(errors);
}

export function parseConfirmedExamErrorPatternObservation(
  value: unknown,
): ConfirmedExamErrorPatternObservationV1 {
  const validation = validateConfirmedExamErrorPatternObservation(value);
  if (!validation.valid || !isPlainRecord(value)) throw new ExamErrorReviewValidationError();
  const facts = canonicalObservationFacts(value, []);
  if (!facts) throw new ExamErrorReviewValidationError();
  return {
    schemaVersion: EXAM_ERROR_REVIEW_SCHEMA_VERSION,
    observationId: value.observationId as string,
    confirmedQuestionId: value.confirmedQuestionId as string,
    sourceCandidateId: value.sourceCandidateId as string,
    ...facts,
    authoritySource: EXAM_ERROR_PATTERN_AUTHORITY_SOURCE,
  };
}
