import {
  EXAM_DISPLAY_NAME_MAX_LENGTH,
  EXAM_DERIVATIVE_VERSION_MAX,
  EXAM_DOCUMENT_ROLES,
  EXAM_MAX_ANSWER_KEY_ARTIFACT_BYTES,
  EXAM_MAX_ASSESSMENT_ARTIFACT_BYTES,
  EXAM_MAX_CANDIDATE_ARTIFACT_BYTES,
  EXAM_MAX_DOCUMENT_ARTIFACT_BYTES,
  EXAM_MAX_EXTRACTED_PAGES,
  EXAM_MAX_HUMAN_REVIEW_ARTIFACT_BYTES,
  EXAM_MAX_KNOWLEDGE_MAPPING_ARTIFACT_BYTES,
  EXAM_MAX_KNOWLEDGE_SUGGESTION_ARTIFACT_BYTES,
  EXAM_MAX_KNOWLEDGE_SUGGESTIONS_PER_QUESTION,
  EXAM_MAX_MATCH_ARTIFACT_BYTES,
  EXAM_MAX_DOCUMENTS,
  EXAM_MAX_DOCUMENT_BYTES,
  EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
  EXAM_MAX_QUESTION_CANDIDATES,
  EXAM_MAX_OBSERVATION_ARTIFACT_BYTES,
  EXAM_MAX_RESPONSE_ARTIFACT_BYTES,
  EXAM_MAX_TOTAL_BYTES,
  EXAM_TITLE_MAX_LENGTH,
  compareExamDocumentRoles,
  isExamDocumentRole,
  isExamOwnerMaterialId,
  isExamSupportedMimeType,
  type ExamDocumentRole,
  type ExamSupportedMimeType,
} from './exam';
import { ExamError } from './exam-errors';
import {
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  validateIsoDateTime,
  type DomainValidationIssue,
  type DomainValidationResult,
} from './validation';

export const EXAM_EVENT_SCHEMA_VERSION = 1 as const;
export const EXAM_OPERATION_FINGERPRINT_LENGTH = 64;

export interface ExamCreatedDocument {
  examDocumentId: string;
  role: ExamDocumentRole;
  ownerMaterialId: string;
  sourceSha256: string;
  mimeType: ExamSupportedMimeType;
  byteLength: number;
  displayName?: string;
}

interface ExamEventBase {
  schemaVersion: typeof EXAM_EVENT_SCHEMA_VERSION;
  eventId: string;
  examSessionId: string;
  profileId: string;
  eventType: ExamEventType;
  createdAt: string;
  operationId: string;
  operationFingerprint: string;
}

export interface ExamCreatedEvent extends ExamEventBase {
  eventType: 'exam_created';
  subjectId: string;
  title?: string;
  requestFingerprint: string;
  documentSetFingerprint: string;
  documents: readonly ExamCreatedDocument[];
}

export interface ExamDocumentSnapshottedEvent extends ExamEventBase {
  eventType: 'exam_document_snapshotted';
  examDocumentId: string;
  snapshotSha256: string;
  byteLength: number;
}

export interface ExamIntakeCompletedEvent extends ExamEventBase {
  eventType: 'exam_intake_completed';
  documentSetFingerprint: string;
}

export interface ExamQuestionExtractionStartedEvent extends ExamEventBase {
  eventType: 'exam_question_extraction_started';
  extractionVersion: number;
  examDocumentId: string;
  sourceSnapshotFingerprint: string;
  extractorId: string;
  extractorVersion: string;
  normalizationVersion: string;
  documentArtifactRef: string;
}

export interface ExamDocumentArtifactExtractedEvent extends ExamEventBase {
  eventType: 'exam_document_artifact_extracted';
  extractionVersion: number;
  examDocumentId: string;
  sourceSnapshotFingerprint: string;
  extractorId: string;
  extractorVersion: string;
  normalizationVersion: string;
  documentArtifactRef: string;
  artifactByteLength: number;
  artifactSha256: string;
  pageCount: number;
}

export interface ExamQuestionSegmentationStartedEvent extends ExamEventBase {
  eventType: 'exam_question_segmentation_started';
  extractionVersion: number;
  segmentationVersion: number;
  examDocumentId: string;
  sourceArtifactFingerprint: string;
  documentArtifactRef: string;
  candidateArtifactRef: string;
}

export interface ExamQuestionCandidatesExtractedEvent extends ExamEventBase {
  eventType: 'exam_question_candidates_extracted';
  extractionVersion: number;
  segmentationVersion: number;
  examDocumentId: string;
  sourceArtifactFingerprint: string;
  documentArtifactRef: string;
  candidateArtifactRef: string;
  artifactByteLength: number;
  artifactSha256: string;
  candidateCount: number;
  needsReview: boolean;
}

interface ExamStudentResponseCapturePlanFacts {
  captureVersion: number;
  matchingVersion: number;
  segmentationVersion: number;
  questionCandidateArtifactRef: string;
  sourceQuestionCandidateFingerprint: string;
  inputSemanticFingerprint: string;
  captureRef: string;
  responseArtifactRef: string;
  matchingArtifactRef: string;
}

export interface ExamStudentResponseCaptureStartedEvent
  extends ExamEventBase, ExamStudentResponseCapturePlanFacts {
  eventType: 'exam_student_response_capture_started';
}

export interface ExamResponseCandidatesRecordedEvent
  extends ExamEventBase, ExamStudentResponseCapturePlanFacts {
  eventType: 'exam_response_candidates_recorded';
  artifactByteLength: number;
  artifactSha256: string;
  responseCount: number;
}

export interface ExamResponseMatchingCompletedEvent
  extends ExamEventBase, ExamStudentResponseCapturePlanFacts {
  eventType: 'exam_response_matching_completed';
  responseArtifactFingerprint: string;
  artifactByteLength: number;
  artifactSha256: string;
  responseCount: number;
  matchedCount: number;
  ambiguousCount: number;
  unmatchedCount: number;
  needsReview: true;
}

export interface ExamHumanReviewPlanFacts {
  reviewVersion: number;
  questionExtractionVersion: number;
  questionSegmentationVersion: number;
  responseCaptureVersion: number;
  matchingVersion: number;
  questionCandidateArtifactRef: string;
  sourceQuestionCandidateFingerprint: string;
  responseArtifactRef: string;
  sourceResponseArtifactFingerprint: string;
  matchingArtifactRef: string;
  sourceMatchingArtifactFingerprint: string;
  decisionSemanticFingerprint: string;
  reviewArtifactRef: string;
}

export interface ExamHumanReviewStartedEvent extends ExamEventBase, ExamHumanReviewPlanFacts {
  eventType: 'exam_human_review_started';
}

export interface ExamHumanReviewCompletedEvent extends ExamEventBase, ExamHumanReviewPlanFacts {
  eventType: 'exam_human_review_completed';
  artifactByteLength: number;
  artifactSha256: string;
  confirmedQuestionCount: number;
  confirmedResponseCount: number;
  confirmedMatchCount: number;
  rejectedQuestionCount: number;
  rejectedResponseCount: number;
}

export interface ExamAnswerKeyPlanFacts {
  answerKeyVersion: number;
  reviewVersion: number;
  reviewArtifactRef: string;
  sourceReviewArtifactFingerprint: string;
  answerKeySemanticFingerprint: string;
  answerKeyRef: string;
  answerKeyArtifactRef: string;
}

