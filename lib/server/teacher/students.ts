import { createHash, randomUUID } from 'node:crypto';

import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import { RuntimeAppendConflictError, type RuntimeStore } from '@openmaic/storage';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  isTeacherStudentProfileId,
  parseCreateTeacherStudentRequest,
  parseUpdateTeacherStudentRequest,
  TEACHER_STUDENT_LIMIT,
  TEACHER_STUDENT_ROSTER_KIND,
  TeacherStudentError,
  validateTeacherRosterEvent,
  type CreateTeacherStudentRequest,
  type TeacherRosterEvent,
  type TeacherStudent,
  type TeacherStudentFields,
} from '@/lib/teacher/students';
import {
  confirmObservedField,
  createUnknownField,
  type ObservedField,
} from '@/lib/zhongkao/observed-field';
import {
  createInitialStudentProfile,
  validateStudentProfile,
  type StudentProfile,
} from '@/lib/zhongkao/profile';
import { studentProfileRuntimeSessionId, zhongkaoStageId } from '@/lib/zhongkao/runtime';
import { ZHONGKAO_RUNTIME_KINDS } from '@/lib/zhongkao/runtime-kinds';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';

export interface TeacherStudentServiceDeps {
  store: RuntimeStore;
  ownerId: string;
  now?: () => string;
}

const ROSTER_STAGE_ID = 'teacher-students:v1';
const APPEND_ATTEMPTS = 8;

interface SessionIdentity {
  id: string;
  kind: string;
  stageId: string;
  learnerKey: string;
}

