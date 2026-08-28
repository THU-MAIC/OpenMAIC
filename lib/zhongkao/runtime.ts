import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import { RuntimeAppendConflictError, type RuntimeStore } from '@openmaic/storage';

import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';

import { assertStudentProfile, type StudentProfile } from './profile';
import { ZHONGKAO_RUNTIME_KINDS, type ZhongkaoLongLivedRuntimeKind } from './runtime-kinds';
import {
  assertStudyAttempt,
  STUDY_ATTEMPT_CONFLICT_CODE,
  studyAttemptFactsEqual,
  type StudyAttempt,
} from './study-attempt';
import {
  assertValidation,
  finishValidation,
  validateIdentifier,
  type DomainValidationIssue,
} from './validation';

export { ZHONGKAO_RUNTIME_KINDS } from './runtime-kinds';
export type { ZhongkaoLongLivedRuntimeKind, ZhongkaoRuntimeKind } from './runtime-kinds';

export interface ZhongkaoRuntimeDeps {
  store?: RuntimeStore;
  learnerKey?: string;
  now?: () => string;
  mintRecordId?: () => string;
}

interface RuntimeContext {
  store: RuntimeStore;
  learnerKey: string;
  now: () => string;
  mintRecordId: () => string;
}

function assertProfileId(profileId: string): void {
  const errors: DomainValidationIssue[] = [];
  validateIdentifier(profileId, '/profileId', errors);
  assertValidation(finishValidation(errors), 'ZHONGKAO_PROFILE_ID_INVALID');
}

function encodeIdentitySegment(value: string, code: string): string {
  const errors: DomainValidationIssue[] = [];
  validateIdentifier(value, '/identity', errors);
  assertValidation(finishValidation(errors), code);
  try {
    return encodeURIComponent(value);
  } catch {
    throw new Error(code);
  }
}

function encodeGeneratedSegment(value: string, code: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    throw new Error(code);
  }
}

export function studentProfileRuntimeSessionId(profileId: string, learnerKey: string): string {
  return zhongkaoRuntimeSessionId(ZHONGKAO_RUNTIME_KINDS.studentProfile, profileId, learnerKey);
}

export function studyAttemptRuntimeSessionId(profileId: string, learnerKey: string): string {
  return zhongkaoRuntimeSessionId(ZHONGKAO_RUNTIME_KINDS.studyAttempt, profileId, learnerKey);
}

export function zhongkaoStageId(profileId: string): string {
  assertProfileId(profileId);
  return `zhongkao-profile:${encodeIdentitySegment(profileId, 'ZHONGKAO_PROFILE_ID_INVALID')}`;
}

export function zhongkaoRuntimeSessionId(
  kind: ZhongkaoLongLivedRuntimeKind,
  profileId: string,
  learnerKey: string,
): string {
  if (
    kind !== ZHONGKAO_RUNTIME_KINDS.studentProfile &&
    kind !== ZHONGKAO_RUNTIME_KINDS.studyAttempt
  ) {
    throw new Error('ZHONGKAO_RUNTIME_KIND_INVALID');
  }
  const stageId = zhongkaoStageId(profileId);
  return [
    'zhongkao',
    kind,
    encodeGeneratedSegment(stageId, 'ZHONGKAO_PROFILE_ID_INVALID'),
    encodeIdentitySegment(learnerKey, 'ZHONGKAO_LEARNER_KEY_INVALID'),
  ].join(':');
}

function mintRuntimeRecordId(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `zhongkao-record:${suffix}`;
}

async function resolveContext(deps: ZhongkaoRuntimeDeps): Promise<RuntimeContext> {
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  encodeIdentitySegment(learnerKey, 'ZHONGKAO_LEARNER_KEY_INVALID');
  return {
    store: deps.store ?? getRuntimeStore(),
    learnerKey,
    now: deps.now ?? (() => new Date().toISOString()),
    mintRecordId: deps.mintRecordId ?? mintRuntimeRecordId,
  };
}

function assertSessionIdentity(
  session: RuntimeSession,
  expected: {
    id: string;
    kind: ZhongkaoLongLivedRuntimeKind;
    stageId: string;
    learnerKey: string;
  },
): void {
  if (
    session.id !== expected.id ||
    session.kind !== expected.kind ||
    session.stageId !== expected.stageId ||
    session.learnerKey !== expected.learnerKey ||
    session.status !== 'active'
  ) {
    throw new Error('ZHONGKAO_RUNTIME_SESSION_INVARIANT');
  }
}

async function selectSession(
  context: RuntimeContext,
  kind: ZhongkaoLongLivedRuntimeKind,
  profileId: string,
): Promise<RuntimeSession | undefined> {
  const stageId = zhongkaoStageId(profileId);
  const id = zhongkaoRuntimeSessionId(kind, profileId, context.learnerKey);
  const sessions = (await context.store.listSessions(stageId, context.learnerKey)).filter(
    (session) => session.kind === kind,
  );
  if (sessions.length > 1) throw new Error('ZHONGKAO_RUNTIME_SESSION_AMBIGUOUS');
  const session = sessions[0] ?? (await context.store.getSession(id));
  if (session)
    assertSessionIdentity(session, { id, kind, stageId, learnerKey: context.learnerKey });
  return session;
}