export interface ExamAnswerKeyStartedEvent extends ExamEventBase, ExamAnswerKeyPlanFacts {
  eventType: 'exam_answer_key_started';
}

export interface ExamAnswerKeyConfirmedEvent extends ExamEventBase, ExamAnswerKeyPlanFacts {
  eventType: 'exam_answer_key_confirmed';
  artifactByteLength: number;
  artifactSha256: string;
  entryCount: number;
  objectiveEntryCount: number;
  unassessedEntryCount: number;
}

export interface ExamGradingPlanFacts {
  gradingVersion: number;
  gradingAlgorithmVersion: typeof EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION;
  reviewVersion: number;
  reviewArtifactRef: string;
  sourceReviewArtifactFingerprint: string;
  answerKeyVersion: number;
  answerKeyRef: string;
  answerKeyArtifactRef: string;
  sourceAnswerKeyArtifactFingerprint: string;
  gradingRef: string;
  assessmentArtifactRef: string;
}

export interface ExamGradingStartedEvent extends ExamEventBase, ExamGradingPlanFacts {
  eventType: 'exam_grading_started';
}

export interface ExamGradingCompletedEvent extends ExamEventBase, ExamGradingPlanFacts {
  eventType: 'exam_grading_completed';
  artifactByteLength: number;
  artifactSha256: string;
  assessmentCount: number;
  evaluatedCount: number;
  correctCount: number;
  incorrectCount: number;
  unassessedCount: number;
}

export interface ExamKnowledgeMappingPlanFacts {
  mappingVersion: number;
  subjectId: string;
  reviewVersion: number;
  reviewArtifactRef: string;
  sourceReviewArtifactFingerprint: string;
  sourceReviewSemanticFingerprint: string;
  assessmentVersion: number;
  assessmentArtifactRef: string;
  sourceAssessmentArtifactFingerprint: string;
  sourceAssessmentSemanticFingerprint: string;
  mappingSemanticFingerprint: string;
  mappingRef: string;
  mappingArtifactRef: string;
}

export interface ExamKnowledgeMappingStartedEvent
  extends ExamEventBase, ExamKnowledgeMappingPlanFacts {
  eventType: 'exam_knowledge_mapping_started';
}

export interface ExamKnowledgeMappingConfirmedEvent
  extends ExamEventBase, ExamKnowledgeMappingPlanFacts {
  eventType: 'exam_knowledge_mapping_confirmed';
  artifactByteLength: number;
  artifactSha256: string;
  entryCount: number;
  mappedQuestionCount: number;
  unmappedQuestionCount: number;
}

export type ExamKnowledgeSuggestionCandidatePoolMode = 'observed_existing_ids' | 'label_only';

export interface ExamKnowledgeSuggestionsPlanFacts {
  generationVersion: number;
  subjectId: string;
  generatorVersion: string;
  candidateSchemaVersion: number;
  reviewVersion: number;
  reviewArtifactRef: string;
  sourceReviewArtifactFingerprint: string;
  sourceReviewSemanticFingerprint: string;
  candidatePoolMode: ExamKnowledgeSuggestionCandidatePoolMode;
  candidatePoolFingerprint: string;
  generationRef: string;
  suggestionArtifactRef: string;
}

export interface ExamKnowledgeSuggestionsStartedEvent
  extends ExamEventBase, ExamKnowledgeSuggestionsPlanFacts {
  eventType: 'exam_knowledge_suggestions_started';
}

export interface ExamKnowledgeSuggestionsCompletedEvent
  extends ExamEventBase, ExamKnowledgeSuggestionsPlanFacts {
  eventType: 'exam_knowledge_suggestions_completed';
  artifactByteLength: number;
  artifactSha256: string;
  questionCount: number;
  generatedQuestionCount: number;
  noSuggestionQuestionCount: number;
  inputTooLargeQuestionCount: number;
  suggestionCount: number;
}

export interface ExamObservationProjectionPlanFacts {
  observationVersion: number;
  reviewVersion: number;
  reviewArtifactRef: string;
  sourceReviewArtifactFingerprint: string;
  sourceReviewSemanticFingerprint: string;
  assessmentVersion: number;
  assessmentArtifactRef: string;
  sourceAssessmentArtifactFingerprint: string;
  sourceAssessmentSemanticFingerprint: string;
  mappingVersion: number;
  mappingRef: string;
  mappingArtifactRef: string;
  sourceMappingArtifactFingerprint: string;
  sourceMappingSemanticFingerprint: string;
  observationSemanticFingerprint: string;
  observationRef: string;
  observationArtifactRef: string;
}

export interface ExamObservationProjectionStartedEvent
  extends ExamEventBase, ExamObservationProjectionPlanFacts {
  eventType: 'exam_observation_projection_started';
}

export interface ExamObservationsProjectedEvent
  extends ExamEventBase, ExamObservationProjectionPlanFacts {
  eventType: 'exam_observations_projected';
  artifactByteLength: number;
  artifactSha256: string;
  observationCount: number;
  evaluatedCount: number;
  correctCount: number;
  incorrectCount: number;
  unassessedCount: number;
}

export interface ExamDeleteRequestedEvent extends ExamEventBase {
  eventType: 'exam_delete_requested';
  documentSetFingerprint: string;
}

export interface ExamDeletedEvent extends ExamEventBase {
  eventType: 'exam_deleted';
  documentSetFingerprint: string;
  deleteRequestEventId: string;
}

export type ExamEvent =
  | ExamCreatedEvent
  | ExamDocumentSnapshottedEvent
  | ExamIntakeCompletedEvent
  | ExamQuestionExtractionStartedEvent
  | ExamDocumentArtifactExtractedEvent
  | ExamQuestionSegmentationStartedEvent
  | ExamQuestionCandidatesExtractedEvent
  | ExamStudentResponseCaptureStartedEvent
  | ExamResponseCandidatesRecordedEvent
  | ExamResponseMatchingCompletedEvent
  | ExamHumanReviewStartedEvent
  | ExamHumanReviewCompletedEvent
  | ExamAnswerKeyStartedEvent
  | ExamAnswerKeyConfirmedEvent
  | ExamGradingStartedEvent
  | ExamGradingCompletedEvent
  | ExamKnowledgeSuggestionsStartedEvent
  | ExamKnowledgeSuggestionsCompletedEvent
  | ExamKnowledgeMappingStartedEvent
  | ExamKnowledgeMappingConfirmedEvent
  | ExamObservationProjectionStartedEvent
  | ExamObservationsProjectedEvent
  | ExamDeleteRequestedEvent
  | ExamDeletedEvent;

export type ExamEventType = ExamEvent['eventType'];

export const EXAM_EVENT_TYPES = [
  'exam_created',
  'exam_document_snapshotted',
  'exam_intake_completed',
  'exam_question_extraction_started',
  'exam_document_artifact_extracted',
  'exam_question_segmentation_started',
  'exam_question_candidates_extracted',
  'exam_student_response_capture_started',
  'exam_response_candidates_recorded',
  'exam_response_matching_completed',
  'exam_human_review_started',
  'exam_human_review_completed',
  'exam_answer_key_started',
  'exam_answer_key_confirmed',
  'exam_grading_started',
  'exam_grading_completed',
  'exam_knowledge_suggestions_started',
  'exam_knowledge_suggestions_completed',
  'exam_knowledge_mapping_started',
  'exam_knowledge_mapping_confirmed',
  'exam_observation_projection_started',
  'exam_observations_projected',
  'exam_delete_requested',
  'exam_deleted',
] as const satisfies readonly ExamEventType[];

