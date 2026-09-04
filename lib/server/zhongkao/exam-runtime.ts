import { createHash } from 'node:crypto';

import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import {
  RuntimeAppendConflictError,
  RuntimeSessionEnumerationCorruptError,
  type RuntimeStore,
  type StrictRuntimeSessionStore,
} from '@openmaic/storage';

import { EXAM_DOCUMENT_SCHEMA_VERSION, EXAM_SCHEMA_VERSION } from '@/lib/zhongkao/exam';
import { ExamError } from '@/lib/zhongkao/exam-errors';
import {
  assertExamEvent,
  type ExamAnswerKeyPlanFacts,
  type ExamCreatedEvent,
  type ExamEvent,
  type ExamGradingPlanFacts,
  type ExamHumanReviewPlanFacts,
  type ExamKnowledgeMappingPlanFacts,
  type ExamKnowledgeSuggestionsPlanFacts,
  type ExamObservationProjectionPlanFacts,
} from '@/lib/zhongkao/exam-event';
import { foldExamEvents, type ExamSessionState } from '@/lib/zhongkao/exam-state';
import { ZHONGKAO_RUNTIME_KINDS } from '@/lib/zhongkao/runtime-kinds';
import { zhongkaoStageId } from '@/lib/zhongkao/runtime';

import { resolveZhongkaoLearnerKeyFromOwnerId } from './learner-identity';

const EXAM_ID_VERSION = 1 as const;
const EXAM_RUNTIME_SESSION_PREFIX = 'zhongkao-exam:';

export interface ExamRuntimeDeps {
  store: RuntimeStore;
  ownerId: string;
}

export interface ExamRuntimeSnapshot {
  session: RuntimeSession;
  records: RuntimeRecord[];
  state: ExamSessionState;
}

