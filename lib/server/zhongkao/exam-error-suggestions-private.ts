import { createHash } from 'node:crypto';

import {
  EXAM_ERROR_DIAGNOSIS_GENERATOR_VERSION,
  EXAM_ERROR_MODEL_POLICY_VERSION,
  EXAM_ERROR_OBSERVABLE_RULES_VERSION,
  EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS,
  EXAM_ERROR_SUGGESTION_SCHEMA_VERSION,
  canonicalizeExamErrorSuggestionQuestionDrafts,
  isExamErrorSuggestionTextSpanGrounded,
  parseExamErrorSuggestionDraft,
  type ExamErrorSuggestionCandidateV1,
  type ExamErrorSuggestionQuestionDraftV1,
  type PublicExamErrorSuggestionsBundleV1,
} from '@/lib/zhongkao/exam-error-suggestions';
import {
  serializeConfirmedExamReviewFacts,
  validateConfirmedExamReviewFacts,
  type ConfirmedExamReviewFactsV1,
} from '@/lib/zhongkao/exam-human-review';
import {
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  type DomainValidationIssue,
  type DomainValidationResult,
} from '@/lib/zhongkao/validation';

import {
  detectExamObservableErrorSuggestions,
  ExamErrorObservableDetectorError,
} from './exam-error-observable-detector';
import {
  EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
  serializeAuthoritativeExamAnswerKeyArtifact,
  serializeExamQuestionAssessmentsArtifact,
  validateAuthoritativeExamAnswerKeyArtifact,
  validateExamQuestionAssessmentsArtifact,
  type AuthoritativeExamAnswerKeyArtifactV1,
  type ExamConfirmedReviewSourceV1,
  type ExamQuestionAssessmentsArtifactV1,
} from './exam-grading-private';
import {
  deriveExamErrorSuggestionsArtifactRef,
  deriveExamErrorSuggestionsGenerationRef,
} from './exam-runtime';

export const EXAM_ERROR_SUGGESTION_ARTIFACT_VERSION = 1 as const;
export const EXAM_ERROR_SUGGESTION_GENERATION_VERSION = 1 as const;
export const EXAM_ERROR_SUGGESTION_MODEL_STAGE = 'exam-error-suggestions' as const;

export type ExamErrorSuggestionModelExecutionV1 =
  | {
      status: 'not_used';
      stage: typeof EXAM_ERROR_SUGGESTION_MODEL_STAGE;
    }
  | {
      status: 'used';
      stage: typeof EXAM_ERROR_SUGGESTION_MODEL_STAGE;
      providerId: string;
      modelId: string;
    };

export type ExamErrorSuggestionUsedModelExecutionV1 = Extract<
  ExamErrorSuggestionModelExecutionV1,
  { status: 'used' }
>;

export interface ExamErrorSuggestionAnswerKeySourceV1 {
  answerKeyVersion: number;
  answerKeyRef: string;
  answerKeyArtifactRef: string;
  answerKeyArtifactSha256: string;
  semanticFingerprint: string;
}

export interface ExamErrorSuggestionAssessmentSourceV1 {
  assessmentVersion: number;
  gradingAlgorithmVersion: typeof EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION;
  gradingRef: string;
  assessmentArtifactRef: string;
  assessmentArtifactSha256: string;
  semanticFingerprint: string;
}

export interface ExamErrorSuggestionGeneratorV1 {
  generatorVersion: typeof EXAM_ERROR_DIAGNOSIS_GENERATOR_VERSION;
  detectorVersion: typeof EXAM_ERROR_OBSERVABLE_RULES_VERSION;
  modelPolicyVersion: typeof EXAM_ERROR_MODEL_POLICY_VERSION;
  candidateSchemaVersion: typeof EXAM_ERROR_SUGGESTION_SCHEMA_VERSION;
}

export interface ExamErrorSuggestionQuestionV1 {
  confirmedQuestionId: string;
  assessmentId: string;
  assessmentOutcome: 'incorrect';
  generationStatus: ExamErrorSuggestionQuestionDraftV1['generationStatus'];
  suggestions: ExamErrorSuggestionCandidateV1[];
}

export interface ExamErrorDiagnosisCandidatesArtifactV1 {
  schemaVersion: typeof EXAM_ERROR_SUGGESTION_SCHEMA_VERSION;
  artifactVersion: typeof EXAM_ERROR_SUGGESTION_ARTIFACT_VERSION;
  generationVersion: typeof EXAM_ERROR_SUGGESTION_GENERATION_VERSION;
  examSessionId: string;
  profileId: string;
  subjectId: string;
  generationRef: string;
  suggestionArtifactRef: string;
  candidateStatus: typeof EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS;
  sourceReview: ExamConfirmedReviewSourceV1;
  sourceAnswerKey: ExamErrorSuggestionAnswerKeySourceV1;
  sourceAssessment: ExamErrorSuggestionAssessmentSourceV1;
  generator: ExamErrorSuggestionGeneratorV1;
  modelExecution: ExamErrorSuggestionModelExecutionV1;
  semanticFingerprint: string;
  eligibleQuestionCount: number;
  candidateQuestionCount: number;
  noSuggestionQuestionCount: number;
  inputTooLargeQuestionCount: number;
  suggestionCount: number;
  deterministicSuggestionCount: number;
  modelSuggestionCount: number;
  questions: ExamErrorSuggestionQuestionV1[];
}

export type ExamErrorDiagnosisCandidatesV1 = ExamErrorDiagnosisCandidatesArtifactV1;
export type ExamErrorSuggestionsArtifactV1 = ExamErrorDiagnosisCandidatesArtifactV1;

export type ExamErrorSuggestionsPrivateErrorCode =
  | 'EXAM_ERROR_SUGGESTION_INPUT_INVALID'
  | 'EXAM_ERROR_SUGGESTION_INCOMPLETE'
  | 'EXAM_ERROR_SUGGESTION_SOURCE_INVALID'
  | 'EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT';

