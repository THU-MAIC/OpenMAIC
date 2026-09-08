import { BrowserRuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  createTeacherStudent,
  getTeacherStudent,
  listTeacherStudents,
  updateTeacherStudent,
  type TeacherStudentServiceDeps,
} from '@/lib/server/teacher/students';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import {
  TEACHER_STUDENT_ROSTER_KIND,
  parseCreateTeacherStudentRequest,
  validateTeacherRosterEvent,
} from '@/lib/teacher/students';
import { createInitialStudentProfile, validateStudentProfile } from '@/lib/zhongkao/profile';
import { createInferredField } from '@/lib/zhongkao/observed-field';
import {
  loadStudentProfile,
  loadStudyAttempts,
  studentProfileRuntimeSessionId,
} from '@/lib/zhongkao/runtime';

const NOW = '2026-09-08T08:00:00.000Z';
const REQUEST = {
  requestId: '13fe7cc0-4fd9-4ad4-8455-105c97352dd5',
  nickname: 'Fictional student A',
  grade: null,
  examYear: null,
  region: null,
};
const OTHER_REQUEST_ID = '242c3d7e-9e25-457a-9e56-efca1f924073';

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

function harness() {
  const indexedDB = new IDBFactory();
  const dbName = `teacher-students-${Math.random()}`;
  const options = {
    indexedDB,
    dbName,
    payloadValidators: {
      ...APP_RUNTIME_PAYLOAD_VALIDATORS,
      [TEACHER_STUDENT_ROSTER_KIND]: validateTeacherRosterEvent,
    },
  };
  const store = new BrowserRuntimeStore(options);
  const deps: TeacherStudentServiceDeps = {
    store,
    ownerId: 'fictional-teacher-a',
    now: () => NOW,
  };
  return { store, deps, options };
}

function edit(expectedUpdatedAt: string, changes: Record<string, unknown> = {}) {
  return {
    nickname: REQUEST.nickname,
    grade: null,
    examYear: null,
    region: null,
    archived: false,
    expectedUpdatedAt,
    ...changes,
  };
}