export interface ExamRuntimeWriteResult {
  snapshot: ExamRuntimeSnapshot;
  replayed: boolean;
  eventAppended: boolean;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

export function deriveExamSessionId(input: {
  learnerKey: string;
  profileId: string;
  clientRequestId: string;
}): string {
  return `exam:v${EXAM_ID_VERSION}:${digest('openmaic:zhongkao-exam-session:v1', {
    schemaVersion: EXAM_SCHEMA_VERSION,
    ...input,
  })}`;
}

export function deriveExamDocumentId(examSessionId: string, role: string): string {
  return `exam-document:v${EXAM_ID_VERSION}:${digest('openmaic:zhongkao-exam-document:v1', {
    schemaVersion: EXAM_DOCUMENT_SCHEMA_VERSION,
    examSessionId,
    role,
  })}`;
}

export function deriveExamDocumentArtifactRef(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
): string {
  return `exam-document-artifact:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-exam-document-artifact:v1',
    { examSessionId, examDocumentId, extractionVersion },
  )}`;
}

export function deriveExamCandidateArtifactRef(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
  segmentationVersion: number,
): string {
  return `exam-question-candidates:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-exam-question-candidates:v1',
    { examSessionId, examDocumentId, extractionVersion, segmentationVersion },
  )}`;
}

export function deriveExamResponseCaptureRef(
  examSessionId: string,
  captureVersion: number,
  segmentationVersion: number,
  sourceQuestionCandidateFingerprint: string,
): string {
  return `exam-response-capture:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-exam-response-capture:v1',
    {
      examSessionId,
      captureVersion,
      segmentationVersion,
      sourceQuestionCandidateFingerprint,
    },
  )}`;
}

export function deriveExamResponseArtifactRef(captureRef: string): string {
  return `exam-student-response-candidates:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-exam-student-response-candidates:v1',
    { captureRef },
  )}`;
}

export function deriveExamMatchingArtifactRef(captureRef: string, matchingVersion: number): string {
  return `exam-question-response-matches:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-exam-question-response-matches:v1',
    { captureRef, matchingVersion },
  )}`;
}

export type ExamHumanReviewRefInput = {
  examSessionId: string;
} & Omit<ExamHumanReviewPlanFacts, 'decisionSemanticFingerprint' | 'reviewArtifactRef'>;

export function deriveExamHumanReviewRef(input: ExamHumanReviewRefInput): string {
  return `exam-human-review:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-exam-human-review:v1',
    input,
  )}`;
}

export function deriveExamHumanReviewArtifactRef(reviewRef: string): string {
  return `exam-confirmed-review-facts:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-exam-confirmed-review-facts:v1',
    { reviewRef },
  )}`;
}

export type ExamAnswerKeyRefInput = {
  examSessionId: string;
} & Omit<
  ExamAnswerKeyPlanFacts,
  'answerKeySemanticFingerprint' | 'answerKeyRef' | 'answerKeyArtifactRef'
>;

export function deriveExamAnswerKeyRef(input: ExamAnswerKeyRefInput): string {
  return `exam-answer-key:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-exam-answer-key:v1',
    input,
  )}`;
}

export function deriveExamAnswerKeyArtifactRef(answerKeyRef: string): string {
  return `exam-authoritative-answer-key:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-exam-authoritative-answer-key:v1',
    { answerKeyRef },
  )}`;
}

export type ExamGradingRefInput = {
  examSessionId: string;
} & Omit<ExamGradingPlanFacts, 'gradingRef' | 'assessmentArtifactRef'>;

export function deriveExamGradingRef(input: ExamGradingRefInput): string {
  return `exam-grading:v${EXAM_ID_VERSION}:${digest('openmaic:zhongkao-exam-grading:v1', input)}`;
}

export function deriveExamAssessmentArtifactRef(gradingRef: string): string {
  return `exam-question-assessments:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-exam-question-assessments:v1',
    { gradingRef },
  )}`;
}

export type ExamKnowledgeSuggestionsGenerationRefInput = {
  examSessionId: string;
  profileId: string;
} & Omit<ExamKnowledgeSuggestionsPlanFacts, 'generationRef' | 'suggestionArtifactRef'>;

export function deriveExamKnowledgeSuggestionsGenerationRef(
  input: ExamKnowledgeSuggestionsGenerationRefInput,
): string {
  return `exam-knowledge-suggestions:v${input.generationVersion}:${digest(
    'openmaic:zhongkao-exam-knowledge-suggestions:v1',
    input,
  )}`;
}

export function deriveExamKnowledgeSuggestionsArtifactRef(generationRef: string): string {
  return `exam-knowledge-suggestions-artifact:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-exam-knowledge-suggestions-artifact:v1',
    { generationRef },
  )}`;
}

export interface ExamKnowledgeMappingRefInput {
  mappingVersion: number;
  examSessionId: string;
  profileId: string;
  subjectId: string;
  sourceReviewSemanticFingerprint: string;
  sourceAssessmentSemanticFingerprint: string;
}

export function deriveExamKnowledgeMappingRef(input: ExamKnowledgeMappingRefInput): string {
  return `exam-knowledge-mapping:v${input.mappingVersion}:${digest(
    'openmaic:zhongkao-exam-knowledge-mapping:v1',
    input,
  )}`;
}

export function deriveExamKnowledgeMappingArtifactRef(mappingRef: string): string {
  return `exam-confirmed-knowledge-mapping:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-confirmed-exam-knowledge-mapping-artifact:v1',
    { mappingRef },
  )}`;
}

export interface ExamObservationProjectionRefInput {
  observationVersion: number;
  examSessionId: string;
  sourceAssessmentSemanticFingerprint: string;
  sourceMappingSemanticFingerprint: string;
}

export function deriveExamObservationProjectionRef(
  input: ExamObservationProjectionRefInput,
): string {
  return `exam-observations:v${input.observationVersion}:${digest(
    'openmaic:zhongkao-confirmed-exam-observations:v1',
    input,
  )}`;
}

export function deriveExamObservationArtifactRef(observationRef: string): string {
  return `exam-confirmed-observations:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-confirmed-exam-observations-artifact:v1',
    { observationRef },
  )}`;
}

export function examRuntimeSessionId(examSessionId: string): string {
  return `${EXAM_RUNTIME_SESSION_PREFIX}${encodeURIComponent(examSessionId)}`;
}

export function createExamRequestFingerprint(facts: unknown): string {
  return digest('openmaic:zhongkao-exam-request-fingerprint:v1', facts);
}

export function createExamDocumentSetFingerprint(facts: unknown): string {
  return digest('openmaic:zhongkao-exam-document-set-fingerprint:v1', facts);
}

export function createExamOperationFingerprint(facts: unknown): string {
  return digest('openmaic:zhongkao-exam-operation-fingerprint:v1', facts);
}

function operationId(action: string, facts: unknown): string {
  return `exam-op:v${EXAM_ID_VERSION}:${digest(
    `openmaic:zhongkao-exam-operation:${action}:v1`,
    facts,
  )}`;
}

export function deriveExamCreatedOperationId(examSessionId: string): string {
  return operationId('created', { schemaVersion: EXAM_SCHEMA_VERSION, examSessionId });
}

export function deriveExamSnapshotOperationId(
  examSessionId: string,
  examDocumentId: string,
): string {
  return operationId('snapshot', {
    schemaVersion: EXAM_DOCUMENT_SCHEMA_VERSION,
    examSessionId,
    examDocumentId,
  });
}

export function deriveExamIntakeCompletedOperationId(
  examSessionId: string,
  documentSetFingerprint: string,
): string {
  return operationId('intake-completed', {
    schemaVersion: EXAM_SCHEMA_VERSION,
    examSessionId,
    documentSetFingerprint,
  });
}

export function deriveExamQuestionExtractionStartedOperationId(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
): string {
  return operationId('question-extraction-started', {
    examSessionId,
    examDocumentId,
    extractionVersion,
  });
}

export function deriveExamDocumentArtifactExtractedOperationId(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
): string {
  return operationId('document-artifact-extracted', {
    examSessionId,
    examDocumentId,
    extractionVersion,
  });
}

export function deriveExamQuestionSegmentationStartedOperationId(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
  segmentationVersion: number,
): string {
  return operationId('question-segmentation-started', {
    examSessionId,
    examDocumentId,
    extractionVersion,
    segmentationVersion,
  });
}

export function deriveExamQuestionCandidatesExtractedOperationId(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
  segmentationVersion: number,
): string {
  return operationId('question-candidates-extracted', {
    examSessionId,
    examDocumentId,
    extractionVersion,
    segmentationVersion,
  });
}

export function deriveExamStudentResponseCaptureStartedOperationId(
  examSessionId: string,
  captureVersion: number,
  segmentationVersion: number,
  sourceQuestionCandidateFingerprint: string,
): string {
  return operationId('student-response-capture-started', {
    examSessionId,
    captureVersion,
    segmentationVersion,
    sourceQuestionCandidateFingerprint,
  });
}

export function deriveExamResponseCandidatesRecordedOperationId(
  examSessionId: string,
  captureVersion: number,
  segmentationVersion: number,
  sourceQuestionCandidateFingerprint: string,
): string {
  return operationId('response-candidates-recorded', {
    examSessionId,
    captureVersion,
    segmentationVersion,
    sourceQuestionCandidateFingerprint,
  });
}

export function deriveExamResponseMatchingCompletedOperationId(
  examSessionId: string,
  captureVersion: number,
  matchingVersion: number,
  segmentationVersion: number,
  sourceQuestionCandidateFingerprint: string,
): string {
  return operationId('response-matching-completed', {
    examSessionId,
    captureVersion,
    matchingVersion,
    segmentationVersion,
    sourceQuestionCandidateFingerprint,
  });
}

export function deriveExamHumanReviewStartedOperationId(
  examSessionId: string,
  reviewVersion: number,
): string {
  return operationId('human-review-started', { examSessionId, reviewVersion });
}

export function deriveExamHumanReviewCompletedOperationId(
  examSessionId: string,
  reviewVersion: number,
): string {
  return operationId('human-review-completed', { examSessionId, reviewVersion });
}

export function deriveExamAnswerKeyStartedOperationId(
  examSessionId: string,
  answerKeyVersion: number,
): string {
  return operationId('answer-key-started', { examSessionId, answerKeyVersion });
}

export function deriveExamAnswerKeyConfirmedOperationId(
  examSessionId: string,
  answerKeyVersion: number,
): string {
  return operationId('answer-key-confirmed', { examSessionId, answerKeyVersion });
}

export function deriveExamGradingStartedOperationId(
  examSessionId: string,
  gradingVersion: number,
): string {
  return operationId('grading-started', { examSessionId, gradingVersion });
}

export function deriveExamGradingCompletedOperationId(
  examSessionId: string,
  gradingVersion: number,
): string {
  return operationId('grading-completed', { examSessionId, gradingVersion });
}

export function deriveExamKnowledgeSuggestionsStartedOperationId(
  examSessionId: string,
  generationVersion: number,
): string {
  return operationId('knowledge-suggestions-started', { examSessionId, generationVersion });
}

export function deriveExamKnowledgeSuggestionsCompletedOperationId(
  examSessionId: string,
  generationVersion: number,
): string {
  return operationId('knowledge-suggestions-completed', { examSessionId, generationVersion });
}

export function deriveExamKnowledgeMappingStartedOperationId(
  examSessionId: string,
  mappingVersion: number,
): string {
  return operationId('knowledge-mapping-started', { examSessionId, mappingVersion });
}

export function deriveExamKnowledgeMappingConfirmedOperationId(
  examSessionId: string,
  mappingVersion: number,
): string {
  return operationId('knowledge-mapping-confirmed', { examSessionId, mappingVersion });
}

export function deriveExamObservationProjectionStartedOperationId(
  examSessionId: string,
  mappingVersion: number,
  observationVersion: number,
): string {
  return operationId('observation-projection-started', {
    examSessionId,
    mappingVersion,
    observationVersion,
  });
}

export function deriveExamObservationsProjectedOperationId(
  examSessionId: string,
  mappingVersion: number,
  observationVersion: number,
): string {
  return operationId('observations-projected', {
    examSessionId,
    mappingVersion,
    observationVersion,
  });
}

export function deriveExamDeleteRequestedOperationId(examSessionId: string): string {
  return operationId('delete-requested', { schemaVersion: EXAM_SCHEMA_VERSION, examSessionId });
}

export function deriveExamDeletedOperationId(examSessionId: string): string {
  return operationId('deleted', { schemaVersion: EXAM_SCHEMA_VERSION, examSessionId });
}

export function deriveExamEventId(operation: string): string {
  return `exam-event:v${EXAM_ID_VERSION}:${digest('openmaic:zhongkao-exam-event:v1', operation)}`;
}

function eventFromRecord(record: RuntimeRecord): ExamEvent {
  assertExamEvent(record.payload);
  assertDerivedExamEvent(record.payload);
  return record.payload;
}

type ExamResponsePlanEvent = Extract<
  ExamEvent,
  {
    eventType:
      | 'exam_student_response_capture_started'
      | 'exam_response_candidates_recorded'
      | 'exam_response_matching_completed';
  }
>;

function responseCapturePlanFacts(event: ExamResponsePlanEvent) {
  return {
    captureVersion: event.captureVersion,
    matchingVersion: event.matchingVersion,
    segmentationVersion: event.segmentationVersion,
    questionCandidateArtifactRef: event.questionCandidateArtifactRef,
    sourceQuestionCandidateFingerprint: event.sourceQuestionCandidateFingerprint,
    inputSemanticFingerprint: event.inputSemanticFingerprint,
    captureRef: event.captureRef,
    responseArtifactRef: event.responseArtifactRef,
    matchingArtifactRef: event.matchingArtifactRef,
  } as const;
}

function assertDerivedResponseCapturePlan(event: ExamResponsePlanEvent): void {
  const captureRef = deriveExamResponseCaptureRef(
    event.examSessionId,
    event.captureVersion,
    event.segmentationVersion,
    event.sourceQuestionCandidateFingerprint,
  );
  if (
    event.captureRef !== captureRef ||
    event.responseArtifactRef !== deriveExamResponseArtifactRef(captureRef) ||
    event.matchingArtifactRef !== deriveExamMatchingArtifactRef(captureRef, event.matchingVersion)
  ) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
}

type ExamHumanReviewPlanEvent = Extract<
  ExamEvent,
  { eventType: 'exam_human_review_started' | 'exam_human_review_completed' }
>;

function humanReviewPlanFacts(event: ExamHumanReviewPlanEvent): ExamHumanReviewPlanFacts {
  return {
    reviewVersion: event.reviewVersion,
    questionExtractionVersion: event.questionExtractionVersion,
    questionSegmentationVersion: event.questionSegmentationVersion,
    responseCaptureVersion: event.responseCaptureVersion,
    matchingVersion: event.matchingVersion,
    questionCandidateArtifactRef: event.questionCandidateArtifactRef,
    sourceQuestionCandidateFingerprint: event.sourceQuestionCandidateFingerprint,
    responseArtifactRef: event.responseArtifactRef,
    sourceResponseArtifactFingerprint: event.sourceResponseArtifactFingerprint,
    matchingArtifactRef: event.matchingArtifactRef,
    sourceMatchingArtifactFingerprint: event.sourceMatchingArtifactFingerprint,
    decisionSemanticFingerprint: event.decisionSemanticFingerprint,
    reviewArtifactRef: event.reviewArtifactRef,
  };
}

function humanReviewRefInput(event: ExamHumanReviewPlanEvent): ExamHumanReviewRefInput {
  return {
    examSessionId: event.examSessionId,
    reviewVersion: event.reviewVersion,
    questionExtractionVersion: event.questionExtractionVersion,
    questionSegmentationVersion: event.questionSegmentationVersion,
    responseCaptureVersion: event.responseCaptureVersion,
    matchingVersion: event.matchingVersion,
    questionCandidateArtifactRef: event.questionCandidateArtifactRef,
    sourceQuestionCandidateFingerprint: event.sourceQuestionCandidateFingerprint,
    responseArtifactRef: event.responseArtifactRef,
    sourceResponseArtifactFingerprint: event.sourceResponseArtifactFingerprint,
    matchingArtifactRef: event.matchingArtifactRef,
    sourceMatchingArtifactFingerprint: event.sourceMatchingArtifactFingerprint,
  };
}

function assertDerivedHumanReviewPlan(event: ExamHumanReviewPlanEvent): void {
  const reviewRef = deriveExamHumanReviewRef(humanReviewRefInput(event));
  if (event.reviewArtifactRef !== deriveExamHumanReviewArtifactRef(reviewRef)) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
}

type ExamAnswerKeyPlanEvent = Extract<
  ExamEvent,
  { eventType: 'exam_answer_key_started' | 'exam_answer_key_confirmed' }
>;

function answerKeyPlanFacts(event: ExamAnswerKeyPlanEvent): ExamAnswerKeyPlanFacts {
  return {
    answerKeyVersion: event.answerKeyVersion,
    reviewVersion: event.reviewVersion,
    reviewArtifactRef: event.reviewArtifactRef,
    sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
    answerKeySemanticFingerprint: event.answerKeySemanticFingerprint,
    answerKeyRef: event.answerKeyRef,
    answerKeyArtifactRef: event.answerKeyArtifactRef,
  };
}

function assertDerivedAnswerKeyPlan(event: ExamAnswerKeyPlanEvent): void {
  const answerKeyRef = deriveExamAnswerKeyRef({
    examSessionId: event.examSessionId,
    answerKeyVersion: event.answerKeyVersion,
    reviewVersion: event.reviewVersion,
    reviewArtifactRef: event.reviewArtifactRef,
    sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
  });
  if (
    event.answerKeyRef !== answerKeyRef ||
    event.answerKeyArtifactRef !== deriveExamAnswerKeyArtifactRef(answerKeyRef)
  ) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
}

type ExamGradingPlanEvent = Extract<
  ExamEvent,
  { eventType: 'exam_grading_started' | 'exam_grading_completed' }
>;

function gradingPlanFacts(event: ExamGradingPlanEvent): ExamGradingPlanFacts {
  return {
    gradingVersion: event.gradingVersion,
    gradingAlgorithmVersion: event.gradingAlgorithmVersion,
    reviewVersion: event.reviewVersion,
    reviewArtifactRef: event.reviewArtifactRef,
    sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
    answerKeyVersion: event.answerKeyVersion,
    answerKeyRef: event.answerKeyRef,
    answerKeyArtifactRef: event.answerKeyArtifactRef,
    sourceAnswerKeyArtifactFingerprint: event.sourceAnswerKeyArtifactFingerprint,
    gradingRef: event.gradingRef,
    assessmentArtifactRef: event.assessmentArtifactRef,
  };
}

function assertDerivedGradingPlan(event: ExamGradingPlanEvent): void {
  const gradingRef = deriveExamGradingRef({
    examSessionId: event.examSessionId,
    gradingVersion: event.gradingVersion,
    gradingAlgorithmVersion: event.gradingAlgorithmVersion,
    reviewVersion: event.reviewVersion,
    reviewArtifactRef: event.reviewArtifactRef,
    sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
    answerKeyVersion: event.answerKeyVersion,
    answerKeyRef: event.answerKeyRef,
    answerKeyArtifactRef: event.answerKeyArtifactRef,
    sourceAnswerKeyArtifactFingerprint: event.sourceAnswerKeyArtifactFingerprint,
  });
  if (
    event.gradingRef !== gradingRef ||
    event.assessmentArtifactRef !== deriveExamAssessmentArtifactRef(gradingRef)
  ) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
}

type ExamKnowledgeSuggestionsPlanEvent = Extract<
  ExamEvent,
  {
    eventType: 'exam_knowledge_suggestions_started' | 'exam_knowledge_suggestions_completed';
  }
>;

function knowledgeSuggestionsPlanFacts(
  event: ExamKnowledgeSuggestionsPlanEvent,
): ExamKnowledgeSuggestionsPlanFacts {
  return {
    generationVersion: event.generationVersion,
    subjectId: event.subjectId,
    generatorVersion: event.generatorVersion,
    candidateSchemaVersion: event.candidateSchemaVersion,
    reviewVersion: event.reviewVersion,
    reviewArtifactRef: event.reviewArtifactRef,
    sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
    sourceReviewSemanticFingerprint: event.sourceReviewSemanticFingerprint,
    candidatePoolMode: event.candidatePoolMode,
    candidatePoolFingerprint: event.candidatePoolFingerprint,
    generationRef: event.generationRef,
    suggestionArtifactRef: event.suggestionArtifactRef,
  };
}

function assertDerivedKnowledgeSuggestionsPlan(event: ExamKnowledgeSuggestionsPlanEvent): void {
  const generationRef = deriveExamKnowledgeSuggestionsGenerationRef({
    generationVersion: event.generationVersion,
    generatorVersion: event.generatorVersion,
    candidateSchemaVersion: event.candidateSchemaVersion,
    examSessionId: event.examSessionId,
    profileId: event.profileId,
    subjectId: event.subjectId,
    reviewVersion: event.reviewVersion,
    reviewArtifactRef: event.reviewArtifactRef,
    sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
    sourceReviewSemanticFingerprint: event.sourceReviewSemanticFingerprint,
    candidatePoolMode: event.candidatePoolMode,
    candidatePoolFingerprint: event.candidatePoolFingerprint,
  });
  if (
    event.generationRef !== generationRef ||
    event.suggestionArtifactRef !== deriveExamKnowledgeSuggestionsArtifactRef(generationRef)
  ) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
}

type ExamKnowledgeMappingPlanEvent = Extract<
  ExamEvent,
  { eventType: 'exam_knowledge_mapping_started' | 'exam_knowledge_mapping_confirmed' }
>;

function knowledgeMappingPlanFacts(
  event: ExamKnowledgeMappingPlanEvent,
): ExamKnowledgeMappingPlanFacts {
  return {
    mappingVersion: event.mappingVersion,
    subjectId: event.subjectId,
    reviewVersion: event.reviewVersion,
    reviewArtifactRef: event.reviewArtifactRef,
    sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
    sourceReviewSemanticFingerprint: event.sourceReviewSemanticFingerprint,
    assessmentVersion: event.assessmentVersion,
    assessmentArtifactRef: event.assessmentArtifactRef,
    sourceAssessmentArtifactFingerprint: event.sourceAssessmentArtifactFingerprint,
    sourceAssessmentSemanticFingerprint: event.sourceAssessmentSemanticFingerprint,
    mappingSemanticFingerprint: event.mappingSemanticFingerprint,
    mappingRef: event.mappingRef,
    mappingArtifactRef: event.mappingArtifactRef,
  };
}

function assertDerivedKnowledgeMappingPlan(event: ExamKnowledgeMappingPlanEvent): void {
  const mappingRef = deriveExamKnowledgeMappingRef({
    mappingVersion: event.mappingVersion,
    examSessionId: event.examSessionId,
    profileId: event.profileId,
    subjectId: event.subjectId,
    sourceReviewSemanticFingerprint: event.sourceReviewSemanticFingerprint,
    sourceAssessmentSemanticFingerprint: event.sourceAssessmentSemanticFingerprint,
  });
  if (
    event.mappingRef !== mappingRef ||
    event.mappingArtifactRef !== deriveExamKnowledgeMappingArtifactRef(mappingRef)
  ) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
}

type ExamObservationProjectionPlanEvent = Extract<
  ExamEvent,
  {
    eventType: 'exam_observation_projection_started' | 'exam_observations_projected';
  }
>;

function observationProjectionPlanFacts(
  event: ExamObservationProjectionPlanEvent,
): ExamObservationProjectionPlanFacts {
  return {
    observationVersion: event.observationVersion,
    reviewVersion: event.reviewVersion,
    reviewArtifactRef: event.reviewArtifactRef,
    sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
    sourceReviewSemanticFingerprint: event.sourceReviewSemanticFingerprint,
    assessmentVersion: event.assessmentVersion,
    assessmentArtifactRef: event.assessmentArtifactRef,
    sourceAssessmentArtifactFingerprint: event.sourceAssessmentArtifactFingerprint,
    sourceAssessmentSemanticFingerprint: event.sourceAssessmentSemanticFingerprint,
    mappingVersion: event.mappingVersion,
    mappingRef: event.mappingRef,
    mappingArtifactRef: event.mappingArtifactRef,
    sourceMappingArtifactFingerprint: event.sourceMappingArtifactFingerprint,
    sourceMappingSemanticFingerprint: event.sourceMappingSemanticFingerprint,
    observationSemanticFingerprint: event.observationSemanticFingerprint,
    observationRef: event.observationRef,
    observationArtifactRef: event.observationArtifactRef,
  };
}

function assertDerivedObservationProjectionPlan(event: ExamObservationProjectionPlanEvent): void {
  const observationRef = deriveExamObservationProjectionRef({
    observationVersion: event.observationVersion,
    examSessionId: event.examSessionId,
    sourceAssessmentSemanticFingerprint: event.sourceAssessmentSemanticFingerprint,
    sourceMappingSemanticFingerprint: event.sourceMappingSemanticFingerprint,
  });
  if (
    event.observationRef !== observationRef ||
    event.observationArtifactRef !== deriveExamObservationArtifactRef(observationRef)
  ) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
}

function assertDerivedExamEvent(event: ExamEvent): void {
  if (event.eventId !== deriveExamEventId(event.operationId)) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }

