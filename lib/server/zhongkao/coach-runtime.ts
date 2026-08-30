import { createHash } from 'node:crypto';

import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import { RuntimeAppendConflictError, type RuntimeStore } from '@openmaic/storage';

import { CoachError } from '@/lib/zhongkao/coach-errors';
import {
  COACH_EVENT_SCHEMA_VERSION,
  assertCoachEvent,
  type CoachEvent,
  type CoachQuestionSource,
  type CoachStartedEvent,
} from '@/lib/zhongkao/coach-event';
import { foldCoachEvents, type CoachState } from '@/lib/zhongkao/coach-state';
import { ZHONGKAO_RUNTIME_KINDS } from '@/lib/zhongkao/runtime-kinds';
import {
  finishValidation,
  validateIdentifier,
  type DomainValidationIssue,
} from '@/lib/zhongkao/validation';
import { zhongkaoStageId } from '@/lib/zhongkao/runtime';

import { resolveZhongkaoLearnerKeyFromOwnerId } from './learner-identity';

const COACH_START_MARKER = 'start:v2' as const;
const COACH_ID_VERSION = 2 as const;

export interface CoachRuntimeDeps {
  store: RuntimeStore;
  ownerId: string;
  now?: () => string;
}

export interface CoachRuntimeSnapshot {
  session: RuntimeSession;
  records: RuntimeRecord[];
  state: CoachState;
}

export interface CoachRuntimeWriteResult {
  snapshot: CoachRuntimeSnapshot;
  replayed: boolean;
  eventAppended: boolean;
}

export interface CoachStartIdentity {
  learnerKey: string;
  profileId: string;
  agentSessionId: string;
  sourceUserMessageSeq: number;
  marker: typeof COACH_START_MARKER;
}

export interface CoachModelOperationIdentity {
  learnerKey: string;
  profileId: string;
  coachSessionId: string;
  agentSessionId: string;
  sourceUserMessageSeq: number;
  action: string;
}

interface EventMetadata {
  eventId: string;
  createdAt: string;
  operationId: string;
  operationFingerprint: string;
}

export interface AppendCoachEventInput {
  profileId: string;
  coachSessionId: string;
  expectedRevision: number;
  operationId: string;
  operationFingerprint: string;
  createEvent: (metadata: EventMetadata, snapshot: CoachRuntimeSnapshot) => CoachEvent;
}

export interface StartCoachRuntimeInput {
  profileId: string;
  subjectId: string;
  knowledgePointIds: readonly string[];
  questionSource: CoachQuestionSource;
  questionText: string;
  agentSessionId: string;
  sourceUserMessageSeq: number;
}

function assertIdentifier(value: string): void {
  const errors: DomainValidationIssue[] = [];
  validateIdentifier(value, '/id', errors);
  if (!finishValidation(errors).valid) throw new CoachError('COACH_INPUT_INVALID');
}

function assertFingerprint(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new CoachError('COACH_INPUT_INVALID');
}

