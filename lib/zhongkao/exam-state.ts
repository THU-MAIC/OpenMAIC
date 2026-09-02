import type { RuntimeRecord } from '@openmaic/dsl';

import {
  EXAM_SCHEMA_VERSION,
  type PublicExamGradingSummary,
  type PublicExamHumanReviewSummary,
  type PublicExamKnowledgeMappingSummary,
  type PublicExamObservationProjectionSummary,
  type PublicExamQuestionExtractionSummary,
  type PublicExamSession,
  type PublicExamStatus,
  type PublicExamStudentResponseMatchingSummary,
} from './exam';
import { ExamError } from './exam-errors';
import {
  assertExamEvent,
  type ExamAnswerKeyPlanFacts,
  type ExamCreatedDocument,
  type ExamEvent,
  type ExamGradingPlanFacts,
  type ExamHumanReviewPlanFacts,
  type ExamKnowledgeMappingPlanFacts,
  type ExamObservationProjectionPlanFacts,
} from './exam-event';

export type ExamSessionStatus = 'intake_pending' | 'ready_for_extraction' | 'deleting' | 'deleted';

export interface ExamDocumentSnapshotFact {
  eventId: string;
  createdAt: string;
  sha256: string;
  byteLength: number;
}

export interface ExamDocumentState extends ExamCreatedDocument {
  snapshot?: ExamDocumentSnapshotFact;
}

export type ExamQuestionExtractionStatus =
  | 'extracting_document'
  | 'document_artifact_ready'
  | 'segmenting_questions'
  | 'question_candidates_ready';

export interface ExamDocumentArtifactFact {
  eventId: string;
  createdAt: string;
  byteLength: number;
  sha256: string;
  pageCount: number;
}

export interface ExamQuestionCandidateArtifactFact {
  eventId: string;
  createdAt: string;
  byteLength: number;
  sha256: string;
  candidateCount: number;
  needsReview: boolean;
}

export interface ExamQuestionSegmentationState {
  startedEventId: string;
  startedAt: string;
  segmentationVersion: number;
  sourceArtifactFingerprint: string;
  candidateArtifactRef: string;
  candidateArtifact?: ExamQuestionCandidateArtifactFact;
}

export interface ExamQuestionExtractionState {
  status: ExamQuestionExtractionStatus;
  startedEventId: string;
  startedAt: string;
  extractionVersion: number;
  examDocumentId: string;
  sourceSnapshotFingerprint: string;
  extractorId: string;
  extractorVersion: string;
  normalizationVersion: string;
  documentArtifactRef: string;
  documentArtifact?: ExamDocumentArtifactFact;
  segmentation?: ExamQuestionSegmentationState;
}

export type ExamStudentResponseCaptureStatus =
  | 'capturing'
  | 'response_candidates_ready'
  | 'matching_ready';

export interface ExamResponseCandidateArtifactFact {
  eventId: string;
  createdAt: string;
  byteLength: number;
  sha256: string;
  responseCount: number;
}

export interface ExamResponseMatchingArtifactFact {
  eventId: string;
  createdAt: string;
  byteLength: number;
  sha256: string;
  responseCount: number;
  matchedCount: number;
  ambiguousCount: number;
  unmatchedCount: number;
  needsReview: true;
}

export interface ExamStudentResponseCaptureState {
  status: ExamStudentResponseCaptureStatus;
  startedEventId: string;
  startedAt: string;
  captureVersion: number;
  matchingVersion: number;
  segmentationVersion: number;
  questionCandidateArtifactRef: string;
  sourceQuestionCandidateFingerprint: string;
  inputSemanticFingerprint: string;
  captureRef: string;
  responseArtifactRef: string;
  matchingArtifactRef: string;
  responseArtifact?: ExamResponseCandidateArtifactFact;
  matchingArtifact?: ExamResponseMatchingArtifactFact;
}

export type ExamHumanReviewStatus = 'confirming' | 'confirmed';

export interface ExamHumanReviewArtifactFact {
  eventId: string;
  createdAt: string;
  byteLength: number;
  sha256: string;
  confirmedQuestionCount: number;
  confirmedResponseCount: number;
  confirmedMatchCount: number;
  rejectedQuestionCount: number;
  rejectedResponseCount: number;
}

export interface ExamHumanReviewState extends ExamHumanReviewPlanFacts {
  status: ExamHumanReviewStatus;
  startedEventId: string;
  startedAt: string;
  reviewArtifact?: ExamHumanReviewArtifactFact;
}

export type ExamAnswerKeyStatus = 'confirming' | 'confirmed';

export interface ExamAnswerKeyArtifactFact {
  eventId: string;
  createdAt: string;
  byteLength: number;
  sha256: string;
  entryCount: number;
  objectiveEntryCount: number;
  unassessedEntryCount: number;
}

export interface ExamAnswerKeyState extends ExamAnswerKeyPlanFacts {
  status: ExamAnswerKeyStatus;
  startedEventId: string;
  startedAt: string;
  answerKeyArtifact?: ExamAnswerKeyArtifactFact;
}

export type ExamGradingStatus = 'grading' | 'completed';

export interface ExamAssessmentArtifactFact {
  eventId: string;
  createdAt: string;
  byteLength: number;
  sha256: string;
  assessmentCount: number;
  evaluatedCount: number;
  correctCount: number;
  incorrectCount: number;
  unassessedCount: number;
}

export interface ExamGradingState extends ExamGradingPlanFacts {
  status: ExamGradingStatus;
  startedEventId: string;
  startedAt: string;
  assessmentArtifact?: ExamAssessmentArtifactFact;
}

export type ExamKnowledgeMappingStatus = 'mapping' | 'confirmed';

export interface ExamKnowledgeMappingArtifactFact {
  eventId: string;
  createdAt: string;
  byteLength: number;
  sha256: string;
  entryCount: number;
  mappedQuestionCount: number;
  unmappedQuestionCount: number;
}

export interface ExamKnowledgeMappingState extends ExamKnowledgeMappingPlanFacts {
  status: ExamKnowledgeMappingStatus;
  startedEventId: string;
  startedAt: string;
  mappingArtifact?: ExamKnowledgeMappingArtifactFact;
}

