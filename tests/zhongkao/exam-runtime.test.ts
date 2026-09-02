import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import {
  BrowserRuntimeStore,
  RuntimeAppendConflictError,
  type RuntimeStore,
  type StrictRuntimeSessionStore,
} from '@openmaic/storage';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION } from '@/lib/zhongkao/exam';
import {
  appendExamRuntimeEvent,
  createExamDocumentSetFingerprint,
  createExamOperationFingerprint,
  createExamRequestFingerprint,
  deriveExamAnswerKeyArtifactRef,
  deriveExamAnswerKeyConfirmedOperationId,
  deriveExamAnswerKeyRef,
  deriveExamAnswerKeyStartedOperationId,
  deriveExamAssessmentArtifactRef,
  deriveExamCandidateArtifactRef,
  deriveExamCreatedOperationId,
  deriveExamDocumentArtifactExtractedOperationId,
  deriveExamDocumentArtifactRef,
  deriveExamDocumentId,
  deriveExamDeletedOperationId,
  deriveExamDeleteRequestedOperationId,
  deriveExamEventId,
  deriveExamHumanReviewArtifactRef,
  deriveExamHumanReviewCompletedOperationId,
  deriveExamHumanReviewRef,
  deriveExamHumanReviewStartedOperationId,
  deriveExamIntakeCompletedOperationId,
  deriveExamGradingCompletedOperationId,
  deriveExamGradingRef,
  deriveExamGradingStartedOperationId,
  deriveExamKnowledgeMappingArtifactRef,
  deriveExamKnowledgeMappingConfirmedOperationId,
  deriveExamKnowledgeMappingRef,
  deriveExamKnowledgeMappingStartedOperationId,
  deriveExamObservationArtifactRef,
  deriveExamObservationProjectionRef,
  deriveExamObservationProjectionStartedOperationId,
  deriveExamObservationsProjectedOperationId,
  type ExamGradingRefInput,
  deriveExamQuestionCandidatesExtractedOperationId,
  deriveExamQuestionExtractionStartedOperationId,
  deriveExamQuestionSegmentationStartedOperationId,
  deriveExamMatchingArtifactRef,
  deriveExamResponseArtifactRef,
  deriveExamResponseCandidatesRecordedOperationId,
  deriveExamResponseCaptureRef,
  deriveExamResponseMatchingCompletedOperationId,
  deriveExamSessionId,
  deriveExamSnapshotOperationId,
  deriveExamStudentResponseCaptureStartedOperationId,
  examRuntimeSessionId,
  ensureExamRuntimeCreated,
  listProfileExamRuntimeSnapshots,
  loadExamRuntime,
} from '@/lib/server/zhongkao/exam-runtime';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import type {
  ExamAnswerKeyConfirmedEvent,
  ExamAnswerKeyStartedEvent,
  ExamCreatedDocument,
  ExamCreatedEvent,
  ExamDeletedEvent,
  ExamDeleteRequestedEvent,
  ExamDocumentArtifactExtractedEvent,
  ExamDocumentSnapshottedEvent,
  ExamHumanReviewCompletedEvent,
  ExamHumanReviewStartedEvent,
  ExamGradingCompletedEvent,
  ExamGradingStartedEvent,
  ExamIntakeCompletedEvent,
  ExamKnowledgeMappingConfirmedEvent,
  ExamKnowledgeMappingStartedEvent,
  ExamObservationProjectionStartedEvent,
  ExamObservationsProjectedEvent,
  ExamQuestionCandidatesExtractedEvent,
  ExamQuestionExtractionStartedEvent,
  ExamQuestionSegmentationStartedEvent,
  ExamResponseCandidatesRecordedEvent,
  ExamResponseMatchingCompletedEvent,
  ExamStudentResponseCaptureStartedEvent,
} from '@/lib/zhongkao/exam-event';
import { zhongkaoStageId } from '@/lib/zhongkao/runtime';

const NOW = '2026-08-31T08:00:00.000Z';
const OWNER_ID = 'fictional-owner-alpha';
const PROFILE_ID = 'student-alpha';
const CLIENT_REQUEST_ID = 'exam-request-alpha';

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

interface BrowserStoreHarness {
  store: BrowserRuntimeStore;
  indexedDB: IDBFactory;
  dbName: string;
}

function browserStoreHarness(): BrowserStoreHarness {
  const indexedDB = new IDBFactory();
  const dbName = `exam-runtime-${Math.random()}`;
  return {
    store: new BrowserRuntimeStore({
      indexedDB,
      dbName,
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    }),
    indexedDB,
    dbName,
  };
}

function store(): RuntimeStore {
  return browserStoreHarness().store;
}

async function rewriteSessionRow(
  indexedDB: IDBFactory,
  dbName: string,
  sessionId: string,
  rewrite: (row: Record<string, unknown>) => void,
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('sessions', 'readwrite');
    const sessions = transaction.objectStore('sessions');
    const request = sessions.get(sessionId);
    request.onsuccess = () => {
      const row = request.result as Record<string, unknown>;
      rewrite(row);
      sessions.put(row);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

function withAppend(
  backing: RuntimeStore,
  appendRecord: RuntimeStore['appendRecord'],
): RuntimeStore {
  return new Proxy(backing, {
    get(target, property, receiver) {
      if (property === 'appendRecord') return appendRecord;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function createdEvent(
  ownerId = OWNER_ID,
  overrides: Partial<ExamCreatedEvent> = {},
): ExamCreatedEvent {
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(ownerId);
  const examSessionId = deriveExamSessionId({
    learnerKey,
    profileId: PROFILE_ID,
    clientRequestId: CLIENT_REQUEST_ID,
  });
  const document: ExamCreatedDocument = {
    examDocumentId: deriveExamDocumentId(examSessionId, 'question_paper'),
    role: 'question_paper',
    ownerMaterialId: `mat_${'0'.repeat(26)}`,
    sourceSha256: 'a'.repeat(64),
    mimeType: 'application/pdf',
    byteLength: 12,
  };
  const requestFingerprint = createExamRequestFingerprint({
    schemaVersion: 1,
    profileId: PROFILE_ID,
    subjectId: 'math',
    documents: [{ role: document.role, ownerMaterialId: document.ownerMaterialId }],
  });
  const documentSetFingerprint = createExamDocumentSetFingerprint([document]);
  const operationId = deriveExamCreatedOperationId(examSessionId);
  const operationFingerprint = createExamOperationFingerprint({
    action: 'exam_created',
    schemaVersion: 1,
    examSessionId,
    profileId: PROFILE_ID,
    subjectId: 'math',
    requestFingerprint,
    documentSetFingerprint,
    documents: [document],
  });
  return {
    schemaVersion: 1,
    eventId: deriveExamEventId(operationId),
    examSessionId,
    profileId: PROFILE_ID,
    eventType: 'exam_created',
    createdAt: NOW,
    operationId,
    operationFingerprint,
    subjectId: 'math',
    requestFingerprint,
    documentSetFingerprint,
    documents: [document],
    ...overrides,
  };
}

function snapshotEvent(created: ExamCreatedEvent): ExamDocumentSnapshottedEvent {
  const document = created.documents[0]!;
  const operationId = deriveExamSnapshotOperationId(created.examSessionId, document.examDocumentId);
  return {
    schemaVersion: 1,
    eventId: deriveExamEventId(operationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_document_snapshotted',
    createdAt: '2026-08-31T08:00:01.000Z',
    operationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_document_snapshotted',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      examDocumentId: document.examDocumentId,
      snapshotSha256: document.sourceSha256,
      byteLength: document.byteLength,
    }),
    examDocumentId: document.examDocumentId,
    snapshotSha256: document.sourceSha256,
    byteLength: document.byteLength,
  };
}

function completedEvent(created: ExamCreatedEvent): ExamIntakeCompletedEvent {
  const operationId = deriveExamIntakeCompletedOperationId(
    created.examSessionId,
    created.documentSetFingerprint,
  );
  return {
    schemaVersion: 1,
    eventId: deriveExamEventId(operationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_intake_completed',
    createdAt: '2026-08-31T08:00:02.000Z',
    operationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_intake_completed',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      documentSetFingerprint: created.documentSetFingerprint,
    }),
    documentSetFingerprint: created.documentSetFingerprint,
  };
}

function extractionEvents(
  created: ExamCreatedEvent,
): [
  ExamQuestionExtractionStartedEvent,
  ExamDocumentArtifactExtractedEvent,
  ExamQuestionSegmentationStartedEvent,
  ExamQuestionCandidatesExtractedEvent,
] {
  const examDocumentId = created.documents[0]!.examDocumentId;
  const extractionVersion = 1;
  const segmentationVersion = 1;
  const documentArtifactRef = deriveExamDocumentArtifactRef(
    created.examSessionId,
    examDocumentId,
    extractionVersion,
  );
  const candidateArtifactRef = deriveExamCandidateArtifactRef(
    created.examSessionId,
    examDocumentId,
    extractionVersion,
    segmentationVersion,
  );
  const extractionFacts = {
    extractionVersion,
    examDocumentId,
    sourceSnapshotFingerprint: created.documents[0]!.sourceSha256,
    extractorId: 'unpdf',
    extractorVersion: 'exam-pdf-text:v1',
    normalizationVersion: 'exam-document-normalization:v1',
    documentArtifactRef,
  };
  const startedOperationId = deriveExamQuestionExtractionStartedOperationId(
    created.examSessionId,
    examDocumentId,
    extractionVersion,
  );
  const started: ExamQuestionExtractionStartedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(startedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_question_extraction_started',
    createdAt: '2026-08-31T08:00:03.000Z',
    operationId: startedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_question_extraction_started',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...extractionFacts,
    }),
    ...extractionFacts,
  };
  const documentFacts = {
    ...extractionFacts,
    artifactByteLength: 512,
    artifactSha256: 'b'.repeat(64),
    pageCount: 2,
  };
  const documentOperationId = deriveExamDocumentArtifactExtractedOperationId(
    created.examSessionId,
    examDocumentId,
    extractionVersion,
  );
  const document: ExamDocumentArtifactExtractedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(documentOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_document_artifact_extracted',
    createdAt: '2026-08-31T08:00:04.000Z',
    operationId: documentOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_document_artifact_extracted',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...documentFacts,
    }),
    ...documentFacts,
  };
  const segmentationFacts = {
    extractionVersion,
    segmentationVersion,
    examDocumentId,
    sourceArtifactFingerprint: document.artifactSha256,
    documentArtifactRef,
    candidateArtifactRef,
  };
  const segmentationOperationId = deriveExamQuestionSegmentationStartedOperationId(
    created.examSessionId,
    examDocumentId,
    extractionVersion,
    segmentationVersion,
  );
  const segmentation: ExamQuestionSegmentationStartedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(segmentationOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_question_segmentation_started',
    createdAt: '2026-08-31T08:00:05.000Z',
    operationId: segmentationOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_question_segmentation_started',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...segmentationFacts,
    }),
    ...segmentationFacts,
  };
  const candidateFacts = {
    ...segmentationFacts,
    artifactByteLength: 384,
    artifactSha256: 'c'.repeat(64),
    candidateCount: 5,
    needsReview: true,
  };
  const candidateOperationId = deriveExamQuestionCandidatesExtractedOperationId(
    created.examSessionId,
    examDocumentId,
    extractionVersion,
    segmentationVersion,
  );
  const candidates: ExamQuestionCandidatesExtractedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(candidateOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_question_candidates_extracted',
    createdAt: '2026-08-31T08:00:06.000Z',
    operationId: candidateOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_question_candidates_extracted',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...candidateFacts,
    }),
    ...candidateFacts,
  };
  return [started, document, segmentation, candidates];
}