export class ExamErrorSuggestionsPrivateError extends Error {
  override readonly name = 'ExamErrorSuggestionsPrivateError';

  constructor(readonly code: ExamErrorSuggestionsPrivateErrorCode) {
    super(code);
  }
}

export interface BuildExamErrorSuggestionsArtifactInput {
  examSessionId: string;
  profileId: string;
  subjectId: string;
  confirmedReview: ConfirmedExamReviewFactsV1;
  confirmedReviewArtifactSha256: string;
  answerKey: AuthoritativeExamAnswerKeyArtifactV1;
  answerKeyArtifactRef: string;
  answerKeyArtifactSha256: string;
  assessments: ExamQuestionAssessmentsArtifactV1;
  assessmentArtifactRef: string;
  assessmentArtifactSha256: string;
  generator: ExamErrorSuggestionGeneratorV1;
  modelExecution: ExamErrorSuggestionModelExecutionV1;
  questionDrafts: readonly ExamErrorSuggestionQuestionDraftV1[];
  generationRef?: string;
  suggestionArtifactRef?: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_QUESTIONS = 500;
const MAX_SUGGESTIONS_PER_QUESTION = 3;

const REVIEW_SOURCE_KEYS = new Set([
  'reviewRef',
  'reviewArtifactRef',
  'reviewArtifactSha256',
  'reviewVersion',
  'reviewArtifactVersion',
  'decisionSemanticFingerprint',
]);
const ANSWER_KEY_SOURCE_KEYS = new Set([
  'answerKeyVersion',
  'answerKeyRef',
  'answerKeyArtifactRef',
  'answerKeyArtifactSha256',
  'semanticFingerprint',
]);
const ASSESSMENT_SOURCE_KEYS = new Set([
  'assessmentVersion',
  'gradingAlgorithmVersion',
  'gradingRef',
  'assessmentArtifactRef',
  'assessmentArtifactSha256',
  'semanticFingerprint',
]);
const GENERATOR_KEYS = new Set([
  'generatorVersion',
  'detectorVersion',
  'modelPolicyVersion',
  'candidateSchemaVersion',
]);
const MODEL_EXECUTION_NOT_USED_KEYS = new Set(['status', 'stage']);
const MODEL_EXECUTION_USED_KEYS = new Set(['status', 'stage', 'providerId', 'modelId']);
const QUESTION_KEYS = new Set([
  'confirmedQuestionId',
  'assessmentId',
  'assessmentOutcome',
  'generationStatus',
  'suggestions',
]);
const CANDIDATE_KEYS = new Set([
  'candidateId',
  'ordinal',
  'kind',
  'generationSource',
  'candidateStatus',
  'confidenceBand',
  'evidence',
]);
const ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactVersion',
  'generationVersion',
  'examSessionId',
  'profileId',
  'subjectId',
  'generationRef',
  'suggestionArtifactRef',
  'candidateStatus',
  'sourceReview',
  'sourceAnswerKey',
  'sourceAssessment',
  'generator',
  'modelExecution',
  'semanticFingerprint',
  'eligibleQuestionCount',
  'candidateQuestionCount',
  'noSuggestionQuestionCount',
  'inputTooLargeQuestionCount',
  'suggestionCount',
  'deterministicSuggestionCount',
  'modelSuggestionCount',
  'questions',
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function reviewSource(
  review: ConfirmedExamReviewFactsV1,
  artifactSha256: string,
): ExamConfirmedReviewSourceV1 {
  return {
    reviewRef: review.reviewRef,
    reviewArtifactRef: review.reviewArtifactRef,
    reviewArtifactSha256: artifactSha256,
    reviewVersion: review.reviewVersion,
    reviewArtifactVersion: review.artifactVersion,
    decisionSemanticFingerprint: review.decisionSemanticFingerprint,
  };
}

function generatorValid(value: unknown): value is ExamErrorSuggestionGeneratorV1 {
  return (
    isPlainRecord(value) &&
    Object.keys(value).every((key) => GENERATOR_KEYS.has(key)) &&
    Object.keys(value).length === GENERATOR_KEYS.size &&
    value.generatorVersion === EXAM_ERROR_DIAGNOSIS_GENERATOR_VERSION &&
    value.detectorVersion === EXAM_ERROR_OBSERVABLE_RULES_VERSION &&
    value.modelPolicyVersion === EXAM_ERROR_MODEL_POLICY_VERSION &&
    value.candidateSchemaVersion === EXAM_ERROR_SUGGESTION_SCHEMA_VERSION
  );
}

function modelExecutionValid(value: unknown): value is ExamErrorSuggestionModelExecutionV1 {
  if (!isPlainRecord(value) || value.stage !== EXAM_ERROR_SUGGESTION_MODEL_STAGE) return false;
  const errors: DomainValidationIssue[] = [];
  if (value.status === 'not_used') {
    rejectUnknownKeys(value, MODEL_EXECUTION_NOT_USED_KEYS, '/modelExecution', errors);
    return Object.keys(value).length === MODEL_EXECUTION_NOT_USED_KEYS.size && errors.length === 0;
  }
  if (value.status !== 'used') return false;
  rejectUnknownKeys(value, MODEL_EXECUTION_USED_KEYS, '/modelExecution', errors);
  validateIdentifier(value.providerId, '/modelExecution/providerId', errors);
  validateIdentifier(value.modelId, '/modelExecution/modelId', errors);
  return Object.keys(value).length === MODEL_EXECUTION_USED_KEYS.size && errors.length === 0;
}

function sourceFactsValid(input: BuildExamErrorSuggestionsArtifactInput): boolean {
  if (
    !validateConfirmedExamReviewFacts(input.confirmedReview).valid ||
    !validateAuthoritativeExamAnswerKeyArtifact(input.answerKey).valid ||
    !validateExamQuestionAssessmentsArtifact(input.assessments).valid ||
    !generatorValid(input.generator) ||
    !modelExecutionValid(input.modelExecution) ||
    !validSha256(input.confirmedReviewArtifactSha256) ||
    !validSha256(input.answerKeyArtifactSha256) ||
    !validSha256(input.assessmentArtifactSha256)
  ) {
    return false;
  }
  let reviewBytes: Buffer;
  let answerKeyBytes: Buffer;
  let assessmentBytes: Buffer;
  try {
    reviewBytes = serializeConfirmedExamReviewFacts(input.confirmedReview);
    answerKeyBytes = serializeAuthoritativeExamAnswerKeyArtifact(input.answerKey);
    assessmentBytes = serializeExamQuestionAssessmentsArtifact(input.assessments);
  } catch {
    return false;
  }
  return (
    sha256(reviewBytes) === input.confirmedReviewArtifactSha256 &&
    sha256(answerKeyBytes) === input.answerKeyArtifactSha256 &&
    sha256(assessmentBytes) === input.assessmentArtifactSha256 &&
    input.confirmedReview.examSessionId === input.examSessionId &&
    input.answerKey.examSessionId === input.examSessionId &&
    input.assessments.examSessionId === input.examSessionId &&
    input.answerKey.subjectId === input.subjectId &&
    input.answerKey.sourceReview.reviewRef === input.confirmedReview.reviewRef &&
    input.answerKey.sourceReview.reviewArtifactRef === input.confirmedReview.reviewArtifactRef &&
    input.answerKey.sourceReview.reviewArtifactSha256 === input.confirmedReviewArtifactSha256 &&
    input.answerKey.sourceReview.decisionSemanticFingerprint ===
      input.confirmedReview.decisionSemanticFingerprint &&
    input.assessments.sourceReview.reviewRef === input.confirmedReview.reviewRef &&
    input.assessments.sourceReview.reviewArtifactRef === input.confirmedReview.reviewArtifactRef &&
    input.assessments.sourceReview.reviewArtifactSha256 === input.confirmedReviewArtifactSha256 &&
    input.assessments.answerKeyRef === input.answerKey.answerKeyRef &&
    input.assessments.answerKeySemanticFingerprint === input.answerKey.semanticFingerprint &&
    input.assessments.answerKeyArtifactSha256 === input.answerKeyArtifactSha256
  );
}

function semanticDraftKey(
  value: ExamErrorSuggestionQuestionDraftV1['suggestions'][number],
): string {
  return JSON.stringify(canonicalize({ kind: value.kind, evidence: value.evidence }));
}

function completeDraftKey(
  value: ExamErrorSuggestionQuestionDraftV1['suggestions'][number],
): string {
  return JSON.stringify(canonicalize(value));
}

function validateDraftsAgainstSources(
  input: BuildExamErrorSuggestionsArtifactInput,
): ExamErrorSuggestionQuestionDraftV1[] {
  let drafts: ExamErrorSuggestionQuestionDraftV1[];
  let expected: ExamErrorSuggestionQuestionDraftV1[];
  try {
    drafts = canonicalizeExamErrorSuggestionQuestionDrafts(input.questionDrafts);
    expected = detectExamObservableErrorSuggestions({
      confirmedReview: input.confirmedReview,
      answerKey: input.answerKey,
      assessments: input.assessments,
    });
  } catch (error) {
    if (error instanceof ExamErrorObservableDetectorError) {
      throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_SOURCE_INVALID');
    }
    throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_INPUT_INVALID');
  }
  if (drafts.length !== expected.length) {
    throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_INCOMPLETE');
  }
  const expectedById = new Map(expected.map((draft) => [draft.confirmedQuestionId, draft]));
  const questionById = new Map(
    input.confirmedReview.confirmedQuestions.map((question) => [
      question.confirmedQuestionId,
      question,
    ]),
  );
  const responseById = new Map(
    input.confirmedReview.confirmedResponses.map((response) => [
      response.confirmedQuestionId,
      response,
    ]),
  );
  for (const draft of drafts) {
    const expectedDraft = expectedById.get(draft.confirmedQuestionId);
    const question = questionById.get(draft.confirmedQuestionId);
    const response = responseById.get(draft.confirmedQuestionId);
    if (!expectedDraft || !question || !response) {
      throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_INCOMPLETE');
    }
    const deterministic = draft.suggestions.filter(
      (suggestion) => suggestion.generationSource === 'deterministic_candidate',
    );
    const expectedKeys = expectedDraft.suggestions.map(completeDraftKey).sort();
    const actualKeys = deterministic.map(completeDraftKey).sort();
    if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
      throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_SOURCE_INVALID');
    }
    const formatEligible = expectedDraft.suggestions.some(
      (suggestion) =>
        suggestion.kind === 'response_format_mismatch_candidate' &&
        suggestion.evidence.some(
          (evidence) =>
            evidence.evidenceType === 'format_observation' && evidence.gradingType === 'numeric',
        ),
    );
    for (const suggestion of draft.suggestions) {
      if (suggestion.generationSource !== 'model_candidate') continue;
      if (
        !formatEligible ||
        suggestion.kind !== 'unit_error_candidate' ||
        response.answerStatus !== 'text' ||
        typeof response.rawAnswerText !== 'string' ||
        !suggestion.evidence.every(
          (evidence) =>
            evidence.evidenceType === 'text_span' &&
            isExamErrorSuggestionTextSpanGrounded(evidence, {
              questionText: question.questionText,
              parentContext: question.parentContext?.questionText,
              responseText: response.rawAnswerText,
            }),
        )
      ) {
        throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_SOURCE_INVALID');
      }
    }
    if (
      (draft.suggestions.length > 0 && draft.generationStatus !== 'generated') ||
      (draft.suggestions.length === 0 && draft.generationStatus === 'generated')
    ) {
      throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_INPUT_INVALID');
    }
  }
  return drafts;
}

