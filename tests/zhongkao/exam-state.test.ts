import type { RuntimeRecord } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';

import { ExamError } from '@/lib/zhongkao/exam-errors';
import { EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION } from '@/lib/zhongkao/exam';
import type {
  ExamAnswerKeyConfirmedEvent,
  ExamAnswerKeyStartedEvent,
  ExamCreatedEvent,
  ExamDocumentArtifactExtractedEvent,
  ExamDocumentSnapshottedEvent,
  ExamErrorSuggestionsCompletedEvent,
  ExamErrorSuggestionsStartedEvent,
  ExamEvent,
  ExamGradingCompletedEvent,
  ExamGradingStartedEvent,
  ExamHumanReviewCompletedEvent,
  ExamHumanReviewStartedEvent,
  ExamIntakeCompletedEvent,
  ExamKnowledgeMappingConfirmedEvent,
  ExamKnowledgeMappingStartedEvent,
  ExamKnowledgeSuggestionsCompletedEvent,
  ExamKnowledgeSuggestionsStartedEvent,
  ExamObservationProjectionStartedEvent,
  ExamObservationsProjectedEvent,
  ExamQuestionCandidatesExtractedEvent,
  ExamQuestionExtractionStartedEvent,
  ExamQuestionSegmentationStartedEvent,
  ExamResponseCandidatesRecordedEvent,
  ExamResponseMatchingCompletedEvent,
  ExamStudentResponseCaptureStartedEvent,
} from '@/lib/zhongkao/exam-event';
import { foldExamEvents, toPublicExamSession } from '@/lib/zhongkao/exam-state';

const NOW = '2026-08-31T08:00:00.000Z';
const EXAM_ID = `exam:v1:${'a'.repeat(64)}`;
const DOCUMENT_SET_FP = 'b'.repeat(64);
const RESPONSE_PLAN = {
  captureVersion: 1,
  matchingVersion: 1,
  segmentationVersion: 1,
  questionCandidateArtifactRef: 'exam-question-candidates-v1',
  sourceQuestionCandidateFingerprint: '2'.repeat(64),
  inputSemanticFingerprint: '3'.repeat(64),
  captureRef: 'exam-response-capture-v1',
  responseArtifactRef: 'exam-response-artifact-v1',
  matchingArtifactRef: 'exam-response-matching-v1',
} as const;
const HUMAN_REVIEW_PLAN = {
  reviewVersion: 1,
  questionExtractionVersion: 1,
  questionSegmentationVersion: 1,
  responseCaptureVersion: 1,
  matchingVersion: 1,
  questionCandidateArtifactRef: RESPONSE_PLAN.questionCandidateArtifactRef,
  sourceQuestionCandidateFingerprint: RESPONSE_PLAN.sourceQuestionCandidateFingerprint,
  responseArtifactRef: RESPONSE_PLAN.responseArtifactRef,
  sourceResponseArtifactFingerprint: '4'.repeat(64),
  matchingArtifactRef: RESPONSE_PLAN.matchingArtifactRef,
  sourceMatchingArtifactFingerprint: '5'.repeat(64),
  decisionSemanticFingerprint: '6'.repeat(64),
  reviewArtifactRef: 'exam-human-review-artifact-v1',
} as const;
const ANSWER_KEY_PLAN = {
  answerKeyVersion: 1,
  reviewVersion: 1,
  reviewArtifactRef: HUMAN_REVIEW_PLAN.reviewArtifactRef,
  sourceReviewArtifactFingerprint: '7'.repeat(64),
  answerKeySemanticFingerprint: '8'.repeat(64),
  answerKeyRef: 'exam-answer-key-v1',
  answerKeyArtifactRef: 'exam-answer-key-artifact-v1',
} as const;
const GRADING_PLAN = {
  gradingVersion: 1,
  gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
  reviewVersion: ANSWER_KEY_PLAN.reviewVersion,
  reviewArtifactRef: ANSWER_KEY_PLAN.reviewArtifactRef,
  sourceReviewArtifactFingerprint: ANSWER_KEY_PLAN.sourceReviewArtifactFingerprint,
  answerKeyVersion: ANSWER_KEY_PLAN.answerKeyVersion,
  answerKeyRef: ANSWER_KEY_PLAN.answerKeyRef,
  answerKeyArtifactRef: ANSWER_KEY_PLAN.answerKeyArtifactRef,
  sourceAnswerKeyArtifactFingerprint: '9'.repeat(64),
  gradingRef: 'exam-grading-v1',
  assessmentArtifactRef: 'exam-assessment-artifact-v1',
} as const;
const KNOWLEDGE_SUGGESTIONS_PLAN = {
  generationVersion: 1,
  subjectId: 'math',
  generatorVersion: 'exam-knowledge-suggestions-generator:v1',
  candidateSchemaVersion: 1,
  reviewVersion: HUMAN_REVIEW_PLAN.reviewVersion,
  reviewArtifactRef: HUMAN_REVIEW_PLAN.reviewArtifactRef,
  sourceReviewArtifactFingerprint: '7'.repeat(64),
  sourceReviewSemanticFingerprint: HUMAN_REVIEW_PLAN.decisionSemanticFingerprint,
  candidatePoolMode: 'label_only',
  candidatePoolFingerprint: '8'.repeat(64),
  generationRef: 'exam-knowledge-suggestions-v1',
  suggestionArtifactRef: 'exam-knowledge-suggestions-artifact-v1',
} as const;
const ERROR_SUGGESTIONS_PLAN = {
  generationVersion: 1,
  subjectId: 'math',
  generatorVersion: 'exam-error-diagnosis-generator:v1',
  detectorVersion: 'exam-error-observable-rules:v1',
  modelPolicyVersion: 'exam-error-model-policy:v1',
  candidateSchemaVersion: 1,
  reviewVersion: HUMAN_REVIEW_PLAN.reviewVersion,
  reviewArtifactRef: HUMAN_REVIEW_PLAN.reviewArtifactRef,
  sourceReviewArtifactFingerprint: '7'.repeat(64),
  sourceReviewSemanticFingerprint: HUMAN_REVIEW_PLAN.decisionSemanticFingerprint,
  answerKeyVersion: ANSWER_KEY_PLAN.answerKeyVersion,
  answerKeyRef: ANSWER_KEY_PLAN.answerKeyRef,
  answerKeyArtifactRef: ANSWER_KEY_PLAN.answerKeyArtifactRef,
  sourceAnswerKeyArtifactFingerprint: '9'.repeat(64),
  sourceAnswerKeySemanticFingerprint: ANSWER_KEY_PLAN.answerKeySemanticFingerprint,
  assessmentVersion: GRADING_PLAN.gradingVersion,
  gradingAlgorithmVersion: GRADING_PLAN.gradingAlgorithmVersion,
  gradingRef: GRADING_PLAN.gradingRef,
  assessmentArtifactRef: GRADING_PLAN.assessmentArtifactRef,
  sourceAssessmentArtifactFingerprint: 'a'.repeat(64),
  sourceAssessmentSemanticFingerprint: 'b'.repeat(64),
  generationRef: 'exam-error-suggestions-v1',
  suggestionArtifactRef: 'exam-error-suggestions-artifact-v1',
} as const;
const KNOWLEDGE_MAPPING_PLAN = {
  mappingVersion: 1,
  subjectId: 'math',
  reviewVersion: HUMAN_REVIEW_PLAN.reviewVersion,
  reviewArtifactRef: HUMAN_REVIEW_PLAN.reviewArtifactRef,
  sourceReviewArtifactFingerprint: '7'.repeat(64),
  sourceReviewSemanticFingerprint: HUMAN_REVIEW_PLAN.decisionSemanticFingerprint,
  assessmentVersion: 1,
  assessmentArtifactRef: GRADING_PLAN.assessmentArtifactRef,
  sourceAssessmentArtifactFingerprint: 'a'.repeat(64),
  sourceAssessmentSemanticFingerprint: 'b'.repeat(64),
  mappingSemanticFingerprint: 'c'.repeat(64),
  mappingRef: 'exam-knowledge-mapping-v1',
  mappingArtifactRef: 'exam-knowledge-mapping-artifact-v1',
} as const;
const OBSERVATION_PROJECTION_PLAN = {
  observationVersion: 1,
  reviewVersion: KNOWLEDGE_MAPPING_PLAN.reviewVersion,
  reviewArtifactRef: KNOWLEDGE_MAPPING_PLAN.reviewArtifactRef,
  sourceReviewArtifactFingerprint: KNOWLEDGE_MAPPING_PLAN.sourceReviewArtifactFingerprint,
  sourceReviewSemanticFingerprint: KNOWLEDGE_MAPPING_PLAN.sourceReviewSemanticFingerprint,
  assessmentVersion: KNOWLEDGE_MAPPING_PLAN.assessmentVersion,
  assessmentArtifactRef: KNOWLEDGE_MAPPING_PLAN.assessmentArtifactRef,
  sourceAssessmentArtifactFingerprint: KNOWLEDGE_MAPPING_PLAN.sourceAssessmentArtifactFingerprint,
  sourceAssessmentSemanticFingerprint: KNOWLEDGE_MAPPING_PLAN.sourceAssessmentSemanticFingerprint,
  mappingVersion: KNOWLEDGE_MAPPING_PLAN.mappingVersion,
  mappingRef: KNOWLEDGE_MAPPING_PLAN.mappingRef,
  mappingArtifactRef: KNOWLEDGE_MAPPING_PLAN.mappingArtifactRef,
  sourceMappingArtifactFingerprint: 'd'.repeat(64),
  sourceMappingSemanticFingerprint: KNOWLEDGE_MAPPING_PLAN.mappingSemanticFingerprint,
  observationSemanticFingerprint: 'e'.repeat(64),
  observationRef: 'exam-observations-v1',
  observationArtifactRef: 'exam-observations-artifact-v1',
} as const;

