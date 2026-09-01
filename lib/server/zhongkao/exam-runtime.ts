import { createHash } from 'node:crypto';

import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import { RuntimeAppendConflictError, type RuntimeStore } from '@openmaic/storage';

import { EXAM_DOCUMENT_SCHEMA_VERSION, EXAM_SCHEMA_VERSION } from '@/lib/zhongkao/exam';
import { ExamError } from '@/lib/zhongkao/exam-errors';
import { assertExamEvent, type ExamCreatedEvent, type ExamEvent } from '@/lib/zhongkao/exam-event';
import { foldExamEvents, type ExamSessionState } from '@/lib/zhongkao/exam-state';
import { ZHONGKAO_RUNTIME_KINDS } from '@/lib/zhongkao/runtime-kinds';
import { zhongkaoStageId } from '@/lib/zhongkao/runtime';

import { resolveZhongkaoLearnerKeyFromOwnerId } from './learner-identity';

const EXAM_ID_VERSION = 1 as const;

export interface ExamRuntimeDeps {
  store: RuntimeStore;
  ownerId: string;
}

export interface ExamRuntimeSnapshot {
  session: RuntimeSession;
  records: RuntimeRecord[];
  state: ExamSessionState;
}

export interface ExamRuntimeWriteResult {
  snapshot: ExamRuntimeSnapshot;
  replayed: boolean;
  eventAppended: boolean;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

export function deriveExamSessionId(input: {
  learnerKey: string;
  profileId: string;
  clientRequestId: string;
}): string {
  return `exam:v${EXAM_ID_VERSION}:${digest('openmaic:zhongkao-exam-session:v1', {
    schemaVersion: EXAM_SCHEMA_VERSION,
    ...input,
  })}`;
}

export function deriveExamDocumentId(examSessionId: string, role: string): string {
  return `exam-document:v${EXAM_ID_VERSION}:${digest('openmaic:zhongkao-exam-document:v1', {
    schemaVersion: EXAM_DOCUMENT_SCHEMA_VERSION,
    examSessionId,
    role,
  })}`;
}

export function deriveExamDocumentArtifactRef(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
): string {
  return `exam-document-artifact:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-exam-document-artifact:v1',
    { examSessionId, examDocumentId, extractionVersion },
  )}`;
}

export function deriveExamCandidateArtifactRef(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
  segmentationVersion: number,
): string {
  return `exam-question-candidates:v${EXAM_ID_VERSION}:${digest(
    'openmaic:zhongkao-exam-question-candidates:v1',
    { examSessionId, examDocumentId, extractionVersion, segmentationVersion },
  )}`;
}

export function examRuntimeSessionId(examSessionId: string): string {
  return `zhongkao-exam:${encodeURIComponent(examSessionId)}`;
}

export function createExamRequestFingerprint(facts: unknown): string {
  return digest('openmaic:zhongkao-exam-request-fingerprint:v1', facts);
}

export function createExamDocumentSetFingerprint(facts: unknown): string {
  return digest('openmaic:zhongkao-exam-document-set-fingerprint:v1', facts);
}

export function createExamOperationFingerprint(facts: unknown): string {
  return digest('openmaic:zhongkao-exam-operation-fingerprint:v1', facts);
}

function operationId(action: string, facts: unknown): string {
  return `exam-op:v${EXAM_ID_VERSION}:${digest(
    `openmaic:zhongkao-exam-operation:${action}:v1`,
    facts,
  )}`;
}

export function deriveExamCreatedOperationId(examSessionId: string): string {
  return operationId('created', { schemaVersion: EXAM_SCHEMA_VERSION, examSessionId });
}

export function deriveExamSnapshotOperationId(
  examSessionId: string,
  examDocumentId: string,
): string {
  return operationId('snapshot', {
    schemaVersion: EXAM_DOCUMENT_SCHEMA_VERSION,
    examSessionId,
    examDocumentId,
  });
}

export function deriveExamIntakeCompletedOperationId(
  examSessionId: string,
  documentSetFingerprint: string,
): string {
  return operationId('intake-completed', {
    schemaVersion: EXAM_SCHEMA_VERSION,
    examSessionId,
    documentSetFingerprint,
  });
}

export function deriveExamQuestionExtractionStartedOperationId(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
): string {
  return operationId('question-extraction-started', {
    examSessionId,
    examDocumentId,
    extractionVersion,
  });
}

export function deriveExamDocumentArtifactExtractedOperationId(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
): string {
  return operationId('document-artifact-extracted', {
    examSessionId,
    examDocumentId,
    extractionVersion,
  });
}

export function deriveExamQuestionSegmentationStartedOperationId(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
  segmentationVersion: number,
): string {
  return operationId('question-segmentation-started', {
    examSessionId,
    examDocumentId,
    extractionVersion,
    segmentationVersion,
  });
}

export function deriveExamQuestionCandidatesExtractedOperationId(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
  segmentationVersion: number,
): string {
  return operationId('question-candidates-extracted', {
    examSessionId,
    examDocumentId,
    extractionVersion,
    segmentationVersion,
  });
}

export function deriveExamDeleteRequestedOperationId(examSessionId: string): string {
  return operationId('delete-requested', { schemaVersion: EXAM_SCHEMA_VERSION, examSessionId });
}

export function deriveExamDeletedOperationId(examSessionId: string): string {
  return operationId('deleted', { schemaVersion: EXAM_SCHEMA_VERSION, examSessionId });
}

export function deriveExamEventId(operation: string): string {
  return `exam-event:v${EXAM_ID_VERSION}:${digest('openmaic:zhongkao-exam-event:v1', operation)}`;
}

function eventFromRecord(record: RuntimeRecord): ExamEvent {
  assertExamEvent(record.payload);
  assertDerivedExamEvent(record.payload);
  return record.payload;
}

function assertDerivedExamEvent(event: ExamEvent): void {
  if (event.eventId !== deriveExamEventId(event.operationId)) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }

  let expectedOperationId: string;
  let expectedOperationFingerprint: string;
  switch (event.eventType) {
    case 'exam_created': {
      if (
        event.documents.some(
          (document) =>
            document.examDocumentId !== deriveExamDocumentId(event.examSessionId, document.role),
        )
      ) {
        throw new ExamError('EXAM_EVENT_CONFLICT');
      }
      const requestFingerprint = createExamRequestFingerprint({
        schemaVersion: EXAM_SCHEMA_VERSION,
        profileId: event.profileId,
        subjectId: event.subjectId,
        ...(event.title === undefined ? {} : { title: event.title }),
        documents: event.documents.map(({ role, ownerMaterialId }) => ({
          role,
          ownerMaterialId,
        })),
      });
      const documentSetFingerprint = createExamDocumentSetFingerprint(event.documents);
      if (
        event.requestFingerprint !== requestFingerprint ||
        event.documentSetFingerprint !== documentSetFingerprint
      ) {
        throw new ExamError('EXAM_EVENT_CONFLICT');
      }
      expectedOperationId = deriveExamCreatedOperationId(event.examSessionId);
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_created',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        subjectId: event.subjectId,
        title: event.title,
        requestFingerprint,
        documentSetFingerprint,
        documents: event.documents,
      });
      break;
    }
    case 'exam_document_snapshotted':
      expectedOperationId = deriveExamSnapshotOperationId(
        event.examSessionId,
        event.examDocumentId,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_document_snapshotted',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        examDocumentId: event.examDocumentId,
        snapshotSha256: event.snapshotSha256,
        byteLength: event.byteLength,
      });
      break;
    case 'exam_intake_completed':
      expectedOperationId = deriveExamIntakeCompletedOperationId(
        event.examSessionId,
        event.documentSetFingerprint,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_intake_completed',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        documentSetFingerprint: event.documentSetFingerprint,
      });
      break;
    case 'exam_question_extraction_started':
      if (
        event.documentArtifactRef !==
        deriveExamDocumentArtifactRef(
          event.examSessionId,
          event.examDocumentId,
          event.extractionVersion,
        )
      ) {
        throw new ExamError('EXAM_EVENT_CONFLICT');
      }
      expectedOperationId = deriveExamQuestionExtractionStartedOperationId(
        event.examSessionId,
        event.examDocumentId,
        event.extractionVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_question_extraction_started',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        extractionVersion: event.extractionVersion,
        examDocumentId: event.examDocumentId,
        sourceSnapshotFingerprint: event.sourceSnapshotFingerprint,
        extractorId: event.extractorId,
        extractorVersion: event.extractorVersion,
        normalizationVersion: event.normalizationVersion,
        documentArtifactRef: event.documentArtifactRef,
      });
      break;
    case 'exam_document_artifact_extracted':
      if (
        event.documentArtifactRef !==
        deriveExamDocumentArtifactRef(
          event.examSessionId,
          event.examDocumentId,
          event.extractionVersion,
        )
      ) {
        throw new ExamError('EXAM_EVENT_CONFLICT');
      }
      expectedOperationId = deriveExamDocumentArtifactExtractedOperationId(
        event.examSessionId,
        event.examDocumentId,
        event.extractionVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_document_artifact_extracted',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        extractionVersion: event.extractionVersion,
        examDocumentId: event.examDocumentId,
        sourceSnapshotFingerprint: event.sourceSnapshotFingerprint,
        extractorId: event.extractorId,
        extractorVersion: event.extractorVersion,
        normalizationVersion: event.normalizationVersion,
        documentArtifactRef: event.documentArtifactRef,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        pageCount: event.pageCount,
      });
      break;
    case 'exam_question_segmentation_started':
      if (
        event.documentArtifactRef !==
          deriveExamDocumentArtifactRef(
            event.examSessionId,
            event.examDocumentId,
            event.extractionVersion,
          ) ||
        event.candidateArtifactRef !==
          deriveExamCandidateArtifactRef(
            event.examSessionId,
            event.examDocumentId,
            event.extractionVersion,
            event.segmentationVersion,
          )
      ) {
        throw new ExamError('EXAM_EVENT_CONFLICT');
      }
      expectedOperationId = deriveExamQuestionSegmentationStartedOperationId(
        event.examSessionId,
        event.examDocumentId,
        event.extractionVersion,
        event.segmentationVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_question_segmentation_started',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        extractionVersion: event.extractionVersion,
        segmentationVersion: event.segmentationVersion,
        examDocumentId: event.examDocumentId,
        sourceArtifactFingerprint: event.sourceArtifactFingerprint,
        documentArtifactRef: event.documentArtifactRef,
        candidateArtifactRef: event.candidateArtifactRef,
      });
      break;
    case 'exam_question_candidates_extracted':
      if (
        event.documentArtifactRef !==
          deriveExamDocumentArtifactRef(
            event.examSessionId,
            event.examDocumentId,
            event.extractionVersion,
          ) ||
        event.candidateArtifactRef !==
          deriveExamCandidateArtifactRef(
            event.examSessionId,
            event.examDocumentId,
            event.extractionVersion,
            event.segmentationVersion,
          )
      ) {
        throw new ExamError('EXAM_EVENT_CONFLICT');
      }
      expectedOperationId = deriveExamQuestionCandidatesExtractedOperationId(
        event.examSessionId,
        event.examDocumentId,
        event.extractionVersion,
        event.segmentationVersion,
      );
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_question_candidates_extracted',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        extractionVersion: event.extractionVersion,
        segmentationVersion: event.segmentationVersion,
        examDocumentId: event.examDocumentId,
        sourceArtifactFingerprint: event.sourceArtifactFingerprint,
        documentArtifactRef: event.documentArtifactRef,
        candidateArtifactRef: event.candidateArtifactRef,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        candidateCount: event.candidateCount,
        needsReview: event.needsReview,
      });
      break;
    case 'exam_delete_requested':
      expectedOperationId = deriveExamDeleteRequestedOperationId(event.examSessionId);
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_delete_requested',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        documentSetFingerprint: event.documentSetFingerprint,
      });
      break;
    case 'exam_deleted':
      expectedOperationId = deriveExamDeletedOperationId(event.examSessionId);
      expectedOperationFingerprint = createExamOperationFingerprint({
        action: 'exam_deleted',
        schemaVersion: event.schemaVersion,
        examSessionId: event.examSessionId,
        profileId: event.profileId,
        documentSetFingerprint: event.documentSetFingerprint,
        deleteRequestEventId: event.deleteRequestEventId,
      });
      break;
  }
  if (
    event.operationId !== expectedOperationId ||
    event.operationFingerprint !== expectedOperationFingerprint
  ) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
}