async function ensureSession(
  context: RuntimeContext,
  kind: ZhongkaoLongLivedRuntimeKind,
  profileId: string,
): Promise<RuntimeSession> {
  const existing = await selectSession(context, kind, profileId);
  if (existing) return existing;

  const stageId = zhongkaoStageId(profileId);
  const id = zhongkaoRuntimeSessionId(kind, profileId, context.learnerKey);
  const timestamp = context.now();
  try {
    const created = await context.store.createSession({
      id,
      kind,
      stageId,
      learnerKey: context.learnerKey,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    assertSessionIdentity(created, { id, kind, stageId, learnerKey: context.learnerKey });
    return created;
  } catch (error) {
    const winner = await selectSession(context, kind, profileId);
    if (!winner) throw error;
    return winner;
  }
}

function profileFromRecord(record: RuntimeRecord): StudentProfile {
  assertStudentProfile(record.payload);
  return record.payload;
}

function attemptFromRecord(record: RuntimeRecord): StudyAttempt {
  assertStudyAttempt(record.payload);
  return record.payload;
}

function latestRecordBySeq(records: readonly RuntimeRecord[]): RuntimeRecord | undefined {
  let latest: RuntimeRecord | undefined;
  for (const record of records) {
    if (!latest || record.seq > latest.seq) latest = record;
  }
  return latest;
}

export async function saveStudentProfile(
  profile: StudentProfile,
  deps: ZhongkaoRuntimeDeps = {},
): Promise<void> {
  assertStudentProfile(profile);
  const context = await resolveContext(deps);
  const session = await ensureSession(
    context,
    ZHONGKAO_RUNTIME_KINDS.studentProfile,
    profile.profileId,
  );

  while (true) {
    const records = await context.store.listRecords(session.id);
    const last = latestRecordBySeq(records);
    if (last && JSON.stringify(profileFromRecord(last)) === JSON.stringify(profile)) return;
    try {
      await context.store.appendRecord(
        {
          id: context.mintRecordId(),
          sessionId: session.id,
          createdAt: context.now(),
          payload: profile,
        },
        { expectedLastSeq: last?.seq ?? null },
      );
      return;
    } catch (error) {
      if (error instanceof RuntimeAppendConflictError) continue;
      throw error;
    }
  }
}

export async function loadStudentProfile(
  profileId: string,
  deps: ZhongkaoRuntimeDeps = {},
): Promise<StudentProfile | undefined> {
  assertProfileId(profileId);
  const context = await resolveContext(deps);
  const session = await selectSession(context, ZHONGKAO_RUNTIME_KINDS.studentProfile, profileId);
  if (!session) return undefined;
  const last = latestRecordBySeq(await context.store.listRecords(session.id));
  if (!last) return undefined;
  const profile = profileFromRecord(last);
  if (profile.profileId !== profileId) throw new Error('ZHONGKAO_RUNTIME_PROFILE_MISMATCH');
  return profile;
}

export async function saveStudyAttempt(
  attempt: StudyAttempt,
  deps: ZhongkaoRuntimeDeps = {},
): Promise<void> {
  assertStudyAttempt(attempt);
  const context = await resolveContext(deps);
  const session = await ensureSession(
    context,
    ZHONGKAO_RUNTIME_KINDS.studyAttempt,
    attempt.profileId,
  );

  while (true) {
    const records = await context.store.listRecords(session.id);
    const duplicate = records.find((record) => attemptFromRecord(record).id === attempt.id);
    if (duplicate) {
      if (studyAttemptFactsEqual(attemptFromRecord(duplicate), attempt)) return;
      throw new Error(STUDY_ATTEMPT_CONFLICT_CODE);
    }
    try {
      await context.store.appendRecord(
        {
          id: context.mintRecordId(),
          sessionId: session.id,
          createdAt: context.now(),
          subAnchor: attempt.id,
          payload: attempt,
        },
        { expectedLastSeq: latestRecordBySeq(records)?.seq ?? null },
      );
      return;
    } catch (error) {
      if (error instanceof RuntimeAppendConflictError) continue;
      throw error;
    }
  }
}

export async function loadStudyAttempts(
  profileId: string,
  deps: ZhongkaoRuntimeDeps = {},
): Promise<StudyAttempt[]> {
  assertProfileId(profileId);
  const context = await resolveContext(deps);
  const session = await selectSession(context, ZHONGKAO_RUNTIME_KINDS.studyAttempt, profileId);
  if (!session) return [];
  return (await context.store.listRecords(session.id)).map((record) => {
    const attempt = attemptFromRecord(record);
    if (attempt.profileId !== profileId) throw new Error('ZHONGKAO_RUNTIME_PROFILE_MISMATCH');
    return attempt;
  });
}