  let expectedOperationId: string;
  let expectedOperationFingerprint: string;
  switch (event.eventType) {
    case 'exam_created': {
      if (
        event.documents.some(
          (document) =>
            document.examDocumentId !== deriveExamDocumentId(event.examSessionId, document.role),
        )
      ) {
        throw new ExamError('EXAM_EVENT_CONFLICT');
      }
      const requestFingerprint = createExamRequestFingerprint({
        schemaVersion: EXAM_SCHEMA_VERSION,
        profileId: event.profileId,
        subjectId: event.subjectId,
        ...(event.title === undefined ? {} : { title: event.title }),
        documents: event.documents.map(({ role, ownerMaterialId }) => ({
          role,
          ownerMaterialId,
        })),
      });
      const documentSetFingerprint = createExamDocumentSetFingerprint(event.documents);
      if (
        event.requestFingerprint !== requestFingerprint ||
        event.documentSetFingerprint !== documentSetFingerprint
      ) {
        throw new ExamError('EXAM_EVENT_CONFLICT');
      }
      expectedOperationId = deriveExamCreatedOperationId(event.examSessionId);
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_created',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        subjectId: event.subjectId,
        title: event.title,
        requestFingerprint,
        documentSetFingerprint,
        documents: event.documents,
      });
      break;
    }
    case 'exam_document_snapshotted':
      expectedOperationId = deriveExamSnapshotOperationId(
        event.examSessionId,
        event.examDocumentId,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_document_snapshotted',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        examDocumentId: event.examDocumentId,
        snapshotSha256: event.snapshotSha256,
        byteLength: event.byteLength,
      });
      break;
    case 'exam_intake_completed':
      expectedOperationId = deriveExamIntakeCompletedOperationId(
        event.examSessionId,
        event.documentSetFingerprint,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_intake_completed',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        documentSetFingerprint: event.documentSetFingerprint,
      });
      break;
    case 'exam_question_extraction_started':
      if (
        event.documentArtifactRef !==
        deriveExamDocumentArtifactRef(
          event.examSessionId,
          event.examDocumentId,
          event.extractionVersion,
        )
      ) {
        throw new ExamError('EXAM_EVENT_CONFLICT');
      }
      expectedOperationId = deriveExamQuestionExtractionStartedOperationId(
        event.examSessionId,
        event.examDocumentId,
        event.extractionVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_question_extraction_started',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        extractionVersion: event.extractionVersion,
        examDocumentId: event.examDocumentId,
        sourceSnapshotFingerprint: event.sourceSnapshotFingerprint,
        extractorId: event.extractorId,
        extractorVersion: event.extractorVersion,
        normalizationVersion: event.normalizationVersion,
        documentArtifactRef: event.documentArtifactRef,
      });
      break;
    case 'exam_document_artifact_extracted':
      if (
        event.documentArtifactRef !==
        deriveExamDocumentArtifactRef(
          event.examSessionId,
          event.examDocumentId,
          event.extractionVersion,
        )
      ) {
        throw new ExamError('EXAM_EVENT_CONFLICT');
      }
      expectedOperationId = deriveExamDocumentArtifactExtractedOperationId(
        event.examSessionId,
        event.examDocumentId,
        event.extractionVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_document_artifact_extracted',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        extractionVersion: event.extractionVersion,
        examDocumentId: event.examDocumentId,
        sourceSnapshotFingerprint: event.sourceSnapshotFingerprint,
        extractorId: event.extractorId,
        extractorVersion: event.extractorVersion,
        normalizationVersion: event.normalizationVersion,
        documentArtifactRef: event.documentArtifactRef,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        pageCount: event.pageCount,
      });
      break;
    case 'exam_question_segmentation_started':
      if (
        event.documentArtifactRef !==
          deriveExamDocumentArtifactRef(
            event.examSessionId,
            event.examDocumentId,
            event.extractionVersion,
          ) ||
        event.candidateArtifactRef !==
          deriveExamCandidateArtifactRef(
            event.examSessionId,
            event.examDocumentId,
            event.extractionVersion,
            event.segmentationVersion,
          )
      ) {
        throw new ExamError('EXAM_EVENT_CONFLICT');
      }
      expectedOperationId = deriveExamQuestionSegmentationStartedOperationId(
        event.examSessionId,
        event.examDocumentId,
        event.extractionVersion,
        event.segmentationVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_question_segmentation_started',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        extractionVersion: event.extractionVersion,
        segmentationVersion: event.segmentationVersion,
        examDocumentId: event.examDocumentId,
        sourceArtifactFingerprint: event.sourceArtifactFingerprint,
        documentArtifactRef: event.documentArtifactRef,
        candidateArtifactRef: event.candidateArtifactRef,
      });
      break;
    case 'exam_question_candidates_extracted':
      if (
        event.documentArtifactRef !==
          deriveExamDocumentArtifactRef(
            event.examSessionId,
            event.examDocumentId,
            event.extractionVersion,
          ) ||
        event.candidateArtifactRef !==
          deriveExamCandidateArtifactRef(
            event.examSessionId,
            event.examDocumentId,
            event.extractionVersion,
            event.segmentationVersion,
          )
      ) {
        throw new ExamError('EXAM_EVENT_CONFLICT');
      }
      expectedOperationId = deriveExamQuestionCandidatesExtractedOperationId(
        event.examSessionId,
        event.examDocumentId,
        event.extractionVersion,
        event.segmentationVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_question_candidates_extracted',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        extractionVersion: event.extractionVersion,
        segmentationVersion: event.segmentationVersion,
        examDocumentId: event.examDocumentId,
        sourceArtifactFingerprint: event.sourceArtifactFingerprint,
        documentArtifactRef: event.documentArtifactRef,
        candidateArtifactRef: event.candidateArtifactRef,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        candidateCount: event.candidateCount,
        needsReview: event.needsReview,
      });
      break;
    case 'exam_student_response_capture_started':
      assertDerivedResponseCapturePlan(event);
      expectedOperationId = deriveExamStudentResponseCaptureStartedOperationId(
        event.examSessionId,
        event.captureVersion,
        event.segmentationVersion,
        event.sourceQuestionCandidateFingerprint,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_student_response_capture_started',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...responseCapturePlanFacts(event),
      });
      break;
    case 'exam_response_candidates_recorded':
      assertDerivedResponseCapturePlan(event);
      expectedOperationId = deriveExamResponseCandidatesRecordedOperationId(
        event.examSessionId,
        event.captureVersion,
        event.segmentationVersion,
        event.sourceQuestionCandidateFingerprint,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_response_candidates_recorded',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...responseCapturePlanFacts(event),
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        responseCount: event.responseCount,
      });
      break;
    case 'exam_response_matching_completed':
      assertDerivedResponseCapturePlan(event);
      expectedOperationId = deriveExamResponseMatchingCompletedOperationId(
        event.examSessionId,
        event.captureVersion,
        event.matchingVersion,
        event.segmentationVersion,
        event.sourceQuestionCandidateFingerprint,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_response_matching_completed',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...responseCapturePlanFacts(event),
        responseArtifactFingerprint: event.responseArtifactFingerprint,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        responseCount: event.responseCount,
        matchedCount: event.matchedCount,
        ambiguousCount: event.ambiguousCount,
        unmatchedCount: event.unmatchedCount,
        needsReview: event.needsReview,
      });
      break;
    case 'exam_human_review_started':
      assertDerivedHumanReviewPlan(event);
      expectedOperationId = deriveExamHumanReviewStartedOperationId(
        event.examSessionId,
        event.reviewVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_human_review_started',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...humanReviewPlanFacts(event),
      });
      break;
    case 'exam_human_review_completed':
      assertDerivedHumanReviewPlan(event);
      expectedOperationId = deriveExamHumanReviewCompletedOperationId(
        event.examSessionId,
        event.reviewVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_human_review_completed',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...humanReviewPlanFacts(event),
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        confirmedQuestionCount: event.confirmedQuestionCount,
        confirmedResponseCount: event.confirmedResponseCount,
        confirmedMatchCount: event.confirmedMatchCount,
        rejectedQuestionCount: event.rejectedQuestionCount,
        rejectedResponseCount: event.rejectedResponseCount,
      });
      break;
    case 'exam_answer_key_started':
      assertDerivedAnswerKeyPlan(event);
      expectedOperationId = deriveExamAnswerKeyStartedOperationId(
        event.examSessionId,
        event.answerKeyVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_answer_key_started',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...answerKeyPlanFacts(event),
      });
      break;
    case 'exam_answer_key_confirmed':
      assertDerivedAnswerKeyPlan(event);
      expectedOperationId = deriveExamAnswerKeyConfirmedOperationId(
        event.examSessionId,
        event.answerKeyVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_answer_key_confirmed',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...answerKeyPlanFacts(event),
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        entryCount: event.entryCount,
        objectiveEntryCount: event.objectiveEntryCount,
        unassessedEntryCount: event.unassessedEntryCount,
      });
      break;
    case 'exam_grading_started':
      assertDerivedGradingPlan(event);
      expectedOperationId = deriveExamGradingStartedOperationId(
        event.examSessionId,
        event.gradingVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_grading_started',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...gradingPlanFacts(event),
      });
      break;
    case 'exam_grading_completed':
      assertDerivedGradingPlan(event);
      expectedOperationId = deriveExamGradingCompletedOperationId(
        event.examSessionId,
        event.gradingVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_grading_completed',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...gradingPlanFacts(event),
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        assessmentCount: event.assessmentCount,
        evaluatedCount: event.evaluatedCount,
        correctCount: event.correctCount,
        incorrectCount: event.incorrectCount,
        unassessedCount: event.unassessedCount,
      });
      break;
    case 'exam_knowledge_suggestions_started':
      assertDerivedKnowledgeSuggestionsPlan(event);
      expectedOperationId = deriveExamKnowledgeSuggestionsStartedOperationId(
        event.examSessionId,
        event.generationVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_knowledge_suggestions_started',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...knowledgeSuggestionsPlanFacts(event),
      });
      break;
    case 'exam_knowledge_suggestions_completed':
      assertDerivedKnowledgeSuggestionsPlan(event);
      expectedOperationId = deriveExamKnowledgeSuggestionsCompletedOperationId(
        event.examSessionId,
        event.generationVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_knowledge_suggestions_completed',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...knowledgeSuggestionsPlanFacts(event),
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        questionCount: event.questionCount,
        generatedQuestionCount: event.generatedQuestionCount,
        noSuggestionQuestionCount: event.noSuggestionQuestionCount,
        inputTooLargeQuestionCount: event.inputTooLargeQuestionCount,
        suggestionCount: event.suggestionCount,
      });
      break;
    case 'exam_knowledge_mapping_started':
      assertDerivedKnowledgeMappingPlan(event);
      expectedOperationId = deriveExamKnowledgeMappingStartedOperationId(
        event.examSessionId,
        event.mappingVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_knowledge_mapping_started',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...knowledgeMappingPlanFacts(event),
      });
      break;
    case 'exam_knowledge_mapping_confirmed':
      assertDerivedKnowledgeMappingPlan(event);
      expectedOperationId = deriveExamKnowledgeMappingConfirmedOperationId(
        event.examSessionId,
        event.mappingVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_knowledge_mapping_confirmed',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...knowledgeMappingPlanFacts(event),
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        entryCount: event.entryCount,
        mappedQuestionCount: event.mappedQuestionCount,
        unmappedQuestionCount: event.unmappedQuestionCount,
      });
      break;
    case 'exam_observation_projection_started':
      assertDerivedObservationProjectionPlan(event);
      expectedOperationId = deriveExamObservationProjectionStartedOperationId(
        event.examSessionId,
        event.mappingVersion,
        event.observationVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_observation_projection_started',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...observationProjectionPlanFacts(event),
      });
      break;
    case 'exam_observations_projected':
      assertDerivedObservationProjectionPlan(event);
      expectedOperationId = deriveExamObservationsProjectedOperationId(
        event.examSessionId,
        event.mappingVersion,
        event.observationVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_observations_projected',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        ...observationProjectionPlanFacts(event),
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        observationCount: event.observationCount,
        evaluatedCount: event.evaluatedCount,
        correctCount: event.correctCount,
        incorrectCount: event.incorrectCount,
        unassessedCount: event.unassessedCount,
      });
      break;
    case 'exam_delete_requested':
      expectedOperationId = deriveExamDeleteRequestedOperationId(event.examSessionId);
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_delete_requested',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        documentSetFingerprint: event.documentSetFingerprint,
      });
      break;
    case 'exam_deleted':
      expectedOperationId = deriveExamDeletedOperationId(event.examSessionId);
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_deleted',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        documentSetFingerprint: event.documentSetFingerprint,
        deleteRequestEventId: event.deleteRequestEventId,
      });
      break;
  }
  if (
    event.operationId !== expectedOperationId ||
    event.operationFingerprint !== expectedOperationFingerprint
  ) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
}