function responseEvents(
  created: ExamCreatedEvent,
): [
  ExamStudentResponseCaptureStartedEvent,
  ExamResponseCandidatesRecordedEvent,
  ExamResponseMatchingCompletedEvent,
] {
  const candidates = extractionEvents(created)[3];
  const captureVersion = 1;
  const matchingVersion = 1;
  const segmentationVersion = candidates.segmentationVersion;
  const sourceQuestionCandidateFingerprint = candidates.artifactSha256;
  const captureRef = deriveExamResponseCaptureRef(
    created.examSessionId,
    captureVersion,
    segmentationVersion,
    sourceQuestionCandidateFingerprint,
  );
  const plan = {
    captureVersion,
    matchingVersion,
    segmentationVersion,
    questionCandidateArtifactRef: candidates.candidateArtifactRef,
    sourceQuestionCandidateFingerprint,
    inputSemanticFingerprint: 'd'.repeat(64),
    captureRef,
    responseArtifactRef: deriveExamResponseArtifactRef(captureRef),
    matchingArtifactRef: deriveExamMatchingArtifactRef(captureRef, matchingVersion),
  } as const;
  const startedOperationId = deriveExamStudentResponseCaptureStartedOperationId(
    created.examSessionId,
    captureVersion,
    segmentationVersion,
    sourceQuestionCandidateFingerprint,
  );
  const started: ExamStudentResponseCaptureStartedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(startedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_student_response_capture_started',
    createdAt: '2026-08-31T08:00:07.000Z',
    operationId: startedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_student_response_capture_started',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...plan,
    }),
    ...plan,
  };
  const responseFacts = {
    ...plan,
    artifactByteLength: 256,
    artifactSha256: 'e'.repeat(64),
    responseCount: 5,
  } as const;
  const recordedOperationId = deriveExamResponseCandidatesRecordedOperationId(
    created.examSessionId,
    captureVersion,
    segmentationVersion,
    sourceQuestionCandidateFingerprint,
  );
  const recorded: ExamResponseCandidatesRecordedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(recordedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_response_candidates_recorded',
    createdAt: '2026-08-31T08:00:08.000Z',
    operationId: recordedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_response_candidates_recorded',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...responseFacts,
    }),
    ...responseFacts,
  };
  const matchFacts = {
    ...plan,
    responseArtifactFingerprint: recorded.artifactSha256,
    artifactByteLength: 192,
    artifactSha256: 'f'.repeat(64),
    responseCount: recorded.responseCount,
    matchedCount: 3,
    ambiguousCount: 1,
    unmatchedCount: 1,
    needsReview: true as const,
  };
  const completedOperationId = deriveExamResponseMatchingCompletedOperationId(
    created.examSessionId,
    captureVersion,
    matchingVersion,
    segmentationVersion,
    sourceQuestionCandidateFingerprint,
  );
  const completed: ExamResponseMatchingCompletedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(completedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_response_matching_completed',
    createdAt: '2026-08-31T08:00:09.000Z',
    operationId: completedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_response_matching_completed',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...matchFacts,
    }),
    ...matchFacts,
  };
  return [started, recorded, completed];
}

function humanReviewEvents(
  created: ExamCreatedEvent,
): [ExamHumanReviewStartedEvent, ExamHumanReviewCompletedEvent] {
  const candidates = extractionEvents(created)[3];
  const [capture, response, matching] = responseEvents(created);
  const reviewVersion = 1;
  const upstreamPlan = {
    reviewVersion,
    questionExtractionVersion: candidates.extractionVersion,
    questionSegmentationVersion: candidates.segmentationVersion,
    responseCaptureVersion: capture.captureVersion,
    matchingVersion: matching.matchingVersion,
    questionCandidateArtifactRef: candidates.candidateArtifactRef,
    sourceQuestionCandidateFingerprint: candidates.artifactSha256,
    responseArtifactRef: response.responseArtifactRef,
    sourceResponseArtifactFingerprint: response.artifactSha256,
    matchingArtifactRef: matching.matchingArtifactRef,
    sourceMatchingArtifactFingerprint: matching.artifactSha256,
  } as const;
  const reviewRefInput = { examSessionId: created.examSessionId, ...upstreamPlan };
  const plan = {
    ...upstreamPlan,
    decisionSemanticFingerprint: '1'.repeat(64),
    reviewArtifactRef: deriveExamHumanReviewArtifactRef(deriveExamHumanReviewRef(reviewRefInput)),
  };
  const startedOperationId = deriveExamHumanReviewStartedOperationId(
    created.examSessionId,
    reviewVersion,
  );
  const started: ExamHumanReviewStartedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(startedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_human_review_started',
    createdAt: '2026-08-31T08:00:10.000Z',
    operationId: startedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_human_review_started',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...plan,
    }),
    ...plan,
  };
  const completedFacts = {
    ...plan,
    artifactByteLength: 224,
    artifactSha256: '2'.repeat(64),
    confirmedQuestionCount: 3,
    confirmedResponseCount: 3,
    confirmedMatchCount: 3,
    rejectedQuestionCount: 2,
    rejectedResponseCount: 2,
  };
  const completedOperationId = deriveExamHumanReviewCompletedOperationId(
    created.examSessionId,
    reviewVersion,
  );
  const completed: ExamHumanReviewCompletedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(completedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_human_review_completed',
    createdAt: '2026-08-31T08:00:11.000Z',
    operationId: completedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_human_review_completed',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...completedFacts,
    }),
    ...completedFacts,
  };
  return [started, completed];
}