function operationRecord(
  records: readonly RuntimeRecord[],
  operation: string,
  fingerprint: string,
): RuntimeRecord | undefined {
  const match = records.find((record) => eventFromRecord(record).operationId === operation);
  if (!match) return undefined;
  if (eventFromRecord(match).operationFingerprint !== fingerprint) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
  return match;
}

function assertSessionOwner(session: RuntimeSession, learnerKey: string): void {
  if (
    session.kind !== ZHONGKAO_RUNTIME_KINDS.examEvent ||
    session.learnerKey !== learnerKey ||
    (session.status !== 'active' && session.status !== 'completed')
  ) {
    throw new ExamError('EXAM_NOT_FOUND');
  }
}

function assertCreatedSessionPartition(
  session: RuntimeSession,
  event: ExamCreatedEvent,
  learnerKey: string,
): void {
  if (
    session.id !== examRuntimeSessionId(event.examSessionId) ||
    session.kind !== ZHONGKAO_RUNTIME_KINDS.examEvent ||
    session.stageId !== zhongkaoStageId(event.profileId) ||
    session.learnerKey !== learnerKey ||
    session.status !== 'active'
  ) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
}

function currentSnapshot(
  session: RuntimeSession,
  records: readonly RuntimeRecord[],
): ExamRuntimeSnapshot {
  records.forEach(eventFromRecord);
  const state = foldExamEvents(records);
  if (
    session.id !== examRuntimeSessionId(state.examSessionId) ||
    session.stageId !== zhongkaoStageId(state.profileId) ||
    (state.status === 'deleted' && session.status !== 'completed') ||
    (state.status !== 'deleted' && session.status !== 'active')
  ) {
    throw new ExamError('EXAM_EVENT_CONFLICT');
  }
  return { session, records: [...records], state };
}