function operationRecord(
  records: readonly RuntimeRecord[],
  operation: string,
  fingerprint: string,
): RuntimeRecord | undefined {
  const match = records.find((record) => eventFromRecord(record).operationId === operation);
  if (!match) return undefined;
  if (eventFromRecord(match).operationFingerprint !== fingerprint) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
  return match;
}

function assertSessionOwner(session: RuntimeSession, learnerKey: string): void {
  if (
    session.kind !== ZHONGKAO_RUNTIME_KINDS.examEvent ||
    session.learnerKey !== learnerKey ||
    (session.status !== 'active' && session.status !== 'completed')
  ) {
    throw new ExamError('EXAM_NOT_FOUND');
  }
}

function assertCreatedSessionPartition(
  session: RuntimeSession,
  event: ExamCreatedEvent,
  learnerKey: string,
): void {
  if (
    session.id !== examRuntimeSessionId(event.examSessionId) ||
    session.kind !== ZHONGKAO_RUNTIME_KINDS.examEvent ||
    session.stageId !== zhongkaoStageId(event.profileId) ||
    session.learnerKey !== learnerKey ||
    session.status !== 'active'
  ) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
}

function currentSnapshot(
  session: RuntimeSession,
  records: readonly RuntimeRecord[],
): ExamRuntimeSnapshot {
  records.forEach(eventFromRecord);
  const state = foldExamEvents(records);
  if (
    session.id !== examRuntimeSessionId(state.examSessionId) ||
    session.stageId !== zhongkaoStageId(state.profileId) ||
    (state.status === 'deleted' && session.status !== 'completed') ||
    (state.status !== 'deleted' && session.status !== 'active')
  ) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
  return { session, records: [...records], state };
}

