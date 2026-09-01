import type { RuntimeRecord } from '@openmaic/dsl';

import {
  EXAM_SCHEMA_VERSION,
  type PublicExamHumanReviewSummary,
  type PublicExamQuestionExtractionSummary,
  type PublicExamSession,
  type PublicExamStatus,
  type PublicExamStudentResponseMatchingSummary,
} from './exam';
import { ExamError } from './exam-errors';
import {
  assertExamEvent,
  type ExamCreatedDocument,
  type ExamEvent,
  type ExamHumanReviewPlanFacts,
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
  };
}
