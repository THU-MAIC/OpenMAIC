import { createHash } from 'node:crypto';

import {
  EXAM_ERROR_PATTERN_AUTHORITY_SOURCE,
  EXAM_ERROR_REVIEW_ARTIFACT_VERSION,
  EXAM_ERROR_REVIEW_LIMITS,
  EXAM_ERROR_REVIEW_SCHEMA_VERSION,
  EXAM_ERROR_REVIEW_VERSION,
  createExamErrorReviewDecisionSemanticFingerprint,
  deriveConfirmedExamErrorPatternObservationId,
  parseConfirmedExamErrorPatternObservation,
  parseExamErrorReviewRequest,
  type ConfirmedExamErrorPatternObservationV1,
  type ExamErrorReviewQuestionDecisionV1,
  type ExamErrorReviewRequestV1,
} from '@/lib/zhongkao/exam-error-review';
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
  EXAM_ERROR_SUGGESTION_ARTIFACT_VERSION,
  parseExamErrorSuggestionsArtifact,
  serializeExamErrorSuggestionsArtifact,
  type ExamErrorDiagnosisCandidatesArtifactV1,
} from './exam-error-suggestions-private';
import { deriveExamErrorReviewArtifactRef, deriveExamErrorReviewRef } from './exam-runtime';

export interface ExamErrorReviewSourceSuggestionsV1 {
  artifactVersion: number;
  candidateSchemaVersion: number;
  generationVersion: number;
  generationRef: string;
  suggestionArtifactRef: string;
  suggestionArtifactSha256: string;
  semanticFingerprint: string;
}

export interface ExamErrorReviewQuestionResultV1 {
  confirmedQuestionId: string;
  reviewedCandidateCount: number;
  confirmedPatternCount: number;
  hasConfirmedPattern: boolean;
}

export interface ConfirmedExamErrorPatternReviewArtifactV1 {
  schemaVersion: typeof EXAM_ERROR_REVIEW_SCHEMA_VERSION;
  artifactVersion: typeof EXAM_ERROR_REVIEW_ARTIFACT_VERSION;
  errorReviewVersion: typeof EXAM_ERROR_REVIEW_VERSION;
  examSessionId: string;
  profileId: string;
  subjectId: string;
  reviewedAt: string;
  errorReviewRef: string;
  errorReviewArtifactRef: string;
  sourceSuggestions: ExamErrorReviewSourceSuggestionsV1;
  authoritySource: typeof EXAM_ERROR_PATTERN_AUTHORITY_SOURCE;
  decisionSemanticFingerprint: string;
  semanticFingerprint: string;
  reviewedQuestionCount: number;
  reviewedCandidateCount: number;
  acceptedCandidateCount: number;
  rejectedCandidateCount: number;
  confirmedObservationCount: number;
  questions: ExamErrorReviewQuestionDecisionV1[];
  questionResults: ExamErrorReviewQuestionResultV1[];
  confirmedPatternObservations: ConfirmedExamErrorPatternObservationV1[];
}

export interface BuildConfirmedExamErrorPatternReviewArtifactInput {
  examSessionId: string;
  profileId: string;
  subjectId: string;
  reviewedAt: string;
  sourceCandidates: ExamErrorDiagnosisCandidatesArtifactV1;
  sourceCandidateArtifactSha256: string;
  request: ExamErrorReviewRequestV1;
  errorReviewRef?: string;
  errorReviewArtifactRef?: string;
}

export type ExamErrorReviewPrivateErrorCode =
  | 'EXAM_ERROR_REVIEW_INPUT_INVALID'
  | 'EXAM_ERROR_REVIEW_INCOMPLETE'
  | 'EXAM_ERROR_REVIEW_SOURCE_INVALID'
  | 'EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT';

export class ExamErrorReviewPrivateError extends Error {
  override readonly name = 'ExamErrorReviewPrivateError';