function currentTime(deps: CoachRuntimeDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
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

export function hashCoachMessageText(text: string): string {
  return digest('openmaic:zhongkao-coach-message:v1', text);
}

export function createCoachOperationFingerprint(semanticFacts: unknown): string {
  return digest('openmaic:zhongkao-coach-operation-fingerprint:v1', semanticFacts);
}

export function deriveCoachStartIdentity(input: {
  learnerKey: string;
  profileId: string;
  agentSessionId: string;
  sourceUserMessageSeq: number;
}): Readonly<CoachStartIdentity> {
  assertIdentifier(input.learnerKey);
  assertIdentifier(input.profileId);
  assertIdentifier(input.agentSessionId);
  if (!Number.isSafeInteger(input.sourceUserMessageSeq) || input.sourceUserMessageSeq < 1) {
    throw new CoachError('COACH_INPUT_INVALID');
  }
  return Object.freeze({ ...input, marker: COACH_START_MARKER });
}

export function deriveCoachSessionId(identity: CoachStartIdentity): string {
  return `coach:v${COACH_ID_VERSION}:${digest('openmaic:zhongkao-coach-session:v2', identity)}`;
}

export function deriveCoachStartOperationId(identity: CoachStartIdentity): string {
  return `coach-op:v${COACH_ID_VERSION}:${digest(
    'openmaic:zhongkao-coach-start-operation:v2',
    identity,
  )}`;
}

export function deriveCoachModelOperationId(identity: CoachModelOperationIdentity): string {
  return `coach-op:v${COACH_ID_VERSION}:${digest(
    'openmaic:zhongkao-coach-model-operation:v2',
    identity,
  )}`;
}

export function deriveCoachCausalOperationId(input: {
  coachSessionId: string;
  action: string;
  causalEventId: string;
  version?: number;
}): string {
  return `coach-op:v${COACH_ID_VERSION}:${digest(
    'openmaic:zhongkao-coach-causal-operation:v2',
    input,
  )}`;
}

export function deriveCoachEventId(operationId: string): string {
  assertIdentifier(operationId);
  return `coach-event:v${COACH_ID_VERSION}:${digest(
    'openmaic:zhongkao-coach-event:v2',
    operationId,
  )}`;
}

export function coachRuntimeSessionId(coachSessionId: string): string {
  assertIdentifier(coachSessionId);
  return `zhongkao-coach:${encodeURIComponent(coachSessionId)}`;
}

function assertSessionPartition(
  session: RuntimeSession,
  profileId: string,
  coachSessionId: string,
  learnerKey: string,
): void {
  if (
    session.id !== coachRuntimeSessionId(coachSessionId) ||
    session.kind !== ZHONGKAO_RUNTIME_KINDS.coachEvent ||
    session.stageId !== zhongkaoStageId(profileId) ||
    session.learnerKey !== learnerKey ||
    (session.status !== 'active' && session.status !== 'completed')
  ) {
    throw new CoachError('COACH_SESSION_NOT_FOUND');
  }
}

function eventFromRecord(record: RuntimeRecord): CoachEvent {
  assertCoachEvent(record.payload);
  return record.payload;
}

function operationRecord(
  records: readonly RuntimeRecord[],
  operationId: string,
  operationFingerprint: string,
): RuntimeRecord | undefined {
  const match = records.find((record) => eventFromRecord(record).operationId === operationId);
  if (!match) return undefined;
  if (eventFromRecord(match).operationFingerprint !== operationFingerprint) {
    throw new CoachError('COACH_EVENT_CONFLICT');
  }
  return match;
}

function snapshotThroughOperation(
  session: RuntimeSession,
  records: readonly RuntimeRecord[],
  operationId: string,
  operationFingerprint: string,
): CoachRuntimeSnapshot | undefined {
  if (records.length === 0) return undefined;
  foldCoachEvents(records);
  const operation = operationRecord(records, operationId, operationFingerprint);
  if (!operation) return undefined;
  const throughOperation = records.filter((record) => record.seq <= operation.seq);
  return {
    session,
    records: [...throughOperation],
    state: foldCoachEvents(throughOperation),
  };
}

function currentSnapshot(
  session: RuntimeSession,
  records: readonly RuntimeRecord[],
): CoachRuntimeSnapshot {
  const state = foldCoachEvents(records);
  const terminal = state.status === 'completed' || state.status === 'abandoned';
  if ((terminal && session.status !== 'completed') || (!terminal && session.status !== 'active')) {
    throw new CoachError('COACH_EVENT_CONFLICT');
  }
  return { session, records: [...records], state };
}

async function loadSessionForPartition(
  deps: CoachRuntimeDeps,
  profileId: string,
  coachSessionId: string,
  learnerKey: string,
): Promise<RuntimeSession | undefined> {
  const session = await deps.store.getSession(coachRuntimeSessionId(coachSessionId));
  if (!session) return undefined;
  assertSessionPartition(session, profileId, coachSessionId, learnerKey);
  return session;
}

async function reloadAfterConflict(
  deps: CoachRuntimeDeps,
  profileId: string,
  coachSessionId: string,
  learnerKey: string,
  operationId: string,
  operationFingerprint: string,
): Promise<CoachRuntimeWriteResult> {
  const session = await loadSessionForPartition(deps, profileId, coachSessionId, learnerKey);
  if (!session) throw new CoachError('COACH_SESSION_NOT_FOUND');
  const records = await deps.store.listRecords(session.id);
  const replay = snapshotThroughOperation(session, records, operationId, operationFingerprint);
  if (replay) return { snapshot: replay, replayed: true, eventAppended: false };
  const latest = records.length > 0 ? foldCoachEvents(records).revision : undefined;
  throw new CoachError('COACH_SESSION_CONFLICT', latest);
}

export async function loadCoachRuntime(
  deps: CoachRuntimeDeps,
  profileId: string,
  coachSessionId: string,
): Promise<CoachRuntimeSnapshot> {
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  const session = await loadSessionForPartition(deps, profileId, coachSessionId, learnerKey);
  if (!session) throw new CoachError('COACH_SESSION_NOT_FOUND');
  const records = await deps.store.listRecords(session.id);
  if (records.length === 0) throw new CoachError('COACH_EVENT_CONFLICT');
  const snapshot = currentSnapshot(session, records);
  if (snapshot.state.profileId !== profileId || snapshot.state.coachSessionId !== coachSessionId) {
    throw new CoachError('COACH_SESSION_NOT_FOUND');
  }
  return snapshot;
}

export async function startCoachRuntime(
  deps: CoachRuntimeDeps,
  input: StartCoachRuntimeInput,
): Promise<CoachRuntimeWriteResult> {
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  const identity = deriveCoachStartIdentity({
    learnerKey,
    profileId: input.profileId,
    agentSessionId: input.agentSessionId,
    sourceUserMessageSeq: input.sourceUserMessageSeq,
  });
  const coachSessionId = deriveCoachSessionId(identity);
  const operationId = deriveCoachStartOperationId(identity);
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'start_problem',
    schemaVersion: COACH_EVENT_SCHEMA_VERSION,
    profileId: input.profileId,
    subjectId: input.subjectId,
    knowledgePointIds: [...input.knowledgePointIds],
    questionSource: input.questionSource,
    questionTextHash: hashCoachMessageText(input.questionText),
  });
  const createdAt = currentTime(deps);
  const event: CoachStartedEvent = {
    schemaVersion: COACH_EVENT_SCHEMA_VERSION,
    eventId: deriveCoachEventId(operationId),
    coachSessionId,
    profileId: input.profileId,
    eventType: 'coach_started',
    createdAt,
    agentSessionId: input.agentSessionId,
    sourceUserMessageSeq: input.sourceUserMessageSeq,
    operationId,
    operationFingerprint,
    subjectId: input.subjectId,
    knowledgePointIds: [...input.knowledgePointIds],
    questionSource: { ...input.questionSource },
    questionText: input.questionText,
  };
  assertCoachEvent(event);

  const sessionId = coachRuntimeSessionId(coachSessionId);
  let session = await loadSessionForPartition(deps, input.profileId, coachSessionId, learnerKey);
  if (!session) {
    try {
      session = await deps.store.createSession({
        id: sessionId,
        kind: ZHONGKAO_RUNTIME_KINDS.coachEvent,
        stageId: zhongkaoStageId(input.profileId),
        learnerKey,
        status: 'active',
        createdAt,
        updatedAt: createdAt,
      });
    } catch (error) {
      session = await loadSessionForPartition(deps, input.profileId, coachSessionId, learnerKey);
      if (!session) throw error;
    }
  }
  assertSessionPartition(session, input.profileId, coachSessionId, learnerKey);

  let records = await deps.store.listRecords(session.id);
  const replay = snapshotThroughOperation(session, records, operationId, operationFingerprint);
  if (replay) return { snapshot: replay, replayed: true, eventAppended: false };
  if (records.length > 0) throw new CoachError('COACH_EVENT_CONFLICT');

  try {
    const record = await deps.store.appendRecord(
      {
        id: event.eventId,
        sessionId: session.id,
        createdAt: event.createdAt,
        subAnchor: event.eventId,
        payload: event,
      },
      { expectedLastSeq: null },
    );
    records = [record];
    return {
      snapshot: currentSnapshot(session, records),
      replayed: false,
      eventAppended: true,
    };
  } catch (error) {
    if (!(error instanceof RuntimeAppendConflictError)) throw error;
    return reloadAfterConflict(
      deps,
      input.profileId,
      coachSessionId,
      learnerKey,
      operationId,
      operationFingerprint,
    );
  }
}

