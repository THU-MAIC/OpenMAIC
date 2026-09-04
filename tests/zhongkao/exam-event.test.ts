import { describe, expect, it } from 'vitest';

import {
  EXAM_MAX_ANSWER_KEY_ARTIFACT_BYTES,
  EXAM_MAX_ASSESSMENT_ARTIFACT_BYTES,
  EXAM_MAX_CANDIDATE_ARTIFACT_BYTES,
  EXAM_MAX_DOCUMENT_BYTES,
  EXAM_MAX_DOCUMENT_ARTIFACT_BYTES,
  EXAM_MAX_ERROR_SUGGESTION_ARTIFACT_BYTES,
  EXAM_MAX_EXTRACTED_PAGES,
  EXAM_MAX_HUMAN_REVIEW_ARTIFACT_BYTES,
  EXAM_MAX_KNOWLEDGE_SUGGESTION_ARTIFACT_BYTES,
  EXAM_MAX_KNOWLEDGE_SUGGESTIONS_PER_QUESTION,
  EXAM_MAX_MATCH_ARTIFACT_BYTES,
  EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
  EXAM_MAX_QUESTION_CANDIDATES,
  EXAM_MAX_RESPONSE_ARTIFACT_BYTES,
  EXAM_MAX_TOTAL_BYTES,
} from '@/lib/zhongkao/exam';
import {
  EXAM_EVENT_TYPES,
  assertExamEvent,
  validateExamEvent,
  type ExamCreatedEvent,
  type ExamEvent,
} from '@/lib/zhongkao/exam-event';

const NOW = '2026-08-31T08:00:00.000Z';
const EXAM_ID = `exam:v1:${'a'.repeat(64)}`;
const PROFILE_ID = 'student-alpha';
const REQUEST_FP = 'b'.repeat(64);
const DOCUMENT_SET_FP = 'c'.repeat(64);
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
  reviewVersion: 1,
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