async function ownedSession(
  deps: ExamRuntimeDeps,
  examSessionId: string,
): Promise<RuntimeSession | undefined> {
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  const session = await deps.store.getSession(examRuntimeSessionId(examSessionId));
  if (!session) return undefined;
  assertSessionOwner(session, learnerKey);
  return session;
}

async function reloadOperation(
  deps: ExamRuntimeDeps,
  event: ExamEvent,
): Promise<ExamRuntimeWriteResult | undefined> {
  const session = await ownedSession(deps, event.examSessionId);
  if (!session) return undefined;
  const records = await deps.store.listRecords(session.id);
  if (records.length === 0) return undefined;
  const snapshot = currentSnapshot(session, records);
  if (snapshot.state.profileId !== event.profileId) throw new ExamError('EXAM_NOT_FOUND');
  const replay = operationRecord(records, event.operationId, event.operationFingerprint);
  return replay ? { snapshot, replayed: true, eventAppended: false } : undefined;
}

export async function loadExamRuntime(
  deps: ExamRuntimeDeps,
  examSessionId: string,
): Promise<ExamRuntimeSnapshot> {
  const session = await ownedSession(deps, examSessionId);
  if (!session) throw new ExamError('EXAM_NOT_FOUND');
  const records = await deps.store.listRecords(session.id);
  if (records.length === 0) throw new ExamError('EXAM_EVENT_CONFLICT');
  const snapshot = currentSnapshot(session, records);
  if (snapshot.state.examSessionId !== examSessionId) throw new ExamError('EXAM_NOT_FOUND');
  return snapshot;
}

