import type { RuntimeRecord } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';

import { ExamError } from '@/lib/zhongkao/exam-errors';
import type {
  ExamCreatedEvent,
  ExamDocumentSnapshottedEvent,
  ExamEvent,
  ExamIntakeCompletedEvent,
} from '@/lib/zhongkao/exam-event';
import { foldExamEvents, toPublicExamSession } from '@/lib/zhongkao/exam-state';

const NOW = '2026-08-31T08:00:00.000Z';
const EXAM_ID = `exam:v1:${'a'.repeat(64)}`;
const DOCUMENT_SET_FP = 'b'.repeat(64);

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

  it('does not return a deleted Exam', () => {
    const request = deleteRequested(1);
    const state = foldExamEvents(records([created(), request, deleted(2, request.eventId)]));
    expect(() => toPublicExamSession(state)).toThrowError(new ExamError('EXAM_NOT_FOUND'));
  });
});