export function deriveExamErrorSuggestionCandidateId(input: {
  generationRef: string;
  confirmedQuestionId: string;
  suggestion: ExamErrorSuggestionQuestionDraftV1['suggestions'][number];
  ordinal: number;
}): string {
  return `exam-error-suggestion:v1:${fingerprint(
    'openmaic:zhongkao-exam-error-suggestion-candidate:v1',
    input,
  )}`;
}

export function createExamErrorSuggestionsSemanticFingerprint(
  artifact: Omit<ExamErrorDiagnosisCandidatesArtifactV1, 'semanticFingerprint'>,
): string {
  return fingerprint('openmaic:zhongkao-exam-error-suggestions-semantic:v1', artifact);
}

export function buildExamErrorSuggestionsArtifact(
  input: BuildExamErrorSuggestionsArtifactInput,
): ExamErrorDiagnosisCandidatesArtifactV1 {
  const idErrors: DomainValidationIssue[] = [];
  validateIdentifier(input.examSessionId, '/examSessionId', idErrors);
  validateIdentifier(input.profileId, '/profileId', idErrors);
  validateIdentifier(input.subjectId, '/subjectId', idErrors);
  validateIdentifier(input.answerKeyArtifactRef, '/answerKeyArtifactRef', idErrors);
  validateIdentifier(input.assessmentArtifactRef, '/assessmentArtifactRef', idErrors);
  if (idErrors.length > 0 || !sourceFactsValid(input)) {
    throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_SOURCE_INVALID');
  }
  const drafts = validateDraftsAgainstSources(input);
  const sourceReview = reviewSource(input.confirmedReview, input.confirmedReviewArtifactSha256);
  const sourceAnswerKey: ExamErrorSuggestionAnswerKeySourceV1 = {
    answerKeyVersion: input.answerKey.answerKeyVersion,
    answerKeyRef: input.answerKey.answerKeyRef,
    answerKeyArtifactRef: input.answerKeyArtifactRef,
    answerKeyArtifactSha256: input.answerKeyArtifactSha256,
    semanticFingerprint: input.answerKey.semanticFingerprint,
  };
  const sourceAssessment: ExamErrorSuggestionAssessmentSourceV1 = {
    assessmentVersion: input.assessments.assessmentVersion,
    gradingAlgorithmVersion: input.assessments.gradingAlgorithmVersion,
    gradingRef: input.assessments.assessmentRef,
    assessmentArtifactRef: input.assessmentArtifactRef,
    assessmentArtifactSha256: input.assessmentArtifactSha256,
    semanticFingerprint: input.assessments.semanticFingerprint,
  };
  const generationRef = deriveExamErrorSuggestionsGenerationRef({
    examSessionId: input.examSessionId,
    profileId: input.profileId,
    generationVersion: EXAM_ERROR_SUGGESTION_GENERATION_VERSION,
    subjectId: input.subjectId,
    ...input.generator,
    reviewVersion: sourceReview.reviewVersion,
    reviewArtifactRef: sourceReview.reviewArtifactRef,
    sourceReviewArtifactFingerprint: sourceReview.reviewArtifactSha256,
    sourceReviewSemanticFingerprint: sourceReview.decisionSemanticFingerprint,
    answerKeyVersion: sourceAnswerKey.answerKeyVersion,
    answerKeyRef: sourceAnswerKey.answerKeyRef,
    answerKeyArtifactRef: sourceAnswerKey.answerKeyArtifactRef,
    sourceAnswerKeyArtifactFingerprint: sourceAnswerKey.answerKeyArtifactSha256,
    sourceAnswerKeySemanticFingerprint: sourceAnswerKey.semanticFingerprint,
    assessmentVersion: sourceAssessment.assessmentVersion,
    gradingAlgorithmVersion:
      sourceAssessment.gradingAlgorithmVersion as ExamQuestionAssessmentsArtifactV1['gradingAlgorithmVersion'],
    gradingRef: sourceAssessment.gradingRef,
    assessmentArtifactRef: sourceAssessment.assessmentArtifactRef,
    sourceAssessmentArtifactFingerprint: sourceAssessment.assessmentArtifactSha256,
    sourceAssessmentSemanticFingerprint: sourceAssessment.semanticFingerprint,
  });
  if (input.generationRef !== undefined && input.generationRef !== generationRef) {
    throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_SOURCE_INVALID');
  }
  const suggestionArtifactRef = deriveExamErrorSuggestionsArtifactRef(generationRef);
  if (
    input.suggestionArtifactRef !== undefined &&
    input.suggestionArtifactRef !== suggestionArtifactRef
  ) {
    throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_SOURCE_INVALID');
  }
  const assessments = new Map(
    input.assessments.assessments.map((assessment) => [assessment.confirmedQuestionId, assessment]),
  );
  const questions: ExamErrorSuggestionQuestionV1[] = drafts.map((draft) => {
    const assessment = assessments.get(draft.confirmedQuestionId);
    if (!assessment || assessment.status !== 'evaluated' || assessment.outcome !== 'incorrect') {
      throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_SOURCE_INVALID');
    }
    return {
      confirmedQuestionId: draft.confirmedQuestionId,
      assessmentId: assessment.assessmentId,
      assessmentOutcome: 'incorrect',
      generationStatus: draft.generationStatus,
      suggestions: draft.suggestions.map((suggestion, ordinal) => ({
        candidateId: deriveExamErrorSuggestionCandidateId({
          generationRef,
          confirmedQuestionId: draft.confirmedQuestionId,
          suggestion,
          ordinal,
        }),
        ordinal,
        ...suggestion,
        evidence: suggestion.evidence.map((evidence) => ({ ...evidence })),
      })),
    };
  });
  const suggestionCount = questions.reduce((sum, question) => sum + question.suggestions.length, 0);
  const withoutFingerprint: Omit<ExamErrorDiagnosisCandidatesArtifactV1, 'semanticFingerprint'> = {
    schemaVersion: EXAM_ERROR_SUGGESTION_SCHEMA_VERSION,
    artifactVersion: EXAM_ERROR_SUGGESTION_ARTIFACT_VERSION,
    generationVersion: EXAM_ERROR_SUGGESTION_GENERATION_VERSION,
    examSessionId: input.examSessionId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    generationRef,
    suggestionArtifactRef,
    candidateStatus: EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS,
    sourceReview,
    sourceAnswerKey,
    sourceAssessment,
    generator: { ...input.generator },
    modelExecution: { ...input.modelExecution },
    eligibleQuestionCount: questions.length,
    candidateQuestionCount: questions.filter(
      (question) => question.generationStatus === 'generated',
    ).length,
    noSuggestionQuestionCount: questions.filter(
      (question) => question.generationStatus === 'no_suggestion',
    ).length,
    inputTooLargeQuestionCount: questions.filter(
      (question) => question.generationStatus === 'input_too_large',
    ).length,
    suggestionCount,
    deterministicSuggestionCount: questions.reduce(
      (sum, question) =>
        sum +
        question.suggestions.filter((item) => item.generationSource === 'deterministic_candidate')
          .length,
      0,
    ),
    modelSuggestionCount: questions.reduce(
      (sum, question) =>
        sum +
        question.suggestions.filter((item) => item.generationSource === 'model_candidate').length,
      0,
    ),
    questions,
  };
  const artifact: ExamErrorDiagnosisCandidatesArtifactV1 = {
    ...withoutFingerprint,
    semanticFingerprint: createExamErrorSuggestionsSemanticFingerprint(withoutFingerprint),
  };
  if (!validateExamErrorSuggestionsArtifact(artifact).valid) {
    throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT');
  }
  return artifact;
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function validateSourceObject(
  value: unknown,
  keys: ReadonlySet<string>,
  path: string,
  errors: DomainValidationIssue[],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected source object');
    return false;
  }
  rejectUnknownKeys(value, keys, path, errors);
  if (Object.keys(value).length !== keys.size) pushIssue(errors, path, 'missing source field');
  return true;
}