interface ProfileSnapshot {
  student: TeacherStudent;
  records: RuntimeRecord[];
  last: RuntimeRecord;
  identity: SessionIdentity;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function corruption(): never {
  throw new TeacherStudentError('TEACHER_STUDENT_STORAGE_CORRUPT');
}

function conflict(): never {
  throw new TeacherStudentError('TEACHER_STUDENT_CONFLICT');
}

function timestamp(deps: TeacherStudentServiceDeps, after?: string): string {
  const value = Date.parse((deps.now ?? (() => new Date().toISOString()))());
  if (!Number.isFinite(value)) throw new TeacherStudentError('TEACHER_STUDENT_UNAVAILABLE');
  return new Date(Math.max(value, after ? Date.parse(after) + 1 : value)).toISOString();
}

function rosterIdentity(deps: TeacherStudentServiceDeps): SessionIdentity {
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  return {
    id: `teacher-roster:v1:${hash(learnerKey)}`,
    kind: TEACHER_STUDENT_ROSTER_KIND,
    stageId: ROSTER_STAGE_ID,
    learnerKey,
  };
}

function profileIdentity(deps: TeacherStudentServiceDeps, profileId: string): SessionIdentity {
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  return {
    id: studentProfileRuntimeSessionId(profileId, learnerKey),
    kind: ZHONGKAO_RUNTIME_KINDS.studentProfile,
    stageId: zhongkaoStageId(profileId),
    learnerKey,
  };
}

function assertSession(session: RuntimeSession, identity: SessionIdentity): void {
  if (
    session.id !== identity.id ||
    session.kind !== identity.kind ||
    session.stageId !== identity.stageId ||
    session.learnerKey !== identity.learnerKey ||
    session.status !== 'active'
  ) {
    corruption();
  }
}

async function findSession(
  deps: TeacherStudentServiceDeps,
  identity: SessionIdentity,
): Promise<RuntimeSession | undefined> {
  const sessions = (await deps.store.listSessions(identity.stageId, identity.learnerKey)).filter(
    (session) => session.kind === identity.kind,
  );
  if (sessions.length > 1) corruption();
  const session = sessions[0] ?? (await deps.store.getSession(identity.id));
  if (session) assertSession(session, identity);
  return session;
}

async function ensureSession(
  deps: TeacherStudentServiceDeps,
  identity: SessionIdentity,
): Promise<void> {
  if (await findSession(deps, identity)) return;
  const now = timestamp(deps);
  try {
    const session = await deps.store.createSession({
      ...identity,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    assertSession(session, identity);
  } catch (error) {
    if (!(await findSession(deps, identity))) throw error;
  }
}

async function sessionRecords(
  deps: TeacherStudentServiceDeps,
  identity: SessionIdentity,
): Promise<RuntimeRecord[]> {
  if (!(await findSession(deps, identity))) return [];
  const records = (await deps.store.listRecords(identity.id)).sort((a, b) => a.seq - b.seq);
  for (let index = 0; index < records.length; index += 1) {
    if (
      records[index].sessionId !== identity.id ||
      !Number.isSafeInteger(records[index].seq) ||
      records[index].seq < 0 ||
      (index > 0 && records[index].seq <= records[index - 1].seq)
    ) {
      corruption();
    }
  }
  return records;
}

async function roster(deps: TeacherStudentServiceDeps): Promise<{
  identity: SessionIdentity;
  records: RuntimeRecord[];
  entries: Map<string, TeacherRosterEvent>;
}> {
  const identity = rosterIdentity(deps);
  const records = await sessionRecords(deps, identity);
  const entries = new Map<string, TeacherRosterEvent>();
  const requestIds = new Set<string>();
  for (const record of records) {
    if (!validateTeacherRosterEvent(record.payload).valid) corruption();
    const event = record.payload as TeacherRosterEvent;
    if (
      entries.has(event.profileId) ||
      requestIds.has(event.requestId) ||
      event.profileId !== deriveProfileId(deps, event.requestId)
    ) {
      corruption();
    }
    entries.set(event.profileId, event);
    requestIds.add(event.requestId);
  }
  if (entries.size > TEACHER_STUDENT_LIMIT) corruption();
  return { identity, records, entries };
}

async function readProfile(
  deps: TeacherStudentServiceDeps,
  profileId: string,
): Promise<ProfileSnapshot | undefined> {
  const identity = profileIdentity(deps, profileId);
  const records = await sessionRecords(deps, identity);
  for (const record of records) {
    if (!validateStudentProfile(record.payload).valid) corruption();
    if ((record.payload as StudentProfile).profileId !== profileId) corruption();
  }
  const last = records.at(-1);
  if (!last) return undefined;
  const profile = last.payload as StudentProfile;
  return {
    identity,
    records,
    last,
    student: { profile, archived: profile.archivedAt !== undefined },
  };
}

function deriveProfileId(deps: TeacherStudentServiceDeps, requestId: string): string {
  return `teacher-student:v1:${hash([rosterIdentity(deps).learnerKey, requestId])}`;
}

function fieldsFromProfile(profile: StudentProfile): TeacherStudentFields {
  return {
    nickname: profile.displayName.value ?? '',
    grade: profile.grade.value,
    examYear: profile.examYear.value,
    region: profile.region.value,
  };
}

function fieldsFromRequest(request: TeacherStudentFields): TeacherStudentFields {
  return {
    nickname: request.nickname,
    grade: request.grade,
    examYear: request.examYear,
    region: request.region,
  };
}

function applyFields(
  profile: StudentProfile,
  fields: TeacherStudentFields,
  updatedAt: string,
): StudentProfile {
  const evidence = {
    type: 'user_input' as const,
    sourceId: `teacher-student:${profile.profileId}`,
    description: 'Teacher explicitly entered student profile information',
    createdAt: updatedAt,
  };
  function field<T>(current: ObservedField<T>, value: T | null): ObservedField<T> {
    if (current.value === value) return current;
    return value === null
      ? createUnknownField(updatedAt)
      : confirmObservedField(current, value, evidence, updatedAt);
  }
  return {
    ...profile,
    displayName: field(profile.displayName, fields.nickname),
    grade: field(profile.grade, fields.grade),
    examYear: field(profile.examYear, fields.examYear),
    region: field(profile.region, fields.region),
    updatedAt,
  };
}

function assertInitialRequest(
  snapshot: ProfileSnapshot,
  request: CreateTeacherStudentRequest,
): void {
  const first = snapshot.records[0];
  if (
    first.id !== `teacher-student-create:${hash(snapshot.identity.id)}` ||
    hash(fieldsFromProfile(first.payload as StudentProfile)) !== hash(fieldsFromRequest(request))
  ) {
    conflict();
  }
}

export async function listTeacherStudents(
  deps: TeacherStudentServiceDeps,
): Promise<TeacherStudent[]> {
  const { entries } = await roster(deps);
  return Promise.all(
    [...entries.keys()].map(async (profileId) => {
      const snapshot = await readProfile(deps, profileId);
      if (!snapshot) corruption();
      return snapshot.student;
    }),
  );
}

export async function getTeacherStudent(
  deps: TeacherStudentServiceDeps,
  profileId: string,
): Promise<TeacherStudent> {
  if (!isTeacherStudentProfileId(profileId) || !(await roster(deps)).entries.has(profileId)) {
    throw new TeacherStudentError('TEACHER_STUDENT_NOT_FOUND');
  }
  const snapshot = await readProfile(deps, profileId);
  if (!snapshot) corruption();
  return snapshot.student;
}

export async function createTeacherStudent(
  deps: TeacherStudentServiceDeps,
  input: unknown,
): Promise<{ student: TeacherStudent; replayed: boolean }> {
  const request = parseCreateTeacherStudentRequest(input);
  const profileId = deriveProfileId(deps, request.requestId);
  const requestFingerprint = hash(request);
  let state = await roster(deps);
  const existing = state.entries.get(profileId);
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) conflict();
    return { student: await getTeacherStudent(deps, profileId), replayed: true };
  }
  if (state.entries.size >= TEACHER_STUDENT_LIMIT) {
    throw new TeacherStudentError('TEACHER_STUDENT_LIMIT_REACHED');
  }
  let snapshot = await readProfile(deps, profileId);
  let replayed = !!snapshot;
  if (!snapshot) {
    const identity = profileIdentity(deps, profileId);
    await ensureSession(deps, identity);
    const now = timestamp(deps);
    const initial = createInitialStudentProfile({ profileId, createdAt: now });
    initial.grade = createUnknownField(now);
    initial.examYear = createUnknownField(now);
    const profile = applyFields(initial, request, now);
    try {
      await deps.store.appendRecord(
        {
          id: `teacher-student-create:${hash(identity.id)}`,
          sessionId: identity.id,
          createdAt: now,
          payload: profile,
        },
        { expectedLastSeq: null },
      );
    } catch (error) {
      if (!(error instanceof RuntimeAppendConflictError)) throw error;
      replayed = true;
    }
    snapshot = await readProfile(deps, profileId);
    if (!snapshot) corruption();
  }
  assertInitialRequest(snapshot, request);
  await ensureSession(deps, state.identity);
  // The deterministic first profile record lets a retry finish registration after a partial write.
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
    state = await roster(deps);
    const winner = state.entries.get(profileId);
    if (winner) {
      if (winner.requestFingerprint !== requestFingerprint) conflict();
      return { student: await getTeacherStudent(deps, profileId), replayed: true };
    }
    if (state.entries.size >= TEACHER_STUDENT_LIMIT) {
      throw new TeacherStudentError('TEACHER_STUDENT_LIMIT_REACHED');
    }
    const event: TeacherRosterEvent = {
      schemaVersion: 1,
      profileId,
      requestId: request.requestId,
      requestFingerprint,
      archived: false,
      createdAt: snapshot.student.profile.createdAt,
    };
    try {
      await deps.store.appendRecord(
        {
          id: `teacher-roster-register:${hash(profileId)}`,
          sessionId: state.identity.id,
          createdAt: event.createdAt,
          payload: event,
        },
        { expectedLastSeq: state.records.at(-1)?.seq ?? null },
      );
      return { student: snapshot.student, replayed };
    } catch (error) {
      if (!(error instanceof RuntimeAppendConflictError)) throw error;
    }
  }
  return conflict();
}

