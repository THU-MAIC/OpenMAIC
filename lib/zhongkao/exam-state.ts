import type { RuntimeRecord } from '@openmaic/dsl';

import { EXAM_SCHEMA_VERSION, type PublicExamSession, type PublicExamStatus } from './exam';
import { ExamError } from './exam-errors';
import { assertExamEvent, type ExamCreatedDocument, type ExamEvent } from './exam-event';

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
  };
}