function validateArtifactQuestion(
  value: unknown,
  generationRef: string,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamErrorSuggestionQuestionV1 {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected error suggestion question');
    return false;
  }
  rejectUnknownKeys(value, QUESTION_KEYS, path, errors);
  validateIdentifier(value.confirmedQuestionId, `${path}/confirmedQuestionId`, errors);
  validateIdentifier(value.assessmentId, `${path}/assessmentId`, errors);
  if (value.assessmentOutcome !== 'incorrect')
    pushIssue(errors, `${path}/assessmentOutcome`, 'must be incorrect');
  if (
    value.generationStatus !== 'generated' &&
    value.generationStatus !== 'no_suggestion' &&
    value.generationStatus !== 'input_too_large'
  ) {
    pushIssue(errors, `${path}/generationStatus`, 'unknown generation status');
  }
  if (
    !Array.isArray(value.suggestions) ||
    value.suggestions.length > MAX_SUGGESTIONS_PER_QUESTION
  ) {
    pushIssue(errors, `${path}/suggestions`, 'expected bounded suggestions');
    return false;
  }
  for (const [index, rawCandidate] of value.suggestions.entries()) {
    const candidatePath = `${path}/suggestions/${index}`;
    if (!isPlainRecord(rawCandidate)) {
      pushIssue(errors, candidatePath, 'expected candidate object');
      continue;
    }
    rejectUnknownKeys(rawCandidate, CANDIDATE_KEYS, candidatePath, errors);
    validateIdentifier(rawCandidate.candidateId, `${candidatePath}/candidateId`, errors);
    if (rawCandidate.ordinal !== index)
      pushIssue(errors, `${candidatePath}/ordinal`, 'invalid ordinal');
    const { candidateId: _id, ordinal: _ordinal, ...rawDraft } = rawCandidate;
    try {
      const draft = parseExamErrorSuggestionDraft(rawDraft);
      const expectedId = deriveExamErrorSuggestionCandidateId({
        generationRef,
        confirmedQuestionId: String(value.confirmedQuestionId),
        suggestion: draft,
        ordinal: index,
      });
      if (rawCandidate.candidateId !== expectedId) {
        pushIssue(errors, `${candidatePath}/candidateId`, 'candidate id mismatch');
      }
    } catch {
      pushIssue(errors, candidatePath, 'invalid candidate');
    }
  }
  const semanticKeys = value.suggestions
    .filter(isPlainRecord)
    .map(({ candidateId: _candidateId, ordinal: _ordinal, ...draft }) =>
      semanticDraftKey(
        draft as unknown as ExamErrorSuggestionQuestionDraftV1['suggestions'][number],
      ),
    );
  if (new Set(semanticKeys).size !== semanticKeys.length) {
    pushIssue(errors, `${path}/suggestions`, 'duplicate semantic candidate');
  }
  if (JSON.stringify([...semanticKeys].sort()) !== JSON.stringify(semanticKeys)) {
    pushIssue(errors, `${path}/suggestions`, 'candidates not canonical');
  }
  if (
    (value.generationStatus === 'generated' && value.suggestions.length === 0) ||
    (value.generationStatus !== 'generated' && value.suggestions.length !== 0)
  ) {
    pushIssue(errors, `${path}/suggestions`, 'generation status mismatch');
  }
  return true;
}