const COMMON_KEYS = [
  'schemaVersion',
  'eventId',
  'examSessionId',
  'profileId',
  'eventType',
  'createdAt',
  'operationId',
  'operationFingerprint',
] as const;

const HUMAN_REVIEW_PLAN_KEYS = [
  'reviewVersion',
  'questionExtractionVersion',
  'questionSegmentationVersion',
  'responseCaptureVersion',
  'matchingVersion',
  'questionCandidateArtifactRef',
  'sourceQuestionCandidateFingerprint',
  'responseArtifactRef',
  'sourceResponseArtifactFingerprint',
  'matchingArtifactRef',
  'sourceMatchingArtifactFingerprint',
  'decisionSemanticFingerprint',
  'reviewArtifactRef',
] as const;

const ANSWER_KEY_PLAN_KEYS = [
  'answerKeyVersion',
  'reviewVersion',
  'reviewArtifactRef',
  'sourceReviewArtifactFingerprint',
  'answerKeySemanticFingerprint',
  'answerKeyRef',
  'answerKeyArtifactRef',
] as const;

const GRADING_PLAN_KEYS = [
  'gradingVersion',
  'gradingAlgorithmVersion',
  'reviewVersion',
  'reviewArtifactRef',
  'sourceReviewArtifactFingerprint',
  'answerKeyVersion',
  'answerKeyRef',
  'answerKeyArtifactRef',
  'sourceAnswerKeyArtifactFingerprint',
  'gradingRef',
  'assessmentArtifactRef',
] as const;

const KNOWLEDGE_MAPPING_PLAN_KEYS = [
  'mappingVersion',
  'subjectId',
  'reviewVersion',
  'reviewArtifactRef',
  'sourceReviewArtifactFingerprint',
  'sourceReviewSemanticFingerprint',
  'assessmentVersion',
  'assessmentArtifactRef',
  'sourceAssessmentArtifactFingerprint',
  'sourceAssessmentSemanticFingerprint',
  'mappingSemanticFingerprint',
  'mappingRef',
  'mappingArtifactRef',
] as const;

const KNOWLEDGE_SUGGESTIONS_PLAN_KEYS = [
  'generationVersion',
  'subjectId',
  'generatorVersion',
  'candidateSchemaVersion',
  'reviewVersion',
  'reviewArtifactRef',
  'sourceReviewArtifactFingerprint',
  'sourceReviewSemanticFingerprint',
  'candidatePoolMode',
  'candidatePoolFingerprint',
  'generationRef',
  'suggestionArtifactRef',
] as const;

const OBSERVATION_PROJECTION_PLAN_KEYS = [
  'observationVersion',
  'reviewVersion',
  'reviewArtifactRef',
  'sourceReviewArtifactFingerprint',
  'sourceReviewSemanticFingerprint',
  'assessmentVersion',
  'assessmentArtifactRef',
  'sourceAssessmentArtifactFingerprint',
  'sourceAssessmentSemanticFingerprint',
  'mappingVersion',
  'mappingRef',
  'mappingArtifactRef',
  'sourceMappingArtifactFingerprint',
  'sourceMappingSemanticFingerprint',
  'observationSemanticFingerprint',
  'observationRef',
  'observationArtifactRef',
] as const;

const EVENT_KEYS: Readonly<Record<ExamEventType, ReadonlySet<string>>> = {
  exam_created: new Set([
    ...COMMON_KEYS,
    'subjectId',
    'title',
    'requestFingerprint',
    'documentSetFingerprint',
    'documents',
  ]),
  exam_document_snapshotted: new Set([
    ...COMMON_KEYS,
    'examDocumentId',
    'snapshotSha256',
    'byteLength',
  ]),
  exam_intake_completed: new Set([...COMMON_KEYS, 'documentSetFingerprint']),
  exam_question_extraction_started: new Set([
    ...COMMON_KEYS,
    'extractionVersion',
    'examDocumentId',
    'sourceSnapshotFingerprint',
    'extractorId',
    'extractorVersion',
    'normalizationVersion',
    'documentArtifactRef',
  ]),
  exam_document_artifact_extracted: new Set([
    ...COMMON_KEYS,
    'extractionVersion',
    'examDocumentId',
    'sourceSnapshotFingerprint',
    'extractorId',
    'extractorVersion',
    'normalizationVersion',
    'documentArtifactRef',
    'artifactByteLength',
    'artifactSha256',
    'pageCount',
  ]),
  exam_question_segmentation_started: new Set([
    ...COMMON_KEYS,
    'extractionVersion',
    'segmentationVersion',
    'examDocumentId',
    'sourceArtifactFingerprint',
    'documentArtifactRef',
    'candidateArtifactRef',
  ]),
  exam_question_candidates_extracted: new Set([
    ...COMMON_KEYS,
    'extractionVersion',
    'segmentationVersion',
    'examDocumentId',
    'sourceArtifactFingerprint',
    'documentArtifactRef',
    'candidateArtifactRef',
    'artifactByteLength',
    'artifactSha256',
    'candidateCount',
    'needsReview',
  ]),
  exam_student_response_capture_started: new Set([
    ...COMMON_KEYS,
    'captureVersion',
    'matchingVersion',
    'segmentationVersion',
    'questionCandidateArtifactRef',
    'sourceQuestionCandidateFingerprint',
    'inputSemanticFingerprint',
    'captureRef',
    'responseArtifactRef',
    'matchingArtifactRef',
  ]),
  exam_response_candidates_recorded: new Set([
    ...COMMON_KEYS,
    'captureVersion',
    'matchingVersion',
    'segmentationVersion',
    'questionCandidateArtifactRef',
    'sourceQuestionCandidateFingerprint',
    'inputSemanticFingerprint',
    'captureRef',
    'responseArtifactRef',
    'matchingArtifactRef',
    'artifactByteLength',
    'artifactSha256',
    'responseCount',
  ]),
  exam_response_matching_completed: new Set([
    ...COMMON_KEYS,
    'captureVersion',
    'matchingVersion',
    'segmentationVersion',
    'questionCandidateArtifactRef',
    'sourceQuestionCandidateFingerprint',
    'inputSemanticFingerprint',
    'captureRef',
    'responseArtifactRef',
    'matchingArtifactRef',
    'responseArtifactFingerprint',
    'artifactByteLength',
    'artifactSha256',
    'responseCount',
    'matchedCount',
    'ambiguousCount',
    'unmatchedCount',
    'needsReview',
  ]),
  exam_human_review_started: new Set([...COMMON_KEYS, ...HUMAN_REVIEW_PLAN_KEYS]),
  exam_human_review_completed: new Set([
    ...COMMON_KEYS,
    ...HUMAN_REVIEW_PLAN_KEYS,
    'artifactByteLength',
    'artifactSha256',
    'confirmedQuestionCount',
    'confirmedResponseCount',
    'confirmedMatchCount',
    'rejectedQuestionCount',
    'rejectedResponseCount',
  ]),
  exam_answer_key_started: new Set([...COMMON_KEYS, ...ANSWER_KEY_PLAN_KEYS]),
  exam_answer_key_confirmed: new Set([
    ...COMMON_KEYS,
    ...ANSWER_KEY_PLAN_KEYS,
    'artifactByteLength',
    'artifactSha256',
    'entryCount',
    'objectiveEntryCount',
    'unassessedEntryCount',
  ]),
  exam_grading_started: new Set([...COMMON_KEYS, ...GRADING_PLAN_KEYS]),
  exam_grading_completed: new Set([
    ...COMMON_KEYS,
    ...GRADING_PLAN_KEYS,
    'artifactByteLength',
    'artifactSha256',
    'assessmentCount',
    'evaluatedCount',
    'correctCount',
    'incorrectCount',
    'unassessedCount',
  ]),
  exam_knowledge_suggestions_started: new Set([...COMMON_KEYS, ...KNOWLEDGE_SUGGESTIONS_PLAN_KEYS]),
  exam_knowledge_suggestions_completed: new Set([
    ...COMMON_KEYS,
    ...KNOWLEDGE_SUGGESTIONS_PLAN_KEYS,
    'artifactByteLength',
    'artifactSha256',
    'questionCount',
    'generatedQuestionCount',
    'noSuggestionQuestionCount',
    'inputTooLargeQuestionCount',
    'suggestionCount',
  ]),
  exam_knowledge_mapping_started: new Set([...COMMON_KEYS, ...KNOWLEDGE_MAPPING_PLAN_KEYS]),
  exam_knowledge_mapping_confirmed: new Set([
    ...COMMON_KEYS,
    ...KNOWLEDGE_MAPPING_PLAN_KEYS,
    'artifactByteLength',
    'artifactSha256',
    'entryCount',
    'mappedQuestionCount',
    'unmappedQuestionCount',
  ]),
  exam_observation_projection_started: new Set([
    ...COMMON_KEYS,
    ...OBSERVATION_PROJECTION_PLAN_KEYS,
  ]),
  exam_observations_projected: new Set([
    ...COMMON_KEYS,
    ...OBSERVATION_PROJECTION_PLAN_KEYS,
    'artifactByteLength',
    'artifactSha256',
    'observationCount',
    'evaluatedCount',
    'correctCount',
    'incorrectCount',
    'unassessedCount',
  ]),
  exam_delete_requested: new Set([...COMMON_KEYS, 'documentSetFingerprint']),
  exam_deleted: new Set([...COMMON_KEYS, 'documentSetFingerprint', 'deleteRequestEventId']),
};