export async function listProfileExamRuntimeSnapshots(
  deps: ExamRuntimeDeps,
  profileId: string,
): Promise<ExamRuntimeSnapshot[]> {
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  const strictStore = deps.store as Partial<StrictRuntimeSessionStore>;
  if (typeof strictStore.listSessionsStrict !== 'function') {
    throw new ExamError('EXAM_SESSION_CONFLICT');
  }

  let sessions: RuntimeSession[];
  try {
    sessions = await strictStore.listSessionsStrict.call(
      deps.store,
      zhongkaoStageId(profileId),
      learnerKey,
      {
        kinds: [ZHONGKAO_RUNTIME_KINDS.examEvent],
        idPrefixes: [EXAM_RUNTIME_SESSION_PREFIX],
      },
    );
  } catch (error) {
    if (error instanceof RuntimeSessionEnumerationCorruptError) {
      throw new ExamError('EXAM_EVENT_CONFLICT');
    }
    throw new ExamError('EXAM_SESSION_CONFLICT');
  }
  const snapshots: ExamRuntimeSnapshot[] = [];

  for (const session of sessions) {
    if (session.kind !== ZHONGKAO_RUNTIME_KINDS.examEvent) continue;
    assertSessionOwner(session, learnerKey);
    const records = await deps.store.listRecords(session.id);
    if (records.length === 0) throw new ExamError('EXAM_EVENT_CONFLICT');
    const snapshot = currentSnapshot(session, records);
    if (snapshot.state.profileId !== profileId) throw new ExamError('EXAM_EVENT_CONFLICT');
    if (snapshot.state.status !== 'deleted') snapshots.push(snapshot);
  }

  return snapshots.toSorted((left, right) => {
    const createdOrder = Date.parse(left.state.createdAt) - Date.parse(right.state.createdAt);
    if (createdOrder !== 0) return createdOrder;
    return left.state.examSessionId < right.state.examSessionId
      ? -1
      : left.state.examSessionId > right.state.examSessionId
        ? 1
        : 0;
  });
}