export async function updateTeacherStudent(
  deps: TeacherStudentServiceDeps,
  profileId: string,
  input: unknown,
): Promise<TeacherStudent> {
  const request = parseUpdateTeacherStudentRequest(input);
  if (!isTeacherStudentProfileId(profileId) || !(await roster(deps)).entries.has(profileId)) {
    throw new TeacherStudentError('TEACHER_STUDENT_NOT_FOUND');
  }
  const snapshot = await readProfile(deps, profileId);
  if (!snapshot) corruption();
  if (snapshot.student.profile.updatedAt !== request.expectedUpdatedAt) conflict();
  const now = timestamp(deps, request.expectedUpdatedAt);
  const profile = applyFields(snapshot.student.profile, request, now);
  if (request.archived) profile.archivedAt = snapshot.student.profile.archivedAt ?? now;
  else delete profile.archivedAt;
  try {
    await deps.store.appendRecord(
      {
        id: `teacher-student-update:${randomUUID()}`,
        sessionId: snapshot.identity.id,
        createdAt: now,
        payload: profile,
      },
      { expectedLastSeq: snapshot.last.seq },
    );
  } catch (error) {
    if (error instanceof RuntimeAppendConflictError) conflict();
    throw error;
  }
  return { profile, archived: request.archived };
}

export async function defaultTeacherStudentServiceDeps(
  ownerId: string,
): Promise<TeacherStudentServiceDeps> {
  try {
    const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    return { ownerId, store: provider.runtimeStore };
  } catch {
    throw new TeacherStudentError('TEACHER_STUDENT_UNAVAILABLE');
  }
}
