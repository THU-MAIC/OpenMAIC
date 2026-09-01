import type { RuntimeRecord } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';

import { ExamError } from '@/lib/zhongkao/exam-errors';
import type {
  ExamCreatedEvent,
  ExamDocumentArtifactExtractedEvent,
  ExamDocumentSnapshottedEvent,
  ExamEvent,
  ExamIntakeCompletedEvent,
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

  it('does not return a deleted Exam', () => {
    const request = deleteRequested(1);
    const state = foldExamEvents(records([created(), request, deleted(2, request.eventId)]));
    expect(() => toPublicExamSession(state)).toThrowError(new ExamError('EXAM_NOT_FOUND'));
  });
});