  constructor(readonly code: ExamErrorReviewPrivateErrorCode) {
    super(code);
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const SOURCE_KEYS = new Set([
  'artifactVersion',
  'candidateSchemaVersion',
  'generationVersion',
  'generationRef',
  'suggestionArtifactRef',
  'suggestionArtifactSha256',
  'semanticFingerprint',
]);
const ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactVersion',
  'errorReviewVersion',
  'examSessionId',
  'profileId',
  'subjectId',
  'reviewedAt',
  'errorReviewRef',
  'errorReviewArtifactRef',
  'sourceSuggestions',
  'authoritySource',
  'decisionSemanticFingerprint',
  'semanticFingerprint',
  'reviewedQuestionCount',
  'reviewedCandidateCount',
  'acceptedCandidateCount',
  'rejectedCandidateCount',
  'confirmedObservationCount',
  'questions',
  'questionResults',
  'confirmedPatternObservations',
]);
const QUESTION_RESULT_KEYS = new Set([
  'confirmedQuestionId',
  'reviewedCandidateCount',
  'confirmedPatternCount',
  'hasConfirmedPattern',
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

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprint(domain: string, value: unknown): string {
  return sha256(`${domain}\0${JSON.stringify(canonicalize(value))}`);
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function validCount(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function compareQuestion(
  left: { confirmedQuestionId: string },
  right: { confirmedQuestionId: string },
): number {
  return left.confirmedQuestionId.localeCompare(right.confirmedQuestionId, 'en');
}

function compareObservation(
  left: ConfirmedExamErrorPatternObservationV1,
  right: ConfirmedExamErrorPatternObservationV1,
): number {
  return left.sourceCandidateId.localeCompare(right.sourceCandidateId, 'en');
}

function cloneQuestion(
  question: ExamErrorReviewQuestionDecisionV1,
): ExamErrorReviewQuestionDecisionV1 {
  return {
    confirmedQuestionId: question.confirmedQuestionId,
    candidateDecisions: question.candidateDecisions.map((decision) => ({ ...decision })),
  };
}

function cloneObservation(
  observation: ConfirmedExamErrorPatternObservationV1,
): ConfirmedExamErrorPatternObservationV1 {
  return {
    ...observation,
    evidence: observation.evidence.map((evidence) => ({ ...evidence })),
  };
}

function sourceFromCandidates(
  candidates: ExamErrorDiagnosisCandidatesArtifactV1,
  artifactSha256: string,
): ExamErrorReviewSourceSuggestionsV1 {
  return {
    artifactVersion: candidates.artifactVersion,
    candidateSchemaVersion: candidates.generator.candidateSchemaVersion,
    generationVersion: candidates.generationVersion,
    generationRef: candidates.generationRef,
    suggestionArtifactRef: candidates.suggestionArtifactRef,
    suggestionArtifactSha256: artifactSha256,
    semanticFingerprint: candidates.semanticFingerprint,
  };
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort();
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === sortedRight[index])
  );
}

export function assertExamErrorReviewCoverage(
  candidates: ExamErrorDiagnosisCandidatesArtifactV1,
  request: ExamErrorReviewRequestV1,
): void {
  const canonical = parseExamErrorReviewRequest(request);
  if (
    !equalIds(
      candidates.questions.map((question) => question.confirmedQuestionId),
      canonical.questions.map((question) => question.confirmedQuestionId),
    )
  )
    throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_INCOMPLETE');
  const decisions = new Map(
    canonical.questions.map((question) => [question.confirmedQuestionId, question]),
  );
  for (const question of candidates.questions) {
    const review = decisions.get(question.confirmedQuestionId);
    if (
      !review ||
      !equalIds(
        question.suggestions.map((candidate) => candidate.candidateId),
        review.candidateDecisions.map((decision) => decision.candidateId),
      )
    )
      throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_INCOMPLETE');
  }
}

function validateSourceCandidates(
  input: BuildConfirmedExamErrorPatternReviewArtifactInput,
): ExamErrorDiagnosisCandidatesArtifactV1 {
  let candidates: ExamErrorDiagnosisCandidatesArtifactV1;
  let bytes: Buffer;
  try {
    candidates = parseExamErrorSuggestionsArtifact(input.sourceCandidates);
    bytes = serializeExamErrorSuggestionsArtifact(candidates);
  } catch {
    throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_SOURCE_INVALID');
  }
  if (
    !validSha256(input.sourceCandidateArtifactSha256) ||
    sha256(bytes) !== input.sourceCandidateArtifactSha256 ||
    candidates.artifactVersion !== EXAM_ERROR_SUGGESTION_ARTIFACT_VERSION ||
    candidates.examSessionId !== input.examSessionId ||
    candidates.profileId !== input.profileId ||
    candidates.subjectId !== input.subjectId ||
    candidates.eligibleQuestionCount !== candidates.questions.length
  ) {
    throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_SOURCE_INVALID');
  }
  return candidates;
}

export function createConfirmedExamErrorPatternReviewSemanticFingerprint(
  artifact: Omit<ConfirmedExamErrorPatternReviewArtifactV1, 'semanticFingerprint'>,
): string {
  return fingerprint('openmaic:zhongkao:confirmed-exam-error-pattern-review:v1', artifact);
}

export function buildConfirmedExamErrorPatternReviewArtifact(
  input: BuildConfirmedExamErrorPatternReviewArtifactInput,
): ConfirmedExamErrorPatternReviewArtifactV1 {
  const errors: DomainValidationIssue[] = [];
  validateIdentifier(input.examSessionId, '/examSessionId', errors);
  validateIdentifier(input.profileId, '/profileId', errors);
  validateIdentifier(input.subjectId, '/subjectId', errors);
  validateIsoDateTime(input.reviewedAt, '/reviewedAt', errors);
  if (errors.length > 0) {
    throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_SOURCE_INVALID');
  }

  const sourceCandidates = validateSourceCandidates(input);
  let request: ExamErrorReviewRequestV1;
  try {
    request = parseExamErrorReviewRequest(input.request);
  } catch {
    throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_INPUT_INVALID');
  }

  const sourceQuestionIds = sourceCandidates.questions.map(
    (question) => question.confirmedQuestionId,
  );
  const requestedQuestionIds = request.questions.map((question) => question.confirmedQuestionId);
  if (!equalIds(sourceQuestionIds, requestedQuestionIds)) {
    throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_INCOMPLETE');
  }

  const requestByQuestion = new Map(
    request.questions.map((question) => [question.confirmedQuestionId, question]),
  );
  const questions: ExamErrorReviewQuestionDecisionV1[] = [];
  const questionResults: ExamErrorReviewQuestionResultV1[] = [];
  const observations: ConfirmedExamErrorPatternObservationV1[] = [];

  const source = sourceFromCandidates(sourceCandidates, input.sourceCandidateArtifactSha256);
  for (const sourceQuestion of [...sourceCandidates.questions].sort(compareQuestion)) {
    const reviewed = requestByQuestion.get(sourceQuestion.confirmedQuestionId);
    if (!reviewed) {
      throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_INCOMPLETE');
    }
    const sourceIds = sourceQuestion.suggestions.map((candidate) => candidate.candidateId);
    const decisionIds = reviewed.candidateDecisions.map((decision) => decision.candidateId);
    if (!equalIds(sourceIds, decisionIds)) {
      throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_INCOMPLETE');
    }
    const sourceById = new Map(
      sourceQuestion.suggestions.map((candidate) => [candidate.candidateId, candidate]),
    );
    let confirmedPatternCount = 0;
    for (const decision of reviewed.candidateDecisions) {
      const candidate = sourceById.get(decision.candidateId);
      if (!candidate) {
        throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_INCOMPLETE');
      }
      if (decision.decision === 'accept') {
        confirmedPatternCount += 1;
        observations.push({
          schemaVersion: EXAM_ERROR_REVIEW_SCHEMA_VERSION,
          observationId: deriveConfirmedExamErrorPatternObservationId({
            examSessionId: input.examSessionId,
            sourceCandidateId: candidate.candidateId,
            sourceCandidateArtifactFingerprint: source.suggestionArtifactSha256,
            sourceCandidateSemanticFingerprint: source.semanticFingerprint,
            errorReviewVersion: EXAM_ERROR_REVIEW_VERSION,
          }),
          confirmedQuestionId: sourceQuestion.confirmedQuestionId,
          sourceCandidateId: candidate.candidateId,
          patternKind: candidate.kind,
          candidateGenerationSource: candidate.generationSource,
          evidence: candidate.evidence.map((evidence) => ({ ...evidence })),
          authoritySource: EXAM_ERROR_PATTERN_AUTHORITY_SOURCE,
        });
      }
    }
    questions.push(cloneQuestion(reviewed));
    questionResults.push({
      confirmedQuestionId: sourceQuestion.confirmedQuestionId,
      reviewedCandidateCount: reviewed.candidateDecisions.length,
      confirmedPatternCount,
      hasConfirmedPattern: confirmedPatternCount > 0,
    });
  }

  questions.sort(compareQuestion);
  questionResults.sort(compareQuestion);
  observations.sort(compareObservation);
  const reviewedCandidateCount = questions.reduce(
    (total, question) => total + question.candidateDecisions.length,
    0,
  );
  const acceptedCandidateCount = observations.length;
  const decisionSemanticFingerprint = createExamErrorReviewDecisionSemanticFingerprint({
    sourceCandidateArtifactRef: source.suggestionArtifactRef,
    sourceCandidateArtifactFingerprint: source.suggestionArtifactSha256,
    sourceCandidateSemanticFingerprint: source.semanticFingerprint,
    reviewVersion: EXAM_ERROR_REVIEW_VERSION,
    request: { schemaVersion: EXAM_ERROR_REVIEW_SCHEMA_VERSION, questions },
  });
  const errorReviewRef = deriveExamErrorReviewRef({
    examSessionId: input.examSessionId,
    profileId: input.profileId,
    errorReviewVersion: EXAM_ERROR_REVIEW_VERSION,
    sourceSuggestionGenerationVersion: source.generationVersion,
    sourceSuggestionGenerationRef: source.generationRef,
    sourceSuggestionArtifactRef: source.suggestionArtifactRef,
    sourceSuggestionArtifactFingerprint: source.suggestionArtifactSha256,
    sourceSuggestionSemanticFingerprint: source.semanticFingerprint,
    expectedQuestionCount: sourceCandidates.eligibleQuestionCount,
    expectedCandidateCount: sourceCandidates.suggestionCount,
  });
  if (input.errorReviewRef !== undefined && input.errorReviewRef !== errorReviewRef) {
    throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_SOURCE_INVALID');
  }
  const errorReviewArtifactRef = deriveExamErrorReviewArtifactRef(errorReviewRef);
  if (
    input.errorReviewArtifactRef !== undefined &&
    input.errorReviewArtifactRef !== errorReviewArtifactRef
  ) {
    throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_SOURCE_INVALID');
  }

  const withoutFingerprint: Omit<ConfirmedExamErrorPatternReviewArtifactV1, 'semanticFingerprint'> =
    {
      schemaVersion: EXAM_ERROR_REVIEW_SCHEMA_VERSION,
      artifactVersion: EXAM_ERROR_REVIEW_ARTIFACT_VERSION,
      errorReviewVersion: EXAM_ERROR_REVIEW_VERSION,
      examSessionId: input.examSessionId,
      profileId: input.profileId,
      subjectId: input.subjectId,
      reviewedAt: input.reviewedAt,
      errorReviewRef,
      errorReviewArtifactRef,
      sourceSuggestions: source,
      authoritySource: EXAM_ERROR_PATTERN_AUTHORITY_SOURCE,
      decisionSemanticFingerprint,
      reviewedQuestionCount: questions.length,
      reviewedCandidateCount,
      acceptedCandidateCount,
      rejectedCandidateCount: reviewedCandidateCount - acceptedCandidateCount,
      confirmedObservationCount: observations.length,
      questions,
      questionResults,
      confirmedPatternObservations: observations,
    };
  const artifact: ConfirmedExamErrorPatternReviewArtifactV1 = {
    ...withoutFingerprint,
    semanticFingerprint:
      createConfirmedExamErrorPatternReviewSemanticFingerprint(withoutFingerprint),
  };
  if (!validateConfirmedExamErrorPatternReviewArtifact(artifact).valid) {
    throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT');
  }
  return artifact;
}

function validateSource(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamErrorReviewSourceSuggestionsV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected error suggestion source object');
    return false;
  }
  rejectUnknownKeys(value, SOURCE_KEYS, path, errors);
  if (Object.keys(value).length !== SOURCE_KEYS.size)
    pushIssue(errors, path, 'missing source field');
  if (value.artifactVersion !== EXAM_ERROR_SUGGESTION_ARTIFACT_VERSION) {
    pushIssue(errors, `${path}/artifactVersion`, 'unexpected candidate artifact version');
  }
  if (value.candidateSchemaVersion !== 1) {
    pushIssue(errors, `${path}/candidateSchemaVersion`, 'invalid candidate schema version');
  }
  if (value.generationVersion !== 1) {
    pushIssue(errors, `${path}/generationVersion`, 'invalid generation version');
  }
  validateIdentifier(value.generationRef, `${path}/generationRef`, errors);
  validateIdentifier(value.suggestionArtifactRef, `${path}/suggestionArtifactRef`, errors);
  if (!validSha256(value.suggestionArtifactSha256)) {
    pushIssue(errors, `${path}/suggestionArtifactSha256`, 'invalid source artifact digest');
  }
  if (!validSha256(value.semanticFingerprint)) {
    pushIssue(errors, `${path}/semanticFingerprint`, 'invalid source semantic fingerprint');
  }
  return errors.length === before;
}

function validateQuestionResults(
  value: unknown,
  errors: DomainValidationIssue[],
): ExamErrorReviewQuestionResultV1[] {
  if (!Array.isArray(value) || value.length > EXAM_ERROR_REVIEW_LIMITS.maxQuestions) {
    pushIssue(errors, '/questionResults', 'expected bounded question result array');
    return [];
  }
  const results: ExamErrorReviewQuestionResultV1[] = [];
  value.forEach((entry, index) => {
    const path = `/questionResults/${index}`;
    if (!isPlainRecord(entry)) {
      pushIssue(errors, path, 'expected question result object');
      return;
    }
    rejectUnknownKeys(entry, QUESTION_RESULT_KEYS, path, errors);
    validateIdentifier(entry.confirmedQuestionId, `${path}/confirmedQuestionId`, errors);
    if (!validCount(entry.reviewedCandidateCount, EXAM_ERROR_REVIEW_LIMITS.maxCandidateDecisions)) {
      pushIssue(errors, `${path}/reviewedCandidateCount`, 'invalid reviewed candidate count');
    }
    if (!validCount(entry.confirmedPatternCount, EXAM_ERROR_REVIEW_LIMITS.maxCandidateDecisions)) {
      pushIssue(errors, `${path}/confirmedPatternCount`, 'invalid confirmed pattern count');
    }
    if (typeof entry.hasConfirmedPattern !== 'boolean') {
      pushIssue(errors, `${path}/hasConfirmedPattern`, 'expected boolean');
    }
    if (
      typeof entry.confirmedQuestionId === 'string' &&
      Number.isSafeInteger(entry.reviewedCandidateCount) &&
      Number.isSafeInteger(entry.confirmedPatternCount) &&
      typeof entry.hasConfirmedPattern === 'boolean'
    ) {
      results.push(entry as unknown as ExamErrorReviewQuestionResultV1);
    }
  });
  return results;
}

export function validateConfirmedExamErrorPatternReviewArtifact(
  value: unknown,
): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected confirmed error pattern review artifact');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, ARTIFACT_KEYS, '', errors);
  if (Object.keys(value).length !== ARTIFACT_KEYS.size)
    pushIssue(errors, '', 'missing artifact field');
  if (value.schemaVersion !== EXAM_ERROR_REVIEW_SCHEMA_VERSION)
    pushIssue(errors, '/schemaVersion', 'unexpected schema version');
  if (value.artifactVersion !== EXAM_ERROR_REVIEW_ARTIFACT_VERSION)
    pushIssue(errors, '/artifactVersion', 'unexpected artifact version');
  if (value.errorReviewVersion !== EXAM_ERROR_REVIEW_VERSION)
    pushIssue(errors, '/errorReviewVersion', 'unexpected review version');
  for (const field of [
    'examSessionId',
    'profileId',
    'subjectId',
    'errorReviewRef',
    'errorReviewArtifactRef',
  ] as const) {
    validateIdentifier(value[field], `/${field}`, errors);
  }
  validateIsoDateTime(value.reviewedAt, '/reviewedAt', errors);
  const sourceValid = validateSource(value.sourceSuggestions, '/sourceSuggestions', errors);
  if (value.authoritySource !== EXAM_ERROR_PATTERN_AUTHORITY_SOURCE)
    pushIssue(errors, '/authoritySource', 'unexpected authority source');
  if (!validSha256(value.decisionSemanticFingerprint))
    pushIssue(errors, '/decisionSemanticFingerprint', 'invalid decision fingerprint');
  if (!validSha256(value.semanticFingerprint))
    pushIssue(errors, '/semanticFingerprint', 'invalid semantic fingerprint');

  let request: ExamErrorReviewRequestV1 | undefined;
  try {
    request = parseExamErrorReviewRequest({
      schemaVersion: EXAM_ERROR_REVIEW_SCHEMA_VERSION,
      questions: value.questions,
    });
    if (JSON.stringify(request.questions) !== JSON.stringify(value.questions)) {
      pushIssue(errors, '/questions', 'review questions are not canonical');
    }
  } catch {
    pushIssue(errors, '/questions', 'invalid review questions');
  }
  const questionResults = validateQuestionResults(value.questionResults, errors);
  if (
    JSON.stringify([...questionResults].sort(compareQuestion)) !==
    JSON.stringify(value.questionResults)
  ) {
    pushIssue(errors, '/questionResults', 'question results are not canonical');
  }
  const resultIds = questionResults.map((entry) => entry.confirmedQuestionId);
  if (new Set(resultIds).size !== resultIds.length)
    pushIssue(errors, '/questionResults', 'duplicate question result');

  const observations: ConfirmedExamErrorPatternObservationV1[] = [];
  if (
    !Array.isArray(value.confirmedPatternObservations) ||
    value.confirmedPatternObservations.length > EXAM_ERROR_REVIEW_LIMITS.maxCandidateDecisions
  ) {
    pushIssue(errors, '/confirmedPatternObservations', 'expected bounded observation array');
  } else {
    value.confirmedPatternObservations.forEach((entry, index) => {
      try {
        observations.push(parseConfirmedExamErrorPatternObservation(entry));
      } catch {
        pushIssue(
          errors,
          `/confirmedPatternObservations/${index}`,
          'invalid confirmed observation',
        );
      }
    });
  }
  if (
    JSON.stringify([...observations].sort(compareObservation)) !==
    JSON.stringify(value.confirmedPatternObservations)
  ) {
    pushIssue(errors, '/confirmedPatternObservations', 'confirmed observations are not canonical');
  }
  const observationIds = observations.map((entry) => entry.observationId);
  const sourceCandidateIds = observations.map((entry) => entry.sourceCandidateId);
  if (
    new Set(observationIds).size !== observationIds.length ||
    new Set(sourceCandidateIds).size !== sourceCandidateIds.length
  ) {
    pushIssue(errors, '/confirmedPatternObservations', 'duplicate confirmed observation');
  }

  for (const field of [
    'reviewedQuestionCount',
    'reviewedCandidateCount',
    'acceptedCandidateCount',
    'rejectedCandidateCount',
    'confirmedObservationCount',
  ] as const) {
    if (!validCount(value[field], EXAM_ERROR_REVIEW_LIMITS.maxCandidateDecisions))
      pushIssue(errors, `/${field}`, 'invalid aggregate count');
  }

  if (request) {
    const reviewedCandidates = request.questions.flatMap((question) => question.candidateDecisions);
    const accepted = reviewedCandidates.filter((decision) => decision.decision === 'accept');
    const resultByQuestion = new Map(
      questionResults.map((result) => [result.confirmedQuestionId, result]),
    );
    if (
      value.reviewedQuestionCount !== request.questions.length ||
      value.reviewedCandidateCount !== reviewedCandidates.length ||
      value.acceptedCandidateCount !== accepted.length ||
      value.rejectedCandidateCount !== reviewedCandidates.length - accepted.length ||
      value.confirmedObservationCount !== observations.length ||
      accepted.length !== observations.length ||
      !equalIds(
        request.questions.map((item) => item.confirmedQuestionId),
        resultIds,
      ) ||
      !equalIds(
        accepted.map((item) => item.candidateId),
        sourceCandidateIds,
      )
    ) {
      pushIssue(errors, '/reviewedQuestionCount', 'review aggregate facts do not match');
    }
    for (const question of request.questions) {
      const result = resultByQuestion.get(question.confirmedQuestionId);
      const acceptedForQuestion = question.candidateDecisions.filter(
        (item) => item.decision === 'accept',
      ).length;
      if (
        !result ||
        result.reviewedCandidateCount !== question.candidateDecisions.length ||
        result.confirmedPatternCount !== acceptedForQuestion ||
        result.hasConfirmedPattern !== acceptedForQuestion > 0
      ) {
        pushIssue(errors, '/questionResults', 'per-question result does not match decisions');
        break;
      }
      for (const decision of question.candidateDecisions) {
        if (decision.decision !== 'accept') continue;
        const observation = observations.find(
          (item) => item.sourceCandidateId === decision.candidateId,
        );
        if (!observation || observation.confirmedQuestionId !== question.confirmedQuestionId) {
          pushIssue(
            errors,
            '/confirmedPatternObservations',
            'observation question binding mismatch',
          );
        }
      }
    }
  }

  if (errors.length === 0 && sourceValid && request) {
    const source = value.sourceSuggestions as unknown as ExamErrorReviewSourceSuggestionsV1;
    const expectedReviewRef = deriveExamErrorReviewRef({
      examSessionId: String(value.examSessionId),
      profileId: String(value.profileId),
      errorReviewVersion: EXAM_ERROR_REVIEW_VERSION,
      sourceSuggestionGenerationVersion: source.generationVersion,
      sourceSuggestionGenerationRef: source.generationRef,
      sourceSuggestionArtifactRef: source.suggestionArtifactRef,
      sourceSuggestionArtifactFingerprint: source.suggestionArtifactSha256,
      sourceSuggestionSemanticFingerprint: source.semanticFingerprint,
      expectedQuestionCount: request.questions.length,
      expectedCandidateCount: request.questions.reduce(
        (count, question) => count + question.candidateDecisions.length,
        0,
      ),
    });
    if (value.errorReviewRef !== expectedReviewRef)
      pushIssue(errors, '/errorReviewRef', 'review reference mismatch');
    if (value.errorReviewArtifactRef !== deriveExamErrorReviewArtifactRef(expectedReviewRef))
      pushIssue(errors, '/errorReviewArtifactRef', 'artifact reference mismatch');
    const expectedDecisionFingerprint = createExamErrorReviewDecisionSemanticFingerprint({
      sourceCandidateArtifactRef: source.suggestionArtifactRef,
      sourceCandidateArtifactFingerprint: source.suggestionArtifactSha256,
      sourceCandidateSemanticFingerprint: source.semanticFingerprint,
      reviewVersion: EXAM_ERROR_REVIEW_VERSION,
      request,
    });
    if (value.decisionSemanticFingerprint !== expectedDecisionFingerprint)
      pushIssue(errors, '/decisionSemanticFingerprint', 'decision fingerprint mismatch');
    for (const observation of observations) {
      const expectedId = deriveConfirmedExamErrorPatternObservationId({
        examSessionId: String(value.examSessionId),
        sourceCandidateId: observation.sourceCandidateId,
        sourceCandidateArtifactFingerprint: source.suggestionArtifactSha256,
        sourceCandidateSemanticFingerprint: source.semanticFingerprint,
        errorReviewVersion: EXAM_ERROR_REVIEW_VERSION,
      });
      if (observation.observationId !== expectedId)
        pushIssue(errors, '/confirmedPatternObservations', 'observation id mismatch');
    }
  }

  if (errors.length === 0) {
    const artifact = value as unknown as ConfirmedExamErrorPatternReviewArtifactV1;
    const { semanticFingerprint: _ignored, ...withoutFingerprint } = artifact;
    if (
      createConfirmedExamErrorPatternReviewSemanticFingerprint(withoutFingerprint) !==
      artifact.semanticFingerprint
    ) {
      pushIssue(errors, '/semanticFingerprint', 'semantic fingerprint mismatch');
    }
  }
  return finishValidation(errors);
}