function fingerprint(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

function base(seq: number) {
  return {
    schemaVersion: 1 as const,
    eventId: `exam-event-${seq}`,
    examSessionId: EXAM_ID,
    profileId: 'student-alpha',
    createdAt: new Date(Date.parse(NOW) + seq * 1000).toISOString(),
    operationId: `exam-operation-${seq}`,
    operationFingerprint: fingerprint(seq + 1),
  };
}

function created(overrides: Partial<ExamCreatedEvent> = {}): ExamCreatedEvent {
  return {
    ...base(0),
    eventType: 'exam_created',
    subjectId: 'math',
    title: 'Fictional exam',
    requestFingerprint: 'c'.repeat(64),
    documentSetFingerprint: DOCUMENT_SET_FP,
    documents: [
      {
        examDocumentId: 'exam-document-question',
        role: 'question_paper',
        ownerMaterialId: `mat_${'0'.repeat(26)}`,
        sourceSha256: 'd'.repeat(64),
        mimeType: 'application/pdf',
        byteLength: 12,
        displayName: 'fictional-question.pdf',
      },
      {
        examDocumentId: 'exam-document-response',
        role: 'student_response',
        ownerMaterialId: `mat_${'1'.repeat(26)}`,
        sourceSha256: 'e'.repeat(64),
        mimeType: 'image/png',
        byteLength: 8,
      },
      {
        examDocumentId: 'exam-document-key',
        role: 'answer_key',
        ownerMaterialId: `mat_${'2'.repeat(26)}`,
        sourceSha256: 'f'.repeat(64),
        mimeType: 'text/plain',
        byteLength: 6,
      },
    ],
    ...overrides,
  };
}

function snapshotted(
  seq: number,
  index: number,
  overrides: Partial<ExamDocumentSnapshottedEvent> = {},
): ExamDocumentSnapshottedEvent {
  const document = created().documents[index]!;
  return {
    ...base(seq),
    eventType: 'exam_document_snapshotted',
    examDocumentId: document.examDocumentId,
    snapshotSha256: document.sourceSha256,
    byteLength: document.byteLength,
    ...overrides,
  };
}

function completed(seq: number): ExamIntakeCompletedEvent {
  return {
    ...base(seq),
    eventType: 'exam_intake_completed',
    documentSetFingerprint: DOCUMENT_SET_FP,
  };
}

function extractionStarted(
  seq: number,
  overrides: Partial<ExamQuestionExtractionStartedEvent> = {},
): ExamQuestionExtractionStartedEvent {
  return {
    ...base(seq),
    eventType: 'exam_question_extraction_started',
    extractionVersion: 1,
    examDocumentId: 'exam-document-question',
    sourceSnapshotFingerprint: 'd'.repeat(64),
    extractorId: 'unpdf',
    extractorVersion: 'exam-pdf-text:v1',
    normalizationVersion: 'exam-document-normalization:v1',
    documentArtifactRef: 'exam-document-artifact-v1',
    ...overrides,
  };
}

function documentExtracted(
  seq: number,
  overrides: Partial<ExamDocumentArtifactExtractedEvent> = {},
): ExamDocumentArtifactExtractedEvent {
  return {
    ...base(seq),
    eventType: 'exam_document_artifact_extracted',
    extractionVersion: 1,
    examDocumentId: 'exam-document-question',
    sourceSnapshotFingerprint: 'd'.repeat(64),
    extractorId: 'unpdf',
    extractorVersion: 'exam-pdf-text:v1',
    normalizationVersion: 'exam-document-normalization:v1',
    documentArtifactRef: 'exam-document-artifact-v1',
    artifactByteLength: 512,
    artifactSha256: '1'.repeat(64),
    pageCount: 2,
    ...overrides,
  };
}

function segmentationStarted(
  seq: number,
  overrides: Partial<ExamQuestionSegmentationStartedEvent> = {},
): ExamQuestionSegmentationStartedEvent {
  return {
    ...base(seq),
    eventType: 'exam_question_segmentation_started',
    extractionVersion: 1,
    segmentationVersion: 1,
    examDocumentId: 'exam-document-question',
    sourceArtifactFingerprint: '1'.repeat(64),
    documentArtifactRef: 'exam-document-artifact-v1',
    candidateArtifactRef: 'exam-question-candidates-v1',
    ...overrides,
  };
}

function candidatesExtracted(
  seq: number,
  overrides: Partial<ExamQuestionCandidatesExtractedEvent> = {},
): ExamQuestionCandidatesExtractedEvent {
  return {
    ...base(seq),
    eventType: 'exam_question_candidates_extracted',
    extractionVersion: 1,
    segmentationVersion: 1,
    examDocumentId: 'exam-document-question',
    sourceArtifactFingerprint: '1'.repeat(64),
    documentArtifactRef: 'exam-document-artifact-v1',
    candidateArtifactRef: 'exam-question-candidates-v1',
    artifactByteLength: 384,
    artifactSha256: '2'.repeat(64),
    candidateCount: 5,
    needsReview: true,
    ...overrides,
  };
}

function responseCaptureStarted(
  seq: number,
  overrides: Partial<ExamStudentResponseCaptureStartedEvent> = {},
): ExamStudentResponseCaptureStartedEvent {
  return {
    ...base(seq),
    eventType: 'exam_student_response_capture_started',
    ...RESPONSE_PLAN,
    ...overrides,
  };
}

function responseCandidatesRecorded(
  seq: number,
  overrides: Partial<ExamResponseCandidatesRecordedEvent> = {},
): ExamResponseCandidatesRecordedEvent {
  return {
    ...base(seq),
    eventType: 'exam_response_candidates_recorded',
    ...RESPONSE_PLAN,
    artifactByteLength: 256,
    artifactSha256: '4'.repeat(64),
    responseCount: 5,
    ...overrides,
  };
}

function responseMatchingCompleted(
  seq: number,
  overrides: Partial<ExamResponseMatchingCompletedEvent> = {},
): ExamResponseMatchingCompletedEvent {
  return {
    ...base(seq),
    eventType: 'exam_response_matching_completed',
    ...RESPONSE_PLAN,
    responseArtifactFingerprint: '4'.repeat(64),
    artifactByteLength: 192,
    artifactSha256: '5'.repeat(64),
    responseCount: 5,
    matchedCount: 3,
    ambiguousCount: 1,
    unmatchedCount: 1,
    needsReview: true,
    ...overrides,
  };
}

function humanReviewStarted(
  seq: number,
  overrides: Partial<ExamHumanReviewStartedEvent> = {},
): ExamHumanReviewStartedEvent {
  return {
    ...base(seq),
    eventType: 'exam_human_review_started',
    ...HUMAN_REVIEW_PLAN,
    ...overrides,
  };
}

function humanReviewCompleted(
  seq: number,
  overrides: Partial<ExamHumanReviewCompletedEvent> = {},
): ExamHumanReviewCompletedEvent {
  return {
    ...base(seq),
    eventType: 'exam_human_review_completed',
    ...HUMAN_REVIEW_PLAN,
    artifactByteLength: 224,
    artifactSha256: '7'.repeat(64),
    confirmedQuestionCount: 3,
    confirmedResponseCount: 3,
    confirmedMatchCount: 3,
    rejectedQuestionCount: 2,
    rejectedResponseCount: 2,
    ...overrides,
  };
}

function answerKeyStarted(
  seq: number,
  overrides: Partial<ExamAnswerKeyStartedEvent> = {},
): ExamAnswerKeyStartedEvent {
  return {
    ...base(seq),
    eventType: 'exam_answer_key_started',
    ...ANSWER_KEY_PLAN,
    ...overrides,
  };
}

function answerKeyConfirmed(
  seq: number,
  overrides: Partial<ExamAnswerKeyConfirmedEvent> = {},
): ExamAnswerKeyConfirmedEvent {
  return {
    ...base(seq),
    eventType: 'exam_answer_key_confirmed',
    ...ANSWER_KEY_PLAN,
    artifactByteLength: 256,
    artifactSha256: '9'.repeat(64),
    entryCount: 3,
    objectiveEntryCount: 2,
    unassessedEntryCount: 1,
    ...overrides,
  };
}

function gradingStarted(
  seq: number,
  overrides: Partial<ExamGradingStartedEvent> = {},
): ExamGradingStartedEvent {
  return {
    ...base(seq),
    eventType: 'exam_grading_started',
    ...GRADING_PLAN,
    ...overrides,
  };
}

function gradingCompleted(
  seq: number,
  overrides: Partial<ExamGradingCompletedEvent> = {},
): ExamGradingCompletedEvent {
  return {
    ...base(seq),
    eventType: 'exam_grading_completed',
    ...GRADING_PLAN,
    artifactByteLength: 192,
    artifactSha256: 'a'.repeat(64),
    assessmentCount: 3,
    evaluatedCount: 2,
    correctCount: 1,
    incorrectCount: 1,
    unassessedCount: 1,
    ...overrides,
  };
}

function knowledgeSuggestionsStarted(
  seq: number,
  overrides: Partial<ExamKnowledgeSuggestionsStartedEvent> = {},
): ExamKnowledgeSuggestionsStartedEvent {
  return {
    ...base(seq),
    eventType: 'exam_knowledge_suggestions_started',
    ...KNOWLEDGE_SUGGESTIONS_PLAN,
    ...overrides,
  };
}

function knowledgeSuggestionsCompleted(
  seq: number,
  overrides: Partial<ExamKnowledgeSuggestionsCompletedEvent> = {},
): ExamKnowledgeSuggestionsCompletedEvent {
  return {
    ...base(seq),
    eventType: 'exam_knowledge_suggestions_completed',
    ...KNOWLEDGE_SUGGESTIONS_PLAN,
    artifactByteLength: 320,
    artifactSha256: '8'.repeat(64),
    questionCount: 3,
    generatedQuestionCount: 2,
    noSuggestionQuestionCount: 1,
    inputTooLargeQuestionCount: 0,
    suggestionCount: 3,
    ...overrides,
  };
}

function errorSuggestionsStarted(
  seq: number,
  overrides: Partial<ExamErrorSuggestionsStartedEvent> = {},
): ExamErrorSuggestionsStartedEvent {
  return {
    ...base(seq),
    eventType: 'exam_error_suggestions_started',
    ...ERROR_SUGGESTIONS_PLAN,
    ...overrides,
  };
}

function errorSuggestionsCompleted(
  seq: number,
  overrides: Partial<ExamErrorSuggestionsCompletedEvent> = {},
): ExamErrorSuggestionsCompletedEvent {
  return {
    ...base(seq),
    eventType: 'exam_error_suggestions_completed',
    ...ERROR_SUGGESTIONS_PLAN,
    artifactByteLength: 384,
    artifactSha256: 'c'.repeat(64),
    eligibleQuestionCount: 1,
    candidateQuestionCount: 1,
    noSuggestionQuestionCount: 0,
    inputTooLargeQuestionCount: 0,
    suggestionCount: 2,
    deterministicSuggestionCount: 1,
    modelSuggestionCount: 1,
    ...overrides,
  };
}

function knowledgeMappingStarted(
  seq: number,
  overrides: Partial<ExamKnowledgeMappingStartedEvent> = {},
): ExamKnowledgeMappingStartedEvent {
  return {
    ...base(seq),
    eventType: 'exam_knowledge_mapping_started',
    ...KNOWLEDGE_MAPPING_PLAN,
    ...overrides,
  };
}

function knowledgeMappingConfirmed(
  seq: number,
  overrides: Partial<ExamKnowledgeMappingConfirmedEvent> = {},
): ExamKnowledgeMappingConfirmedEvent {
  return {
    ...base(seq),
    eventType: 'exam_knowledge_mapping_confirmed',
    ...KNOWLEDGE_MAPPING_PLAN,
    artifactByteLength: 160,
    artifactSha256: 'd'.repeat(64),
    entryCount: 3,
    mappedQuestionCount: 2,
    unmappedQuestionCount: 1,
    ...overrides,
  };
}

function observationProjectionStarted(
  seq: number,
  overrides: Partial<ExamObservationProjectionStartedEvent> = {},
): ExamObservationProjectionStartedEvent {
  return {
    ...base(seq),
    eventType: 'exam_observation_projection_started',
    ...OBSERVATION_PROJECTION_PLAN,
    ...overrides,
  };
}

function observationsProjected(
  seq: number,
  overrides: Partial<ExamObservationsProjectedEvent> = {},
): ExamObservationsProjectedEvent {
  return {
    ...base(seq),
    eventType: 'exam_observations_projected',
    ...OBSERVATION_PROJECTION_PLAN,
    artifactByteLength: 192,
    artifactSha256: 'f'.repeat(64),
    observationCount: 2,
    evaluatedCount: 1,
    correctCount: 0,
    incorrectCount: 1,
    unassessedCount: 1,
    ...overrides,
  };
}

function deleteRequested(seq: number): ExamEvent {
  return {
    ...base(seq),
    eventType: 'exam_delete_requested',
    documentSetFingerprint: DOCUMENT_SET_FP,
  };
}

function deleted(seq: number, deleteRequestEventId: string): ExamEvent {
  return {
    ...base(seq),
    eventType: 'exam_deleted',
    documentSetFingerprint: DOCUMENT_SET_FP,
    deleteRequestEventId,
  };
}

function records(
  events: readonly ExamEvent[],
  sessionId = 'zhongkao-exam:fixture',
): RuntimeRecord[] {
  return events.map((event, seq) => ({
    id: event.eventId,
    sessionId,
    seq,
    subAnchor: event.eventId,
    createdAt: event.createdAt,
    payload: event,
  }));
}

function readyEvents(): ExamEvent[] {
  return [created(), snapshotted(1, 0), snapshotted(2, 1), snapshotted(3, 2), completed(4)];
}

function extractionEvents(): ExamEvent[] {
  return [
    ...readyEvents(),
    extractionStarted(5),
    documentExtracted(6),
    segmentationStarted(7),
    candidatesExtracted(8),
  ];
}

function responseEvents(): ExamEvent[] {
  return [
    ...extractionEvents(),
    responseCaptureStarted(9),
    responseCandidatesRecorded(10),
    responseMatchingCompleted(11),
  ];
}

function reviewEvents(): ExamEvent[] {
  return [...responseEvents(), humanReviewStarted(12), humanReviewCompleted(13)];
}

function answerKeyEvents(): ExamEvent[] {
  return [...reviewEvents(), answerKeyStarted(14), answerKeyConfirmed(15)];
}

function gradingEvents(): ExamEvent[] {
  return [...answerKeyEvents(), gradingStarted(16), gradingCompleted(17)];
}

function knowledgeSuggestionEvents(startSeq = 14): ExamEvent[] {
  return [
    ...reviewEvents(),
    knowledgeSuggestionsStarted(startSeq),
    knowledgeSuggestionsCompleted(startSeq + 1),
  ];
}

function errorSuggestionEvents(startSeq = 18): ExamEvent[] {
  return [
    ...gradingEvents(),
    errorSuggestionsStarted(startSeq),
    errorSuggestionsCompleted(startSeq + 1),
  ];
}

function mappingEvents(): ExamEvent[] {
  return [...gradingEvents(), knowledgeMappingStarted(18), knowledgeMappingConfirmed(19)];
}

function observationEvents(): ExamEvent[] {
  return [...mappingEvents(), observationProjectionStarted(20), observationsProjected(21)];
}

describe('Exam event fold', () => {
  it('starts as intake_pending with immutable private declarations', () => {
    const state = foldExamEvents(records([created()]));
    expect(state).toMatchObject({
      schemaVersion: 1,
      examSessionId: EXAM_ID,
      profileId: 'student-alpha',
      subjectId: 'math',
      status: 'intake_pending',
      revision: 0,
      requestFingerprint: 'c'.repeat(64),
      documentSetFingerprint: DOCUMENT_SET_FP,
    });
    expect(state.documents[0]).toMatchObject({
      ownerMaterialId: `mat_${'0'.repeat(26)}`,
      sourceSha256: 'd'.repeat(64),
    });
  });

  it('becomes ready only after every declared snapshot', () => {
    const state = foldExamEvents(records(readyEvents()));
    expect(state.status).toBe('ready_for_extraction');
    expect(state.revision).toBe(4);
    expect(state.documents.every((document) => document.snapshot !== undefined)).toBe(true);
    expect(state.intakeCompletedEventId).toBe('exam-event-4');
  });

  it('folds the event-first document and candidate artifact plans in strict order', () => {
    const state = foldExamEvents(records(extractionEvents()));
    expect(state.status).toBe('ready_for_extraction');
    expect(state.questionExtraction).toEqual({
      status: 'question_candidates_ready',
      startedEventId: 'exam-event-5',
      startedAt: extractionStarted(5).createdAt,
      extractionVersion: 1,
      examDocumentId: 'exam-document-question',
      sourceSnapshotFingerprint: 'd'.repeat(64),
      extractorId: 'unpdf',
      extractorVersion: 'exam-pdf-text:v1',
      normalizationVersion: 'exam-document-normalization:v1',
      documentArtifactRef: 'exam-document-artifact-v1',
      documentArtifact: {
        eventId: 'exam-event-6',
        createdAt: documentExtracted(6).createdAt,
        byteLength: 512,
        sha256: '1'.repeat(64),
        pageCount: 2,
      },
      segmentation: {
        startedEventId: 'exam-event-7',
        startedAt: segmentationStarted(7).createdAt,
        segmentationVersion: 1,
        sourceArtifactFingerprint: '1'.repeat(64),
        candidateArtifactRef: 'exam-question-candidates-v1',
        candidateArtifact: {
          eventId: 'exam-event-8',
          createdAt: candidatesExtracted(8).createdAt,
          byteLength: 384,
          sha256: '2'.repeat(64),
          candidateCount: 5,
          needsReview: true,
        },
      },
    });
  });

  it('folds response capture, candidate recording and deterministic matching in strict order', () => {
    const state = foldExamEvents(records(responseEvents()));
    expect(state.studentResponseCapture).toEqual({
      status: 'matching_ready',
      startedEventId: 'exam-event-9',
      startedAt: responseCaptureStarted(9).createdAt,
      ...RESPONSE_PLAN,
      responseArtifact: {
        eventId: 'exam-event-10',
        createdAt: responseCandidatesRecorded(10).createdAt,
        byteLength: 256,
        sha256: '4'.repeat(64),
        responseCount: 5,
      },
      matchingArtifact: {
        eventId: 'exam-event-11',
        createdAt: responseMatchingCompleted(11).createdAt,
        byteLength: 192,
        sha256: '5'.repeat(64),
        responseCount: 5,
        matchedCount: 3,
        ambiguousCount: 1,
        unmatchedCount: 1,
        needsReview: true,
      },
    });
  });

  it('folds human review from confirming to confirmed with immutable summary facts', () => {
    const confirming = foldExamEvents(records([...responseEvents(), humanReviewStarted(12)]));
    expect(confirming.humanReview).toEqual({
      status: 'confirming',
      startedEventId: 'exam-event-12',
      startedAt: humanReviewStarted(12).createdAt,
      ...HUMAN_REVIEW_PLAN,
    });

    const confirmed = foldExamEvents(records(reviewEvents()));
    expect(confirmed.humanReview).toEqual({
      status: 'confirmed',
      startedEventId: 'exam-event-12',
      startedAt: humanReviewStarted(12).createdAt,
      ...HUMAN_REVIEW_PLAN,
      reviewArtifact: {
        eventId: 'exam-event-13',
        createdAt: humanReviewCompleted(13).createdAt,
        byteLength: 224,
        sha256: '7'.repeat(64),
        confirmedQuestionCount: 3,
        confirmedResponseCount: 3,
        confirmedMatchCount: 3,
        rejectedQuestionCount: 2,
        rejectedResponseCount: 2,
      },
    });
  });

  it('folds answer-key confirmation and deterministic grading with immutable counts', () => {
    const confirming = foldExamEvents(records([...reviewEvents(), answerKeyStarted(14)]));
    expect(confirming.answerKey).toEqual({
      status: 'confirming',
      startedEventId: 'exam-event-14',
      startedAt: answerKeyStarted(14).createdAt,
      ...ANSWER_KEY_PLAN,
    });

    const keyed = foldExamEvents(records(answerKeyEvents()));
    expect(keyed.answerKey).toEqual({
      status: 'confirmed',
      startedEventId: 'exam-event-14',
      startedAt: answerKeyStarted(14).createdAt,
      ...ANSWER_KEY_PLAN,
      answerKeyArtifact: {
        eventId: 'exam-event-15',
        createdAt: answerKeyConfirmed(15).createdAt,
        byteLength: 256,
        sha256: '9'.repeat(64),
        entryCount: 3,
        objectiveEntryCount: 2,
        unassessedEntryCount: 1,
      },
    });

    const grading = foldExamEvents(records([...answerKeyEvents(), gradingStarted(16)]));
    expect(grading.grading).toEqual({
      status: 'grading',
      startedEventId: 'exam-event-16',
      startedAt: gradingStarted(16).createdAt,
      ...GRADING_PLAN,
    });

    const completed = foldExamEvents(records(gradingEvents()));
    expect(completed.grading).toEqual({
      status: 'completed',
      startedEventId: 'exam-event-16',
      startedAt: gradingStarted(16).createdAt,
      ...GRADING_PLAN,
      assessmentArtifact: {
        eventId: 'exam-event-17',
        createdAt: gradingCompleted(17).createdAt,
        byteLength: 192,
        sha256: 'a'.repeat(64),
        assessmentCount: 3,
        evaluatedCount: 2,
        correctCount: 1,
        incorrectCount: 1,
        unassessedCount: 1,
      },
    });
  });

  it('folds review-only knowledge suggestions with immutable source and count facts', () => {
    const generating = foldExamEvents(
      records([...reviewEvents(), knowledgeSuggestionsStarted(14)]),
    );
    expect(generating.knowledgeSuggestions).toEqual({
      status: 'generating',
      startedEventId: 'exam-event-14',
      startedAt: knowledgeSuggestionsStarted(14).createdAt,
      ...KNOWLEDGE_SUGGESTIONS_PLAN,
    });

    const completed = foldExamEvents(records(knowledgeSuggestionEvents()));
    expect(completed.knowledgeSuggestions).toEqual({
      status: 'completed',
      startedEventId: 'exam-event-14',
      startedAt: knowledgeSuggestionsStarted(14).createdAt,
      ...KNOWLEDGE_SUGGESTIONS_PLAN,
      suggestionArtifact: {
        eventId: 'exam-event-15',
        createdAt: knowledgeSuggestionsCompleted(15).createdAt,
        byteLength: 320,
        sha256: '8'.repeat(64),
        questionCount: 3,
        generatedQuestionCount: 2,
        noSuggestionQuestionCount: 1,
        inputTooLargeQuestionCount: 0,
        suggestionCount: 3,
      },
    });
  });

  it('requires confirmed review and an exact immutable knowledge-suggestion plan', () => {
    expect(() =>
      foldExamEvents(records([...responseEvents(), knowledgeSuggestionsStarted(12)])),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([...reviewEvents(), knowledgeSuggestionsStarted(14, { subjectId: 'physics' })]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...reviewEvents(),
          knowledgeSuggestionsStarted(14, {
            sourceReviewArtifactFingerprint: '0'.repeat(64),
          }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...reviewEvents(),
          knowledgeSuggestionsStarted(14),
          knowledgeSuggestionsStarted(15),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(records([...reviewEvents(), knowledgeSuggestionsCompleted(14)])),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...reviewEvents(),
          knowledgeSuggestionsStarted(14),
          knowledgeSuggestionsCompleted(15, { candidatePoolFingerprint: '9'.repeat(64) }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...reviewEvents(),
          knowledgeSuggestionsStarted(14),
          knowledgeSuggestionsCompleted(15, {
            generatedQuestionCount: 1,
            noSuggestionQuestionCount: 1,
          }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('lets manual authority supersede an unfinished suggestion generation', () => {
    const superseded = foldExamEvents(
      records([...gradingEvents(), knowledgeSuggestionsStarted(18), knowledgeMappingStarted(19)]),
    );
    expect(superseded.knowledgeSuggestions?.status).toBe('superseded');
    expect(superseded.knowledgeMapping?.status).toBe('mapping');
    expect(toPublicExamSession(superseded).knowledgeSuggestions).toEqual({
      status: 'superseded',
    });

    expect(() =>
      foldExamEvents(
        records([
          ...gradingEvents(),
          knowledgeSuggestionsStarted(18),
          knowledgeMappingStarted(19),
          knowledgeSuggestionsCompleted(20),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');

    const state = foldExamEvents(
      records([
        ...gradingEvents(),
        knowledgeSuggestionsStarted(18),
        knowledgeSuggestionsCompleted(19),
        knowledgeMappingStarted(20),
      ]),
    );
    expect(state.knowledgeSuggestions?.status).toBe('completed');
    expect(state.knowledgeMapping?.status).toBe('mapping');
  });

  it('folds source-bound error suggestions without creating diagnosis authority', () => {
    const generating = foldExamEvents(records([...gradingEvents(), errorSuggestionsStarted(18)]));
    expect(generating.errorSuggestions).toEqual({
      status: 'generating',
      startedEventId: 'exam-event-18',
      startedAt: errorSuggestionsStarted(18).createdAt,
      ...ERROR_SUGGESTIONS_PLAN,
    });

    const completed = foldExamEvents(records(errorSuggestionEvents()));
    expect(completed.errorSuggestions).toEqual({
      status: 'completed',
      startedEventId: 'exam-event-18',
      startedAt: errorSuggestionsStarted(18).createdAt,
      ...ERROR_SUGGESTIONS_PLAN,
      suggestionArtifact: {
        eventId: 'exam-event-19',
        createdAt: errorSuggestionsCompleted(19).createdAt,
        byteLength: 384,
        sha256: 'c'.repeat(64),
        eligibleQuestionCount: 1,
        candidateQuestionCount: 1,
        noSuggestionQuestionCount: 0,
        inputTooLargeQuestionCount: 0,
        suggestionCount: 2,
        deterministicSuggestionCount: 1,
        modelSuggestionCount: 1,
      },
    });
    expect(completed).not.toHaveProperty('confirmedErrorDiagnosis');
    expect(completed).not.toHaveProperty('authoritativeErrorType');
  });

  it('requires completed grading and exact immutable error-suggestion sources and counts', () => {
    expect(() =>
      foldExamEvents(records([...answerKeyEvents(), errorSuggestionsStarted(16)])),
    ).toThrow('EXAM_EVENT_CONFLICT');
    for (const invalid of [
      { subjectId: 'physics' },
      { sourceReviewArtifactFingerprint: '0'.repeat(64) },
      { sourceAnswerKeyArtifactFingerprint: '0'.repeat(64) },
      { sourceAnswerKeySemanticFingerprint: '0'.repeat(64) },
      { gradingRef: 'other-grading-ref' },
      { sourceAssessmentArtifactFingerprint: '0'.repeat(64) },
    ]) {
      expect(() =>
        foldExamEvents(records([...gradingEvents(), errorSuggestionsStarted(18, invalid)])),
      ).toThrow('EXAM_EVENT_CONFLICT');
    }
    expect(() =>
      foldExamEvents(
        records([
          ...gradingEvents(),
          errorSuggestionsStarted(18),
          errorSuggestionsCompleted(19, { eligibleQuestionCount: 2 }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...gradingEvents(),
          errorSuggestionsStarted(18),
          errorSuggestionsCompleted(19, {
            deterministicSuggestionCount: 2,
            modelSuggestionCount: 1,
          }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('keeps error suggestions independent from knowledge mapping and observation ordering', () => {
    const errorFirst = foldExamEvents(
      records([...errorSuggestionEvents(), knowledgeMappingStarted(20)]),
    );
    expect(errorFirst.errorSuggestions?.status).toBe('completed');
    expect(errorFirst.knowledgeMapping?.status).toBe('mapping');

    const mappingFirst = foldExamEvents(
      records([...mappingEvents(), errorSuggestionsStarted(20), errorSuggestionsCompleted(21)]),
    );
    expect(mappingFirst.knowledgeMapping?.status).toBe('confirmed');
    expect(mappingFirst.errorSuggestions?.status).toBe('completed');
  });

  it('folds confirmed knowledge mapping and source-bound observation projection', () => {
    const mapping = foldExamEvents(records(mappingEvents()));
    expect(mapping.knowledgeMapping).toEqual({
      status: 'confirmed',
      startedEventId: 'exam-event-18',
      startedAt: knowledgeMappingStarted(18).createdAt,
      ...KNOWLEDGE_MAPPING_PLAN,
      mappingArtifact: {
        eventId: 'exam-event-19',
        createdAt: knowledgeMappingConfirmed(19).createdAt,
        byteLength: 160,
        sha256: 'd'.repeat(64),
        entryCount: 3,
        mappedQuestionCount: 2,
        unmappedQuestionCount: 1,
      },
    });

    const projected = foldExamEvents(records(observationEvents()));
    expect(projected.observationProjection).toEqual({
      status: 'completed',
      startedEventId: 'exam-event-20',
      startedAt: observationProjectionStarted(20).createdAt,
      ...OBSERVATION_PROJECTION_PLAN,
      observationArtifact: {
        eventId: 'exam-event-21',
        createdAt: observationsProjected(21).createdAt,
        byteLength: 192,
        sha256: 'f'.repeat(64),
        observationCount: 2,
        evaluatedCount: 1,
        correctCount: 0,
        incorrectCount: 1,
        unassessedCount: 1,
      },
    });
  });

  it('requires completed grading, exact source lineage, and complete mapping/projection counts', () => {
    expect(() =>
      foldExamEvents(records([...answerKeyEvents(), knowledgeMappingStarted(16)])),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...gradingEvents(),
          knowledgeMappingStarted(18, {
            sourceAssessmentArtifactFingerprint: '0'.repeat(64),
          }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...gradingEvents(),
          knowledgeMappingStarted(18),
          knowledgeMappingConfirmed(19, {
            entryCount: 2,
            mappedQuestionCount: 1,
            unmappedQuestionCount: 1,
          }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([...gradingEvents(), knowledgeMappingStarted(18, { assessmentVersion: 2 })]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...mappingEvents(),
          observationProjectionStarted(20, {
            sourceMappingSemanticFingerprint: '0'.repeat(64),
          }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([...mappingEvents(), observationProjectionStarted(20, { assessmentVersion: 2 })]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...mappingEvents(),
          observationProjectionStarted(20),
          observationsProjected(21, { observationCount: 1, unassessedCount: 0 }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('requires confirmed review authority and exact full-set answer-key coverage', () => {
    expect(() => foldExamEvents(records([...responseEvents(), answerKeyStarted(12)]))).toThrow(
      'EXAM_EVENT_CONFLICT',
    );
    expect(() =>
      foldExamEvents(
        records([
          ...reviewEvents(),
          answerKeyStarted(14, { sourceReviewArtifactFingerprint: '0'.repeat(64) }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() => foldExamEvents(records([...reviewEvents(), answerKeyConfirmed(14)]))).toThrow(
      'EXAM_EVENT_CONFLICT',
    );
    expect(() =>
      foldExamEvents(
        records([
          ...reviewEvents(),
          answerKeyStarted(14),
          answerKeyConfirmed(15, {
            entryCount: 2,
            objectiveEntryCount: 1,
            unassessedEntryCount: 1,
          }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('requires a verified key lineage and complete assessment partition', () => {
    expect(() => foldExamEvents(records([...reviewEvents(), gradingStarted(14)]))).toThrow(
      'EXAM_EVENT_CONFLICT',
    );
    expect(() =>
      foldExamEvents(
        records([
          ...answerKeyEvents(),
          {
            ...gradingStarted(16),
            gradingAlgorithmVersion: 'exam-objective-grading:v2',
          } as unknown as ExamEvent,
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...answerKeyEvents(),
          gradingStarted(16, { sourceAnswerKeyArtifactFingerprint: '0'.repeat(64) }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() => foldExamEvents(records([...answerKeyEvents(), gradingCompleted(16)]))).toThrow(
      'EXAM_EVENT_CONFLICT',
    );
    expect(() =>
      foldExamEvents(
        records([
          ...answerKeyEvents(),
          gradingStarted(16),
          gradingCompleted(17, {
            evaluatedCount: 1,
            correctCount: 1,
            incorrectCount: 0,
            unassessedCount: 2,
          }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('requires matching-ready sources and exact human-review plan bindings', () => {
    expect(() => foldExamEvents(records([...extractionEvents(), humanReviewStarted(9)]))).toThrow(
      'EXAM_EVENT_CONFLICT',
    );
    expect(() =>
      foldExamEvents(
        records([...responseEvents(), humanReviewStarted(12, { questionExtractionVersion: 2 })]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...responseEvents(),
          humanReviewStarted(12, { sourceResponseArtifactFingerprint: '9'.repeat(64) }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...responseEvents(),
          humanReviewStarted(12, { matchingArtifactRef: 'another-matching-ref' }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...responseEvents(),
          humanReviewStarted(12),
          humanReviewCompleted(13, {
            confirmedQuestionCount: 2,
            confirmedResponseCount: 2,
            confirmedMatchCount: 2,
          }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...responseEvents(),
          humanReviewStarted(12),
          humanReviewCompleted(13, { rejectedResponseCount: 1 }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('rejects review stage skips, plan drift, restarts and invalid source-relative counts', () => {
    expect(() => foldExamEvents(records([...responseEvents(), humanReviewCompleted(12)]))).toThrow(
      'EXAM_EVENT_CONFLICT',
    );
    expect(() =>
      foldExamEvents(
        records([
          ...responseEvents(),
          humanReviewStarted(12),
          humanReviewCompleted(13, { decisionSemanticFingerprint: '9'.repeat(64) }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...responseEvents(),
          humanReviewStarted(12),
          { ...humanReviewStarted(13), operationId: 'exam-operation-review-restart' },
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...responseEvents(),
          humanReviewStarted(12),
          humanReviewCompleted(13, { confirmedResponseCount: 2 }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...responseEvents(),
          humanReviewStarted(12),
          humanReviewCompleted(13, { rejectedQuestionCount: 6 }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('requires ready question candidates before response capture and preserves exact source binding', () => {
    expect(() => foldExamEvents(records([...readyEvents(), responseCaptureStarted(5)]))).toThrow(
      'EXAM_EVENT_CONFLICT',
    );
    expect(() =>
      foldExamEvents(
        records([
          ...extractionEvents(),
          responseCaptureStarted(9, {
            sourceQuestionCandidateFingerprint: '9'.repeat(64),
          }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([...extractionEvents(), responseCaptureStarted(9, { segmentationVersion: 2 })]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('rejects response stage skips, plan drift, duplicate starts and mismatched match counts', () => {
    expect(() =>
      foldExamEvents(records([...extractionEvents(), responseCandidatesRecorded(9)])),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([...extractionEvents(), responseCaptureStarted(9), responseMatchingCompleted(10)]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...extractionEvents(),
          responseCaptureStarted(9),
          responseCandidatesRecorded(10, { inputSemanticFingerprint: '9'.repeat(64) }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...extractionEvents(),
          responseCaptureStarted(9),
          { ...responseCaptureStarted(10), operationId: 'exam-operation-response-restart' },
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...extractionEvents(),
          responseCaptureStarted(9),
          responseCandidatesRecorded(10),
          responseMatchingCompleted(11, { matchedCount: 4 }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('rejects extraction before intake, for a non-question document, or out of order', () => {
    expect(() => foldExamEvents(records([created(), extractionStarted(1)]))).toThrow(
      'EXAM_EVENT_CONFLICT',
    );
    expect(() =>
      foldExamEvents(
        records([
          ...readyEvents(),
          extractionStarted(5, {
            examDocumentId: 'exam-document-response',
            sourceSnapshotFingerprint: 'e'.repeat(64),
          }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() => foldExamEvents(records([...readyEvents(), documentExtracted(5)]))).toThrow(
      'EXAM_EVENT_CONFLICT',
    );
    expect(() =>
      foldExamEvents(records([...readyEvents(), extractionStarted(5), segmentationStarted(6)])),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('rejects changed plan facts, restarts and mismatched artifact lineage', () => {
    expect(() =>
      foldExamEvents(
        records([
          ...readyEvents(),
          extractionStarted(5),
          documentExtracted(6, { extractorVersion: 'changed:v2' }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...readyEvents(),
          extractionStarted(5),
          { ...extractionStarted(6), operationId: 'exam-operation-restart' },
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...readyEvents(),
          extractionStarted(5),
          documentExtracted(6),
          segmentationStarted(7, { sourceArtifactFingerprint: '9'.repeat(64) }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(
        records([
          ...readyEvents(),
          extractionStarted(5),
          documentExtracted(6),
          segmentationStarted(7),
          candidatesExtracted(8, { candidateArtifactRef: 'another-ref' }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('requires exam_created as the first event', () => {
    expect(() => foldExamEvents(records([snapshotted(0, 0)]))).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('requires contiguous ordered sequence numbers', () => {
    const history = records([created(), snapshotted(1, 0)]);
    history[1] = { ...history[1]!, seq: 2 };
    expect(() => foldExamEvents(history)).toThrow('EXAM_EVENT_CONFLICT');
    expect(() => foldExamEvents(history.toReversed())).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('rejects duplicate event and operation identities', () => {
    const duplicateEvent = snapshotted(2, 1, { eventId: 'exam-event-1' });
    expect(() => foldExamEvents(records([created(), snapshotted(1, 0), duplicateEvent]))).toThrow(
      'EXAM_EVENT_CONFLICT',
    );

    const duplicateOperation = snapshotted(2, 1, { operationId: 'exam-operation-1' });
    expect(() =>
      foldExamEvents(records([created(), snapshotted(1, 0), duplicateOperation])),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('rejects mixed runtime, exam and profile partitions', () => {
    const runtimeMix = records([created(), snapshotted(1, 0)]);
    runtimeMix[1] = { ...runtimeMix[1]!, sessionId: 'other-runtime' };
    expect(() => foldExamEvents(runtimeMix)).toThrow('EXAM_EVENT_CONFLICT');

    expect(() =>
      foldExamEvents(
        records([created(), snapshotted(1, 0, { examSessionId: `exam:v1:${'9'.repeat(64)}` })]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(records([created(), snapshotted(1, 0, { profileId: 'student-beta' })])),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('rejects a snapshot for an undeclared document', () => {
    expect(() =>
      foldExamEvents(
        records([created(), snapshotted(1, 0, { examDocumentId: 'exam-document-undeclared' })]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('rejects snapshot digest and length mismatches', () => {
    expect(() =>
      foldExamEvents(records([created(), snapshotted(1, 0, { snapshotSha256: '0'.repeat(64) })])),
    ).toThrow('EXAM_EVENT_CONFLICT');
    expect(() =>
      foldExamEvents(records([created(), snapshotted(1, 0, { byteLength: 13 })])),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('accepts an identical duplicate snapshot fact and rejects a conflicting duplicate', () => {
    const duplicate = snapshotted(2, 0);
    const state = foldExamEvents(records([created(), snapshotted(1, 0), duplicate]));
    expect(state.documents[0]?.snapshot?.eventId).toBe('exam-event-1');
    expect(state.revision).toBe(2);

    expect(() =>
      foldExamEvents(
        records([
          created(),
          snapshotted(1, 0),
          snapshotted(2, 0, { snapshotSha256: '0'.repeat(64) }),
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('rejects intake completion before all snapshots or with another document set', () => {
    expect(() => foldExamEvents(records([created(), snapshotted(1, 0), completed(2)]))).toThrow(
      'EXAM_EVENT_CONFLICT',
    );
    expect(() =>
      foldExamEvents(
        records([
          ...readyEvents().slice(0, -1),
          { ...completed(4), documentSetFingerprint: '0'.repeat(64) },
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('supports deletion from pending and ready states', () => {
    const pendingDelete = deleteRequested(1);
    expect(foldExamEvents(records([created(), pendingDelete])).status).toBe('deleting');

    const readyDelete = deleteRequested(5);
    expect(foldExamEvents(records([...readyEvents(), readyDelete])).status).toBe('deleting');
  });

  it.each([1, 2, 3, 4] as const)('supports deletion after extraction stage %s', (stage) => {
    const history = extractionEvents().slice(0, readyEvents().length + stage);
    const request = deleteRequested(history.length);
    const state = foldExamEvents(records([...history, request]));
    expect(state.status).toBe('deleting');
    expect(state.questionExtraction).toBeDefined();
  });

  it('supports deletion while human review is confirming and after it is confirmed', () => {
    const confirmingHistory = [...responseEvents(), humanReviewStarted(12)];
    expect(foldExamEvents(records([...confirmingHistory, deleteRequested(13)])).status).toBe(
      'deleting',
    );
    expect(foldExamEvents(records([...reviewEvents(), deleteRequested(14)])).status).toBe(
      'deleting',
    );
  });

  it('supports deletion during partial and completed key/grading stages', () => {
    for (const history of [
      [...reviewEvents(), answerKeyStarted(14)],
      answerKeyEvents(),
      [...answerKeyEvents(), gradingStarted(16)],
      gradingEvents(),
    ]) {
      expect(foldExamEvents(records([...history, deleteRequested(history.length)])).status).toBe(
        'deleting',
      );
    }
  });

  it('supports deletion during partial and completed mapping/projection stages', () => {
    for (const history of [
      [...gradingEvents(), knowledgeMappingStarted(18)],
      mappingEvents(),
      [...mappingEvents(), observationProjectionStarted(20)],
      observationEvents(),
    ]) {
      expect(foldExamEvents(records([...history, deleteRequested(history.length)])).status).toBe(
        'deleting',
      );
    }
  });

  it('supports deletion during partial and completed suggestion generation', () => {
    for (const history of [
      [...reviewEvents(), knowledgeSuggestionsStarted(14)],
      knowledgeSuggestionEvents(),
    ]) {
      const state = foldExamEvents(records([...history, deleteRequested(history.length)]));
      expect(state.status).toBe('deleting');
      expect(state.knowledgeSuggestions).toBeDefined();
    }
  });

  it('requires the exact delete request before the deleted terminal', () => {
    const request = deleteRequested(1);
    expect(foldExamEvents(records([created(), request, deleted(2, request.eventId)])).status).toBe(
      'deleted',
    );
    expect(() =>
      foldExamEvents(records([created(), request, deleted(2, 'another-delete-request')])),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it('rejects every event after deleted', () => {
    const request = deleteRequested(1);
    expect(() =>
      foldExamEvents(
        records([
          created(),
          request,
          deleted(2, request.eventId),
          { ...deleteRequested(3), operationId: 'exam-operation-after-delete' },
        ]),
      ),
    ).toThrow('EXAM_EVENT_CONFLICT');
  });

  it.each(['id', 'subAnchor', 'createdAt'] as const)(
    'rejects a record envelope whose %s does not bind its event',
    (field) => {
      const history = records([created()]);
      history[0] = { ...history[0]!, [field]: 'mismatch' };
      expect(() => foldExamEvents(history)).toThrow('EXAM_EVENT_CONFLICT');
    },
  );

  it('rejects snapshots after ready and another created event', () => {
    expect(() => foldExamEvents(records([...readyEvents(), snapshotted(5, 0)]))).toThrow(
      'EXAM_EVENT_CONFLICT',
    );
    expect(() => foldExamEvents(records([created(), { ...created(), ...base(1) }]))).toThrow(
      'EXAM_EVENT_CONFLICT',
    );
  });
});

describe('public Exam projection', () => {
  it('omits every private locator, digest, owner and operation field', () => {
    const publicExam = toPublicExamSession(foldExamEvents(records(readyEvents())));
    expect(publicExam).toMatchObject({
      schemaVersion: 1,
      examSessionId: EXAM_ID,
      profileId: 'student-alpha',
      subjectId: 'math',
      status: 'ready_for_extraction',
    });
    expect(publicExam.documents[0]).toMatchObject({
      examDocumentId: 'exam-document-question',
      role: 'question_paper',
      mimeType: 'application/pdf',
      byteLength: 12,
      snapshotStatus: 'snapshotted',
    });
    const serialized = JSON.stringify(publicExam);
    expect(serialized).not.toMatch(
      /sourceSha256|snapshotSha256|ownerMaterialId|objectKey|learnerKey|runtime|eventId|operation|requestFingerprint|documentSetFingerprint/u,
    );
  });

  it('does not promote answer_key role to semantic authority', () => {
    const publicExam = toPublicExamSession(foldExamEvents(records(readyEvents())));
    const answerKey = publicExam.documents.find((document) => document.role === 'answer_key');
    expect(answerKey).toEqual({
      examDocumentId: 'exam-document-key',
      role: 'answer_key',
      mimeType: 'text/plain',
      byteLength: 6,
      snapshotStatus: 'snapshotted',
    });
    expect(JSON.stringify(answerKey)).not.toMatch(
      /authoritative|verified|gradingSpec|correctAnswer|expectedAnswer/u,
    );
  });

  it('exposes only a safe extraction summary for pending, in-progress and ready states', () => {
    expect(toPublicExamSession(foldExamEvents(records(readyEvents()))).questionExtraction).toEqual({
      status: 'not_started',
    });
    expect(
      toPublicExamSession(
        foldExamEvents(records([...readyEvents(), extractionStarted(5), documentExtracted(6)])),
      ).questionExtraction,
    ).toEqual({ status: 'extracting_questions', pageCount: 2 });

    const summary = toPublicExamSession(foldExamEvents(records(extractionEvents())));
    expect(summary.questionExtraction).toEqual({
      status: 'question_candidates_ready',
      pageCount: 2,
      candidateCount: 5,
      needsReview: true,
    });
    expect(JSON.stringify(summary.questionExtraction)).not.toMatch(
      /artifact|digest|sha256|fingerprint|event|operation|ref|objectKey|path/u,
    );
  });

  it('exposes only response stage counts and always requires human review', () => {
    expect(
      toPublicExamSession(foldExamEvents(records(extractionEvents()))).studentResponseMatching,
    ).toEqual({ status: 'not_started', needsReview: true });
    expect(
      toPublicExamSession(
        foldExamEvents(records([...extractionEvents(), responseCaptureStarted(9)])),
      ).studentResponseMatching,
    ).toEqual({ status: 'capturing', needsReview: true });
    expect(
      toPublicExamSession(
        foldExamEvents(
          records([
            ...extractionEvents(),
            responseCaptureStarted(9),
            responseCandidatesRecorded(10),
          ]),
        ),
      ).studentResponseMatching,
    ).toEqual({ status: 'capturing', responseCount: 5, needsReview: true });

    const summary = toPublicExamSession(
      foldExamEvents(records(responseEvents())),
    ).studentResponseMatching;
    expect(summary).toEqual({
      status: 'matching_ready',
      responseCount: 5,
      matchedCount: 3,
      ambiguousCount: 1,
      unmatchedCount: 1,
      needsReview: true,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /answer|artifact|digest|sha256|fingerprint|event|operation|ref|objectKey|path/u,
    );
  });

  it('exposes only the safe human-review status and confirmed count summary', () => {
    expect(toPublicExamSession(foldExamEvents(records(responseEvents()))).humanReview).toEqual({
      status: 'not_started',
    });
    expect(
      toPublicExamSession(foldExamEvents(records([...responseEvents(), humanReviewStarted(12)])))
        .humanReview,
    ).toEqual({ status: 'confirming' });

    const summary = toPublicExamSession(foldExamEvents(records(reviewEvents()))).humanReview;
    expect(summary).toEqual({
      status: 'confirmed',
      confirmedQuestionCount: 3,
      confirmedResponseCount: 3,
      confirmedMatchCount: 3,
      rejectedQuestionCount: 2,
      rejectedResponseCount: 2,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /answer|artifact|digest|sha256|fingerprint|event|operation|ref|objectKey|path|decision/u,
    );
  });

  it('exposes only grading lifecycle and aggregate outcome counts', () => {
    expect(toPublicExamSession(foldExamEvents(records(reviewEvents()))).grading).toEqual({
      status: 'not_started',
    });
    expect(
      toPublicExamSession(foldExamEvents(records([...reviewEvents(), answerKeyStarted(14)])))
        .grading,
    ).toEqual({ status: 'processing' });
    expect(
      toPublicExamSession(foldExamEvents(records([...answerKeyEvents(), gradingStarted(16)])))
        .grading,
    ).toEqual({ status: 'processing' });

    const summary = toPublicExamSession(foldExamEvents(records(gradingEvents()))).grading;
    expect(summary).toEqual({
      status: 'completed',
      assessmentCount: 3,
      evaluatedCount: 2,
      correctCount: 1,
      incorrectCount: 1,
      unassessedCount: 1,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /answer|artifact|digest|sha256|fingerprint|event|operation|ref|objectKey|path|gradingSpec/u,
    );
  });

  it('exposes only aggregate knowledge-suggestion lifecycle facts', () => {
    expect(
      toPublicExamSession(foldExamEvents(records(reviewEvents()))).knowledgeSuggestions,
    ).toEqual({ status: 'not_started' });
    expect(
      toPublicExamSession(
        foldExamEvents(records([...reviewEvents(), knowledgeSuggestionsStarted(14)])),
      ).knowledgeSuggestions,
    ).toEqual({ status: 'processing' });

    const summary = toPublicExamSession(
      foldExamEvents(records(knowledgeSuggestionEvents())),
    ).knowledgeSuggestions;
    expect(summary).toEqual({
      status: 'completed',
      questionCount: 3,
      generatedQuestionCount: 2,
      noSuggestionQuestionCount: 1,
      inputTooLargeQuestionCount: 0,
      suggestionCount: 3,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /knowledgePoint|questionText|suggestions|artifact|digest|sha256|fingerprint|event|operation|ref|objectKey|path/u,
    );
  });

  it('exposes only aggregate error-suggestion lifecycle facts', () => {
    expect(toPublicExamSession(foldExamEvents(records(gradingEvents()))).errorSuggestions).toEqual({
      status: 'not_started',
    });
    expect(
      toPublicExamSession(
        foldExamEvents(records([...gradingEvents(), errorSuggestionsStarted(18)])),
      ).errorSuggestions,
    ).toEqual({ status: 'processing' });

    const summary = toPublicExamSession(
      foldExamEvents(records(errorSuggestionEvents())),
    ).errorSuggestions;
    expect(summary).toEqual({
      status: 'completed',
      questionCount: 1,
      suggestionCount: 2,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /questionText|response|answer|expected|candidate|evidence|artifact|digest|sha256|fingerprint|event|operation|ref|objectKey|path/u,
    );
  });

  it('exposes only safe knowledge-mapping and observation aggregate summaries', () => {
    const before = toPublicExamSession(foldExamEvents(records(gradingEvents())));
    expect(before.knowledgeMapping).toEqual({ status: 'not_started' });
    expect(before.observationProjection).toEqual({ status: 'not_started' });

    const mapping = toPublicExamSession(
      foldExamEvents(records([...gradingEvents(), knowledgeMappingStarted(18)])),
    );
    expect(mapping.knowledgeMapping).toEqual({ status: 'processing' });

    const mapped = toPublicExamSession(foldExamEvents(records(mappingEvents())));
    expect(mapped.knowledgeMapping).toEqual({
      status: 'confirmed',
      mappedQuestionCount: 2,
      unmappedQuestionCount: 1,
    });
    expect(mapped.observationProjection).toEqual({ status: 'not_started' });

    const projecting = toPublicExamSession(
      foldExamEvents(records([...mappingEvents(), observationProjectionStarted(20)])),
    );
    expect(projecting.observationProjection).toEqual({ status: 'processing' });

    const projected = toPublicExamSession(foldExamEvents(records(observationEvents())));
    expect(projected.observationProjection).toEqual({
      status: 'completed',
      observationCount: 2,
    });
    expect(
      JSON.stringify({
        knowledgeMapping: projected.knowledgeMapping,
        observationProjection: projected.observationProjection,
      }),
    ).not.toMatch(
      /knowledgePoint|assessment|artifact|digest|sha256|fingerprint|event|operation|ref|objectKey|path/u,
    );
  });

  it('does not return a deleted Exam', () => {
    const request = deleteRequested(1);
    const state = foldExamEvents(records([created(), request, deleted(2, request.eventId)]));
    expect(() => toPublicExamSession(state)).toThrowError(new ExamError('EXAM_NOT_FOUND'));
  });
});