export async function ensureExamRuntimeCreated(
  deps: ExamRuntimeDeps,
  event: ExamCreatedEvent,
): Promise<ExamRuntimeWriteResult> {
  assertExamEvent(event);
  assertDerivedExamEvent(event);
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  const sessionId = examRuntimeSessionId(event.examSessionId);
  let session = await ownedSession(deps, event.examSessionId);
  if (!session) {
    try {
      session = await deps.store.createSession({
        id: sessionId,
        kind: ZHONGKAO_RUNTIME_KINDS.examEvent,
        stageId: zhongkaoStageId(event.profileId),
        learnerKey,
        status: 'active',
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      });
    } catch (error) {
      session = await ownedSession(deps, event.examSessionId);
      if (!session) throw error;
    }
  }
  assertCreatedSessionPartition(session, event, learnerKey);

  const records = await deps.store.listRecords(session.id);
  if (records.length > 0) {
    const snapshot = currentSnapshot(session, records);
    const replay = operationRecord(records, event.operationId, event.operationFingerprint);
    if (!replay) throw new ExamError('EXAM_REQUEST_CONFLICT');
    return { snapshot, replayed: true, eventAppended: false };
  }

  try {
    await deps.store.appendRecord(
      {
        id: event.eventId,
        sessionId: session.id,
        subAnchor: event.eventId,
        createdAt: event.createdAt,
        payload: event,
      },
      { expectedLastSeq: null },
    );
  } catch (error) {
    const replay = await reloadOperation(deps, event).catch(() => undefined);
    if (replay) return replay;
    if (error instanceof RuntimeAppendConflictError) {
      throw new ExamError('EXAM_SESSION_CONFLICT');
    }
    throw error;
  }
  const snapshot = await loadExamRuntime(deps, event.examSessionId);
  return { snapshot, replayed: false, eventAppended: true };
}

