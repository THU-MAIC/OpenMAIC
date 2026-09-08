import { BrowserRuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createClientVisibleRuntimeStore,
  handlePersistenceRequest,
} from '@/app/api/persistence/[...path]/route';
import { isServerOnlyRuntimeSession } from '@/lib/persistence/runtime-access';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { createTeacherStudent } from '@/lib/server/teacher/students';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import {
  saveStudentProfile,
  studentProfileRuntimeSessionId,
  zhongkaoStageId,
} from '@/lib/zhongkao/runtime';
import { ZHONGKAO_RUNTIME_KINDS } from '@/lib/zhongkao/runtime-kinds';

const NOW = '2026-09-08T08:00:00.000Z';
const OWNER = 'fictional-teacher-access';
const LEARNER = resolveZhongkaoLearnerKeyFromOwnerId(OWNER);
const PROFILE = `teacher-student:v1:${'a'.repeat(64)}`;

beforeAll(() => vi.stubGlobal('IDBKeyRange', IDBKeyRange));
afterEach(() => vi.unstubAllEnvs());

function session(profileId = PROFILE) {
  return {
    id: studentProfileRuntimeSessionId(profileId, LEARNER),
    kind: ZHONGKAO_RUNTIME_KINDS.studentProfile,
    stageId: zhongkaoStageId(profileId),
    learnerKey: LEARNER,
    status: 'active' as const,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('teacher profile access through generic persistence', () => {
  it('reserves teacher profile stages and canonical IDs independently of supplied kind', () => {
    expect(isServerOnlyRuntimeSession(session())).toBe(true);
    expect(isServerOnlyRuntimeSession({ ...session(), kind: 'chat' })).toBe(true);
    expect(isServerOnlyRuntimeSession({ ...session(), kind: 'chat', stageId: 'unrelated' })).toBe(
      true,
    );
    expect(isServerOnlyRuntimeSession({ ...session(), id: 'unrelated' })).toBe(true);
    expect(isServerOnlyRuntimeSession(session('fictional-original-student'))).toBe(false);
    expect(isServerOnlyRuntimeSession({ kind: 'chat', id: 'normal', stageId: 'normal' })).toBe(
      false,
    );
    expect(isServerOnlyRuntimeSession(null)).toBe(false);
  });

  it('rejects teacher session creation before database initialization, including disguised kinds', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://unused-fictional-access');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'fictional-token');
    const poolFactory = vi.fn();
    for (const body of [
      session(),
      { ...session(), kind: 'chat', stageId: 'unrelated' },
      { ...session(), id: 'unrelated' },
    ]) {
      const response = await handlePersistenceRequest(
        new Request('http://localhost/api/persistence/runtime/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { poolFactory },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'SESSION_NOT_FOUND' } });
    }
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it('hides teacher records from every generic read/write/delete while leaving original profiles usable', async () => {
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: `teacher-access-${Math.random()}`,
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
    const { student } = await createTeacherStudent(
      { store, ownerId: OWNER, now: () => NOW },
      {
        requestId: '13fe7cc0-4fd9-4ad4-8455-105c97352dd5',
        nickname: 'Fictional protected student',
        grade: null,
        examYear: null,
        region: null,
      },
    );
    const profileId = student.profile.profileId;
    const identity = session(profileId);
    const client = createClientVisibleRuntimeStore(store);
    const recordCount = (await store.listRecords(identity.id)).length;
    expect(await client.getSession(identity.id)).toBeUndefined();
    expect(await client.listSessions(identity.stageId, LEARNER)).toEqual([]);
    expect(await client.listRecords(identity.id)).toEqual([]);
    await expect(client.createSession(session())).rejects.toThrow('runtime session not found');
    await expect(
      client.appendRecord({
        id: 'injected-profile',
        sessionId: identity.id,
        createdAt: NOW,
        payload: student.profile,
      }),
    ).rejects.toThrow('runtime session not found');
    await expect(client.setSessionStatus(identity.id, 'completed', NOW)).rejects.toThrow(
      'runtime session not found',
    );
    await client.deleteSession(identity.id);
    await client.deleteLearnerRuntime(identity.stageId, LEARNER);
    expect(await store.getSession(identity.id)).toMatchObject({ status: 'active' });
    expect(await store.listRecords(identity.id)).toHaveLength(recordCount);

    const original = createInitialStudentProfile({
      profileId: 'fictional-original-student',
      createdAt: NOW,
    });
    await saveStudentProfile(original, { store: client, learnerKey: LEARNER });
    const originalIdentity = session(original.profileId);
    expect(await client.getSession(originalIdentity.id)).toBeDefined();
    expect(await client.listRecords(originalIdentity.id)).toHaveLength(1);
    await client.deleteLearnerRuntime(originalIdentity.stageId, LEARNER);
    expect(await store.getSession(originalIdentity.id)).toBeUndefined();
    expect(await store.getSession(identity.id)).toBeDefined();
  });
});