const CREATED_DOCUMENT_KEYS = new Set([
  'examDocumentId',
  'role',
  'ownerMaterialId',
  'sourceSha256',
  'mimeType',
  'byteLength',
  'displayName',
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

function isExamEventType(value: unknown): value is ExamEventType {
  return (EXAM_EVENT_TYPES as readonly unknown[]).includes(value);
}

function validateSha256(value: unknown, path: string, errors: DomainValidationIssue[]): void {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    pushIssue(errors, path, 'expected lowercase SHA-256 digest');
  }
}

function validateByteLength(value: unknown, path: string, errors: DomainValidationIssue[]): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    pushIssue(errors, path, 'expected positive safe byte length');
    return;
  }
  if ((value as number) > EXAM_MAX_DOCUMENT_BYTES) {
    pushIssue(errors, path, `byte length exceeds ${EXAM_MAX_DOCUMENT_BYTES}`);
  }
}

function validateArtifactByteLength(
  value: unknown,
  path: string,
  max: number,
  errors: DomainValidationIssue[],
): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    pushIssue(errors, path, 'expected positive safe artifact byte length');
    return;
  }
  if ((value as number) > max) {
    pushIssue(errors, path, `artifact byte length exceeds ${max}`);
  }
}

function validatePositiveVersion(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > EXAM_DERIVATIVE_VERSION_MAX
  ) {
    pushIssue(
      errors,
      path,
      `expected integer version between 1 and ${EXAM_DERIVATIVE_VERSION_MAX}`,
    );
  }
}

function validateBoundedCount(
  value: unknown,
  path: string,
  max: number,
  allowZero: boolean,
  errors: DomainValidationIssue[],
): void {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < (allowZero ? 0 : 1) ||
    (value as number) > max
  ) {
    pushIssue(errors, path, `expected safe integer between ${allowZero ? 0 : 1} and ${max}`);
  }
}

function validateSafeDisplayText(
  value: unknown,
  path: string,
  maxLength: number,
  errors: DomainValidationIssue[],
): void {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    pushIssue(errors, path, 'expected non-empty trimmed display text');
    return;
  }
  if (value.length > maxLength) pushIssue(errors, path, `text exceeds ${maxLength} characters`);
  if (CONTROL_CHARACTER.test(value) || UNPAIRED_SURROGATE.test(value)) {
    pushIssue(errors, path, 'display text contains an unsafe character');
  }
}

function validateCreatedDocuments(value: unknown, errors: DomainValidationIssue[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > EXAM_MAX_DOCUMENTS) {
    pushIssue(errors, '/documents', `expected 1 to ${EXAM_MAX_DOCUMENTS} created documents`);
    return;
  }

  const roles = new Set<ExamDocumentRole>();
  const documentIds = new Set<string>();
  let previousRole: ExamDocumentRole | undefined;
  let totalBytes = 0;
  value.forEach((raw, index) => {
    const path = `/documents/${index}`;
    if (!isPlainRecord(raw)) {
      pushIssue(errors, path, 'expected created document object');
      return;
    }
    rejectUnknownKeys(raw, CREATED_DOCUMENT_KEYS, path, errors);
    if (validateIdentifier(raw.examDocumentId, `${path}/examDocumentId`, errors)) {
      if (documentIds.has(raw.examDocumentId)) {
        pushIssue(errors, `${path}/examDocumentId`, 'duplicate exam document id');
      }
      documentIds.add(raw.examDocumentId);
    }
    if (!isExamDocumentRole(raw.role)) {
      pushIssue(errors, `${path}/role`, 'unknown exam document role');
    } else {
      if (roles.has(raw.role)) pushIssue(errors, `${path}/role`, 'duplicate exam document role');
      if (previousRole !== undefined && compareExamDocumentRoles(previousRole, raw.role) >= 0) {
        pushIssue(errors, `${path}/role`, 'exam documents must use canonical role order');
      }
      roles.add(raw.role);
      previousRole = raw.role;
    }
    if (!isExamOwnerMaterialId(raw.ownerMaterialId)) {
      pushIssue(errors, `${path}/ownerMaterialId`, 'expected owner material id');
    }
    validateSha256(raw.sourceSha256, `${path}/sourceSha256`, errors);
    if (!isExamSupportedMimeType(raw.mimeType)) {
      pushIssue(errors, `${path}/mimeType`, 'unsupported exam document MIME type');
    }
    validateByteLength(raw.byteLength, `${path}/byteLength`, errors);
    if (Number.isSafeInteger(raw.byteLength) && (raw.byteLength as number) > 0) {
      totalBytes += raw.byteLength as number;
    }
    if (Object.hasOwn(raw, 'displayName')) {
      validateSafeDisplayText(
        raw.displayName,
        `${path}/displayName`,
        EXAM_DISPLAY_NAME_MAX_LENGTH,
        errors,
      );
    }
  });

  if (!roles.has(EXAM_DOCUMENT_ROLES[0])) {
    pushIssue(errors, '/documents', 'exactly one question_paper is required');
  }
  if (totalBytes > EXAM_MAX_TOTAL_BYTES) {
    pushIssue(errors, '/documents', `total bytes exceed ${EXAM_MAX_TOTAL_BYTES}`);
  }
}