export function validateExamErrorSuggestionsArtifact(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected error suggestion artifact');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, ARTIFACT_KEYS, '', errors);
  if (Object.keys(value).length !== ARTIFACT_KEYS.size)
    pushIssue(errors, '', 'missing artifact field');
  if (value.schemaVersion !== EXAM_ERROR_SUGGESTION_SCHEMA_VERSION)
    pushIssue(errors, '/schemaVersion', 'unknown schema version');
  if (value.artifactVersion !== EXAM_ERROR_SUGGESTION_ARTIFACT_VERSION)
    pushIssue(errors, '/artifactVersion', 'unknown artifact version');
  if (value.generationVersion !== EXAM_ERROR_SUGGESTION_GENERATION_VERSION)
    pushIssue(errors, '/generationVersion', 'unknown generation version');
  validateIdentifier(value.examSessionId, '/examSessionId', errors);
  validateIdentifier(value.profileId, '/profileId', errors);
  validateIdentifier(value.subjectId, '/subjectId', errors);
  validateIdentifier(value.generationRef, '/generationRef', errors);
  validateIdentifier(value.suggestionArtifactRef, '/suggestionArtifactRef', errors);
  if (value.candidateStatus !== EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS)
    pushIssue(errors, '/candidateStatus', 'must remain candidate');
  if (!validSha256(value.semanticFingerprint))
    pushIssue(errors, '/semanticFingerprint', 'invalid sha256');

  const reviewValid = validateSourceObject(
    value.sourceReview,
    REVIEW_SOURCE_KEYS,
    '/sourceReview',
    errors,
  );
  const review = isPlainRecord(value.sourceReview) ? value.sourceReview : undefined;
  if (reviewValid && review) {
    validateIdentifier(review.reviewRef, '/sourceReview/reviewRef', errors);
    validateIdentifier(review.reviewArtifactRef, '/sourceReview/reviewArtifactRef', errors);
    if (!validSha256(review.reviewArtifactSha256))
      pushIssue(errors, '/sourceReview/reviewArtifactSha256', 'invalid sha256');
    if (!validSha256(review.decisionSemanticFingerprint))
      pushIssue(errors, '/sourceReview/decisionSemanticFingerprint', 'invalid sha256');
    if (!integerInRange(review.reviewVersion, 1, 9999))
      pushIssue(errors, '/sourceReview/reviewVersion', 'invalid version');
    if (!integerInRange(review.reviewArtifactVersion, 1, 9999))
      pushIssue(errors, '/sourceReview/reviewArtifactVersion', 'invalid version');
  }
  const answerKeyValid = validateSourceObject(
    value.sourceAnswerKey,
    ANSWER_KEY_SOURCE_KEYS,
    '/sourceAnswerKey',
    errors,
  );
  const answerKey = isPlainRecord(value.sourceAnswerKey) ? value.sourceAnswerKey : undefined;
  if (answerKeyValid && answerKey) {
    validateIdentifier(answerKey.answerKeyRef, '/sourceAnswerKey/answerKeyRef', errors);
    validateIdentifier(
      answerKey.answerKeyArtifactRef,
      '/sourceAnswerKey/answerKeyArtifactRef',
      errors,
    );
    if (!integerInRange(answerKey.answerKeyVersion, 1, 9999))
      pushIssue(errors, '/sourceAnswerKey/answerKeyVersion', 'invalid version');
    if (!validSha256(answerKey.answerKeyArtifactSha256))
      pushIssue(errors, '/sourceAnswerKey/answerKeyArtifactSha256', 'invalid sha256');
    if (!validSha256(answerKey.semanticFingerprint))
      pushIssue(errors, '/sourceAnswerKey/semanticFingerprint', 'invalid sha256');
  }
  const assessmentValid = validateSourceObject(
    value.sourceAssessment,
    ASSESSMENT_SOURCE_KEYS,
    '/sourceAssessment',
    errors,
  );
  const assessment = isPlainRecord(value.sourceAssessment) ? value.sourceAssessment : undefined;
  if (assessmentValid && assessment) {
    validateIdentifier(assessment.gradingRef, '/sourceAssessment/gradingRef', errors);
    validateIdentifier(
      assessment.assessmentArtifactRef,
      '/sourceAssessment/assessmentArtifactRef',
      errors,
    );
    if (!integerInRange(assessment.assessmentVersion, 1, 9999))
      pushIssue(errors, '/sourceAssessment/assessmentVersion', 'invalid version');
    if (assessment.gradingAlgorithmVersion !== EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION) {
      pushIssue(
        errors,
        '/sourceAssessment/gradingAlgorithmVersion',
        `expected ${EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION}`,
      );
    }
    if (!validSha256(assessment.assessmentArtifactSha256))
      pushIssue(errors, '/sourceAssessment/assessmentArtifactSha256', 'invalid sha256');
    if (!validSha256(assessment.semanticFingerprint))
      pushIssue(errors, '/sourceAssessment/semanticFingerprint', 'invalid sha256');
  }
  if (!generatorValid(value.generator))
    pushIssue(errors, '/generator', 'invalid generator descriptor');
  if (!modelExecutionValid(value.modelExecution))
    pushIssue(errors, '/modelExecution', 'invalid model execution metadata');

  const countNames = [
    'eligibleQuestionCount',
    'candidateQuestionCount',
    'noSuggestionQuestionCount',
    'inputTooLargeQuestionCount',
    'suggestionCount',
    'deterministicSuggestionCount',
    'modelSuggestionCount',
  ] as const;
  for (const name of countNames) {
    if (
      !integerInRange(
        value[name],
        0,
        name === 'suggestionCount' || name.endsWith('SuggestionCount') ? 1500 : 500,
      )
    ) {
      pushIssue(errors, `/${name}`, 'invalid count');
    }
  }
  if (!Array.isArray(value.questions) || value.questions.length > MAX_QUESTIONS) {
    pushIssue(errors, '/questions', 'expected bounded question array');
  } else if (typeof value.generationRef === 'string') {
    value.questions.forEach((question, index) =>
      validateArtifactQuestion(
        question,
        value.generationRef as string,
        `/questions/${index}`,
        errors,
      ),
    );
    const typed = value.questions.filter(isPlainRecord);
    const ids = typed.map((question) => question.confirmedQuestionId);
    if (new Set(ids).size !== ids.length) pushIssue(errors, '/questions', 'duplicate question');
    if (JSON.stringify([...ids].sort()) !== JSON.stringify(ids))
      pushIssue(errors, '/questions', 'questions not canonical');
    const suggestionCount = typed.reduce(
      (sum, question) =>
        sum + (Array.isArray(question.suggestions) ? question.suggestions.length : 0),
      0,
    );
    const deterministicCount = typed.reduce(
      (sum, question) =>
        sum +
        (Array.isArray(question.suggestions)
          ? question.suggestions.filter(
              (item) => isPlainRecord(item) && item.generationSource === 'deterministic_candidate',
            ).length
          : 0),
      0,
    );
    if (value.eligibleQuestionCount !== typed.length)
      pushIssue(errors, '/eligibleQuestionCount', 'count mismatch');
    if (
      value.candidateQuestionCount !==
      typed.filter((q) => q.generationStatus === 'generated').length
    )
      pushIssue(errors, '/candidateQuestionCount', 'count mismatch');
    if (
      value.noSuggestionQuestionCount !==
      typed.filter((q) => q.generationStatus === 'no_suggestion').length
    )
      pushIssue(errors, '/noSuggestionQuestionCount', 'count mismatch');
    if (
      value.inputTooLargeQuestionCount !==
      typed.filter((q) => q.generationStatus === 'input_too_large').length
    )
      pushIssue(errors, '/inputTooLargeQuestionCount', 'count mismatch');
    if (value.suggestionCount !== suggestionCount)
      pushIssue(errors, '/suggestionCount', 'count mismatch');
    if (value.deterministicSuggestionCount !== deterministicCount)
      pushIssue(errors, '/deterministicSuggestionCount', 'count mismatch');
    if (value.modelSuggestionCount !== suggestionCount - deterministicCount)
      pushIssue(errors, '/modelSuggestionCount', 'count mismatch');
    if (
      suggestionCount - deterministicCount > 0 &&
      (!isPlainRecord(value.modelExecution) || value.modelExecution.status !== 'used')
    ) {
      pushIssue(errors, '/modelExecution', 'model candidates require used model execution');
    }
  }

  if (
    isPlainRecord(value.sourceReview) &&
    isPlainRecord(value.sourceAnswerKey) &&
    isPlainRecord(value.sourceAssessment) &&
    generatorValid(value.generator) &&
    typeof value.examSessionId === 'string' &&
    typeof value.profileId === 'string'
  ) {
    const expectedGenerationRef = deriveExamErrorSuggestionsGenerationRef({
      examSessionId: value.examSessionId,
      profileId: value.profileId,
      generationVersion: EXAM_ERROR_SUGGESTION_GENERATION_VERSION,
      subjectId: String(value.subjectId),
      ...value.generator,
      reviewVersion: Number(value.sourceReview.reviewVersion),
      reviewArtifactRef: String(value.sourceReview.reviewArtifactRef),
      sourceReviewArtifactFingerprint: String(value.sourceReview.reviewArtifactSha256),
      sourceReviewSemanticFingerprint: String(value.sourceReview.decisionSemanticFingerprint),
      answerKeyVersion: Number(value.sourceAnswerKey.answerKeyVersion),
      answerKeyRef: String(value.sourceAnswerKey.answerKeyRef),
      answerKeyArtifactRef: String(value.sourceAnswerKey.answerKeyArtifactRef),
      sourceAnswerKeyArtifactFingerprint: String(value.sourceAnswerKey.answerKeyArtifactSha256),
      sourceAnswerKeySemanticFingerprint: String(value.sourceAnswerKey.semanticFingerprint),
      assessmentVersion: Number(value.sourceAssessment.assessmentVersion),
      gradingAlgorithmVersion: value.sourceAssessment
        .gradingAlgorithmVersion as ExamQuestionAssessmentsArtifactV1['gradingAlgorithmVersion'],
      gradingRef: String(value.sourceAssessment.gradingRef),
      assessmentArtifactRef: String(value.sourceAssessment.assessmentArtifactRef),
      sourceAssessmentArtifactFingerprint: String(value.sourceAssessment.assessmentArtifactSha256),
      sourceAssessmentSemanticFingerprint: String(value.sourceAssessment.semanticFingerprint),
    });
    if (value.generationRef !== expectedGenerationRef)
      pushIssue(errors, '/generationRef', 'generation ref mismatch');
    if (
      value.suggestionArtifactRef !== deriveExamErrorSuggestionsArtifactRef(expectedGenerationRef)
    )
      pushIssue(errors, '/suggestionArtifactRef', 'artifact ref mismatch');
  }
  if (errors.length === 0) {
    const artifact = value as unknown as ExamErrorDiagnosisCandidatesArtifactV1;
    const { semanticFingerprint, ...withoutFingerprint } = artifact;
    if (createExamErrorSuggestionsSemanticFingerprint(withoutFingerprint) !== semanticFingerprint) {
      pushIssue(errors, '/semanticFingerprint', 'semantic fingerprint mismatch');
    }
    if (Buffer.byteLength(JSON.stringify(artifact), 'utf8') > MAX_ARTIFACT_BYTES) {
      pushIssue(errors, '', 'artifact exceeds byte limit');
    }
  }
  return finishValidation(errors);
}

