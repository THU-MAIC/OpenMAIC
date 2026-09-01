import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import {
  BrowserRuntimeStore,
  RuntimeAppendConflictError,
  type RuntimeStore,
} from '@openmaic/storage';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  appendExamRuntimeEvent,
  createExamDocumentSetFingerprint,
  createExamOperationFingerprint,
  createExamRequestFingerprint,
  deriveExamCandidateArtifactRef,
  deriveExamCreatedOperationId,
  deriveExamDocumentArtifactExtractedOperationId,
  deriveExamDocumentArtifactRef,
  deriveExamDocumentId,
  deriveExamEventId,
  deriveExamIntakeCompletedOperationId,
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
  loadExamRuntime,
} from '@/lib/server/zhongkao/exam-runtime';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import type {
  ExamCreatedDocument,
  ExamCreatedEvent,
  ExamDocumentArtifactExtractedEvent,
  ExamDocumentSnapshottedEvent,
  ExamIntakeCompletedEvent,
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

function store(): RuntimeStore {
  return new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `exam-runtime-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
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