async function ownedSession(
  deps: ExamRuntimeDeps,
  examSessionId: string,
): Promise<RuntimeSession | undefined> {
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  const session = await deps.store.getSession(examRuntimeSessionId(examSessionId));
  if (!session) return undefined;
  assertSessionOwner(session, learnerKey);
  return session;
}

async function reloadOperation(
  deps: ExamRuntimeDeps,
  event: ExamEvent,
): Promise<ExamRuntimeWriteResult | undefined> {
  const session = await ownedSession(deps, event.examSessionId);
  if (!session) return undefined;
  const records = await deps.store.listRecords(session.id);
  if (records.length === 0) return undefined;
  const snapshot = currentSnapshot(session, records);
  if (snapshot.state.profileId !== event.profileId) throw new ExamError('EXAM_NOT_FOUND');
  const replay = operationRecord(records, event.operationId, event.operationFingerprint);
  return replay ? { snapshot, replayed: true, eventAppended: false } : undefined;
}

export async function loadExamRuntime(
  deps: ExamRuntimeDeps,
  examSessionId: string,
): Promise<ExamRuntimeSnapshot> {
  const session = await ownedSession(deps, examSessionId);
  if (!session) throw new ExamError('EXAM_NOT_FOUND');
  const records = await deps.store.listRecords(session.id);
  if (records.length === 0) throw new ExamError('EXAM_EVENT_CONFLICT');
  const snapshot = currentSnapshot(session, records);
  if (snapshot.state.examSessionId !== examSessionId) throw new ExamError('EXAM_NOT_FOUND');
  return snapshot;
}