function canonicalArtifact(
  value: ExamErrorDiagnosisCandidatesArtifactV1,
): ExamErrorDiagnosisCandidatesArtifactV1 {
  return {
    schemaVersion: EXAM_ERROR_SUGGESTION_SCHEMA_VERSION,
    artifactVersion: EXAM_ERROR_SUGGESTION_ARTIFACT_VERSION,
    generationVersion: EXAM_ERROR_SUGGESTION_GENERATION_VERSION,
    examSessionId: value.examSessionId,
    profileId: value.profileId,
    subjectId: value.subjectId,
    generationRef: value.generationRef,
    suggestionArtifactRef: value.suggestionArtifactRef,
    candidateStatus: EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS,
    sourceReview: { ...value.sourceReview },
    sourceAnswerKey: { ...value.sourceAnswerKey },
    sourceAssessment: { ...value.sourceAssessment },
    generator: { ...value.generator },
    modelExecution: { ...value.modelExecution },
    semanticFingerprint: value.semanticFingerprint,
    eligibleQuestionCount: value.eligibleQuestionCount,
    candidateQuestionCount: value.candidateQuestionCount,
    noSuggestionQuestionCount: value.noSuggestionQuestionCount,
    inputTooLargeQuestionCount: value.inputTooLargeQuestionCount,
    suggestionCount: value.suggestionCount,
    deterministicSuggestionCount: value.deterministicSuggestionCount,
    modelSuggestionCount: value.modelSuggestionCount,
    questions: value.questions.map((question) => ({
      confirmedQuestionId: question.confirmedQuestionId,
      assessmentId: question.assessmentId,
      assessmentOutcome: 'incorrect',
      generationStatus: question.generationStatus,
      suggestions: question.suggestions.map((suggestion) => ({
        ...suggestion,
        evidence: suggestion.evidence.map((evidence) => ({ ...evidence })),
      })),
    })),
  };
}