function canonicalArtifact(
  artifact: ConfirmedExamErrorPatternReviewArtifactV1,
): ConfirmedExamErrorPatternReviewArtifactV1 {
  return {
    schemaVersion: artifact.schemaVersion,
    artifactVersion: artifact.artifactVersion,
    errorReviewVersion: artifact.errorReviewVersion,
    examSessionId: artifact.examSessionId,
    profileId: artifact.profileId,
    subjectId: artifact.subjectId,
    reviewedAt: artifact.reviewedAt,
    errorReviewRef: artifact.errorReviewRef,
    errorReviewArtifactRef: artifact.errorReviewArtifactRef,
    sourceSuggestions: { ...artifact.sourceSuggestions },
    authoritySource: artifact.authoritySource,
    decisionSemanticFingerprint: artifact.decisionSemanticFingerprint,
    reviewedQuestionCount: artifact.reviewedQuestionCount,
    reviewedCandidateCount: artifact.reviewedCandidateCount,
    acceptedCandidateCount: artifact.acceptedCandidateCount,
    rejectedCandidateCount: artifact.rejectedCandidateCount,
    confirmedObservationCount: artifact.confirmedObservationCount,
    questions: artifact.questions.map(cloneQuestion).sort(compareQuestion),
    questionResults: artifact.questionResults.map((entry) => ({ ...entry })).sort(compareQuestion),
    confirmedPatternObservations: artifact.confirmedPatternObservations
      .map(cloneObservation)
      .sort(compareObservation),
    semanticFingerprint: artifact.semanticFingerprint,
  };
}

export function parseConfirmedExamErrorPatternReviewArtifact(
  value: unknown,
): ConfirmedExamErrorPatternReviewArtifactV1 {
  let decoded = value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    if (value.byteLength > EXAM_ERROR_REVIEW_LIMITS.maxArtifactBytes) {
      throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT');
    }
    try {
      decoded = JSON.parse(UTF8_DECODER.decode(value)) as unknown;
    } catch {
      throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT');
    }
  }
  if (!validateConfirmedExamErrorPatternReviewArtifact(decoded).valid) {
    throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT');
  }
  return canonicalArtifact(decoded as ConfirmedExamErrorPatternReviewArtifactV1);
}

export function serializeConfirmedExamErrorPatternReviewArtifact(value: unknown): Buffer {
  const bytes = Buffer.from(
    JSON.stringify(parseConfirmedExamErrorPatternReviewArtifact(value)),
    'utf8',
  );
  if (bytes.byteLength > EXAM_ERROR_REVIEW_LIMITS.maxArtifactBytes) {
    throw new ExamErrorReviewPrivateError('EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT');
  }
  return bytes;
}