export async function ensureExamRuntimeCreated(
  deps: ExamRuntimeDeps,
  event: ExamCreatedEvent,
): Promise<ExamRuntimeWriteResult> {
  assertExamEvent(event);
  assertDerivedExamEvent(event);
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  const sessionId = examRuntimeSessionId(event.examSessionId);
  let session = await ownedSession(deps, event.examSessionId);
  if (!session) {
    try {
      session = await deps.store.createSession({
        id: sessionId,
        kind: ZHONGKAO_RUNTIME_KINDS.examEvent,
        stageId: zhongkaoStageId(event.profileId),
        learnerKey,
        status: 'active',
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      });
    } catch (error) {
      session = await ownedSession(deps, event.examSessionId);
      if (!session) throw error;
    }
  }
  assertCreatedSessionPartition(session, event, learnerKey);

  const records = await deps.store.listRecords(session.id);
  if (records.length > 0) {
    const snapshot = currentSnapshot(session, records);
    const replay = operationRecord(records, event.operationId, event.operationFingerprint);
    if (!replay) throw new ExamError('EXAM_REQUEST_CONFLICT');
    return { snapshot, replayed: true, eventAppended: false };
  }

  try {
    await deps.store.appendRecord(
      {
        id: event.eventId,
        sessionId: session.id,
        subAnchor: event.eventId,
        createdAt: event.createdAt,
        payload: event,
      },
      { expectedLastSeq: null },
    );
  } catch (error) {
    const replay = await reloadOperation(deps, event).catch(() => undefined);
    if (replay) return replay;
    if (error instanceof RuntimeAppendConflictError) {
      throw new ExamError('EXAM_SESSION_CONFLICT');
    }
    throw error;
  }
  const snapshot = await loadExamRuntime(deps, event.examSessionId);
  return { snapshot, replayed: false, eventAppended: true };
}

export async function appendExamRuntimeEvent(
  deps: ExamRuntimeDeps,
  input: { event: Exclude<ExamEvent, ExamCreatedEvent>; expectedRevision: number },
): Promise<ExamRuntimeWriteResult> {
  const { event } = input;
  assertExamEvent(event);
  assertDerivedExamEvent(event);
  const session = await ownedSession(deps, event.examSessionId);
  if (!session) throw new ExamError('EXAM_NOT_FOUND');
  const records = await deps.store.listRecords(session.id);
  const before = currentSnapshot(session, records);
  if (before.state.profileId !== event.profileId) throw new ExamError('EXAM_NOT_FOUND');

  const replay = operationRecord(records, event.operationId, event.operationFingerprint);
  if (replay) return { snapshot: before, replayed: true, eventAppended: false };
  if (before.state.revision !== input.expectedRevision) {
    throw new ExamError('EXAM_SESSION_CONFLICT', before.state.revision);
  }

  const candidate = {
    id: event.eventId,
    sessionId: session.id,
    seq: input.expectedRevision + 1,
    subAnchor: event.eventId,
    createdAt: event.createdAt,
    payload: event,
  } as RuntimeRecord;
  foldExamEvents([...records, candidate]);

  try {
    await deps.store.appendRecord(
      {
        id: event.eventId,
        sessionId: session.id,
        subAnchor: event.eventId,
        createdAt: event.createdAt,
        payload: event,
      },
      {
        expectedLastSeq: input.expectedRevision,
        ...(event.eventType === 'exam_deleted'
          ? { sessionTransition: { status: 'completed' as const, updatedAt: event.createdAt } }
          : {}),
      },
    );
  } catch (error) {
    const recovered = await reloadOperation(deps, event).catch(() => undefined);
    if (recovered) return recovered;
    if (error instanceof RuntimeAppendConflictError) {
      const latest = await loadExamRuntime(deps, event.examSessionId).catch(() => undefined);
      throw new ExamError('EXAM_SESSION_CONFLICT', latest?.state.revision);
    }
    throw error;
  }
  const snapshot = await loadExamRuntime(deps, event.examSessionId);
  return { snapshot, replayed: false, eventAppended: true };
}