function validateCommon(value: Record<string, unknown>, errors: DomainValidationIssue[]): void {
  if (value.schemaVersion !== EXAM_EVENT_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', `expected schemaVersion ${EXAM_EVENT_SCHEMA_VERSION}`);
  }
  validateIdentifier(value.eventId, '/eventId', errors);
  validateIdentifier(value.examSessionId, '/examSessionId', errors);
  validateIdentifier(value.profileId, '/profileId', errors);
  validateIsoDateTime(value.createdAt, '/createdAt', errors);
  validateIdentifier(value.operationId, '/operationId', errors);
  validateSha256(value.operationFingerprint, '/operationFingerprint', errors);
}

function validateResponseCapturePlan(
  value: Record<string, unknown>,
  errors: DomainValidationIssue[],
): void {
  validatePositiveVersion(value.captureVersion, '/captureVersion', errors);
  validatePositiveVersion(value.matchingVersion, '/matchingVersion', errors);
  validatePositiveVersion(value.segmentationVersion, '/segmentationVersion', errors);
  validateIdentifier(value.questionCandidateArtifactRef, '/questionCandidateArtifactRef', errors);
  validateSha256(
    value.sourceQuestionCandidateFingerprint,
    '/sourceQuestionCandidateFingerprint',
    errors,
  );
  validateSha256(value.inputSemanticFingerprint, '/inputSemanticFingerprint', errors);
  validateIdentifier(value.captureRef, '/captureRef', errors);
  validateIdentifier(value.responseArtifactRef, '/responseArtifactRef', errors);
  validateIdentifier(value.matchingArtifactRef, '/matchingArtifactRef', errors);
  if (
    value.captureRef === value.responseArtifactRef ||
    value.captureRef === value.matchingArtifactRef ||
    value.responseArtifactRef === value.matchingArtifactRef
  ) {
    pushIssue(errors, '/captureRef', 'response capture references must be distinct');
  }
}

function validateHumanReviewPlan(
  value: Record<string, unknown>,
  errors: DomainValidationIssue[],
): void {
  validatePositiveVersion(value.reviewVersion, '/reviewVersion', errors);
  validatePositiveVersion(value.questionExtractionVersion, '/questionExtractionVersion', errors);
  validatePositiveVersion(
    value.questionSegmentationVersion,
    '/questionSegmentationVersion',
    errors,
  );
  validatePositiveVersion(value.responseCaptureVersion, '/responseCaptureVersion', errors);
  validatePositiveVersion(value.matchingVersion, '/matchingVersion', errors);
  validateIdentifier(value.questionCandidateArtifactRef, '/questionCandidateArtifactRef', errors);
  validateSha256(
    value.sourceQuestionCandidateFingerprint,
    '/sourceQuestionCandidateFingerprint',
    errors,
  );
  validateIdentifier(value.responseArtifactRef, '/responseArtifactRef', errors);
  validateSha256(
    value.sourceResponseArtifactFingerprint,
    '/sourceResponseArtifactFingerprint',
    errors,
  );
  validateIdentifier(value.matchingArtifactRef, '/matchingArtifactRef', errors);
  validateSha256(
    value.sourceMatchingArtifactFingerprint,
    '/sourceMatchingArtifactFingerprint',
    errors,
  );
  validateSha256(value.decisionSemanticFingerprint, '/decisionSemanticFingerprint', errors);
  validateIdentifier(value.reviewArtifactRef, '/reviewArtifactRef', errors);
  if (
    value.reviewArtifactRef === value.questionCandidateArtifactRef ||
    value.reviewArtifactRef === value.responseArtifactRef ||
    value.reviewArtifactRef === value.matchingArtifactRef
  ) {
    pushIssue(errors, '/reviewArtifactRef', 'human review artifact reference must be distinct');
  }
}

function validateAnswerKeyPlan(
  value: Record<string, unknown>,
  errors: DomainValidationIssue[],
): void {
  validatePositiveVersion(value.answerKeyVersion, '/answerKeyVersion', errors);
  validatePositiveVersion(value.reviewVersion, '/reviewVersion', errors);
  validateIdentifier(value.reviewArtifactRef, '/reviewArtifactRef', errors);
  validateSha256(value.sourceReviewArtifactFingerprint, '/sourceReviewArtifactFingerprint', errors);
  validateSha256(value.answerKeySemanticFingerprint, '/answerKeySemanticFingerprint', errors);
  validateIdentifier(value.answerKeyRef, '/answerKeyRef', errors);
  validateIdentifier(value.answerKeyArtifactRef, '/answerKeyArtifactRef', errors);
  if (
    value.answerKeyRef === value.reviewArtifactRef ||
    value.answerKeyArtifactRef === value.reviewArtifactRef ||
    value.answerKeyArtifactRef === value.answerKeyRef
  ) {
    pushIssue(errors, '/answerKeyArtifactRef', 'answer-key references must be distinct');
  }
}

function validateGradingPlan(
  value: Record<string, unknown>,
  errors: DomainValidationIssue[],
): void {
  validatePositiveVersion(value.gradingVersion, '/gradingVersion', errors);
  if (value.gradingAlgorithmVersion !== EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION) {
    pushIssue(errors, '/gradingAlgorithmVersion', 'unexpected grading algorithm version');
  }
  validatePositiveVersion(value.reviewVersion, '/reviewVersion', errors);
  validateIdentifier(value.reviewArtifactRef, '/reviewArtifactRef', errors);
  validateSha256(value.sourceReviewArtifactFingerprint, '/sourceReviewArtifactFingerprint', errors);
  validatePositiveVersion(value.answerKeyVersion, '/answerKeyVersion', errors);
  validateIdentifier(value.answerKeyRef, '/answerKeyRef', errors);
  validateIdentifier(value.answerKeyArtifactRef, '/answerKeyArtifactRef', errors);
  validateSha256(
    value.sourceAnswerKeyArtifactFingerprint,
    '/sourceAnswerKeyArtifactFingerprint',
    errors,
  );
  validateIdentifier(value.gradingRef, '/gradingRef', errors);
  validateIdentifier(value.assessmentArtifactRef, '/assessmentArtifactRef', errors);
  const refs = [
    value.reviewArtifactRef,
    value.answerKeyRef,
    value.answerKeyArtifactRef,
    value.gradingRef,
    value.assessmentArtifactRef,
  ];
  if (new Set(refs).size !== refs.length) {
    pushIssue(errors, '/assessmentArtifactRef', 'grading references must be distinct');
  }
}