export async function appendExamRuntimeEvent(
  deps: ExamRuntimeDeps,
  input: { event: Exclude<ExamEvent, ExamCreatedEvent>; expectedRevision: number },
): Promise<ExamRuntimeWriteResult> {
  const { event } = input;
  assertExamEvent(event);
  assertDerivedExamEvent(event);
  const session = await ownedSession(deps, event.examSessionId);
  if (!session) throw new ExamError('EXAM_NOT_FOUND');
  const records = await deps.store.listRecords(session.id);
  const before = currentSnapshot(session, records);
  if (before.state.profileId !== event.profileId) throw new ExamError('EXAM_NOT_FOUND');

  const replay = operationRecord(records, event.operationId, event.operationFingerprint);
  if (replay) return { snapshot: before, replayed: true, eventAppended: false };
  if (before.state.revision !== input.expectedRevision) {
    throw new ExamError('EXAM_SESSION_CONFLICT', before.state.revision);
  }

  const candidate = {
    id: event.eventId,
    sessionId: session.id,
    seq: input.expectedRevision + 1,
    subAnchor: event.eventId,
    createdAt: event.createdAt,
    payload: event,
  } as RuntimeRecord;
  foldExamEvents([...records, candidate]);

  try {
    await deps.store.appendRecord(
      {
        id: event.eventId,
        sessionId: session.id,
        subAnchor: event.eventId,
        createdAt: event.createdAt,
        payload: event,
      },
      {
        expectedLastSeq: input.expectedRevision,
        ...(event.eventType === 'exam_deleted'
          ? { sessionTransition: { status: 'completed' as const, updatedAt: event.createdAt } }
          : {}),
      },
    );
  } catch (error) {
    const recovered = await reloadOperation(deps, event).catch(() => undefined);
    if (recovered) return recovered;
    if (error instanceof RuntimeAppendConflictError) {
      const latest = await loadExamRuntime(deps, event.examSessionId).catch(() => undefined);
      throw new ExamError('EXAM_SESSION_CONFLICT', latest?.state.revision);
    }
    throw error;
  }
  const snapshot = await loadExamRuntime(deps, event.examSessionId);
  return { snapshot, replayed: false, eventAppended: true };
}