export type ExamObservationProjectionStatus = 'projecting' | 'completed';

export interface ExamObservationArtifactFact {
  eventId: string;
  createdAt: string;
  byteLength: number;
  sha256: string;
  observationCount: number;
  evaluatedCount: number;
  correctCount: number;
  incorrectCount: number;
  unassessedCount: number;
}

export interface ExamObservationProjectionState extends ExamObservationProjectionPlanFacts {
  status: ExamObservationProjectionStatus;
  startedEventId: string;
  startedAt: string;
  observationArtifact?: ExamObservationArtifactFact;
}

export interface ExamSessionState {
  schemaVersion: typeof EXAM_SCHEMA_VERSION;
  examSessionId: string;
  profileId: string;
  subjectId: string;
  title?: string;
  status: ExamSessionStatus;
  revision: number;
  createdAt: string;
  requestFingerprint: string;
  documentSetFingerprint: string;
  documents: ExamDocumentState[];
  questionExtraction?: ExamQuestionExtractionState;
  studentResponseCapture?: ExamStudentResponseCaptureState;
  humanReview?: ExamHumanReviewState;
  answerKey?: ExamAnswerKeyState;
  grading?: ExamGradingState;
  knowledgeMapping?: ExamKnowledgeMappingState;
  observationProjection?: ExamObservationProjectionState;
  intakeCompletedEventId?: string;
  deleteRequestedEventId?: string;
  deletedEventId?: string;
}

function conflict(): never {
  throw new ExamError('EXAM_EVENT_CONFLICT');
}

function eventFromRecord(record: RuntimeRecord): ExamEvent {
  assertExamEvent(record.payload);
  return record.payload;
}

function cloneDeclaredDocument(document: ExamCreatedDocument): ExamDocumentState {
  return {
    examDocumentId: document.examDocumentId,
    role: document.role,
    ownerMaterialId: document.ownerMaterialId,
    sourceSha256: document.sourceSha256,
    mimeType: document.mimeType,
    byteLength: document.byteLength,
    ...(document.displayName === undefined ? {} : { displayName: document.displayName }),
  };
}