describe('teacher student roster with real runtime persistence', () => {
  it('starts empty and keeps all unprovided learning facts unknown across a reload', async () => {
    const { deps, options } = harness();
    expect(await listTeacherStudents(deps)).toEqual([]);
    const created = await createTeacherStudent(deps, REQUEST);
    expect(created.replayed).toBe(false);
    const profile = created.student.profile;
    expect(profile.displayName).toMatchObject({ value: REQUEST.nickname, status: 'confirmed' });
    for (const field of [
      'grade',
      'examYear',
      'region',
      'preferredSubjects',
      'weekdayMinutes',
      'weekendMinutes',
    ] as const) {
      expect(profile[field]).toMatchObject({ value: null, status: 'unknown', evidence: [] });
    }
    expect(profile.textbookVersions).toEqual({});
    expect(profile.baselineScores).toEqual({});
    expect(profile.targetScores).toEqual({});
    const reloaded = { ...deps, store: new BrowserRuntimeStore(options) };
    expect(await listTeacherStudents(reloaded)).toEqual([created.student]);
    const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
    expect(await loadStudentProfile(profile.profileId, { store: deps.store, learnerKey })).toEqual(
      profile,
    );
    expect(await loadStudyAttempts(profile.profileId, { store: deps.store, learnerKey })).toEqual(
      [],
    );
  });

  it('records only teacher supplied grade, year and region as explicit confirmation', async () => {
    const { deps } = harness();
    const { student } = await createTeacherStudent(deps, {
      ...REQUEST,
      grade: 8,
      examYear: 2028,
      region: 'Fictional region',
    });
    for (const name of ['displayName', 'grade', 'examYear', 'region'] as const) {
      expect(student.profile[name].status).toBe('confirmed');
      expect(student.profile[name].evidence.map((e) => e.type)).toEqual(['user_input']);
    }
    expect(student.profile.grade.value).toBe(8);
    expect(student.profile.examYear.value).toBe(2028);
  });

  it('isolates teachers and students even when requests or nicknames match', async () => {
    const { deps } = harness();
    const ownerB = { ...deps, ownerId: 'fictional-teacher-b' };
    const a = (await createTeacherStudent(deps, REQUEST)).student;
    const b = (await createTeacherStudent(deps, { ...REQUEST, requestId: OTHER_REQUEST_ID }))
      .student;
    const c = (await createTeacherStudent(ownerB, REQUEST)).student;
    expect(new Set([a.profile.profileId, b.profile.profileId, c.profile.profileId]).size).toBe(3);
    await expect(getTeacherStudent(ownerB, a.profile.profileId)).rejects.toMatchObject({
      code: 'TEACHER_STUDENT_NOT_FOUND',
    });
    await expect(
      updateTeacherStudent(ownerB, a.profile.profileId, edit(a.profile.updatedAt)),
    ).rejects.toMatchObject({ code: 'TEACHER_STUDENT_NOT_FOUND' });
    await updateTeacherStudent(
      deps,
      a.profile.profileId,
      edit(a.profile.updatedAt, { nickname: 'Fictional renamed A' }),
    );
    expect(await getTeacherStudent(deps, b.profile.profileId)).toEqual(b);
    expect(await listTeacherStudents(ownerB)).toEqual([c]);
  });

  it('replays creation without resetting later edits and rejects request reuse with different facts', async () => {
    const { deps } = harness();
    const first = await createTeacherStudent(deps, REQUEST);
    const updated = await updateTeacherStudent(
      deps,
      first.student.profile.profileId,
      edit(first.student.profile.updatedAt, { grade: 7 }),
    );
    expect(await createTeacherStudent(deps, REQUEST)).toEqual({ student: updated, replayed: true });
    await expect(createTeacherStudent(deps, { ...REQUEST, grade: 9 })).rejects.toMatchObject({
      code: 'TEACHER_STUDENT_CONFLICT',
    });
    expect(await listTeacherStudents(deps)).toHaveLength(1);
  });

  it('deduplicates simultaneous create calls', async () => {
    const { deps } = harness();
    const results = await Promise.all([
      createTeacherStudent(deps, REQUEST),
      createTeacherStudent(deps, REQUEST),
    ]);
    expect(results[0].student).toEqual(results[1].student);
    expect(await listTeacherStudents(deps)).toHaveLength(1);
    const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
    expect(
      await deps.store.listRecords(
        studentProfileRuntimeSessionId(results[0].student.profile.profileId, learnerKey),
      ),
    ).toHaveLength(1);
  });

  it('archives and restores in the same atomic profile update without deleting history', async () => {
    const { deps } = harness();
    const { student } = await createTeacherStudent(deps, REQUEST);
    const archived = await updateTeacherStudent(
      deps,
      student.profile.profileId,
      edit(student.profile.updatedAt, { archived: true, nickname: 'Fictional archived A' }),
    );
    expect(archived.archived).toBe(true);
    expect(archived.profile.archivedAt).toBe(archived.profile.updatedAt);
    expect((await listTeacherStudents(deps))[0]).toEqual(archived);
    const restored = await updateTeacherStudent(
      deps,
      student.profile.profileId,
      edit(archived.profile.updatedAt),
    );
    expect(restored.archived).toBe(false);
    expect(restored.profile).not.toHaveProperty('archivedAt');
    const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
    expect(
      await deps.store.listRecords(
        studentProfileRuntimeSessionId(student.profile.profileId, learnerKey),
      ),
    ).toHaveLength(3);
  });

  it('rejects stale writes and advances timestamps even when the clock does not advance', async () => {
    const { deps } = harness();
    const { student } = await createTeacherStudent(deps, REQUEST);
    const updated = await updateTeacherStudent(
      deps,
      student.profile.profileId,
      edit(student.profile.updatedAt, { grade: 8 }),
    );
    expect(Date.parse(updated.profile.updatedAt)).toBeGreaterThan(
      Date.parse(student.profile.updatedAt),
    );
    await expect(
      updateTeacherStudent(
        deps,
        student.profile.profileId,
        edit(student.profile.updatedAt, { grade: 9 }),
      ),
    ).rejects.toMatchObject({ code: 'TEACHER_STUDENT_CONFLICT' });
    expect((await getTeacherStudent(deps, student.profile.profileId)).profile.grade.value).toBe(8);
  });

  it('preserves unchanged inferred fields and evidence during archive or another field edit', async () => {
    const { deps } = harness();
    const { student } = await createTeacherStudent(deps, REQUEST);
    const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
    const sessionId = studentProfileRuntimeSessionId(student.profile.profileId, learnerKey);
    const profile = {
      ...student.profile,
      grade: createInferredField(8, 0.5, [{ type: 'diagnostic', createdAt: NOW }], NOW),
      updatedAt: '2026-09-08T08:00:01.000Z',
    };
    await deps.store.appendRecord({
      id: 'fictional-inference',
      sessionId,
      createdAt: profile.updatedAt,
      payload: profile,
    });
    const updated = await updateTeacherStudent(
      deps,
      profile.profileId,
      edit(profile.updatedAt, { grade: 8, archived: true, nickname: 'Fictional edited A' }),
    );
    expect(updated.profile.grade).toEqual(profile.grade);
    expect(updated.profile.region).toEqual(profile.region);
    expect(updated.profile.displayName.status).toBe('confirmed');
    expect(updated.archived).toBe(true);
  });

  it('lets exactly one concurrent edit commit against the actual profile sequence', async () => {
    const { deps } = harness();
    const { student } = await createTeacherStudent(deps, REQUEST);
    const results = await Promise.allSettled([
      updateTeacherStudent(
        deps,
        student.profile.profileId,
        edit(student.profile.updatedAt, { grade: 7 }),
      ),
      updateTeacherStudent(
        deps,
        student.profile.profileId,
        edit(student.profile.updatedAt, { grade: 8 }),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'TEACHER_STUDENT_CONFLICT' },
    });
  });

  it('finishes a partial registration on retry without duplicating or replacing the profile', async () => {
    const { deps, store } = harness();
    const append = store.appendRecord.bind(store);
    let failRoster = true;
    vi.spyOn(store, 'appendRecord').mockImplementation(async (record, options) => {
      if (record.id.startsWith('teacher-roster-register:') && failRoster) {
        failRoster = false;
        throw new Error('fictional storage interruption');
      }
      return append(record, options);
    });
    await expect(createTeacherStudent(deps, REQUEST)).rejects.toThrow(
      'fictional storage interruption',
    );
    expect(await listTeacherStudents(deps)).toEqual([]);
    await expect(createTeacherStudent(deps, { ...REQUEST, grade: 9 })).rejects.toMatchObject({
      code: 'TEACHER_STUDENT_CONFLICT',
    });
    const recovered = await createTeacherStudent(deps, REQUEST);
    expect(recovered.replayed).toBe(true);
    expect(await listTeacherStudents(deps)).toEqual([recovered.student]);
  });

  it('fails closed when a persisted roster event or session identity is corrupt', async () => {
    const { deps, store } = harness();
    await createTeacherStudent(deps, REQUEST);
    const list = store.listRecords.bind(store);
    vi.spyOn(store, 'listRecords').mockImplementation(async (id, options) => {
      const records = await list(id, options);
      return id.startsWith('teacher-roster:')
        ? records.map((record) => ({
            ...record,
            payload: { ...(record.payload as object), ownerId: 'injected' },
          }))
        : records;
    });
    await expect(listTeacherStudents(deps)).rejects.toMatchObject({
      code: 'TEACHER_STUDENT_STORAGE_CORRUPT',
    });
    vi.restoreAllMocks();
    const sessions = store.listSessions.bind(store);
    vi.spyOn(store, 'listSessions').mockImplementation(async (stage, learner) =>
      (await sessions(stage, learner)).map((session) => ({
        ...session,
        learnerKey: 'wrong-owner',
      })),
    );
    await expect(listTeacherStudents(deps)).rejects.toMatchObject({
      code: 'TEACHER_STUDENT_STORAGE_CORRUPT',
    });
  });

  it('fails closed when a roster points to a missing or mismatched profile', async () => {
    const { deps, store } = harness();
    await createTeacherStudent(deps, REQUEST);
    const list = store.listRecords.bind(store);
    const spy = vi.spyOn(store, 'listRecords').mockImplementation(async (id, options) => {
      const records = await list(id, options);
      return id.startsWith('zhongkao:') ? [] : records;
    });
    await expect(listTeacherStudents(deps)).rejects.toMatchObject({
      code: 'TEACHER_STUDENT_STORAGE_CORRUPT',
    });
    spy.mockImplementation(async (id, options) => {
      const records = await list(id, options);
      return id.startsWith('zhongkao:')
        ? records.map((record) => ({
            ...record,
            payload: { ...(record.payload as object), profileId: 'another-student' },
          }))
        : records;
    });
    await expect(listTeacherStudents(deps)).rejects.toMatchObject({
      code: 'TEACHER_STUDENT_STORAGE_CORRUPT',
    });
  });
});

describe('teacher student boundaries', () => {
  it.each([
    { ownerId: 'injected' },
    { profileId: 'injected' },
    { mastery: 100 },
    { nickname: '' },
    { nickname: 'x'.repeat(81) },
    { grade: 0 },
    { grade: 13 },
    { grade: '9' },
    { examYear: 2101 },
    { region: '' },
    { region: 'x'.repeat(101) },
    { requestId: 'not-a-uuid' },
  ])('rejects invalid and unauthorized fields: %j', (invalid) => {
    expect(() => parseCreateTeacherStudentRequest({ ...REQUEST, ...invalid })).toThrow(
      'TEACHER_STUDENT_INPUT_INVALID',
    );
  });

  it('preserves old profile validation and permits only a valid optional archive timestamp', () => {
    const profile = createInitialStudentProfile({
      profileId: 'fictional-existing',
      createdAt: NOW,
    });
    expect(validateStudentProfile(profile).valid).toBe(true);
    expect(validateStudentProfile({ ...profile, archivedAt: NOW }).valid).toBe(true);
    expect(validateStudentProfile({ ...profile, archivedAt: null }).valid).toBe(false);
    expect(validateStudentProfile({ ...profile, archivedAt: 'yesterday' }).valid).toBe(false);
  });
});