function answerKeyEvents(
  created: ExamCreatedEvent,
  review: ExamHumanReviewCompletedEvent,
): [ExamAnswerKeyStartedEvent, ExamAnswerKeyConfirmedEvent] {
  const answerKeyVersion = 1;
  const sourceFacts = {
    answerKeyVersion,
    reviewVersion: review.reviewVersion,
    reviewArtifactRef: review.reviewArtifactRef,
    sourceReviewArtifactFingerprint: review.artifactSha256,
  } as const;
  const answerKeyRef = deriveExamAnswerKeyRef({
    examSessionId: created.examSessionId,
    ...sourceFacts,
  });
  const plan = {
    ...sourceFacts,
    answerKeySemanticFingerprint: '3'.repeat(64),
    answerKeyRef,
    answerKeyArtifactRef: deriveExamAnswerKeyArtifactRef(answerKeyRef),
  };
  const startedOperationId = deriveExamAnswerKeyStartedOperationId(
    created.examSessionId,
    answerKeyVersion,
  );
  const started: ExamAnswerKeyStartedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(startedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_answer_key_started',
    createdAt: '2026-08-31T08:00:12.000Z',
    operationId: startedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_answer_key_started',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...plan,
    }),
    ...plan,
  };
  const completedFacts = {
    ...plan,
    artifactByteLength: 256,
    artifactSha256: '4'.repeat(64),
    entryCount: 3,
    objectiveEntryCount: 2,
    unassessedEntryCount: 1,
  } as const;
  const completedOperationId = deriveExamAnswerKeyConfirmedOperationId(
    created.examSessionId,
    answerKeyVersion,
  );
  const completed: ExamAnswerKeyConfirmedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(completedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_answer_key_confirmed',
    createdAt: '2026-08-31T08:00:13.000Z',
    operationId: completedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_answer_key_confirmed',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...completedFacts,
    }),
    ...completedFacts,
  };
  return [started, completed];
}

function gradingEvents(
  created: ExamCreatedEvent,
  review: ExamHumanReviewCompletedEvent,
  answerKey: ExamAnswerKeyConfirmedEvent,
): [ExamGradingStartedEvent, ExamGradingCompletedEvent] {
  const gradingVersion = 1;
  const sourceFacts = {
    gradingVersion,
    gradingAlgorithmVersion: 'exam-objective-grading:v1',
    reviewVersion: review.reviewVersion,
    reviewArtifactRef: review.reviewArtifactRef,
    sourceReviewArtifactFingerprint: review.artifactSha256,
    answerKeyVersion: answerKey.answerKeyVersion,
    answerKeyRef: answerKey.answerKeyRef,
    answerKeyArtifactRef: answerKey.answerKeyArtifactRef,
    sourceAnswerKeyArtifactFingerprint: answerKey.artifactSha256,
  } as const;
  const gradingRef = deriveExamGradingRef({
    examSessionId: created.examSessionId,
    ...sourceFacts,
  });
  const plan = {
    ...sourceFacts,
    gradingRef,
    assessmentArtifactRef: deriveExamAssessmentArtifactRef(gradingRef),
  };
  const startedOperationId = deriveExamGradingStartedOperationId(
    created.examSessionId,
    gradingVersion,
  );
  const started: ExamGradingStartedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(startedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_grading_started',
    createdAt: '2026-08-31T08:00:14.000Z',
    operationId: startedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_grading_started',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...plan,
    }),
    ...plan,
  };
  const completedFacts = {
    ...plan,
    artifactByteLength: 192,
    artifactSha256: '5'.repeat(64),
    assessmentCount: 3,
    evaluatedCount: 2,
    correctCount: 1,
    incorrectCount: 1,
    unassessedCount: 1,
  } as const;
  const completedOperationId = deriveExamGradingCompletedOperationId(
    created.examSessionId,
    gradingVersion,
  );
  const completed: ExamGradingCompletedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(completedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_grading_completed',
    createdAt: '2026-08-31T08:00:15.000Z',
    operationId: completedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_grading_completed',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...completedFacts,
    }),
    ...completedFacts,
  };
  return [started, completed];
}

function knowledgeMappingEvents(
  created: ExamCreatedEvent,
  review: ExamHumanReviewCompletedEvent,
  grading: ExamGradingCompletedEvent,
): [ExamKnowledgeMappingStartedEvent, ExamKnowledgeMappingConfirmedEvent] {
  const sourceFacts = {
    mappingVersion: 1,
    subjectId: created.subjectId,
    reviewVersion: review.reviewVersion,
    reviewArtifactRef: review.reviewArtifactRef,
    sourceReviewArtifactFingerprint: review.artifactSha256,
    sourceReviewSemanticFingerprint: review.decisionSemanticFingerprint,
    assessmentVersion: 1,
    assessmentArtifactRef: grading.assessmentArtifactRef,
    sourceAssessmentArtifactFingerprint: grading.artifactSha256,
    sourceAssessmentSemanticFingerprint: '6'.repeat(64),
    mappingSemanticFingerprint: '7'.repeat(64),
  } as const;
  const mappingRef = deriveExamKnowledgeMappingRef({
    mappingVersion: sourceFacts.mappingVersion,
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    subjectId: sourceFacts.subjectId,
    sourceReviewSemanticFingerprint: sourceFacts.sourceReviewSemanticFingerprint,
    sourceAssessmentSemanticFingerprint: sourceFacts.sourceAssessmentSemanticFingerprint,
  });
  const plan = {
    ...sourceFacts,
    mappingRef,
    mappingArtifactRef: deriveExamKnowledgeMappingArtifactRef(mappingRef),
  };
  const startedOperationId = deriveExamKnowledgeMappingStartedOperationId(
    created.examSessionId,
    plan.mappingVersion,
  );
  const started: ExamKnowledgeMappingStartedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(startedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_knowledge_mapping_started',
    createdAt: '2026-08-31T08:00:16.000Z',
    operationId: startedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_knowledge_mapping_started',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...plan,
    }),
    ...plan,
  };
  const completedFacts = {
    ...plan,
    artifactByteLength: 160,
    artifactSha256: '8'.repeat(64),
    entryCount: 3,
    mappedQuestionCount: 2,
    unmappedQuestionCount: 1,
  } as const;
  const completedOperationId = deriveExamKnowledgeMappingConfirmedOperationId(
    created.examSessionId,
    plan.mappingVersion,
  );
  const completed: ExamKnowledgeMappingConfirmedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(completedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_knowledge_mapping_confirmed',
    createdAt: '2026-08-31T08:00:17.000Z',
    operationId: completedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_knowledge_mapping_confirmed',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...completedFacts,
    }),
    ...completedFacts,
  };
  return [started, completed];
}

function observationProjectionEvents(
  created: ExamCreatedEvent,
  mapping: ExamKnowledgeMappingConfirmedEvent,
): [ExamObservationProjectionStartedEvent, ExamObservationsProjectedEvent] {
  const sourceFacts = {
    observationVersion: 1,
    reviewVersion: mapping.reviewVersion,
    reviewArtifactRef: mapping.reviewArtifactRef,
    sourceReviewArtifactFingerprint: mapping.sourceReviewArtifactFingerprint,
    sourceReviewSemanticFingerprint: mapping.sourceReviewSemanticFingerprint,
    assessmentVersion: mapping.assessmentVersion,
    assessmentArtifactRef: mapping.assessmentArtifactRef,
    sourceAssessmentArtifactFingerprint: mapping.sourceAssessmentArtifactFingerprint,
    sourceAssessmentSemanticFingerprint: mapping.sourceAssessmentSemanticFingerprint,
    mappingVersion: mapping.mappingVersion,
    mappingRef: mapping.mappingRef,
    mappingArtifactRef: mapping.mappingArtifactRef,
    sourceMappingArtifactFingerprint: mapping.artifactSha256,
    sourceMappingSemanticFingerprint: mapping.mappingSemanticFingerprint,
    observationSemanticFingerprint: '9'.repeat(64),
  } as const;
  const observationRef = deriveExamObservationProjectionRef({
    observationVersion: sourceFacts.observationVersion,
    examSessionId: created.examSessionId,
    sourceAssessmentSemanticFingerprint: sourceFacts.sourceAssessmentSemanticFingerprint,
    sourceMappingSemanticFingerprint: sourceFacts.sourceMappingSemanticFingerprint,
  });
  const plan = {
    ...sourceFacts,
    observationRef,
    observationArtifactRef: deriveExamObservationArtifactRef(observationRef),
  };
  const startedOperationId = deriveExamObservationProjectionStartedOperationId(
    created.examSessionId,
    plan.mappingVersion,
    plan.observationVersion,
  );
  const started: ExamObservationProjectionStartedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(startedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_observation_projection_started',
    createdAt: '2026-08-31T08:00:18.000Z',
    operationId: startedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_observation_projection_started',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...plan,
    }),
    ...plan,
  };
  const completedFacts = {
    ...plan,
    artifactByteLength: 192,
    artifactSha256: 'a'.repeat(64),
    observationCount: 2,
    evaluatedCount: 1,
    correctCount: 0,
    incorrectCount: 1,
    unassessedCount: 1,
  } as const;
  const completedOperationId = deriveExamObservationsProjectedOperationId(
    created.examSessionId,
    plan.mappingVersion,
    plan.observationVersion,
  );
  const completed: ExamObservationsProjectedEvent = {
    schemaVersion: 1,
    eventId: deriveExamEventId(completedOperationId),
    examSessionId: created.examSessionId,
    profileId: created.profileId,
    eventType: 'exam_observations_projected',
    createdAt: '2026-08-31T08:00:19.000Z',
    operationId: completedOperationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_observations_projected',
      schemaVersion: 1,
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      ...completedFacts,
    }),
    ...completedFacts,
  };
  return [started, completed];
}