function validateKnowledgeSuggestionsPlan(
  value: Record<string, unknown>,
  errors: DomainValidationIssue[],
): void {
  validatePositiveVersion(value.generationVersion, '/generationVersion', errors);
  validateIdentifier(value.subjectId, '/subjectId', errors);
  validateIdentifier(value.generatorVersion, '/generatorVersion', errors);
  validatePositiveVersion(value.candidateSchemaVersion, '/candidateSchemaVersion', errors);
  validatePositiveVersion(value.reviewVersion, '/reviewVersion', errors);
  validateIdentifier(value.reviewArtifactRef, '/reviewArtifactRef', errors);
  validateSha256(value.sourceReviewArtifactFingerprint, '/sourceReviewArtifactFingerprint', errors);
  validateSha256(value.sourceReviewSemanticFingerprint, '/sourceReviewSemanticFingerprint', errors);
  if (
    value.candidatePoolMode !== 'observed_existing_ids' &&
    value.candidatePoolMode !== 'label_only'
  ) {
    pushIssue(errors, '/candidatePoolMode', 'unknown knowledge-suggestion candidate pool mode');
  }
  validateSha256(value.candidatePoolFingerprint, '/candidatePoolFingerprint', errors);
  validateIdentifier(value.generationRef, '/generationRef', errors);
  validateIdentifier(value.suggestionArtifactRef, '/suggestionArtifactRef', errors);
  const refs = [value.reviewArtifactRef, value.generationRef, value.suggestionArtifactRef];
  if (new Set(refs).size !== refs.length) {
    pushIssue(errors, '/suggestionArtifactRef', 'knowledge-suggestion references must be distinct');
  }
}

function validateKnowledgeMappingPlan(
  value: Record<string, unknown>,
  errors: DomainValidationIssue[],
): void {
  validatePositiveVersion(value.mappingVersion, '/mappingVersion', errors);
  validateIdentifier(value.subjectId, '/subjectId', errors);
  validatePositiveVersion(value.reviewVersion, '/reviewVersion', errors);
  validateIdentifier(value.reviewArtifactRef, '/reviewArtifactRef', errors);
  validateSha256(value.sourceReviewArtifactFingerprint, '/sourceReviewArtifactFingerprint', errors);
  validateSha256(value.sourceReviewSemanticFingerprint, '/sourceReviewSemanticFingerprint', errors);
  validatePositiveVersion(value.assessmentVersion, '/assessmentVersion', errors);
  validateIdentifier(value.assessmentArtifactRef, '/assessmentArtifactRef', errors);
  validateSha256(
    value.sourceAssessmentArtifactFingerprint,
    '/sourceAssessmentArtifactFingerprint',
    errors,
  );
  validateSha256(
    value.sourceAssessmentSemanticFingerprint,
    '/sourceAssessmentSemanticFingerprint',
    errors,
  );
  validateSha256(value.mappingSemanticFingerprint, '/mappingSemanticFingerprint', errors);
  validateIdentifier(value.mappingRef, '/mappingRef', errors);
  validateIdentifier(value.mappingArtifactRef, '/mappingArtifactRef', errors);
  const refs = [
    value.reviewArtifactRef,
    value.assessmentArtifactRef,
    value.mappingRef,
    value.mappingArtifactRef,
  ];
  if (new Set(refs).size !== refs.length) {
    pushIssue(errors, '/mappingArtifactRef', 'knowledge-mapping references must be distinct');
  }
}

function validateObservationProjectionPlan(
  value: Record<string, unknown>,
  errors: DomainValidationIssue[],
): void {
  validatePositiveVersion(value.observationVersion, '/observationVersion', errors);
  validatePositiveVersion(value.reviewVersion, '/reviewVersion', errors);
  validateIdentifier(value.reviewArtifactRef, '/reviewArtifactRef', errors);
  validateSha256(value.sourceReviewArtifactFingerprint, '/sourceReviewArtifactFingerprint', errors);
  validateSha256(value.sourceReviewSemanticFingerprint, '/sourceReviewSemanticFingerprint', errors);
  validatePositiveVersion(value.assessmentVersion, '/assessmentVersion', errors);
  validateIdentifier(value.assessmentArtifactRef, '/assessmentArtifactRef', errors);
  validateSha256(
    value.sourceAssessmentArtifactFingerprint,
    '/sourceAssessmentArtifactFingerprint',
    errors,
  );
  validateSha256(
    value.sourceAssessmentSemanticFingerprint,
    '/sourceAssessmentSemanticFingerprint',
    errors,
  );
  validatePositiveVersion(value.mappingVersion, '/mappingVersion', errors);
  validateIdentifier(value.mappingRef, '/mappingRef', errors);
  validateIdentifier(value.mappingArtifactRef, '/mappingArtifactRef', errors);
  validateSha256(
    value.sourceMappingArtifactFingerprint,
    '/sourceMappingArtifactFingerprint',
    errors,
  );
  validateSha256(
    value.sourceMappingSemanticFingerprint,
    '/sourceMappingSemanticFingerprint',
    errors,
  );
  validateSha256(value.observationSemanticFingerprint, '/observationSemanticFingerprint', errors);
  validateIdentifier(value.observationRef, '/observationRef', errors);
  validateIdentifier(value.observationArtifactRef, '/observationArtifactRef', errors);
  const refs = [
    value.reviewArtifactRef,
    value.assessmentArtifactRef,
    value.mappingRef,
    value.mappingArtifactRef,
    value.observationRef,
    value.observationArtifactRef,
  ];
  if (new Set(refs).size !== refs.length) {
    pushIssue(errors, '/observationArtifactRef', 'observation references must be distinct');
  }
}