export async function appendCoachRuntimeEvent(
  deps: CoachRuntimeDeps,
  input: AppendCoachEventInput,
): Promise<CoachRuntimeWriteResult> {
  assertIdentifier(input.profileId);
  assertIdentifier(input.coachSessionId);
  assertIdentifier(input.operationId);
  assertFingerprint(input.operationFingerprint);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new CoachError('COACH_INPUT_INVALID');
  }

  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  const session = await loadSessionForPartition(
    deps,
    input.profileId,
    input.coachSessionId,
    learnerKey,
  );
  if (!session) throw new CoachError('COACH_SESSION_NOT_FOUND');
  let records = await deps.store.listRecords(session.id);
  if (records.length === 0) throw new CoachError('COACH_EVENT_CONFLICT');

  const before = currentSnapshot(session, records);
  const replay = snapshotThroughOperation(
    session,
    records,
    input.operationId,
    input.operationFingerprint,
  );
  if (replay) return { snapshot: replay, replayed: true, eventAppended: false };
  if (before.state.revision !== input.expectedRevision) {
    throw new CoachError('COACH_SESSION_CONFLICT', before.state.revision);
  }

  const event = input.createEvent(
    {
      eventId: deriveCoachEventId(input.operationId),
      createdAt: currentTime(deps),
      operationId: input.operationId,
      operationFingerprint: input.operationFingerprint,
    },
    before,
  );
  assertCoachEvent(event);
  if (
    event.profileId !== input.profileId ||
    event.coachSessionId !== input.coachSessionId ||
    event.operationId !== input.operationId ||
    event.operationFingerprint !== input.operationFingerprint ||
    event.eventId !== deriveCoachEventId(input.operationId) ||
    event.eventType === 'coach_started'
  ) {
    throw new CoachError('COACH_EVENT_CONFLICT');
  }

  const recordInit = {
    id: event.eventId,
    sessionId: session.id,
    createdAt: event.createdAt,
    subAnchor: event.eventId,
    payload: event,
  };
  foldCoachEvents([...records, { ...recordInit, seq: before.state.revision + 1 }]);

  const terminal =
    event.eventType === 'problem_abandoned' || event.eventType === 'study_attempts_projected';
  try {
    const record = await deps.store.appendRecord(recordInit, {
      expectedLastSeq: before.state.revision,
      ...(terminal
        ? { sessionTransition: { status: 'completed' as const, updatedAt: event.createdAt } }
        : {}),
    });
    records = [...records, record];
    const updatedSession = terminal
      ? { ...session, status: 'completed' as const, updatedAt: event.createdAt }
      : session;
    return {
      snapshot: currentSnapshot(updatedSession, records),
      replayed: false,
      eventAppended: true,
    };
  } catch (error) {
    if (!(error instanceof RuntimeAppendConflictError)) throw error;
    return reloadAfterConflict(
      deps,
      input.profileId,
      input.coachSessionId,
      learnerKey,
      input.operationId,
      input.operationFingerprint,
    );
  }
}