export function parseExamErrorSuggestionsArtifact(
  value: unknown,
): ExamErrorDiagnosisCandidatesArtifactV1 {
  let decoded = value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    if (value.byteLength > MAX_ARTIFACT_BYTES) {
      throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT');
    }
    try {
      decoded = JSON.parse(UTF8_DECODER.decode(value)) as unknown;
    } catch {
      throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT');
    }
  }
  if (!validateExamErrorSuggestionsArtifact(decoded).valid) {
    throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT');
  }
  return canonicalArtifact(decoded as ExamErrorDiagnosisCandidatesArtifactV1);
}

export function serializeExamErrorSuggestionsArtifact(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(parseExamErrorSuggestionsArtifact(value)), 'utf8');
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT');
  }
  return bytes;
}

export function toPublicExamErrorSuggestionsBundle(
  value: unknown,
  confirmedReview: ConfirmedExamReviewFactsV1,
): PublicExamErrorSuggestionsBundleV1 {
  const artifact = parseExamErrorSuggestionsArtifact(value);
  let reviewBytes: Buffer;
  try {
    reviewBytes = serializeConfirmedExamReviewFacts(confirmedReview);
  } catch {
    throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_SOURCE_INVALID');
  }
  if (
    confirmedReview.examSessionId !== artifact.examSessionId ||
    confirmedReview.reviewRef !== artifact.sourceReview.reviewRef ||
    confirmedReview.reviewArtifactRef !== artifact.sourceReview.reviewArtifactRef ||
    confirmedReview.reviewVersion !== artifact.sourceReview.reviewVersion ||
    confirmedReview.artifactVersion !== artifact.sourceReview.reviewArtifactVersion ||
    confirmedReview.decisionSemanticFingerprint !==
      artifact.sourceReview.decisionSemanticFingerprint ||
    sha256(reviewBytes) !== artifact.sourceReview.reviewArtifactSha256
  ) {
    throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_SOURCE_INVALID');
  }
  const questions = new Map(
    confirmedReview.confirmedQuestions.map((question) => [question.confirmedQuestionId, question]),
  );
  const responses = new Map(
    confirmedReview.confirmedResponses.map((response) => [response.confirmedQuestionId, response]),
  );
  return {
    schemaVersion: EXAM_ERROR_SUGGESTION_SCHEMA_VERSION,
    examSessionId: artifact.examSessionId,
    subjectId: artifact.subjectId,
    candidateStatus: EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS,
    questions: artifact.questions.map((question) => {
      const sourceQuestion = questions.get(question.confirmedQuestionId);
      const response = responses.get(question.confirmedQuestionId);
      if (!sourceQuestion || !response) {
        throw new ExamErrorSuggestionsPrivateError('EXAM_ERROR_SUGGESTION_SOURCE_INVALID');
      }
      const confirmedResponse =
        response.answerStatus === 'text'
          ? { answerStatus: 'text' as const, rawAnswerText: response.rawAnswerText! }
          : { answerStatus: response.answerStatus };
      return {
        confirmedQuestionId: question.confirmedQuestionId,
        questionText: sourceQuestion.questionText,
        ...(sourceQuestion.parentContext
          ? { parentContext: { questionText: sourceQuestion.parentContext.questionText } }
          : {}),
        confirmedResponse,
        assessmentOutcome: 'incorrect' as const,
        generationStatus: question.generationStatus,
        suggestions: question.suggestions.map(({ ordinal: _ordinal, ...suggestion }) => ({
          ...suggestion,
          evidence: suggestion.evidence.map((evidence) => ({ ...evidence })),
        })),
      };
    }),
  };
}

export const parseExamErrorDiagnosisCandidatesArtifact = parseExamErrorSuggestionsArtifact;
export const serializeExamErrorDiagnosisCandidatesArtifact = serializeExamErrorSuggestionsArtifact;