function created(overrides: Partial<ExamCreatedEvent> = {}): ExamCreatedEvent {
  return {
    schemaVersion: 1,
    eventId: 'exam-event-created',
    examSessionId: EXAM_ID,
    profileId: PROFILE_ID,
    eventType: 'exam_created',
    createdAt: NOW,
    operationId: 'exam-operation-created',
    operationFingerprint: fingerprint(1),
    subjectId: 'math',
    title: 'Fictional exam',
    requestFingerprint: REQUEST_FP,
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

function event(eventType: ExamEvent['eventType']): ExamEvent {
  const base = {
    schemaVersion: 1 as const,
    eventId: `exam-event-${eventType}`,
    examSessionId: EXAM_ID,
    profileId: PROFILE_ID,
    createdAt: NOW,
    operationId: `exam-operation-${eventType}`,
    operationFingerprint: fingerprint(eventType.length),
  };
  switch (eventType) {
    case 'exam_created':
      return created();
    case 'exam_document_snapshotted':
      return {
        ...base,
        eventType,
        examDocumentId: 'exam-document-question',
        snapshotSha256: 'd'.repeat(64),
        byteLength: 12,
      };
    case 'exam_intake_completed':
      return { ...base, eventType, documentSetFingerprint: DOCUMENT_SET_FP };
    case 'exam_question_extraction_started':
      return {
        ...base,
        eventType,
        extractionVersion: 1,
        examDocumentId: 'exam-document-question',
        sourceSnapshotFingerprint: 'd'.repeat(64),
        extractorId: 'unpdf',
        extractorVersion: 'exam-pdf-text:v1',
        normalizationVersion: 'exam-document-normalization:v1',
        documentArtifactRef: 'exam-document-artifact-v1',
      };
    case 'exam_document_artifact_extracted':
      return {
        ...base,
        eventType,
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
      };
    case 'exam_question_segmentation_started':
      return {
        ...base,
        eventType,
        extractionVersion: 1,
        segmentationVersion: 1,
        examDocumentId: 'exam-document-question',
        sourceArtifactFingerprint: '1'.repeat(64),
        documentArtifactRef: 'exam-document-artifact-v1',
        candidateArtifactRef: 'exam-question-candidates-v1',
      };
    case 'exam_question_candidates_extracted':
      return {
        ...base,
        eventType,
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
      };
    case 'exam_student_response_capture_started':
      return { ...base, eventType, ...RESPONSE_PLAN };
    case 'exam_response_candidates_recorded':
      return {
        ...base,
        eventType,
        ...RESPONSE_PLAN,
        artifactByteLength: 256,
        artifactSha256: '4'.repeat(64),
        responseCount: 5,
      };
    case 'exam_response_matching_completed':
      return {
        ...base,
        eventType,
        ...RESPONSE_PLAN,
        responseArtifactFingerprint: '4'.repeat(64),
        artifactByteLength: 192,
        artifactSha256: '5'.repeat(64),
        responseCount: 5,
        matchedCount: 3,
        ambiguousCount: 1,
        unmatchedCount: 1,
        needsReview: true,
      };
    case 'exam_human_review_started':
      return { ...base, eventType, ...HUMAN_REVIEW_PLAN };
    case 'exam_human_review_completed':
      return {
        ...base,
        eventType,
        ...HUMAN_REVIEW_PLAN,
        artifactByteLength: 224,
        artifactSha256: '7'.repeat(64),
        confirmedQuestionCount: 3,
        confirmedResponseCount: 3,
        confirmedMatchCount: 3,
        rejectedQuestionCount: 2,
        rejectedResponseCount: 2,
      };
    case 'exam_answer_key_started':
      return { ...base, eventType, ...ANSWER_KEY_PLAN };
    case 'exam_answer_key_confirmed':
      return {
        ...base,
        eventType,
        ...ANSWER_KEY_PLAN,
        artifactByteLength: 256,
        artifactSha256: '9'.repeat(64),
        entryCount: 3,
        objectiveEntryCount: 2,
        unassessedEntryCount: 1,
      };
    case 'exam_grading_started':
      return { ...base, eventType, ...GRADING_PLAN };
    case 'exam_grading_completed':
      return {
        ...base,
        eventType,
        ...GRADING_PLAN,
        artifactByteLength: 192,
        artifactSha256: 'a'.repeat(64),
        assessmentCount: 3,
        evaluatedCount: 2,
        correctCount: 1,
        incorrectCount: 1,
        unassessedCount: 1,
      };
    case 'exam_knowledge_suggestions_started':
      return { ...base, eventType, ...KNOWLEDGE_SUGGESTIONS_PLAN };
    case 'exam_knowledge_suggestions_completed':
      return {
        ...base,
        eventType,
        ...KNOWLEDGE_SUGGESTIONS_PLAN,
        artifactByteLength: 320,
        artifactSha256: '8'.repeat(64),
        questionCount: 3,
        generatedQuestionCount: 2,
        noSuggestionQuestionCount: 1,
        inputTooLargeQuestionCount: 0,
        suggestionCount: 3,
      };
    case 'exam_error_suggestions_started':
      return { ...base, eventType, ...ERROR_SUGGESTIONS_PLAN };
    case 'exam_error_suggestions_completed':
      return {
        ...base,
        eventType,
        ...ERROR_SUGGESTIONS_PLAN,
        artifactByteLength: 384,
        artifactSha256: 'c'.repeat(64),
        eligibleQuestionCount: 3,
        candidateQuestionCount: 2,
        noSuggestionQuestionCount: 1,
        inputTooLargeQuestionCount: 0,
        suggestionCount: 3,
        deterministicSuggestionCount: 2,
        modelSuggestionCount: 1,
      };
    case 'exam_knowledge_mapping_started':
      return { ...base, eventType, ...KNOWLEDGE_MAPPING_PLAN };
    case 'exam_knowledge_mapping_confirmed':
      return {
        ...base,
        eventType,
        ...KNOWLEDGE_MAPPING_PLAN,
        artifactByteLength: 160,
        artifactSha256: 'd'.repeat(64),
        entryCount: 3,
        mappedQuestionCount: 2,
        unmappedQuestionCount: 1,
      };
    case 'exam_observation_projection_started':
      return { ...base, eventType, ...OBSERVATION_PROJECTION_PLAN };
    case 'exam_observations_projected':
      return {
        ...base,
        eventType,
        ...OBSERVATION_PROJECTION_PLAN,
        artifactByteLength: 192,
        artifactSha256: 'f'.repeat(64),
        observationCount: 2,
        evaluatedCount: 1,
        correctCount: 0,
        incorrectCount: 1,
        unassessedCount: 1,
      };
    case 'exam_delete_requested':
      return { ...base, eventType, documentSetFingerprint: DOCUMENT_SET_FP };
    case 'exam_deleted':
      return {
        ...base,
        eventType,
        documentSetFingerprint: DOCUMENT_SET_FP,
        deleteRequestEventId: 'exam-event-delete-requested',
      };
  }
}

describe('Exam event schema', () => {
  it.each(EXAM_EVENT_TYPES)('accepts the closed %s event', (eventType) => {
    expect(validateExamEvent(event(eventType))).toEqual({ valid: true });
    expect(() => assertExamEvent(event(eventType))).not.toThrow();
  });

  it('rejects unknown common and event-specific fields', () => {
    expect(validateExamEvent({ ...created(), learnerKey: 'private' }).valid).toBe(false);
    expect(validateExamEvent({ ...event('exam_intake_completed'), ready: true }).valid).toBe(false);
    expect(
      validateExamEvent({ ...event('exam_question_candidates_extracted'), objectKey: 'private' })
        .valid,
    ).toBe(false);
  });

  it('requires canonical role order and unique roles', () => {
    expect(
      validateExamEvent({ ...created(), documents: created().documents.toReversed() }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...created(),
        documents: [created().documents[0], created().documents[0]],
      }).valid,
    ).toBe(false);
  });

  it('requires a question paper and at most three documents', () => {
    expect(validateExamEvent({ ...created(), documents: [created().documents[1]] }).valid).toBe(
      false,
    );
    expect(
      validateExamEvent({
        ...created(),
        documents: [...created().documents, { ...created().documents[2], role: 'answer_key' }],
      }).valid,
    ).toBe(false);
  });

  it('validates authoritative digest, MIME and byte facts', () => {
    const document = created().documents[0]!;
    expect(
      validateExamEvent({
        ...created(),
        documents: [{ ...document, sourceSha256: 'NOT-A-DIGEST' }],
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...created(),
        documents: [{ ...document, mimeType: 'application/octet-stream' }],
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...created(),
        documents: [{ ...document, byteLength: EXAM_MAX_DOCUMENT_BYTES + 1 }],
      }).valid,
    ).toBe(false);
  });

  it('enforces the aggregate 50 MiB intake cap', () => {
    const first = created().documents[0]!;
    const second = created().documents[1]!;
    expect(
      validateExamEvent({
        ...created(),
        documents: [
          { ...first, byteLength: EXAM_MAX_TOTAL_BYTES },
          { ...second, byteLength: 1 },
        ],
      }).valid,
    ).toBe(false);
  });

  it('rejects malformed private identities and fingerprints', () => {
    expect(validateExamEvent({ ...created(), requestFingerprint: 'short' }).valid).toBe(false);
    expect(validateExamEvent({ ...created(), operationFingerprint: 'A'.repeat(64) }).valid).toBe(
      false,
    );
    expect(validateExamEvent({ ...created(), examSessionId: '' }).valid).toBe(false);
  });

  it('keeps answer_key as a role fact, not grading authority', () => {
    const answerKey = created().documents[2]!;
    expect(
      validateExamEvent({
        ...created(),
        documents: [
          created().documents[0],
          { ...answerKey, authoritative: true, gradingSpec: { correct: 'A' } },
        ],
      }).valid,
    ).toBe(false);
    expect(JSON.stringify(answerKey)).not.toMatch(
      /authoritative|verified|gradingSpec|correctAnswer/u,
    );
  });

  it('bounds display metadata and rejects control characters', () => {
    const document = created().documents[0]!;
    expect(validateExamEvent({ ...created(), title: ' unsafe ' }).valid).toBe(false);
    expect(
      validateExamEvent({
        ...created(),
        documents: [{ ...document, displayName: 'unsafe\nname.pdf' }],
      }).valid,
    ).toBe(false);
  });

  it('validates snapshot integrity facts independently', () => {
    expect(
      validateExamEvent({ ...event('exam_document_snapshotted'), snapshotSha256: 'bad' }).valid,
    ).toBe(false);
    expect(validateExamEvent({ ...event('exam_document_snapshotted'), byteLength: 0 }).valid).toBe(
      false,
    );
  });

  it('validates extraction identities, integrity facts and bounded counts', () => {
    expect(
      validateExamEvent({ ...event('exam_question_extraction_started'), extractionVersion: 0 })
        .valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_document_artifact_extracted'),
        sourceSnapshotFingerprint: 'bad',
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_document_artifact_extracted'),
        artifactByteLength: EXAM_MAX_DOCUMENT_ARTIFACT_BYTES + 1,
        pageCount: EXAM_MAX_EXTRACTED_PAGES + 1,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_question_segmentation_started'),
        candidateArtifactRef: '',
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_question_candidates_extracted'),
        artifactByteLength: EXAM_MAX_CANDIDATE_ARTIFACT_BYTES + 1,
        candidateCount: EXAM_MAX_QUESTION_CANDIDATES + 1,
        needsReview: 'yes',
      }).valid,
    ).toBe(false);
  });

  it('validates closed response capture plans, bounded artifacts and exact summary counts', () => {
    expect(
      validateExamEvent({
        ...event('exam_student_response_capture_started'),
        responseArtifactRef: RESPONSE_PLAN.captureRef,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_response_candidates_recorded'),
        artifactByteLength: EXAM_MAX_RESPONSE_ARTIFACT_BYTES + 1,
        responseCount: EXAM_MAX_QUESTION_CANDIDATES + 1,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_response_matching_completed'),
        artifactByteLength: EXAM_MAX_MATCH_ARTIFACT_BYTES + 1,
        matchedCount: 4,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_response_matching_completed'),
        needsReview: false,
      }).valid,
    ).toBe(false);
  });

  it('keeps raw answers and storage locators out of every response Runtime event', () => {
    expect(
      validateExamEvent({
        ...event('exam_response_candidates_recorded'),
        rawAnswerText: 'PRIVATE-STUDENT-ANSWER',
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_response_matching_completed'),
        objectKey: 'materials/private/student_response_candidates_v1.json',
      }).valid,
    ).toBe(false);
  });

  it('validates closed human-review plans, artifact bounds and count projections', () => {
    expect(
      validateExamEvent({ ...event('exam_human_review_started'), reviewVersion: 0 }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_human_review_started'),
        sourceMatchingArtifactFingerprint: 'bad',
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_human_review_started'),
        reviewArtifactRef: HUMAN_REVIEW_PLAN.matchingArtifactRef,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_human_review_completed'),
        artifactByteLength: EXAM_MAX_HUMAN_REVIEW_ARTIFACT_BYTES + 1,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_human_review_completed'),
        confirmedMatchCount: 2,
      }).valid,
    ).toBe(false);
  });

  it('keeps raw review decisions, answers and storage locators out of review events', () => {
    expect(
      validateExamEvent({
        ...event('exam_human_review_started'),
        decisions: [{ responseText: 'PRIVATE-STUDENT-ANSWER' }],
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_human_review_completed'),
        objectKey: 'materials/private/confirmed_review_facts_v1.json',
      }).valid,
    ).toBe(false);
  });

  it('validates closed answer-key plans, private artifact bounds and complete key counts', () => {
    expect(
      validateExamEvent({ ...event('exam_answer_key_started'), answerKeyVersion: 0 }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_answer_key_started'),
        sourceReviewArtifactFingerprint: 'bad',
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_answer_key_started'),
        answerKeyArtifactRef: ANSWER_KEY_PLAN.answerKeyRef,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_answer_key_confirmed'),
        artifactByteLength: EXAM_MAX_ANSWER_KEY_ARTIFACT_BYTES + 1,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_answer_key_confirmed'),
        objectiveEntryCount: 1,
      }).valid,
    ).toBe(false);
  });

  it('validates grading lineage, artifact bounds and complete outcome counts', () => {
    expect(validateExamEvent({ ...event('exam_grading_started'), gradingVersion: 0 }).valid).toBe(
      false,
    );
    expect(
      validateExamEvent({
        ...event('exam_grading_started'),
        gradingAlgorithmVersion: 'exam-objective-grading:v2',
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_grading_started'),
        sourceAnswerKeyArtifactFingerprint: 'bad',
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_grading_started'),
        assessmentArtifactRef: GRADING_PLAN.gradingRef,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_grading_completed'),
        artifactByteLength: EXAM_MAX_ASSESSMENT_ARTIFACT_BYTES + 1,
      }).valid,
    ).toBe(false);
    expect(validateExamEvent({ ...event('exam_grading_completed'), correctCount: 2 }).valid).toBe(
      false,
    );
    expect(
      validateExamEvent({ ...event('exam_grading_completed'), unassessedCount: 0 }).valid,
    ).toBe(false);
  });

  it('keeps expected answers, responses, outcomes and storage locators out of grading events', () => {
    for (const privateField of [
      { expectedOptionId: 'A' },
      { acceptedAnswers: ['PRIVATE-ANSWER'] },
      { rawAnswerText: 'PRIVATE-STUDENT-ANSWER' },
      { outcome: 'correct' },
      { objectKey: 'materials/private/authoritative_answer_key_v1.json' },
    ]) {
      expect(validateExamEvent({ ...event('exam_grading_completed'), ...privateField }).valid).toBe(
        false,
      );
    }
  });

  it('validates closed knowledge-suggestion plans, artifact bounds and complete counts', () => {
    for (const invalid of [
      { subjectId: '' },
      { generatorVersion: '' },
      { candidateSchemaVersion: 0 },
      { sourceReviewSemanticFingerprint: 'bad' },
      { candidatePoolMode: 'all_taxonomy_ids' },
      { candidatePoolFingerprint: 'bad' },
      { suggestionArtifactRef: KNOWLEDGE_SUGGESTIONS_PLAN.generationRef },
    ]) {
      expect(
        validateExamEvent({ ...event('exam_knowledge_suggestions_started'), ...invalid }).valid,
      ).toBe(false);
    }
    expect(
      validateExamEvent({
        ...event('exam_knowledge_suggestions_completed'),
        artifactByteLength: EXAM_MAX_KNOWLEDGE_SUGGESTION_ARTIFACT_BYTES + 1,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_knowledge_suggestions_completed'),
        generatedQuestionCount: 1,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_knowledge_suggestions_completed'),
        generatedQuestionCount: 0,
        noSuggestionQuestionCount: 3,
        suggestionCount: 1,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_knowledge_suggestions_completed'),
        generatedQuestionCount: 3,
        noSuggestionQuestionCount: 0,
        suggestionCount: 2,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_knowledge_suggestions_completed'),
        generatedQuestionCount: 1,
        noSuggestionQuestionCount: 2,
        suggestionCount: EXAM_MAX_KNOWLEDGE_SUGGESTIONS_PER_QUESTION + 1,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_knowledge_suggestions_completed'),
        suggestionCount:
          EXAM_MAX_QUESTION_CANDIDATES * EXAM_MAX_KNOWLEDGE_SUGGESTIONS_PER_QUESTION + 1,
      }).valid,
    ).toBe(false);
  });

  it('keeps question text, candidate details and storage locators out of suggestion events', () => {
    for (const privateField of [
      { questionText: 'PRIVATE QUESTION' },
      { knowledgePointIds: ['private-kp'] },
      { proposedLabel: 'private label' },
      { evidencePhrases: ['private evidence'] },
      { suggestions: [{ proposedLabel: 'private label' }] },
      { objectKey: 'materials/private/exam_knowledge_suggestions_v1.json' },
      { outcome: 'incorrect' },
    ]) {
      expect(
        validateExamEvent({
          ...event('exam_knowledge_suggestions_completed'),
          ...privateField,
        }).valid,
      ).toBe(false);
    }
  });

  it('validates source-bound error-suggestion plans and exact aggregate counts', () => {
    for (const invalid of [
      { detectorVersion: '' },
      { modelPolicyVersion: '' },
      { sourceAnswerKeySemanticFingerprint: 'bad' },
      { sourceAssessmentSemanticFingerprint: 'bad' },
      { gradingAlgorithmVersion: 'exam-objective-grading:v2' },
      { suggestionArtifactRef: ERROR_SUGGESTIONS_PLAN.generationRef },
    ]) {
      expect(
        validateExamEvent({ ...event('exam_error_suggestions_started'), ...invalid }).valid,
      ).toBe(false);
    }
    for (const invalid of [
      { artifactByteLength: EXAM_MAX_ERROR_SUGGESTION_ARTIFACT_BYTES + 1 },
      { candidateQuestionCount: 1 },
      { suggestionCount: 2 },
      { deterministicSuggestionCount: 3, modelSuggestionCount: 1 },
      {
        candidateQuestionCount: 1,
        noSuggestionQuestionCount: 2,
        suggestionCount: EXAM_MAX_KNOWLEDGE_SUGGESTIONS_PER_QUESTION + 1,
        deterministicSuggestionCount: EXAM_MAX_KNOWLEDGE_SUGGESTIONS_PER_QUESTION + 1,
        modelSuggestionCount: 0,
      },
    ]) {
      expect(
        validateExamEvent({ ...event('exam_error_suggestions_completed'), ...invalid }).valid,
      ).toBe(false);
    }
  });

  it('keeps error candidate content, responses and grading facts out of Runtime events', () => {
    for (const privateField of [
      { questionText: 'PRIVATE QUESTION' },
      { rawAnswerText: 'PRIVATE STUDENT RESPONSE' },
      { expectedValue: 'PRIVATE EXPECTED ANSWER' },
      { acceptedAnswers: ['PRIVATE EXPECTED ANSWER'] },
      { candidates: [{ kind: 'sign_error_candidate' }] },
      { evidence: [{ type: 'numeric_difference', differenceKind: 'sign_mismatch' }] },
      { objectKey: 'materials/private/exam_error_diagnosis_candidates_v1.json' },
    ]) {
      expect(
        validateExamEvent({
          ...event('exam_error_suggestions_completed'),
          ...privateField,
        }).valid,
      ).toBe(false);
    }
  });

  it('validates closed mapping and observation source chains with exact aggregate counts', () => {
    expect(
      validateExamEvent({
        ...event('exam_knowledge_mapping_started'),
        sourceAssessmentSemanticFingerprint: 'bad',
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_knowledge_mapping_confirmed'),
        mappedQuestionCount: 1,
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_observation_projection_started'),
        sourceMappingSemanticFingerprint: 'bad',
      }).valid,
    ).toBe(false);
    expect(
      validateExamEvent({
        ...event('exam_observations_projected'),
        correctCount: 1,
      }).valid,
    ).toBe(false);
  });

  it('keeps mappings, outcomes, observations and storage locators out of Runtime events', () => {
    for (const privateField of [
      { entries: [{ confirmedQuestionId: 'q-1', knowledgePointIds: ['private-kp'] }] },
      { observations: [{ outcome: 'incorrect' }] },
      { outcome: 'incorrect' },
      { objectKey: 'materials/private/confirmed_exam_observations_v1.json' },
    ]) {
      expect(
        validateExamEvent({ ...event('exam_observations_projected'), ...privateField }).valid,
      ).toBe(false);
    }
  });
});