describe('Exam RuntimeStore adapter', () => {
  it('derives stable partitioned Exam and document identities', () => {
    const learner = resolveZhongkaoLearnerKeyFromOwnerId(OWNER_ID);
    const first = deriveExamSessionId({
      learnerKey: learner,
      profileId: PROFILE_ID,
      clientRequestId: CLIENT_REQUEST_ID,
    });
    const replay = deriveExamSessionId({
      learnerKey: learner,
      profileId: PROFILE_ID,
      clientRequestId: CLIENT_REQUEST_ID,
    });
    const anotherOwner = deriveExamSessionId({
      learnerKey: resolveZhongkaoLearnerKeyFromOwnerId('fictional-owner-beta'),
      profileId: PROFILE_ID,
      clientRequestId: CLIENT_REQUEST_ID,
    });
    expect(replay).toBe(first);
    expect(anotherOwner).not.toBe(first);
    expect(deriveExamDocumentId(first, 'question_paper')).toBe(
      deriveExamDocumentId(first, 'question_paper'),
    );
    expect(deriveExamDocumentId(first, 'answer_key')).not.toBe(
      deriveExamDocumentId(first, 'question_paper'),
    );
    const documentId = deriveExamDocumentId(first, 'question_paper');
    expect(deriveExamDocumentArtifactRef(first, documentId, 1)).toBe(
      deriveExamDocumentArtifactRef(first, documentId, 1),
    );
    expect(deriveExamDocumentArtifactRef(first, documentId, 2)).not.toBe(
      deriveExamDocumentArtifactRef(first, documentId, 1),
    );
    expect(deriveExamCandidateArtifactRef(first, documentId, 1, 1)).not.toBe(
      deriveExamCandidateArtifactRef(first, documentId, 1, 2),
    );
    const reviewInput = {
      examSessionId: first,
      reviewVersion: 1,
      questionExtractionVersion: 1,
      questionSegmentationVersion: 1,
      responseCaptureVersion: 1,
      matchingVersion: 1,
      questionCandidateArtifactRef: 'question-candidates-ref',
      sourceQuestionCandidateFingerprint: 'a'.repeat(64),
      responseArtifactRef: 'response-candidates-ref',
      sourceResponseArtifactFingerprint: 'b'.repeat(64),
      matchingArtifactRef: 'response-matches-ref',
      sourceMatchingArtifactFingerprint: 'c'.repeat(64),
    };
    const reviewRef = deriveExamHumanReviewRef(reviewInput);
    expect(reviewRef).toBe(deriveExamHumanReviewRef(reviewInput));
    expect(reviewRef).not.toBe(deriveExamHumanReviewRef({ ...reviewInput, reviewVersion: 2 }));
    expect(deriveExamHumanReviewArtifactRef(reviewRef)).not.toBe(reviewRef);
    expect(deriveExamHumanReviewStartedOperationId(first, 1)).toBe(
      deriveExamHumanReviewStartedOperationId(first, 1),
    );
    expect(deriveExamHumanReviewStartedOperationId(first, 1)).not.toBe(
      deriveExamHumanReviewCompletedOperationId(first, 1),
    );

    const answerKeyInput = {
      examSessionId: first,
      answerKeyVersion: 1,
      reviewVersion: 1,
      reviewArtifactRef: deriveExamHumanReviewArtifactRef(reviewRef),
      sourceReviewArtifactFingerprint: 'd'.repeat(64),
    };
    const answerKeyRef = deriveExamAnswerKeyRef(answerKeyInput);
    expect(answerKeyRef).toBe(deriveExamAnswerKeyRef(answerKeyInput));
    expect(answerKeyRef).not.toBe(
      deriveExamAnswerKeyRef({
        ...answerKeyInput,
        sourceReviewArtifactFingerprint: 'e'.repeat(64),
      }),
    );
    expect(deriveExamAnswerKeyArtifactRef(answerKeyRef)).not.toBe(answerKeyRef);

    const gradingInput = {
      examSessionId: first,
      gradingVersion: 1,
      gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
      reviewVersion: answerKeyInput.reviewVersion,
      reviewArtifactRef: answerKeyInput.reviewArtifactRef,
      sourceReviewArtifactFingerprint: answerKeyInput.sourceReviewArtifactFingerprint,
      answerKeyVersion: answerKeyInput.answerKeyVersion,
      answerKeyRef,
      answerKeyArtifactRef: deriveExamAnswerKeyArtifactRef(answerKeyRef),
      sourceAnswerKeyArtifactFingerprint: 'f'.repeat(64),
    } satisfies ExamGradingRefInput;
    const gradingRef = deriveExamGradingRef(gradingInput);
    expect(gradingRef).toBe(deriveExamGradingRef(gradingInput));
    expect(gradingRef).not.toBe(
      deriveExamGradingRef({
        ...gradingInput,
        gradingAlgorithmVersion: 'exam-objective-grading:v2',
      } as unknown as ExamGradingRefInput),
    );
    expect(deriveExamAssessmentArtifactRef(gradingRef)).not.toBe(gradingRef);
    expect(deriveExamAnswerKeyStartedOperationId(first, 1)).not.toBe(
      deriveExamAnswerKeyConfirmedOperationId(first, 1),
    );
    expect(deriveExamGradingStartedOperationId(first, 1)).not.toBe(
      deriveExamGradingCompletedOperationId(first, 1),
    );

    const mappingInput = {
      mappingVersion: 1,
      examSessionId: first,
      profileId: PROFILE_ID,
      subjectId: 'math',
      sourceReviewSemanticFingerprint: '1'.repeat(64),
      sourceAssessmentSemanticFingerprint: '2'.repeat(64),
    };
    const mappingRef = deriveExamKnowledgeMappingRef(mappingInput);
    expect(mappingRef).toBe(deriveExamKnowledgeMappingRef(mappingInput));
    expect(mappingRef).not.toBe(
      deriveExamKnowledgeMappingRef({
        ...mappingInput,
        sourceAssessmentSemanticFingerprint: '3'.repeat(64),
      }),
    );
    expect(deriveExamKnowledgeMappingArtifactRef(mappingRef)).not.toBe(mappingRef);

    const observationInput = {
      observationVersion: 1,
      examSessionId: first,
      sourceAssessmentSemanticFingerprint: '2'.repeat(64),
      sourceMappingSemanticFingerprint: '4'.repeat(64),
    };
    const observationRef = deriveExamObservationProjectionRef(observationInput);
    expect(observationRef).toBe(deriveExamObservationProjectionRef(observationInput));
    expect(deriveExamObservationArtifactRef(observationRef)).not.toBe(observationRef);
    expect(deriveExamKnowledgeMappingStartedOperationId(first, 1)).not.toBe(
      deriveExamKnowledgeMappingConfirmedOperationId(first, 1),
    );
    expect(deriveExamObservationProjectionStartedOperationId(first, 1, 1)).not.toBe(
      deriveExamObservationsProjectedOperationId(first, 1, 1),
    );
  });

  it('creates, loads and replays one immutable intake plan', async () => {
    const backing = store();
    const event = createdEvent();
    const first = await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, event);
    const replay = await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, event);

    expect(first).toMatchObject({ replayed: false, eventAppended: true });
    expect(replay).toMatchObject({ replayed: true, eventAppended: false });
    expect(
      (await loadExamRuntime({ store: backing, ownerId: OWNER_ID }, event.examSessionId)).state,
    ).toMatchObject({ status: 'intake_pending', revision: 0, profileId: PROFILE_ID });
    expect(replay.snapshot.records).toHaveLength(1);
  });

  it('fails closed for another owner and a guessed Exam id', async () => {
    const backing = store();
    const event = createdEvent();
    await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, event);
    await expect(
      loadExamRuntime({ store: backing, ownerId: 'fictional-owner-beta' }, event.examSessionId),
    ).rejects.toThrow('EXAM_NOT_FOUND');
    await expect(
      loadExamRuntime({ store: backing, ownerId: OWNER_ID }, `exam:v1:${'f'.repeat(64)}`),
    ).rejects.toThrow('EXAM_NOT_FOUND');
  });

  it('rejects persisted history with syntactically valid but non-derived identities', async () => {
    const backing = store();
    const event = createdEvent();
    const runtimeSessionId = examRuntimeSessionId(event.examSessionId);
    await backing.createSession({
      id: runtimeSessionId,
      kind: 'zhongkaoExamEvent',
      stageId: zhongkaoStageId(PROFILE_ID),
      learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(OWNER_ID),
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const forged = {
      ...event,
      eventId: 'exam-event-syntactically-valid-forgery',
      operationId: 'exam-operation-syntactically-valid-forgery',
      operationFingerprint: 'f'.repeat(64),
    };
    await backing.appendRecord(
      {
        id: forged.eventId,
        sessionId: runtimeSessionId,
        subAnchor: forged.eventId,
        createdAt: forged.createdAt,
        payload: forged,
      },
      { expectedLastSeq: null },
    );

    await expect(
      loadExamRuntime({ store: backing, ownerId: OWNER_ID }, event.examSessionId),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');
  });

  it('rejects the same create operation with different durable facts', async () => {
    const backing = store();
    const event = createdEvent();
    await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, event);
    await expect(
      ensureExamRuntimeCreated(
        { store: backing, ownerId: OWNER_ID },
        { ...event, operationFingerprint: 'f'.repeat(64) },
      ),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');
    await expect(
      ensureExamRuntimeCreated(
        { store: backing, ownerId: OWNER_ID },
        { ...event, title: 'changed title with unchanged operation fingerprint' },
      ),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');
  });

  it('rejects an empty pre-created session in the wrong profile partition before append', async () => {
    const backing = store();
    const event = createdEvent();
    const runtimeSessionId = examRuntimeSessionId(event.examSessionId);
    await backing.createSession({
      id: runtimeSessionId,
      kind: 'zhongkaoExamEvent',
      stageId: zhongkaoStageId('student-other'),
      learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(OWNER_ID),
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });

    await expect(
      ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, event),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');
    expect(await backing.listRecords(runtimeSessionId)).toHaveLength(0);
  });

  it('appends and replays a deterministic document snapshot fact', async () => {
    const backing = store();
    const created = createdEvent();
    await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, created);
    const event = snapshotEvent(created);
    const first = await appendExamRuntimeEvent(
      { store: backing, ownerId: OWNER_ID },
      { event, expectedRevision: 0 },
    );
    const replay = await appendExamRuntimeEvent(
      { store: backing, ownerId: OWNER_ID },
      { event, expectedRevision: 0 },
    );
    expect(first).toMatchObject({ replayed: false, eventAppended: true });
    expect(replay).toMatchObject({ replayed: true, eventAppended: false });
    expect(replay.snapshot.state.documents[0]?.snapshot).toBeDefined();
    expect(replay.snapshot.records).toHaveLength(2);
    await expect(
      appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event: { ...event, byteLength: event.byteLength + 1 }, expectedRevision: 0 },
      ),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');
  });

  it('reports the current revision for a stale non-replay append', async () => {
    const backing = store();
    const created = createdEvent();
    await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, created);
    const first = snapshotEvent(created);
    await appendExamRuntimeEvent(
      { store: backing, ownerId: OWNER_ID },
      { event: first, expectedRevision: 0 },
    );
    const conflicting = completedEvent(created);
    await expect(
      appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event: conflicting, expectedRevision: 0 },
      ),
    ).rejects.toMatchObject({ code: 'EXAM_SESSION_CONFLICT', latestRevision: 1 });
  });

  it.each(['exam_created', 'exam_document_snapshotted'] as const)(
    'recovers a committed %s append whose response was lost',
    async (targetType) => {
      const backing = store();
      let lost = false;
      const appendRecord: RuntimeStore['appendRecord'] = async (init, options = {}) => {
        const record = await backing.appendRecord(init, options);
        if (!lost && (init.payload as { eventType?: string }).eventType === targetType) {
          lost = true;
          throw new Error('simulated response loss');
        }
        return record;
      };
      const intercepted = withAppend(backing, appendRecord);
      const created = createdEvent();
      const deps = { store: intercepted, ownerId: OWNER_ID };
      const started = await ensureExamRuntimeCreated(deps, created);
      if (targetType === 'exam_created') {
        expect(started.replayed).toBe(true);
      } else {
        const result = await appendExamRuntimeEvent(deps, {
          event: snapshotEvent(created),
          expectedRevision: 0,
        });
        expect(result.replayed).toBe(true);
        expect(result.snapshot.state.revision).toBe(1);
      }
      expect(lost).toBe(true);
    },
  );

  it('accepts a CAS loser only when read-back proves the identical create fact won', async () => {
    const backing = store();
    let injected = false;
    const appendRecord: RuntimeStore['appendRecord'] = async (init, options = {}) => {
      if (!injected && (init.payload as { eventType?: string }).eventType === 'exam_created') {
        injected = true;
        const winner = await backing.appendRecord(init, options);
        throw new RuntimeAppendConflictError(
          init.sessionId,
          options.expectedLastSeq ?? null,
          winner.seq,
        );
      }
      return backing.appendRecord(init, options);
    };
    const event = createdEvent();
    const result = await ensureExamRuntimeCreated(
      { store: withAppend(backing, appendRecord), ownerId: OWNER_ID },
      event,
    );
    expect(result).toMatchObject({ replayed: true, eventAppended: false });
    expect(result.snapshot.records).toHaveLength(1);
  });

  it('accepts a snapshot CAS loser only after identical event read-back', async () => {
    const backing = store();
    const created = createdEvent();
    await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, created);
    let injected = false;
    const appendRecord: RuntimeStore['appendRecord'] = async (init, options = {}) => {
      if (
        !injected &&
        (init.payload as { eventType?: string }).eventType === 'exam_document_snapshotted'
      ) {
        injected = true;
        const winner = await backing.appendRecord(init, options);
        throw new RuntimeAppendConflictError(
          init.sessionId,
          options.expectedLastSeq ?? null,
          winner.seq,
        );
      }
      return backing.appendRecord(init, options);
    };
    const result = await appendExamRuntimeEvent(
      { store: withAppend(backing, appendRecord), ownerId: OWNER_ID },
      { event: snapshotEvent(created), expectedRevision: 0 },
    );
    expect(result).toMatchObject({ replayed: true, eventAppended: false });
    expect(result.snapshot.records).toHaveLength(2);
  });

  it('derives, appends and replays the complete extraction fact chain', async () => {
    const backing = store();
    const created = createdEvent();
    await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, created);
    await appendExamRuntimeEvent(
      { store: backing, ownerId: OWNER_ID },
      { event: snapshotEvent(created), expectedRevision: 0 },
    );
    await appendExamRuntimeEvent(
      { store: backing, ownerId: OWNER_ID },
      { event: completedEvent(created), expectedRevision: 1 },
    );
    const events = extractionEvents(created);
    for (const [index, event] of events.entries()) {
      const expectedRevision = index + 2;
      const result = await appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event, expectedRevision },
      );
      expect(result).toMatchObject({ replayed: false, eventAppended: true });
      const replay = await appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event, expectedRevision },
      );
      expect(replay).toMatchObject({ replayed: true, eventAppended: false });
    }
    const state = (
      await loadExamRuntime({ store: backing, ownerId: OWNER_ID }, created.examSessionId)
    ).state;
    expect(state).toMatchObject({
      status: 'ready_for_extraction',
      revision: 6,
      questionExtraction: { status: 'question_candidates_ready' },
    });
  });

  it('derives, appends and replays one response capture and matching fact chain', async () => {
    const backing = store();
    const created = createdEvent();
    await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, created);
    await appendExamRuntimeEvent(
      { store: backing, ownerId: OWNER_ID },
      { event: snapshotEvent(created), expectedRevision: 0 },
    );
    await appendExamRuntimeEvent(
      { store: backing, ownerId: OWNER_ID },
      { event: completedEvent(created), expectedRevision: 1 },
    );
    for (const [index, event] of extractionEvents(created).entries()) {
      await appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event, expectedRevision: index + 2 },
      );
    }

    const responseChain = responseEvents(created);
    for (const [index, event] of responseChain.entries()) {
      const expectedRevision = index + 6;
      const result = await appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event, expectedRevision },
      );
      expect(result).toMatchObject({ replayed: false, eventAppended: true });
      const replay = await appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event, expectedRevision },
      );
      expect(replay).toMatchObject({ replayed: true, eventAppended: false });
    }

    const snapshot = await loadExamRuntime(
      { store: backing, ownerId: OWNER_ID },
      created.examSessionId,
    );
    expect(snapshot.state).toMatchObject({
      revision: 9,
      studentResponseCapture: {
        status: 'matching_ready',
        responseArtifact: { responseCount: 5 },
        matchingArtifact: {
          responseCount: 5,
          matchedCount: 3,
          ambiguousCount: 1,
          unmatchedCount: 1,
          needsReview: true,
        },
      },
    });

    const changed = {
      ...responseChain[0],
      inputSemanticFingerprint: '9'.repeat(64),
    };
    changed.operationFingerprint = createExamOperationFingerprint({
      action: changed.eventType,
      schemaVersion: changed.schemaVersion,
      examSessionId: changed.examSessionId,
      profileId: changed.profileId,
      captureVersion: changed.captureVersion,
      matchingVersion: changed.matchingVersion,
      segmentationVersion: changed.segmentationVersion,
      questionCandidateArtifactRef: changed.questionCandidateArtifactRef,
      sourceQuestionCandidateFingerprint: changed.sourceQuestionCandidateFingerprint,
      inputSemanticFingerprint: changed.inputSemanticFingerprint,
      captureRef: changed.captureRef,
      responseArtifactRef: changed.responseArtifactRef,
      matchingArtifactRef: changed.matchingArtifactRef,
    });
    await expect(
      appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event: changed, expectedRevision: 6 },
      ),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');
  });

  it('derives, appends and replays one immutable human-review fact chain', async () => {
    const backing = store();
    const created = createdEvent();
    await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, created);
    await appendExamRuntimeEvent(
      { store: backing, ownerId: OWNER_ID },
      { event: snapshotEvent(created), expectedRevision: 0 },
    );
    await appendExamRuntimeEvent(
      { store: backing, ownerId: OWNER_ID },
      { event: completedEvent(created), expectedRevision: 1 },
    );
    for (const [index, event] of [
      ...extractionEvents(created),
      ...responseEvents(created),
    ].entries()) {
      await appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event, expectedRevision: index + 2 },
      );
    }

    const [started, completed] = humanReviewEvents(created);
    const forged = { ...started, reviewArtifactRef: 'forged-review-artifact-ref' };
    forged.operationFingerprint = createExamOperationFingerprint({
      action: forged.eventType,
      schemaVersion: forged.schemaVersion,
      examSessionId: forged.examSessionId,
      profileId: forged.profileId,
      reviewVersion: forged.reviewVersion,
      questionExtractionVersion: forged.questionExtractionVersion,
      questionSegmentationVersion: forged.questionSegmentationVersion,
      responseCaptureVersion: forged.responseCaptureVersion,
      matchingVersion: forged.matchingVersion,
      questionCandidateArtifactRef: forged.questionCandidateArtifactRef,
      sourceQuestionCandidateFingerprint: forged.sourceQuestionCandidateFingerprint,
      responseArtifactRef: forged.responseArtifactRef,
      sourceResponseArtifactFingerprint: forged.sourceResponseArtifactFingerprint,
      matchingArtifactRef: forged.matchingArtifactRef,
      sourceMatchingArtifactFingerprint: forged.sourceMatchingArtifactFingerprint,
      decisionSemanticFingerprint: forged.decisionSemanticFingerprint,
      reviewArtifactRef: forged.reviewArtifactRef,
    });
    await expect(
      appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event: forged, expectedRevision: 9 },
      ),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');

    for (const [index, event] of [started, completed].entries()) {
      const expectedRevision = index + 9;
      const result = await appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event, expectedRevision },
      );
      expect(result).toMatchObject({ replayed: false, eventAppended: true });
      await expect(
        appendExamRuntimeEvent({ store: backing, ownerId: OWNER_ID }, { event, expectedRevision }),
      ).resolves.toMatchObject({ replayed: true, eventAppended: false });
    }

    const snapshot = await loadExamRuntime(
      { store: backing, ownerId: OWNER_ID },
      created.examSessionId,
    );
    expect(snapshot.state).toMatchObject({
      revision: 11,
      studentResponseCapture: { status: 'matching_ready' },
      humanReview: {
        status: 'confirmed',
        reviewArtifact: {
          confirmedQuestionCount: 3,
          confirmedResponseCount: 3,
          confirmedMatchCount: 3,
          rejectedQuestionCount: 2,
          rejectedResponseCount: 2,
        },
      },
    });

    const changed = {
      ...started,
      decisionSemanticFingerprint: '9'.repeat(64),
    };
    changed.operationFingerprint = createExamOperationFingerprint({
      action: changed.eventType,
      schemaVersion: changed.schemaVersion,
      examSessionId: changed.examSessionId,
      profileId: changed.profileId,
      reviewVersion: changed.reviewVersion,
      questionExtractionVersion: changed.questionExtractionVersion,
      questionSegmentationVersion: changed.questionSegmentationVersion,
      responseCaptureVersion: changed.responseCaptureVersion,
      matchingVersion: changed.matchingVersion,
      questionCandidateArtifactRef: changed.questionCandidateArtifactRef,
      sourceQuestionCandidateFingerprint: changed.sourceQuestionCandidateFingerprint,
      responseArtifactRef: changed.responseArtifactRef,
      sourceResponseArtifactFingerprint: changed.sourceResponseArtifactFingerprint,
      matchingArtifactRef: changed.matchingArtifactRef,
      sourceMatchingArtifactFingerprint: changed.sourceMatchingArtifactFingerprint,
      decisionSemanticFingerprint: changed.decisionSemanticFingerprint,
      reviewArtifactRef: changed.reviewArtifactRef,
    });
    await expect(
      appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event: changed, expectedRevision: 9 },
      ),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');
  });

  it('derives and enforces the answer-key and grading artifact lineage', async () => {
    const backing = store();
    const created = createdEvent();
    await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, created);
    const review = humanReviewEvents(created);
    const baseChain = [
      snapshotEvent(created),
      completedEvent(created),
      ...extractionEvents(created),
      ...responseEvents(created),
      ...review,
    ];
    for (const [index, event] of baseChain.entries()) {
      await appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event, expectedRevision: index },
      );
    }

    const answerKey = answerKeyEvents(created, review[1]);
    const forgedKey = { ...answerKey[0], answerKeyRef: 'forged-answer-key-ref' };
    forgedKey.operationFingerprint = createExamOperationFingerprint({
      action: forgedKey.eventType,
      schemaVersion: forgedKey.schemaVersion,
      examSessionId: forgedKey.examSessionId,
      profileId: forgedKey.profileId,
      answerKeyVersion: forgedKey.answerKeyVersion,
      reviewVersion: forgedKey.reviewVersion,
      reviewArtifactRef: forgedKey.reviewArtifactRef,
      sourceReviewArtifactFingerprint: forgedKey.sourceReviewArtifactFingerprint,
      answerKeySemanticFingerprint: forgedKey.answerKeySemanticFingerprint,
      answerKeyRef: forgedKey.answerKeyRef,
      answerKeyArtifactRef: forgedKey.answerKeyArtifactRef,
    });
    await expect(
      appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event: forgedKey, expectedRevision: 11 },
      ),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');

    for (const [index, event] of answerKey.entries()) {
      await expect(
        appendExamRuntimeEvent(
          { store: backing, ownerId: OWNER_ID },
          { event, expectedRevision: index + 11 },
        ),
      ).resolves.toMatchObject({ replayed: false, eventAppended: true });
    }

    const grading = gradingEvents(created, review[1], answerKey[1]);
    const forgedGrading = {
      ...grading[0],
      assessmentArtifactRef: 'forged-assessment-artifact-ref',
    };
    forgedGrading.operationFingerprint = createExamOperationFingerprint({
      action: forgedGrading.eventType,
      schemaVersion: forgedGrading.schemaVersion,
      examSessionId: forgedGrading.examSessionId,
      profileId: forgedGrading.profileId,
      gradingVersion: forgedGrading.gradingVersion,
      gradingAlgorithmVersion: forgedGrading.gradingAlgorithmVersion,
      reviewVersion: forgedGrading.reviewVersion,
      reviewArtifactRef: forgedGrading.reviewArtifactRef,
      sourceReviewArtifactFingerprint: forgedGrading.sourceReviewArtifactFingerprint,
      answerKeyVersion: forgedGrading.answerKeyVersion,
      answerKeyRef: forgedGrading.answerKeyRef,
      answerKeyArtifactRef: forgedGrading.answerKeyArtifactRef,
      sourceAnswerKeyArtifactFingerprint: forgedGrading.sourceAnswerKeyArtifactFingerprint,
      gradingRef: forgedGrading.gradingRef,
      assessmentArtifactRef: forgedGrading.assessmentArtifactRef,
    });
    await expect(
      appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event: forgedGrading, expectedRevision: 13 },
      ),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');

    for (const [index, event] of grading.entries()) {
      await expect(
        appendExamRuntimeEvent(
          { store: backing, ownerId: OWNER_ID },
          { event, expectedRevision: index + 13 },
        ),
      ).resolves.toMatchObject({ replayed: false, eventAppended: true });
    }
    const snapshot = await loadExamRuntime(
      { store: backing, ownerId: OWNER_ID },
      created.examSessionId,
    );
    expect(snapshot.state).toMatchObject({
      revision: 15,
      answerKey: { status: 'confirmed', answerKeyArtifact: { entryCount: 3 } },
      grading: {
        status: 'completed',
        assessmentArtifact: { assessmentCount: 3, correctCount: 1, incorrectCount: 1 },
      },
    });
  });

  it('derives and enforces mapping and observation source lineage', async () => {
    const backing = store();
    const created = createdEvent();
    await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, created);
    const review = humanReviewEvents(created);
    const answerKey = answerKeyEvents(created, review[1]);
    const grading = gradingEvents(created, review[1], answerKey[1]);
    const baseChain = [
      snapshotEvent(created),
      completedEvent(created),
      ...extractionEvents(created),
      ...responseEvents(created),
      ...review,
      ...answerKey,
      ...grading,
    ];
    for (const [index, event] of baseChain.entries()) {
      await appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event, expectedRevision: index },
      );
    }

    const mapping = knowledgeMappingEvents(created, review[1], grading[1]);
    const forgedMapping = { ...mapping[0], mappingRef: 'forged-mapping-ref' };
    forgedMapping.operationFingerprint = createExamOperationFingerprint({
      action: forgedMapping.eventType,
      schemaVersion: forgedMapping.schemaVersion,
      examSessionId: forgedMapping.examSessionId,
      profileId: forgedMapping.profileId,
      mappingVersion: forgedMapping.mappingVersion,
      subjectId: forgedMapping.subjectId,
      reviewVersion: forgedMapping.reviewVersion,
      reviewArtifactRef: forgedMapping.reviewArtifactRef,
      sourceReviewArtifactFingerprint: forgedMapping.sourceReviewArtifactFingerprint,
      sourceReviewSemanticFingerprint: forgedMapping.sourceReviewSemanticFingerprint,
      assessmentVersion: forgedMapping.assessmentVersion,
      assessmentArtifactRef: forgedMapping.assessmentArtifactRef,
      sourceAssessmentArtifactFingerprint: forgedMapping.sourceAssessmentArtifactFingerprint,
      sourceAssessmentSemanticFingerprint: forgedMapping.sourceAssessmentSemanticFingerprint,
      mappingSemanticFingerprint: forgedMapping.mappingSemanticFingerprint,
      mappingRef: forgedMapping.mappingRef,
      mappingArtifactRef: forgedMapping.mappingArtifactRef,
    });
    await expect(
      appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event: forgedMapping, expectedRevision: 15 },
      ),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');

    for (const [index, event] of mapping.entries()) {
      await appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event, expectedRevision: index + 15 },
      );
    }
    const projection = observationProjectionEvents(created, mapping[1]);
    const forgedProjection = {
      ...projection[0],
      observationRef: 'forged-observation-ref',
    };
    forgedProjection.operationFingerprint = createExamOperationFingerprint({
      action: forgedProjection.eventType,
      schemaVersion: forgedProjection.schemaVersion,
      examSessionId: forgedProjection.examSessionId,
      profileId: forgedProjection.profileId,
      observationVersion: forgedProjection.observationVersion,
      reviewVersion: forgedProjection.reviewVersion,
      reviewArtifactRef: forgedProjection.reviewArtifactRef,
      sourceReviewArtifactFingerprint: forgedProjection.sourceReviewArtifactFingerprint,
      sourceReviewSemanticFingerprint: forgedProjection.sourceReviewSemanticFingerprint,
      assessmentVersion: forgedProjection.assessmentVersion,
      assessmentArtifactRef: forgedProjection.assessmentArtifactRef,
      sourceAssessmentArtifactFingerprint: forgedProjection.sourceAssessmentArtifactFingerprint,
      sourceAssessmentSemanticFingerprint: forgedProjection.sourceAssessmentSemanticFingerprint,
      mappingVersion: forgedProjection.mappingVersion,
      mappingRef: forgedProjection.mappingRef,
      mappingArtifactRef: forgedProjection.mappingArtifactRef,
      sourceMappingArtifactFingerprint: forgedProjection.sourceMappingArtifactFingerprint,
      sourceMappingSemanticFingerprint: forgedProjection.sourceMappingSemanticFingerprint,
      observationSemanticFingerprint: forgedProjection.observationSemanticFingerprint,
      observationRef: forgedProjection.observationRef,
      observationArtifactRef: forgedProjection.observationArtifactRef,
    });
    await expect(
      appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event: forgedProjection, expectedRevision: 17 },
      ),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');

    for (const [index, event] of projection.entries()) {
      await appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event, expectedRevision: index + 17 },
      );
    }

    const snapshot = await loadExamRuntime(
      { store: backing, ownerId: OWNER_ID },
      created.examSessionId,
    );
    expect(snapshot.state).toMatchObject({
      revision: 19,
      knowledgeMapping: {
        status: 'confirmed',
        mappingArtifact: { mappedQuestionCount: 2, unmappedQuestionCount: 1 },
      },
      observationProjection: {
        status: 'completed',
        observationArtifact: { observationCount: 2, incorrectCount: 1 },
      },
    });
  });

  it('requires strict session enumeration and maps unscoped listing failures', async () => {
    const withoutStrict = new Proxy(store(), {
      get(target, property, receiver) {
        if (property === 'listSessionsStrict') return undefined;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      listProfileExamRuntimeSnapshots({ store: withoutStrict, ownerId: OWNER_ID }, PROFILE_ID),
    ).rejects.toMatchObject({ code: 'EXAM_SESSION_CONFLICT' });

    const unavailable = new Proxy(store(), {
      get(target, property, receiver) {
        if (property === 'listSessionsStrict') {
          return async () => {
            throw new Error('simulated enumeration outage');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      listProfileExamRuntimeSnapshots({ store: unavailable, ownerId: OWNER_ID }, PROFILE_ID),
    ).rejects.toMatchObject({ code: 'EXAM_SESSION_CONFLICT' });
  });

  it('fails closed when ordinary Browser listing omits a relevant corrupt Exam envelope', async () => {
    const harness = browserStoreHarness();
    const created = createdEvent();
    const deps = { store: harness.store, ownerId: OWNER_ID };
    await ensureExamRuntimeCreated(deps, created);
    await rewriteSessionRow(
      harness.indexedDB,
      harness.dbName,
      examRuntimeSessionId(created.examSessionId),
      (row) => {
        row.createdAt = 'not-iso';
      },
    );

    const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(OWNER_ID);
    await expect(
      harness.store.listSessions(zhongkaoStageId(PROFILE_ID), learnerKey),
    ).resolves.toEqual([]);
    await expect(listProfileExamRuntimeSnapshots(deps, PROFILE_ID)).rejects.toMatchObject({
      code: 'EXAM_EVENT_CONFLICT',
    });
  });

  it('keeps an Exam relevant by its reserved id prefix when its stored kind is damaged', async () => {
    const harness = browserStoreHarness();
    const created = createdEvent();
    const deps = { store: harness.store, ownerId: OWNER_ID };
    await ensureExamRuntimeCreated(deps, created);
    await rewriteSessionRow(
      harness.indexedDB,
      harness.dbName,
      examRuntimeSessionId(created.examSessionId),
      (row) => {
        row.kind = 'chat';
      },
    );

    await expect(listProfileExamRuntimeSnapshots(deps, PROFILE_ID)).rejects.toMatchObject({
      code: 'EXAM_EVENT_CONFLICT',
    });
  });

  it('does not let out-of-scope or unrelated corrupt sessions block Exam evidence listing', async () => {
    const relevant = browserStoreHarness();
    const created = createdEvent();
    await ensureExamRuntimeCreated({ store: relevant.store, ownerId: OWNER_ID }, created);
    await rewriteSessionRow(
      relevant.indexedDB,
      relevant.dbName,
      examRuntimeSessionId(created.examSessionId),
      (row) => {
        row.createdAt = 'not-iso';
      },
    );

    await expect(
      listProfileExamRuntimeSnapshots(
        { store: relevant.store, ownerId: 'fictional-other-owner' },
        PROFILE_ID,
      ),
    ).resolves.toEqual([]);
    await expect(
      listProfileExamRuntimeSnapshots({ store: relevant.store, ownerId: OWNER_ID }, 'student-beta'),
    ).resolves.toEqual([]);

    const unrelated = browserStoreHarness();
    const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(OWNER_ID);
    await unrelated.store.createSession({
      id: 'unrelated-chat-session',
      kind: 'chat',
      stageId: zhongkaoStageId(PROFILE_ID),
      learnerKey,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await rewriteSessionRow(
      unrelated.indexedDB,
      unrelated.dbName,
      'unrelated-chat-session',
      (row) => {
        row.createdAt = 'not-iso';
      },
    );
    await expect(
      listProfileExamRuntimeSnapshots({ store: unrelated.store, ownerId: OWNER_ID }, PROFILE_ID),
    ).resolves.toEqual([]);
  });

  it('lists only owner/profile scoped non-deleted Exam runtime snapshots', async () => {
    const harness = browserStoreHarness();
    const backing = harness.store;
    const created = createdEvent();
    const deps = { store: backing, ownerId: OWNER_ID };
    const strictListing = vi.spyOn(backing as StrictRuntimeSessionStore, 'listSessionsStrict');
    await ensureExamRuntimeCreated(deps, created);

    await expect(listProfileExamRuntimeSnapshots(deps, PROFILE_ID)).resolves.toMatchObject([
      { state: { examSessionId: created.examSessionId, profileId: PROFILE_ID } },
    ]);
    expect(strictListing).toHaveBeenCalledWith(
      zhongkaoStageId(PROFILE_ID),
      resolveZhongkaoLearnerKeyFromOwnerId(OWNER_ID),
      {
        kinds: ['zhongkaoExamEvent'],
        idPrefixes: ['zhongkao-exam:'],
      },
    );
    await expect(listProfileExamRuntimeSnapshots(deps, 'another-profile')).resolves.toEqual([]);
    await expect(
      listProfileExamRuntimeSnapshots({ store: backing, ownerId: 'another-owner' }, PROFILE_ID),
    ).resolves.toEqual([]);

    const requestedOperationId = deriveExamDeleteRequestedOperationId(created.examSessionId);
    const requested: ExamDeleteRequestedEvent = {
      schemaVersion: 1,
      eventId: deriveExamEventId(requestedOperationId),
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      eventType: 'exam_delete_requested',
      createdAt: '2026-08-31T08:00:20.000Z',
      operationId: requestedOperationId,
      operationFingerprint: createExamOperationFingerprint({
        action: 'exam_delete_requested',
        schemaVersion: 1,
        examSessionId: created.examSessionId,
        profileId: created.profileId,
        documentSetFingerprint: created.documentSetFingerprint,
      }),
      documentSetFingerprint: created.documentSetFingerprint,
    };
    await appendExamRuntimeEvent(deps, { event: requested, expectedRevision: 0 });
    const deletedOperationId = deriveExamDeletedOperationId(created.examSessionId);
    const deleted: ExamDeletedEvent = {
      schemaVersion: 1,
      eventId: deriveExamEventId(deletedOperationId),
      examSessionId: created.examSessionId,
      profileId: created.profileId,
      eventType: 'exam_deleted',
      createdAt: '2026-08-31T08:00:21.000Z',
      operationId: deletedOperationId,
      operationFingerprint: createExamOperationFingerprint({
        action: 'exam_deleted',
        schemaVersion: 1,
        examSessionId: created.examSessionId,
        profileId: created.profileId,
        documentSetFingerprint: created.documentSetFingerprint,
        deleteRequestEventId: requested.eventId,
      }),
      documentSetFingerprint: created.documentSetFingerprint,
      deleteRequestEventId: requested.eventId,
    };
    await appendExamRuntimeEvent(deps, { event: deleted, expectedRevision: 1 });
    await expect(listProfileExamRuntimeSnapshots(deps, PROFILE_ID)).resolves.toEqual([]);

    await rewriteSessionRow(
      harness.indexedDB,
      harness.dbName,
      examRuntimeSessionId(created.examSessionId),
      (row) => {
        row.createdAt = 'not-iso';
      },
    );
    await expect(listProfileExamRuntimeSnapshots(deps, PROFILE_ID)).rejects.toMatchObject({
      code: 'EXAM_EVENT_CONFLICT',
    });
  });

  it('rejects forged deterministic response capture references before append', async () => {
    const backing = store();
    const created = createdEvent();
    await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, created);
    await appendExamRuntimeEvent(
      { store: backing, ownerId: OWNER_ID },
      { event: snapshotEvent(created), expectedRevision: 0 },
    );
    await appendExamRuntimeEvent(
      { store: backing, ownerId: OWNER_ID },
      { event: completedEvent(created), expectedRevision: 1 },
    );
    for (const [index, event] of extractionEvents(created).entries()) {
      await appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event, expectedRevision: index + 2 },
      );
    }
    const [started] = responseEvents(created);
    const forged = { ...started, captureRef: 'forged-response-capture-ref' };
    forged.operationFingerprint = createExamOperationFingerprint({
      action: forged.eventType,
      schemaVersion: forged.schemaVersion,
      examSessionId: forged.examSessionId,
      profileId: forged.profileId,
      captureVersion: forged.captureVersion,
      matchingVersion: forged.matchingVersion,
      segmentationVersion: forged.segmentationVersion,
      questionCandidateArtifactRef: forged.questionCandidateArtifactRef,
      sourceQuestionCandidateFingerprint: forged.sourceQuestionCandidateFingerprint,
      inputSemanticFingerprint: forged.inputSemanticFingerprint,
      captureRef: forged.captureRef,
      responseArtifactRef: forged.responseArtifactRef,
      matchingArtifactRef: forged.matchingArtifactRef,
    });
    await expect(
      appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event: forged, expectedRevision: 6 },
      ),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');
  });

  it('rejects forged derivative refs before append', async () => {
    const backing = store();
    const created = createdEvent();
    await ensureExamRuntimeCreated({ store: backing, ownerId: OWNER_ID }, created);
    await appendExamRuntimeEvent(
      { store: backing, ownerId: OWNER_ID },
      { event: snapshotEvent(created), expectedRevision: 0 },
    );
    await appendExamRuntimeEvent(
      { store: backing, ownerId: OWNER_ID },
      { event: completedEvent(created), expectedRevision: 1 },
    );
    const [started] = extractionEvents(created);
    const forged = { ...started, documentArtifactRef: 'forged-artifact-ref' };
    forged.operationFingerprint = createExamOperationFingerprint({
      action: forged.eventType,
      schemaVersion: forged.schemaVersion,
      examSessionId: forged.examSessionId,
      profileId: forged.profileId,
      extractionVersion: forged.extractionVersion,
      examDocumentId: forged.examDocumentId,
      sourceSnapshotFingerprint: forged.sourceSnapshotFingerprint,
      extractorId: forged.extractorId,
      extractorVersion: forged.extractorVersion,
      normalizationVersion: forged.normalizationVersion,
      documentArtifactRef: forged.documentArtifactRef,
    });
    await expect(
      appendExamRuntimeEvent(
        { store: backing, ownerId: OWNER_ID },
        { event: forged, expectedRevision: 2 },
      ),
    ).rejects.toThrow('EXAM_EVENT_CONFLICT');
  });
});