function documentById(state: ExamSessionState, examDocumentId: string): ExamDocumentState {
  const matches = state.documents.filter((document) => document.examDocumentId === examDocumentId);
  if (matches.length !== 1) conflict();
  return matches[0]!;
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

function responsePlanMatches(
  capture: ExamStudentResponseCaptureState,
  event: ExamResponsePlanEvent,
): boolean {
  return (
    event.captureVersion === capture.captureVersion &&
    event.matchingVersion === capture.matchingVersion &&
    event.segmentationVersion === capture.segmentationVersion &&
    event.questionCandidateArtifactRef === capture.questionCandidateArtifactRef &&
    event.sourceQuestionCandidateFingerprint === capture.sourceQuestionCandidateFingerprint &&
    event.inputSemanticFingerprint === capture.inputSemanticFingerprint &&
    event.captureRef === capture.captureRef &&
    event.responseArtifactRef === capture.responseArtifactRef &&
    event.matchingArtifactRef === capture.matchingArtifactRef
  );
}

type ExamHumanReviewPlanEvent = Extract<
  ExamEvent,
  { eventType: 'exam_human_review_started' | 'exam_human_review_completed' }
>;

function humanReviewPlanMatches(
  review: ExamHumanReviewState,
  event: ExamHumanReviewPlanEvent,
): boolean {
  return (
    event.reviewVersion === review.reviewVersion &&
    event.questionExtractionVersion === review.questionExtractionVersion &&
    event.questionSegmentationVersion === review.questionSegmentationVersion &&
    event.responseCaptureVersion === review.responseCaptureVersion &&
    event.matchingVersion === review.matchingVersion &&
    event.questionCandidateArtifactRef === review.questionCandidateArtifactRef &&
    event.sourceQuestionCandidateFingerprint === review.sourceQuestionCandidateFingerprint &&
    event.responseArtifactRef === review.responseArtifactRef &&
    event.sourceResponseArtifactFingerprint === review.sourceResponseArtifactFingerprint &&
    event.matchingArtifactRef === review.matchingArtifactRef &&
    event.sourceMatchingArtifactFingerprint === review.sourceMatchingArtifactFingerprint &&
    event.decisionSemanticFingerprint === review.decisionSemanticFingerprint &&
    event.reviewArtifactRef === review.reviewArtifactRef
  );
}

type ExamAnswerKeyPlanEvent = Extract<
  ExamEvent,
  { eventType: 'exam_answer_key_started' | 'exam_answer_key_confirmed' }
>;

function answerKeyPlanMatches(
  answerKey: ExamAnswerKeyState,
  event: ExamAnswerKeyPlanEvent,
): boolean {
  return (
    event.answerKeyVersion === answerKey.answerKeyVersion &&
    event.reviewVersion === answerKey.reviewVersion &&
    event.reviewArtifactRef === answerKey.reviewArtifactRef &&
    event.sourceReviewArtifactFingerprint === answerKey.sourceReviewArtifactFingerprint &&
    event.answerKeySemanticFingerprint === answerKey.answerKeySemanticFingerprint &&
    event.answerKeyRef === answerKey.answerKeyRef &&
    event.answerKeyArtifactRef === answerKey.answerKeyArtifactRef
  );
}

type ExamGradingPlanEvent = Extract<
  ExamEvent,
  { eventType: 'exam_grading_started' | 'exam_grading_completed' }
>;

function gradingPlanMatches(grading: ExamGradingState, event: ExamGradingPlanEvent): boolean {
  return (
    event.gradingVersion === grading.gradingVersion &&
    event.gradingAlgorithmVersion === grading.gradingAlgorithmVersion &&
    event.reviewVersion === grading.reviewVersion &&
    event.reviewArtifactRef === grading.reviewArtifactRef &&
    event.sourceReviewArtifactFingerprint === grading.sourceReviewArtifactFingerprint &&
    event.answerKeyVersion === grading.answerKeyVersion &&
    event.answerKeyRef === grading.answerKeyRef &&
    event.answerKeyArtifactRef === grading.answerKeyArtifactRef &&
    event.sourceAnswerKeyArtifactFingerprint === grading.sourceAnswerKeyArtifactFingerprint &&
    event.gradingRef === grading.gradingRef &&
    event.assessmentArtifactRef === grading.assessmentArtifactRef
  );
}

type ExamKnowledgeMappingPlanEvent = Extract<
  ExamEvent,
  { eventType: 'exam_knowledge_mapping_started' | 'exam_knowledge_mapping_confirmed' }
>;

function knowledgeMappingPlanMatches(
  mapping: ExamKnowledgeMappingState,
  event: ExamKnowledgeMappingPlanEvent,
): boolean {
  return (
    event.mappingVersion === mapping.mappingVersion &&
    event.subjectId === mapping.subjectId &&
    event.reviewVersion === mapping.reviewVersion &&
    event.reviewArtifactRef === mapping.reviewArtifactRef &&
    event.sourceReviewArtifactFingerprint === mapping.sourceReviewArtifactFingerprint &&
    event.sourceReviewSemanticFingerprint === mapping.sourceReviewSemanticFingerprint &&
    event.assessmentVersion === mapping.assessmentVersion &&
    event.assessmentArtifactRef === mapping.assessmentArtifactRef &&
    event.sourceAssessmentArtifactFingerprint === mapping.sourceAssessmentArtifactFingerprint &&
    event.sourceAssessmentSemanticFingerprint === mapping.sourceAssessmentSemanticFingerprint &&
    event.mappingSemanticFingerprint === mapping.mappingSemanticFingerprint &&
    event.mappingRef === mapping.mappingRef &&
    event.mappingArtifactRef === mapping.mappingArtifactRef
  );
}

type ExamObservationProjectionPlanEvent = Extract<
  ExamEvent,
  {
    eventType: 'exam_observation_projection_started' | 'exam_observations_projected';
  }
>;

function observationProjectionPlanMatches(
  projection: ExamObservationProjectionState,
  event: ExamObservationProjectionPlanEvent,
): boolean {
  return (
    event.observationVersion === projection.observationVersion &&
    event.reviewVersion === projection.reviewVersion &&
    event.reviewArtifactRef === projection.reviewArtifactRef &&
    event.sourceReviewArtifactFingerprint === projection.sourceReviewArtifactFingerprint &&
    event.sourceReviewSemanticFingerprint === projection.sourceReviewSemanticFingerprint &&
    event.assessmentVersion === projection.assessmentVersion &&
    event.assessmentArtifactRef === projection.assessmentArtifactRef &&
    event.sourceAssessmentArtifactFingerprint === projection.sourceAssessmentArtifactFingerprint &&
    event.sourceAssessmentSemanticFingerprint === projection.sourceAssessmentSemanticFingerprint &&
    event.mappingVersion === projection.mappingVersion &&
    event.mappingRef === projection.mappingRef &&
    event.mappingArtifactRef === projection.mappingArtifactRef &&
    event.sourceMappingArtifactFingerprint === projection.sourceMappingArtifactFingerprint &&
    event.sourceMappingSemanticFingerprint === projection.sourceMappingSemanticFingerprint &&
    event.observationSemanticFingerprint === projection.observationSemanticFingerprint &&
    event.observationRef === projection.observationRef &&
    event.observationArtifactRef === projection.observationArtifactRef
  );
}

function assertRecordEnvelope(
  record: RuntimeRecord,
  event: ExamEvent,
  expectedSeq: number,
  runtimeSessionId: string,
): void {
  if (
    !Number.isSafeInteger(record.seq) ||
    record.seq !== expectedSeq ||
    record.sessionId !== runtimeSessionId ||
    record.id !== event.eventId ||
    record.subAnchor !== event.eventId ||
    record.createdAt !== event.createdAt
  ) {
    conflict();
  }
}

export function foldExamEvents(records: readonly RuntimeRecord[]): ExamSessionState {
  if (records.length === 0) conflict();

  const firstRuntimeSessionId = records[0]!.sessionId;
  const eventIds = new Set<string>();
  const operationIds = new Set<string>();
  let state: ExamSessionState | undefined;

  records.forEach((record, index) => {
    const event = eventFromRecord(record);
    assertRecordEnvelope(record, event, index, firstRuntimeSessionId);
    if (eventIds.has(event.eventId) || operationIds.has(event.operationId)) conflict();

    if (index === 0) {
      if (event.eventType !== 'exam_created') conflict();
      state = {
        schemaVersion: EXAM_SCHEMA_VERSION,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        subjectId: event.subjectId,
        ...(event.title === undefined ? {} : { title: event.title }),
        status: 'intake_pending',
        revision: record.seq,
        createdAt: event.createdAt,
        requestFingerprint: event.requestFingerprint,
        documentSetFingerprint: event.documentSetFingerprint,
        documents: event.documents.map(cloneDeclaredDocument),
      };
    } else {
      if (!state || event.eventType === 'exam_created' || state.status === 'deleted') conflict();
      if (event.examSessionId !== state.examSessionId || event.profileId !== state.profileId) {
        conflict();
      }

      switch (event.eventType) {
        case 'exam_document_snapshotted': {
          if (state.status !== 'intake_pending') conflict();
          const document = documentById(state, event.examDocumentId);
          if (
            event.snapshotSha256 !== document.sourceSha256 ||
            event.byteLength !== document.byteLength
          ) {
            conflict();
          }
          if (document.snapshot) {
            if (
              document.snapshot.sha256 !== event.snapshotSha256 ||
              document.snapshot.byteLength !== event.byteLength
            ) {
              conflict();
            }
          } else {
            document.snapshot = {
              eventId: event.eventId,
              createdAt: event.createdAt,
              sha256: event.snapshotSha256,
              byteLength: event.byteLength,
            };
          }
          break;
        }
        case 'exam_intake_completed':
          if (
            state.status !== 'intake_pending' ||
            event.documentSetFingerprint !== state.documentSetFingerprint ||
            state.documents.some((document) => document.snapshot === undefined)
          ) {
            conflict();
          }
          state.status = 'ready_for_extraction';
          state.intakeCompletedEventId = event.eventId;
          break;
        case 'exam_question_extraction_started': {
          if (state.status !== 'ready_for_extraction' || state.questionExtraction) conflict();
          const document = documentById(state, event.examDocumentId);
          if (
            document.role !== 'question_paper' ||
            !document.snapshot ||
            event.sourceSnapshotFingerprint !== document.snapshot.sha256
          ) {
            conflict();
          }
          state.questionExtraction = {
            status: 'extracting_document',
            startedEventId: event.eventId,
            startedAt: event.createdAt,
            extractionVersion: event.extractionVersion,
            examDocumentId: event.examDocumentId,
            sourceSnapshotFingerprint: event.sourceSnapshotFingerprint,
            extractorId: event.extractorId,
            extractorVersion: event.extractorVersion,
            normalizationVersion: event.normalizationVersion,
            documentArtifactRef: event.documentArtifactRef,
          };
          break;
        }
        case 'exam_document_artifact_extracted': {
          const extraction = state.questionExtraction;
          if (
            state.status !== 'ready_for_extraction' ||
            !extraction ||
            extraction.status !== 'extracting_document' ||
            event.extractionVersion !== extraction.extractionVersion ||
            event.examDocumentId !== extraction.examDocumentId ||
            event.sourceSnapshotFingerprint !== extraction.sourceSnapshotFingerprint ||
            event.extractorId !== extraction.extractorId ||
            event.extractorVersion !== extraction.extractorVersion ||
            event.normalizationVersion !== extraction.normalizationVersion ||
            event.documentArtifactRef !== extraction.documentArtifactRef
          ) {
            conflict();
          }
          extraction.status = 'document_artifact_ready';
          extraction.documentArtifact = {
            eventId: event.eventId,
            createdAt: event.createdAt,
            byteLength: event.artifactByteLength,
            sha256: event.artifactSha256,
            pageCount: event.pageCount,
          };
          break;
        }
        case 'exam_question_segmentation_started': {
          const extraction = state.questionExtraction;
          if (
            state.status !== 'ready_for_extraction' ||
            !extraction ||
            extraction.status !== 'document_artifact_ready' ||
            !extraction.documentArtifact ||
            event.extractionVersion !== extraction.extractionVersion ||
            event.examDocumentId !== extraction.examDocumentId ||
            event.sourceArtifactFingerprint !== extraction.documentArtifact.sha256 ||
            event.documentArtifactRef !== extraction.documentArtifactRef ||
            event.candidateArtifactRef === extraction.documentArtifactRef ||
            extraction.segmentation
          ) {
            conflict();
          }
          extraction.status = 'segmenting_questions';
          extraction.segmentation = {
            startedEventId: event.eventId,
            startedAt: event.createdAt,
            segmentationVersion: event.segmentationVersion,
            sourceArtifactFingerprint: event.sourceArtifactFingerprint,
            candidateArtifactRef: event.candidateArtifactRef,
          };
          break;
        }
        case 'exam_question_candidates_extracted': {
          const extraction = state.questionExtraction;
          const segmentation = extraction?.segmentation;
          if (
            state.status !== 'ready_for_extraction' ||
            !extraction ||
            extraction.status !== 'segmenting_questions' ||
            !extraction.documentArtifact ||
            !segmentation ||
            segmentation.candidateArtifact ||
            event.extractionVersion !== extraction.extractionVersion ||
            event.segmentationVersion !== segmentation.segmentationVersion ||
            event.examDocumentId !== extraction.examDocumentId ||
            event.sourceArtifactFingerprint !== segmentation.sourceArtifactFingerprint ||
            event.documentArtifactRef !== extraction.documentArtifactRef ||
            event.candidateArtifactRef !== segmentation.candidateArtifactRef
          ) {
            conflict();
          }
          extraction.status = 'question_candidates_ready';
          segmentation.candidateArtifact = {
            eventId: event.eventId,
            createdAt: event.createdAt,
            byteLength: event.artifactByteLength,
            sha256: event.artifactSha256,
            candidateCount: event.candidateCount,
            needsReview: event.needsReview,
          };
          break;
        }
        case 'exam_student_response_capture_started': {
          const extraction = state.questionExtraction;
          const segmentation = extraction?.segmentation;
          const candidateArtifact = segmentation?.candidateArtifact;
          if (
            state.status !== 'ready_for_extraction' ||
            extraction?.status !== 'question_candidates_ready' ||
            !segmentation ||
            !candidateArtifact ||
            state.studentResponseCapture ||
            event.segmentationVersion !== segmentation.segmentationVersion ||
            event.questionCandidateArtifactRef !== segmentation.candidateArtifactRef ||
            event.sourceQuestionCandidateFingerprint !== candidateArtifact.sha256 ||
            event.captureRef === extraction.documentArtifactRef ||
            event.captureRef === segmentation.candidateArtifactRef ||
            event.responseArtifactRef === extraction.documentArtifactRef ||
            event.responseArtifactRef === segmentation.candidateArtifactRef ||
            event.matchingArtifactRef === extraction.documentArtifactRef ||
            event.matchingArtifactRef === segmentation.candidateArtifactRef
          ) {
            conflict();
          }
          state.studentResponseCapture = {
            status: 'capturing',
            startedEventId: event.eventId,
            startedAt: event.createdAt,
            captureVersion: event.captureVersion,
            matchingVersion: event.matchingVersion,
            segmentationVersion: event.segmentationVersion,
            questionCandidateArtifactRef: event.questionCandidateArtifactRef,
            sourceQuestionCandidateFingerprint: event.sourceQuestionCandidateFingerprint,
            inputSemanticFingerprint: event.inputSemanticFingerprint,
            captureRef: event.captureRef,
            responseArtifactRef: event.responseArtifactRef,
            matchingArtifactRef: event.matchingArtifactRef,
          };
          break;
        }
        case 'exam_response_candidates_recorded': {
          const capture = state.studentResponseCapture;
          if (
            state.status !== 'ready_for_extraction' ||
            !capture ||
            capture.status !== 'capturing' ||
            capture.responseArtifact ||
            !responsePlanMatches(capture, event)
          ) {
            conflict();
          }
          capture.status = 'response_candidates_ready';
          capture.responseArtifact = {
            eventId: event.eventId,
            createdAt: event.createdAt,
            byteLength: event.artifactByteLength,
            sha256: event.artifactSha256,
            responseCount: event.responseCount,
          };
          break;
        }
        case 'exam_response_matching_completed': {
          const capture = state.studentResponseCapture;
          if (
            state.status !== 'ready_for_extraction' ||
            !capture ||
            capture.status !== 'response_candidates_ready' ||
            !capture.responseArtifact ||
            capture.matchingArtifact ||
            !responsePlanMatches(capture, event) ||
            event.responseArtifactFingerprint !== capture.responseArtifact.sha256 ||
            event.responseCount !== capture.responseArtifact.responseCount ||
            event.responseCount !==
              event.matchedCount + event.ambiguousCount + event.unmatchedCount ||
            event.needsReview !== true
          ) {
            conflict();
          }
          capture.status = 'matching_ready';
          capture.matchingArtifact = {
            eventId: event.eventId,
            createdAt: event.createdAt,
            byteLength: event.artifactByteLength,
            sha256: event.artifactSha256,
            responseCount: event.responseCount,
            matchedCount: event.matchedCount,
            ambiguousCount: event.ambiguousCount,
            unmatchedCount: event.unmatchedCount,
            needsReview: true,
          };
          break;
        }
        case 'exam_human_review_started': {
          const extraction = state.questionExtraction;
          const segmentation = extraction?.segmentation;
          const candidateArtifact = segmentation?.candidateArtifact;
          const capture = state.studentResponseCapture;
          const responseArtifact = capture?.responseArtifact;
          const matchingArtifact = capture?.matchingArtifact;
          if (
            state.status !== 'ready_for_extraction' ||
            extraction?.status !== 'question_candidates_ready' ||
            !segmentation ||
            !candidateArtifact ||
            capture?.status !== 'matching_ready' ||
            !responseArtifact ||
            !matchingArtifact ||
            state.humanReview ||
            event.questionExtractionVersion !== extraction.extractionVersion ||
            event.questionSegmentationVersion !== segmentation.segmentationVersion ||
            event.responseCaptureVersion !== capture.captureVersion ||
            event.matchingVersion !== capture.matchingVersion ||
            event.questionCandidateArtifactRef !== segmentation.candidateArtifactRef ||
            event.sourceQuestionCandidateFingerprint !== candidateArtifact.sha256 ||
            event.responseArtifactRef !== capture.responseArtifactRef ||
            event.sourceResponseArtifactFingerprint !== responseArtifact.sha256 ||
            event.matchingArtifactRef !== capture.matchingArtifactRef ||
            event.sourceMatchingArtifactFingerprint !== matchingArtifact.sha256 ||
            event.reviewArtifactRef === extraction.documentArtifactRef ||
            event.reviewArtifactRef === segmentation.candidateArtifactRef ||
            event.reviewArtifactRef === capture.captureRef ||
            event.reviewArtifactRef === capture.responseArtifactRef ||
            event.reviewArtifactRef === capture.matchingArtifactRef
          ) {
            conflict();
          }
          state.humanReview = {
            status: 'confirming',
            startedEventId: event.eventId,
            startedAt: event.createdAt,
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
          break;
        }
        case 'exam_human_review_completed': {
          const extraction = state.questionExtraction;
          const candidateArtifact = extraction?.segmentation?.candidateArtifact;
          const capture = state.studentResponseCapture;
          const responseArtifact = capture?.responseArtifact;
          const matchingArtifact = capture?.matchingArtifact;
          const review = state.humanReview;
          if (
            state.status !== 'ready_for_extraction' ||
            !candidateArtifact ||
            capture?.status !== 'matching_ready' ||
            !responseArtifact ||
            !matchingArtifact ||
            !review ||
            review.status !== 'confirming' ||
            review.reviewArtifact ||
            !humanReviewPlanMatches(review, event) ||
            event.confirmedQuestionCount !== event.confirmedResponseCount ||
            event.confirmedQuestionCount !== event.confirmedMatchCount ||
            event.confirmedQuestionCount + event.rejectedQuestionCount !==
              candidateArtifact.candidateCount ||
            event.rejectedResponseCount > responseArtifact.responseCount ||
            event.confirmedResponseCount + event.rejectedResponseCount <
              responseArtifact.responseCount
          ) {
            conflict();
          }
          review.status = 'confirmed';
          review.reviewArtifact = {
            eventId: event.eventId,
            createdAt: event.createdAt,
            byteLength: event.artifactByteLength,
            sha256: event.artifactSha256,
            confirmedQuestionCount: event.confirmedQuestionCount,
            confirmedResponseCount: event.confirmedResponseCount,
            confirmedMatchCount: event.confirmedMatchCount,
            rejectedQuestionCount: event.rejectedQuestionCount,
            rejectedResponseCount: event.rejectedResponseCount,
          };
          break;
        }
        case 'exam_answer_key_started': {
          const review = state.humanReview;
          const reviewArtifact = review?.reviewArtifact;
          const existingRefs = [
            state.questionExtraction?.documentArtifactRef,
            state.questionExtraction?.segmentation?.candidateArtifactRef,
            state.studentResponseCapture?.captureRef,
            state.studentResponseCapture?.responseArtifactRef,
            state.studentResponseCapture?.matchingArtifactRef,
            review?.reviewArtifactRef,
          ].filter((value): value is string => value !== undefined);
          if (
            state.status !== 'ready_for_extraction' ||
            review?.status !== 'confirmed' ||
            !reviewArtifact ||
            state.answerKey ||
            state.grading ||
            event.reviewVersion !== review.reviewVersion ||
            event.reviewArtifactRef !== review.reviewArtifactRef ||
            event.sourceReviewArtifactFingerprint !== reviewArtifact.sha256 ||
            existingRefs.includes(event.answerKeyRef) ||
            existingRefs.includes(event.answerKeyArtifactRef)
          ) {
            conflict();
          }
          state.answerKey = {
            status: 'confirming',
            startedEventId: event.eventId,
            startedAt: event.createdAt,
            answerKeyVersion: event.answerKeyVersion,
            reviewVersion: event.reviewVersion,
            reviewArtifactRef: event.reviewArtifactRef,
            sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
            answerKeySemanticFingerprint: event.answerKeySemanticFingerprint,
            answerKeyRef: event.answerKeyRef,
            answerKeyArtifactRef: event.answerKeyArtifactRef,
          };
          break;
        }
        case 'exam_answer_key_confirmed': {
          const review = state.humanReview;
          const reviewArtifact = review?.reviewArtifact;
          const answerKey = state.answerKey;
          if (
            state.status !== 'ready_for_extraction' ||
            review?.status !== 'confirmed' ||
            !reviewArtifact ||
            !answerKey ||
            answerKey.status !== 'confirming' ||
            answerKey.answerKeyArtifact ||
            !answerKeyPlanMatches(answerKey, event) ||
            event.reviewVersion !== review.reviewVersion ||
            event.reviewArtifactRef !== review.reviewArtifactRef ||
            event.sourceReviewArtifactFingerprint !== reviewArtifact.sha256 ||
            event.entryCount !== reviewArtifact.confirmedQuestionCount ||
            event.entryCount !== event.objectiveEntryCount + event.unassessedEntryCount
          ) {
            conflict();
          }
          answerKey.status = 'confirmed';
          answerKey.answerKeyArtifact = {
            eventId: event.eventId,
            createdAt: event.createdAt,
            byteLength: event.artifactByteLength,
            sha256: event.artifactSha256,
            entryCount: event.entryCount,
            objectiveEntryCount: event.objectiveEntryCount,
            unassessedEntryCount: event.unassessedEntryCount,
          };
          break;
        }
        case 'exam_grading_started': {
          const review = state.humanReview;
          const reviewArtifact = review?.reviewArtifact;
          const answerKey = state.answerKey;
          const answerKeyArtifact = answerKey?.answerKeyArtifact;
          const existingRefs = [
            state.questionExtraction?.documentArtifactRef,
            state.questionExtraction?.segmentation?.candidateArtifactRef,
            state.studentResponseCapture?.captureRef,
            state.studentResponseCapture?.responseArtifactRef,
            state.studentResponseCapture?.matchingArtifactRef,
            review?.reviewArtifactRef,
            answerKey?.answerKeyRef,
            answerKey?.answerKeyArtifactRef,
          ].filter((value): value is string => value !== undefined);
          if (
            state.status !== 'ready_for_extraction' ||
            review?.status !== 'confirmed' ||
            !reviewArtifact ||
            answerKey?.status !== 'confirmed' ||
            !answerKeyArtifact ||
            state.grading ||
            event.reviewVersion !== review.reviewVersion ||
            event.reviewArtifactRef !== review.reviewArtifactRef ||
            event.sourceReviewArtifactFingerprint !== reviewArtifact.sha256 ||
            event.answerKeyVersion !== answerKey.answerKeyVersion ||
            event.answerKeyRef !== answerKey.answerKeyRef ||
            event.answerKeyArtifactRef !== answerKey.answerKeyArtifactRef ||
            event.sourceAnswerKeyArtifactFingerprint !== answerKeyArtifact.sha256 ||
            existingRefs.includes(event.gradingRef) ||
            existingRefs.includes(event.assessmentArtifactRef)
          ) {
            conflict();
          }
          state.grading = {
            status: 'grading',
            startedEventId: event.eventId,
            startedAt: event.createdAt,
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
          break;
        }
        case 'exam_grading_completed': {
          const reviewArtifact = state.humanReview?.reviewArtifact;
          const answerKeyArtifact = state.answerKey?.answerKeyArtifact;
          const grading = state.grading;
          if (
            state.status !== 'ready_for_extraction' ||
            !reviewArtifact ||
            !answerKeyArtifact ||
            !grading ||
            grading.status !== 'grading' ||
            grading.assessmentArtifact ||
            !gradingPlanMatches(grading, event) ||
            event.assessmentCount !== reviewArtifact.confirmedQuestionCount ||
            event.assessmentCount !== answerKeyArtifact.entryCount ||
            event.evaluatedCount !== event.correctCount + event.incorrectCount ||
            event.assessmentCount !== event.evaluatedCount + event.unassessedCount ||
            event.unassessedCount !== answerKeyArtifact.unassessedEntryCount ||
            event.evaluatedCount !== answerKeyArtifact.objectiveEntryCount
          ) {
            conflict();
          }
          grading.status = 'completed';
          grading.assessmentArtifact = {
            eventId: event.eventId,
            createdAt: event.createdAt,
            byteLength: event.artifactByteLength,
            sha256: event.artifactSha256,
            assessmentCount: event.assessmentCount,
            evaluatedCount: event.evaluatedCount,
            correctCount: event.correctCount,
            incorrectCount: event.incorrectCount,
            unassessedCount: event.unassessedCount,
          };
          break;
        }
        case 'exam_knowledge_mapping_started': {
          const review = state.humanReview;
          const reviewArtifact = review?.reviewArtifact;
          const grading = state.grading;
          const assessmentArtifact = grading?.assessmentArtifact;
          const existingRefs = [
            state.questionExtraction?.documentArtifactRef,
            state.questionExtraction?.segmentation?.candidateArtifactRef,
            state.studentResponseCapture?.captureRef,
            state.studentResponseCapture?.responseArtifactRef,
            state.studentResponseCapture?.matchingArtifactRef,
            review?.reviewArtifactRef,
            state.answerKey?.answerKeyRef,
            state.answerKey?.answerKeyArtifactRef,
            grading?.gradingRef,
            grading?.assessmentArtifactRef,
          ].filter((value): value is string => value !== undefined);
          if (
            state.status !== 'ready_for_extraction' ||
            review?.status !== 'confirmed' ||
            !reviewArtifact ||
            grading?.status !== 'completed' ||
            !assessmentArtifact ||
            state.knowledgeMapping ||
            state.observationProjection ||
            event.subjectId !== state.subjectId ||
            event.reviewVersion !== review.reviewVersion ||
            event.reviewArtifactRef !== review.reviewArtifactRef ||
            event.sourceReviewArtifactFingerprint !== reviewArtifact.sha256 ||
            event.sourceReviewSemanticFingerprint !== review.decisionSemanticFingerprint ||
            event.assessmentVersion !== grading.gradingVersion ||
            event.assessmentArtifactRef !== grading.assessmentArtifactRef ||
            event.sourceAssessmentArtifactFingerprint !== assessmentArtifact.sha256 ||
            existingRefs.includes(event.mappingRef) ||
            existingRefs.includes(event.mappingArtifactRef)
          ) {
            conflict();
          }
          state.knowledgeMapping = {
            status: 'mapping',
            startedEventId: event.eventId,
            startedAt: event.createdAt,
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
          break;
        }
        case 'exam_knowledge_mapping_confirmed': {
          const gradingArtifact = state.grading?.assessmentArtifact;
          const mapping = state.knowledgeMapping;
          if (
            state.status !== 'ready_for_extraction' ||
            !gradingArtifact ||
            !mapping ||
            mapping.status !== 'mapping' ||
            mapping.mappingArtifact ||
            state.observationProjection ||
            !knowledgeMappingPlanMatches(mapping, event) ||
            event.entryCount !== gradingArtifact.assessmentCount ||
            event.entryCount !== event.mappedQuestionCount + event.unmappedQuestionCount
          ) {
            conflict();
          }
          mapping.status = 'confirmed';
          mapping.mappingArtifact = {
            eventId: event.eventId,
            createdAt: event.createdAt,
            byteLength: event.artifactByteLength,
            sha256: event.artifactSha256,
            entryCount: event.entryCount,
            mappedQuestionCount: event.mappedQuestionCount,
            unmappedQuestionCount: event.unmappedQuestionCount,
          };
          break;
        }
        case 'exam_observation_projection_started': {
          const review = state.humanReview;
          const reviewArtifact = review?.reviewArtifact;
          const grading = state.grading;
          const assessmentArtifact = grading?.assessmentArtifact;
          const mapping = state.knowledgeMapping;
          const mappingArtifact = mapping?.mappingArtifact;
          const existingRefs = [
            state.questionExtraction?.documentArtifactRef,
            state.questionExtraction?.segmentation?.candidateArtifactRef,
            state.studentResponseCapture?.captureRef,
            state.studentResponseCapture?.responseArtifactRef,
            state.studentResponseCapture?.matchingArtifactRef,
            review?.reviewArtifactRef,
            state.answerKey?.answerKeyRef,
            state.answerKey?.answerKeyArtifactRef,
            grading?.gradingRef,
            grading?.assessmentArtifactRef,
            mapping?.mappingRef,
            mapping?.mappingArtifactRef,
          ].filter((value): value is string => value !== undefined);
          if (
            state.status !== 'ready_for_extraction' ||
            review?.status !== 'confirmed' ||
            !reviewArtifact ||
            grading?.status !== 'completed' ||
            !assessmentArtifact ||
            mapping?.status !== 'confirmed' ||
            !mappingArtifact ||
            state.observationProjection ||
            event.reviewVersion !== mapping.reviewVersion ||
            event.reviewArtifactRef !== mapping.reviewArtifactRef ||
            event.sourceReviewArtifactFingerprint !== mapping.sourceReviewArtifactFingerprint ||
            event.sourceReviewSemanticFingerprint !== mapping.sourceReviewSemanticFingerprint ||
            event.assessmentVersion !== grading.gradingVersion ||
            event.assessmentVersion !== mapping.assessmentVersion ||
            event.assessmentArtifactRef !== mapping.assessmentArtifactRef ||
            event.sourceAssessmentArtifactFingerprint !==
              mapping.sourceAssessmentArtifactFingerprint ||
            event.sourceAssessmentSemanticFingerprint !==
              mapping.sourceAssessmentSemanticFingerprint ||
            event.mappingVersion !== mapping.mappingVersion ||
            event.mappingRef !== mapping.mappingRef ||
            event.mappingArtifactRef !== mapping.mappingArtifactRef ||
            event.sourceMappingArtifactFingerprint !== mappingArtifact.sha256 ||
            event.sourceMappingSemanticFingerprint !== mapping.mappingSemanticFingerprint ||
            existingRefs.includes(event.observationRef) ||
            existingRefs.includes(event.observationArtifactRef)
          ) {
            conflict();
          }
          state.observationProjection = {
            status: 'projecting',
            startedEventId: event.eventId,
            startedAt: event.createdAt,
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
          break;
        }
        case 'exam_observations_projected': {
          const gradingArtifact = state.grading?.assessmentArtifact;
          const mappingArtifact = state.knowledgeMapping?.mappingArtifact;
          const projection = state.observationProjection;
          if (
            state.status !== 'ready_for_extraction' ||
            !gradingArtifact ||
            !mappingArtifact ||
            !projection ||
            projection.status !== 'projecting' ||
            projection.observationArtifact ||
            !observationProjectionPlanMatches(projection, event) ||
            event.observationCount !== mappingArtifact.mappedQuestionCount ||
            event.evaluatedCount !== event.correctCount + event.incorrectCount ||
            event.observationCount !== event.evaluatedCount + event.unassessedCount ||
            event.correctCount > gradingArtifact.correctCount ||
            event.incorrectCount > gradingArtifact.incorrectCount ||
            event.unassessedCount > gradingArtifact.unassessedCount
          ) {
            conflict();
          }
          projection.status = 'completed';
          projection.observationArtifact = {
            eventId: event.eventId,
            createdAt: event.createdAt,
            byteLength: event.artifactByteLength,
            sha256: event.artifactSha256,
            observationCount: event.observationCount,
            evaluatedCount: event.evaluatedCount,
            correctCount: event.correctCount,
            incorrectCount: event.incorrectCount,
            unassessedCount: event.unassessedCount,
          };
          break;
        }
        case 'exam_delete_requested':
          if (
            (state.status !== 'intake_pending' && state.status !== 'ready_for_extraction') ||
            event.documentSetFingerprint !== state.documentSetFingerprint
          ) {
            conflict();
          }
          state.status = 'deleting';
          state.deleteRequestedEventId = event.eventId;
          break;
        case 'exam_deleted':
          if (
            state.status !== 'deleting' ||
            event.documentSetFingerprint !== state.documentSetFingerprint ||
            event.deleteRequestEventId !== state.deleteRequestedEventId
          ) {
            conflict();
          }
          state.status = 'deleted';
          state.deletedEventId = event.eventId;
          break;
      }
      state.revision = record.seq;
    }

    eventIds.add(event.eventId);
    operationIds.add(event.operationId);
  });

  if (!state) conflict();
  return state;
}

function toPublicQuestionExtraction(
  extraction: ExamQuestionExtractionState | undefined,
): PublicExamQuestionExtractionSummary {
  if (!extraction) return { status: 'not_started' };
  if (extraction.status !== 'question_candidates_ready') {
    return {
      status: 'extracting_questions',
      ...(extraction.documentArtifact === undefined
        ? {}
        : { pageCount: extraction.documentArtifact.pageCount }),
    };
  }
  const candidateArtifact = extraction.segmentation?.candidateArtifact;
  if (!extraction.documentArtifact || !candidateArtifact) conflict();
  return {
    status: 'question_candidates_ready',
    pageCount: extraction.documentArtifact.pageCount,
    candidateCount: candidateArtifact.candidateCount,
    needsReview: candidateArtifact.needsReview,
  };
}

function toPublicStudentResponseMatching(
  capture: ExamStudentResponseCaptureState | undefined,
): PublicExamStudentResponseMatchingSummary {
  if (!capture) return { status: 'not_started', needsReview: true };
  if (capture.status !== 'matching_ready') {
    return {
      status: 'capturing',
      ...(capture.responseArtifact === undefined
        ? {}
        : { responseCount: capture.responseArtifact.responseCount }),
      needsReview: true,
    };
  }
  const artifact = capture.matchingArtifact;
  if (!capture.responseArtifact || !artifact) conflict();
  return {
    status: 'matching_ready',
    responseCount: artifact.responseCount,
    matchedCount: artifact.matchedCount,
    ambiguousCount: artifact.ambiguousCount,
    unmatchedCount: artifact.unmatchedCount,
    needsReview: true,
  };
}

function toPublicHumanReview(
  review: ExamHumanReviewState | undefined,
): PublicExamHumanReviewSummary {
  if (!review) return { status: 'not_started' };
  if (review.status === 'confirming') return { status: 'confirming' };
  const artifact = review.reviewArtifact;
  if (!artifact) conflict();
  return {
    status: 'confirmed',
    confirmedQuestionCount: artifact.confirmedQuestionCount,
    confirmedResponseCount: artifact.confirmedResponseCount,
    confirmedMatchCount: artifact.confirmedMatchCount,
    rejectedQuestionCount: artifact.rejectedQuestionCount,
    rejectedResponseCount: artifact.rejectedResponseCount,
  };
}

function toPublicGrading(
  answerKey: ExamAnswerKeyState | undefined,
  grading: ExamGradingState | undefined,
): PublicExamGradingSummary {
  if (!answerKey && !grading) return { status: 'not_started' };
  if (grading?.status !== 'completed') return { status: 'processing' };
  const artifact = grading.assessmentArtifact;
  if (!artifact || answerKey?.status !== 'confirmed' || !answerKey.answerKeyArtifact) conflict();
  return {
    status: 'completed',
    assessmentCount: artifact.assessmentCount,
    evaluatedCount: artifact.evaluatedCount,
    correctCount: artifact.correctCount,
    incorrectCount: artifact.incorrectCount,
    unassessedCount: artifact.unassessedCount,
  };
}

function toPublicKnowledgeMapping(
  mapping: ExamKnowledgeMappingState | undefined,
): PublicExamKnowledgeMappingSummary {
  if (!mapping) return { status: 'not_started' };
  if (mapping.status !== 'confirmed') return { status: 'processing' };
  const artifact = mapping.mappingArtifact;
  if (!artifact) conflict();
  return {
    status: 'confirmed',
    mappedQuestionCount: artifact.mappedQuestionCount,
    unmappedQuestionCount: artifact.unmappedQuestionCount,
  };
}

function toPublicObservationProjection(
  projection: ExamObservationProjectionState | undefined,
): PublicExamObservationProjectionSummary {
  if (!projection) return { status: 'not_started' };
  if (projection.status !== 'completed') return { status: 'processing' };
  const artifact = projection.observationArtifact;
  if (!artifact) conflict();
  return {
    status: 'completed',
    observationCount: artifact.observationCount,
  };
}

export function toPublicExamSession(state: ExamSessionState): PublicExamSession {
  if (state.status === 'deleted') throw new ExamError('EXAM_NOT_FOUND');
  return {
    schemaVersion: EXAM_SCHEMA_VERSION,
    examSessionId: state.examSessionId,
    profileId: state.profileId,
    subjectId: state.subjectId,
    ...(state.title === undefined ? {} : { title: state.title }),
    status: state.status satisfies PublicExamStatus,
    createdAt: state.createdAt,
    documents: state.documents.map((document) => ({
      examDocumentId: document.examDocumentId,
      role: document.role,
      ...(document.displayName === undefined ? {} : { displayName: document.displayName }),
      mimeType: document.mimeType,
      byteLength: document.byteLength,
      snapshotStatus: document.snapshot === undefined ? 'pending' : 'snapshotted',
    })),
    questionExtraction: toPublicQuestionExtraction(state.questionExtraction),
    studentResponseMatching: toPublicStudentResponseMatching(state.studentResponseCapture),
    humanReview: toPublicHumanReview(state.humanReview),
    grading: toPublicGrading(state.answerKey, state.grading),
    knowledgeMapping: toPublicKnowledgeMapping(state.knowledgeMapping),
    observationProjection: toPublicObservationProjection(state.observationProjection),
  };
}
