import { describe, expect, it } from 'vitest';

import {
  EXAM_MAX_CANDIDATE_ARTIFACT_BYTES,
  EXAM_MAX_DOCUMENT_BYTES,
  EXAM_MAX_DOCUMENT_ARTIFACT_BYTES,
  EXAM_MAX_EXTRACTED_PAGES,
  EXAM_MAX_QUESTION_CANDIDATES,
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
});