export function validateExamEvent(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected exam event object');
    return finishValidation(errors);
  }
  if (!isExamEventType(value.eventType)) {
    pushIssue(errors, '/eventType', 'unknown exam event type');
    return finishValidation(errors);
  }

  rejectUnknownKeys(value, EVENT_KEYS[value.eventType], '', errors);
  validateCommon(value, errors);
  switch (value.eventType) {
    case 'exam_created':
      validateIdentifier(value.subjectId, '/subjectId', errors);
      if (Object.hasOwn(value, 'title')) {
        validateSafeDisplayText(value.title, '/title', EXAM_TITLE_MAX_LENGTH, errors);
      }
      validateSha256(value.requestFingerprint, '/requestFingerprint', errors);
      validateSha256(value.documentSetFingerprint, '/documentSetFingerprint', errors);
      validateCreatedDocuments(value.documents, errors);
      break;
    case 'exam_document_snapshotted':
      validateIdentifier(value.examDocumentId, '/examDocumentId', errors);
      validateSha256(value.snapshotSha256, '/snapshotSha256', errors);
      validateByteLength(value.byteLength, '/byteLength', errors);
      break;
    case 'exam_intake_completed':
      validateSha256(value.documentSetFingerprint, '/documentSetFingerprint', errors);
      break;
    case 'exam_question_extraction_started':
      validatePositiveVersion(value.extractionVersion, '/extractionVersion', errors);
      validateIdentifier(value.examDocumentId, '/examDocumentId', errors);
      validateSha256(value.sourceSnapshotFingerprint, '/sourceSnapshotFingerprint', errors);
      validateIdentifier(value.extractorId, '/extractorId', errors);
      validateIdentifier(value.extractorVersion, '/extractorVersion', errors);
      validateIdentifier(value.normalizationVersion, '/normalizationVersion', errors);
      validateIdentifier(value.documentArtifactRef, '/documentArtifactRef', errors);
      break;
    case 'exam_document_artifact_extracted':
      validatePositiveVersion(value.extractionVersion, '/extractionVersion', errors);
      validateIdentifier(value.examDocumentId, '/examDocumentId', errors);
      validateSha256(value.sourceSnapshotFingerprint, '/sourceSnapshotFingerprint', errors);
      validateIdentifier(value.extractorId, '/extractorId', errors);
      validateIdentifier(value.extractorVersion, '/extractorVersion', errors);
      validateIdentifier(value.normalizationVersion, '/normalizationVersion', errors);
      validateIdentifier(value.documentArtifactRef, '/documentArtifactRef', errors);
      validateArtifactByteLength(
        value.artifactByteLength,
        '/artifactByteLength',
        EXAM_MAX_DOCUMENT_ARTIFACT_BYTES,
        errors,
      );
      validateSha256(value.artifactSha256, '/artifactSha256', errors);
      validateBoundedCount(value.pageCount, '/pageCount', EXAM_MAX_EXTRACTED_PAGES, false, errors);
      break;
    case 'exam_question_segmentation_started':
      validatePositiveVersion(value.extractionVersion, '/extractionVersion', errors);
      validatePositiveVersion(value.segmentationVersion, '/segmentationVersion', errors);
      validateIdentifier(value.examDocumentId, '/examDocumentId', errors);
      validateSha256(value.sourceArtifactFingerprint, '/sourceArtifactFingerprint', errors);
      validateIdentifier(value.documentArtifactRef, '/documentArtifactRef', errors);
      validateIdentifier(value.candidateArtifactRef, '/candidateArtifactRef', errors);
      break;
    case 'exam_question_candidates_extracted':
      validatePositiveVersion(value.extractionVersion, '/extractionVersion', errors);
      validatePositiveVersion(value.segmentationVersion, '/segmentationVersion', errors);
      validateIdentifier(value.examDocumentId, '/examDocumentId', errors);
      validateSha256(value.sourceArtifactFingerprint, '/sourceArtifactFingerprint', errors);
      validateIdentifier(value.documentArtifactRef, '/documentArtifactRef', errors);
      validateIdentifier(value.candidateArtifactRef, '/candidateArtifactRef', errors);
      validateArtifactByteLength(
        value.artifactByteLength,
        '/artifactByteLength',
        EXAM_MAX_CANDIDATE_ARTIFACT_BYTES,
        errors,
      );
      validateSha256(value.artifactSha256, '/artifactSha256', errors);
      validateBoundedCount(
        value.candidateCount,
        '/candidateCount',
        EXAM_MAX_QUESTION_CANDIDATES,
        true,
        errors,
      );
      if (typeof value.needsReview !== 'boolean') {
        pushIssue(errors, '/needsReview', 'expected boolean');
      }
      break;
    case 'exam_student_response_capture_started':
      validateResponseCapturePlan(value, errors);
      break;
    case 'exam_response_candidates_recorded':
      validateResponseCapturePlan(value, errors);
      validateArtifactByteLength(
        value.artifactByteLength,
        '/artifactByteLength',
        EXAM_MAX_RESPONSE_ARTIFACT_BYTES,
        errors,
      );
      validateSha256(value.artifactSha256, '/artifactSha256', errors);
      validateBoundedCount(
        value.responseCount,
        '/responseCount',
        EXAM_MAX_QUESTION_CANDIDATES,
        true,
        errors,
      );
      break;
    case 'exam_response_matching_completed': {
      validateResponseCapturePlan(value, errors);
      validateSha256(value.responseArtifactFingerprint, '/responseArtifactFingerprint', errors);
      validateArtifactByteLength(
        value.artifactByteLength,
        '/artifactByteLength',
        EXAM_MAX_MATCH_ARTIFACT_BYTES,
        errors,
      );
      validateSha256(value.artifactSha256, '/artifactSha256', errors);
      for (const field of [
        'responseCount',
        'matchedCount',
        'ambiguousCount',
        'unmatchedCount',
      ] as const) {
        validateBoundedCount(value[field], `/${field}`, EXAM_MAX_QUESTION_CANDIDATES, true, errors);
      }
      if (
        Number.isSafeInteger(value.responseCount) &&
        Number.isSafeInteger(value.matchedCount) &&
        Number.isSafeInteger(value.ambiguousCount) &&
        Number.isSafeInteger(value.unmatchedCount) &&
        value.responseCount !==
          (value.matchedCount as number) +
            (value.ambiguousCount as number) +
            (value.unmatchedCount as number)
      ) {
        pushIssue(errors, '/responseCount', 'match counts must cover every response candidate');
      }
      if (value.needsReview !== true) {
        pushIssue(errors, '/needsReview', 'response matching always requires review');
      }
      break;
    }
    case 'exam_human_review_started':
      validateHumanReviewPlan(value, errors);
      break;
    case 'exam_human_review_completed': {
      validateHumanReviewPlan(value, errors);
      validateArtifactByteLength(
        value.artifactByteLength,
        '/artifactByteLength',
        EXAM_MAX_HUMAN_REVIEW_ARTIFACT_BYTES,
        errors,
      );
      validateSha256(value.artifactSha256, '/artifactSha256', errors);
      for (const field of [
        'confirmedQuestionCount',
        'confirmedResponseCount',
        'confirmedMatchCount',
        'rejectedQuestionCount',
        'rejectedResponseCount',
      ] as const) {
        validateBoundedCount(value[field], `/${field}`, EXAM_MAX_QUESTION_CANDIDATES, true, errors);
      }
      if (
        Number.isSafeInteger(value.confirmedQuestionCount) &&
        Number.isSafeInteger(value.rejectedQuestionCount) &&
        (value.confirmedQuestionCount as number) + (value.rejectedQuestionCount as number) >
          EXAM_MAX_QUESTION_CANDIDATES
      ) {
        pushIssue(errors, '/confirmedQuestionCount', 'question decisions exceed the candidate cap');
      }
      if (
        Number.isSafeInteger(value.confirmedResponseCount) &&
        Number.isSafeInteger(value.rejectedResponseCount) &&
        (value.confirmedResponseCount as number) + (value.rejectedResponseCount as number) >
          EXAM_MAX_QUESTION_CANDIDATES
      ) {
        pushIssue(errors, '/confirmedResponseCount', 'response decisions exceed the candidate cap');
      }
      if (
        Number.isSafeInteger(value.confirmedMatchCount) &&
        Number.isSafeInteger(value.confirmedQuestionCount) &&
        Number.isSafeInteger(value.confirmedResponseCount) &&
        ((value.confirmedMatchCount as number) !== (value.confirmedQuestionCount as number) ||
          (value.confirmedMatchCount as number) !== (value.confirmedResponseCount as number))
      ) {
        pushIssue(errors, '/confirmedMatchCount', 'confirmed decision counts must agree');
      }
      break;
    }
    case 'exam_answer_key_started':
      validateAnswerKeyPlan(value, errors);
      break;
    case 'exam_answer_key_confirmed': {
      validateAnswerKeyPlan(value, errors);
      validateArtifactByteLength(
        value.artifactByteLength,
        '/artifactByteLength',
        EXAM_MAX_ANSWER_KEY_ARTIFACT_BYTES,
        errors,
      );
      validateSha256(value.artifactSha256, '/artifactSha256', errors);
      for (const field of ['entryCount', 'objectiveEntryCount', 'unassessedEntryCount'] as const) {
        validateBoundedCount(value[field], `/${field}`, EXAM_MAX_QUESTION_CANDIDATES, true, errors);
      }
      if (
        Number.isSafeInteger(value.entryCount) &&
        Number.isSafeInteger(value.objectiveEntryCount) &&
        Number.isSafeInteger(value.unassessedEntryCount) &&
        value.entryCount !==
          (value.objectiveEntryCount as number) + (value.unassessedEntryCount as number)
      ) {
        pushIssue(errors, '/entryCount', 'answer-key counts must cover every entry');
      }
      break;
    }
    case 'exam_grading_started':
      validateGradingPlan(value, errors);
      break;
    case 'exam_grading_completed': {
      validateGradingPlan(value, errors);
      validateArtifactByteLength(
        value.artifactByteLength,
        '/artifactByteLength',
        EXAM_MAX_ASSESSMENT_ARTIFACT_BYTES,
        errors,
      );
      validateSha256(value.artifactSha256, '/artifactSha256', errors);
      for (const field of [
        'assessmentCount',
        'evaluatedCount',
        'correctCount',
        'incorrectCount',
        'unassessedCount',
      ] as const) {
        validateBoundedCount(value[field], `/${field}`, EXAM_MAX_QUESTION_CANDIDATES, true, errors);
      }
      if (
        Number.isSafeInteger(value.evaluatedCount) &&
        Number.isSafeInteger(value.correctCount) &&
        Number.isSafeInteger(value.incorrectCount) &&
        value.evaluatedCount !== (value.correctCount as number) + (value.incorrectCount as number)
      ) {
        pushIssue(errors, '/evaluatedCount', 'evaluated count must equal outcome counts');
      }
      if (
        Number.isSafeInteger(value.assessmentCount) &&
        Number.isSafeInteger(value.evaluatedCount) &&
        Number.isSafeInteger(value.unassessedCount) &&
        value.assessmentCount !==
          (value.evaluatedCount as number) + (value.unassessedCount as number)
      ) {
        pushIssue(errors, '/assessmentCount', 'grading counts must cover every assessment');
      }
      break;
    }
    case 'exam_knowledge_suggestions_started':
      validateKnowledgeSuggestionsPlan(value, errors);
      break;
    case 'exam_knowledge_suggestions_completed': {
      validateKnowledgeSuggestionsPlan(value, errors);
      validateArtifactByteLength(
        value.artifactByteLength,
        '/artifactByteLength',
        EXAM_MAX_KNOWLEDGE_SUGGESTION_ARTIFACT_BYTES,
        errors,
      );
      validateSha256(value.artifactSha256, '/artifactSha256', errors);
      for (const field of [
        'questionCount',
        'generatedQuestionCount',
        'noSuggestionQuestionCount',
        'inputTooLargeQuestionCount',
      ] as const) {
        validateBoundedCount(value[field], `/${field}`, EXAM_MAX_QUESTION_CANDIDATES, true, errors);
      }
      validateBoundedCount(
        value.suggestionCount,
        '/suggestionCount',
        EXAM_MAX_QUESTION_CANDIDATES * EXAM_MAX_KNOWLEDGE_SUGGESTIONS_PER_QUESTION,
        true,
        errors,
      );
      if (
        Number.isSafeInteger(value.questionCount) &&
        Number.isSafeInteger(value.generatedQuestionCount) &&
        Number.isSafeInteger(value.noSuggestionQuestionCount) &&
        Number.isSafeInteger(value.inputTooLargeQuestionCount) &&
        value.questionCount !==
          (value.generatedQuestionCount as number) +
            (value.noSuggestionQuestionCount as number) +
            (value.inputTooLargeQuestionCount as number)
      ) {
        pushIssue(errors, '/questionCount', 'suggestion statuses must cover every question');
      }
      if (
        Number.isSafeInteger(value.generatedQuestionCount) &&
        Number.isSafeInteger(value.suggestionCount) &&
        ((value.generatedQuestionCount === 0 && value.suggestionCount !== 0) ||
          (value.generatedQuestionCount as number) > (value.suggestionCount as number) ||
          (value.suggestionCount as number) >
            (value.generatedQuestionCount as number) * EXAM_MAX_KNOWLEDGE_SUGGESTIONS_PER_QUESTION)
      ) {
        pushIssue(
          errors,
          '/suggestionCount',
          'generated questions must contain a bounded number of suggestions',
        );
      }
      break;
    }
    case 'exam_knowledge_mapping_started':
      validateKnowledgeMappingPlan(value, errors);
      break;
    case 'exam_knowledge_mapping_confirmed': {
      validateKnowledgeMappingPlan(value, errors);
      validateArtifactByteLength(
        value.artifactByteLength,
        '/artifactByteLength',
        EXAM_MAX_KNOWLEDGE_MAPPING_ARTIFACT_BYTES,
        errors,
      );
      validateSha256(value.artifactSha256, '/artifactSha256', errors);
      for (const field of ['entryCount', 'mappedQuestionCount', 'unmappedQuestionCount'] as const) {
        validateBoundedCount(value[field], `/${field}`, EXAM_MAX_QUESTION_CANDIDATES, true, errors);
      }
      if (
        Number.isSafeInteger(value.entryCount) &&
        Number.isSafeInteger(value.mappedQuestionCount) &&
        Number.isSafeInteger(value.unmappedQuestionCount) &&
        value.entryCount !==
          (value.mappedQuestionCount as number) + (value.unmappedQuestionCount as number)
      ) {
        pushIssue(errors, '/entryCount', 'mapping counts must cover every entry');
      }
      break;
    }
    case 'exam_observation_projection_started':
      validateObservationProjectionPlan(value, errors);
      break;
    case 'exam_observations_projected': {
      validateObservationProjectionPlan(value, errors);
      validateArtifactByteLength(
        value.artifactByteLength,
        '/artifactByteLength',
        EXAM_MAX_OBSERVATION_ARTIFACT_BYTES,
        errors,
      );
      validateSha256(value.artifactSha256, '/artifactSha256', errors);
      for (const field of [
        'observationCount',
        'evaluatedCount',
        'correctCount',
        'incorrectCount',
        'unassessedCount',
      ] as const) {
        validateBoundedCount(value[field], `/${field}`, EXAM_MAX_QUESTION_CANDIDATES, true, errors);
      }
      if (
        Number.isSafeInteger(value.evaluatedCount) &&
        Number.isSafeInteger(value.correctCount) &&
        Number.isSafeInteger(value.incorrectCount) &&
        value.evaluatedCount !== (value.correctCount as number) + (value.incorrectCount as number)
      ) {
        pushIssue(errors, '/evaluatedCount', 'evaluated count must equal outcome counts');
      }
      if (
        Number.isSafeInteger(value.observationCount) &&
        Number.isSafeInteger(value.evaluatedCount) &&
        Number.isSafeInteger(value.unassessedCount) &&
        value.observationCount !==
          (value.evaluatedCount as number) + (value.unassessedCount as number)
      ) {
        pushIssue(errors, '/observationCount', 'projection counts must cover every observation');
      }
      break;
    }
    case 'exam_delete_requested':
      validateSha256(value.documentSetFingerprint, '/documentSetFingerprint', errors);
      break;
    case 'exam_deleted':
      validateSha256(value.documentSetFingerprint, '/documentSetFingerprint', errors);
      validateIdentifier(value.deleteRequestEventId, '/deleteRequestEventId', errors);
      break;
  }
  return finishValidation(errors);
}

export function assertExamEvent(value: unknown): asserts value is ExamEvent {
  if (!validateExamEvent(value).valid) throw new ExamError('EXAM_EVENT_CONFLICT');
}

export function examEventsEqual(left: ExamEvent, right: ExamEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function examCreatedDocumentsEqual(
  left: readonly ExamCreatedDocument[],
  right: readonly ExamCreatedDocument[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
