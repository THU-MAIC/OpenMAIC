import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  loadStudentProfile,
  loadStudyAttempts,
  saveStudentProfile,
  saveStudyAttempt,
  zhongkaoRuntimeSessionId,
  zhongkaoStageId,
  ZHONGKAO_RUNTIME_KINDS,
} from '@/lib/zhongkao/runtime';
import { confirmObservedField } from '@/lib/zhongkao/observed-field';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';

import { NOW, studyAttempt } from './fixtures';

const LATER = '2026-08-29T08:00:00.000Z';

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

function harness(): { store: RuntimeStore; nextId: () => string; now: () => string } {
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `zhongkao-runtime-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  let id = 0;
  let seconds = 0;
  return {
    store,
    nextId: () => `record-${++id}`,
    now: () => new Date(Date.parse(NOW) + seconds++ * 1000).toISOString(),
  };
}

function reverseRecordListing(store: RuntimeStore): RuntimeStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'listRecords') {
        return async (...args: Parameters<RuntimeStore['listRecords']>) =>
          (await target.listRecords(...args)).toReversed();
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('zhongkao RuntimeStore adapter', () => {
  it('round-trips a StudentProfile through the existing app-defined kind', async () => {
    const h = harness();
    const profile = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    const deps = {
      store: h.store,
      learnerKey: 'anon:fictional-device',
      now: h.now,
      mintRecordId: h.nextId,
    };

    await expect(loadStudentProfile(profile.profileId, deps)).resolves.toBeUndefined();
    await saveStudentProfile(profile, deps);
    await expect(loadStudentProfile(profile.profileId, { ...deps })).resolves.toEqual(profile);

    const session = await h.store.getSession(
      zhongkaoRuntimeSessionId(
        ZHONGKAO_RUNTIME_KINDS.studentProfile,
        profile.profileId,
        'anon:fictional-device',
      ),
    );
    expect(session).toMatchObject({
      kind: ZHONGKAO_RUNTIME_KINDS.studentProfile,
      stageId: zhongkaoStageId(profile.profileId),
      learnerKey: 'anon:fictional-device',
    });
  });

  it('loads the maximum-seq profile snapshot even when list order is reversed', async () => {
    const h = harness();
    const deps = {
      store: h.store,
      learnerKey: 'anon:fictional-device',
      now: h.now,
      mintRecordId: h.nextId,
    };
    const initial = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    const firstSaved = { ...initial, updatedAt: LATER };
    const secondSaved = {
      ...initial,
      region: confirmObservedField(
        initial.region,
        'fictional-region',
        { type: 'user_input', sourceId: 'fictional-region-input', createdAt: NOW },
        NOW,
      ),
      updatedAt: NOW,
    };

    await saveStudentProfile(firstSaved, deps);
    await saveStudentProfile(secondSaved, { ...deps });
    await expect(
      loadStudentProfile(initial.profileId, {
        ...deps,
        store: reverseRecordListing(h.store),
      }),
    ).resolves.toEqual(secondSaved);

    const sessionId = zhongkaoRuntimeSessionId(
      ZHONGKAO_RUNTIME_KINDS.studentProfile,
      initial.profileId,
      deps.learnerKey,
    );
    expect((await h.store.listRecords(sessionId)).map((record) => record.seq)).toEqual([0, 1]);
  });

  it('handles duplicate profile saves deterministically', async () => {
    const h = harness();
    const profile = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    const deps = {
      store: h.store,
      learnerKey: 'anon:fictional-device',
      now: h.now,
      mintRecordId: h.nextId,
    };

    await saveStudentProfile(profile, deps);
    await saveStudentProfile(profile, { ...deps });
    await expect(loadStudentProfile(profile.profileId, { ...deps })).resolves.toEqual(profile);
    const sessionId = zhongkaoRuntimeSessionId(
      ZHONGKAO_RUNTIME_KINDS.studentProfile,
      profile.profileId,
      deps.learnerKey,
    );
    await expect(h.store.listRecords(sessionId)).resolves.toHaveLength(1);
  });

  it('isolates profile and learner partitions and ignores non-profile records', async () => {
    const h = harness();
    const learnerA = {
      store: h.store,
      learnerKey: 'anon:fictional-device-a',
      now: h.now,
      mintRecordId: h.nextId,
    };
    const learnerB = { ...learnerA, learnerKey: 'anon:fictional-device-b' };
    const alpha = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    const beta = createInitialStudentProfile({ profileId: 'student-beta', createdAt: NOW });

    await saveStudentProfile(alpha, learnerA);
    await saveStudentProfile(beta, { ...learnerA });
    await saveStudyAttempt(studyAttempt({ id: 'non-profile-record' }), { ...learnerA });

    await expect(loadStudentProfile(alpha.profileId, { ...learnerA })).resolves.toEqual(alpha);
    await expect(loadStudentProfile(beta.profileId, { ...learnerA })).resolves.toEqual(beta);
    await expect(loadStudentProfile(alpha.profileId, learnerB)).resolves.toBeUndefined();
  });

  it('round-trips attempts and reads them without a chat/session id', async () => {
    const h = harness();
    const deps = {
      store: h.store,
      learnerKey: 'anon:fictional-device',
      now: h.now,
      mintRecordId: h.nextId,
    };
    const attempt = studyAttempt({ id: 'attempt-round-trip' });
    await saveStudyAttempt(attempt, deps);
    await expect(
      loadStudyAttempts(attempt.profileId, {
        ...deps,
        // A new ordinary chat would have a different id; the learner/profile
        // partition is intentionally the only identity used by this adapter.
      }),
    ).resolves.toEqual([attempt]);

    const secondAttempt = studyAttempt({
      id: 'attempt-second',
      createdAt: '2026-08-29T08:00:00.000Z',
    });
    await saveStudyAttempt(secondAttempt, { ...deps });
    await expect(loadStudyAttempts(attempt.profileId, { ...deps })).resolves.toEqual([
      attempt,
      secondAttempt,
    ]);
  });

  it('is idempotent for the same attempt and isolates profile ids', async () => {
    const h = harness();
    const deps = {
      store: h.store,
      learnerKey: 'anon:fictional-device',
      now: h.now,
      mintRecordId: h.nextId,
    };
    const alpha = studyAttempt({ id: 'same-attempt' });
    const beta = studyAttempt({ id: 'same-attempt', profileId: 'student-beta' });
    await saveStudyAttempt(alpha, deps);
    await saveStudyAttempt(alpha, { ...deps });
    await saveStudyAttempt(beta, { ...deps });
    await expect(loadStudyAttempts('student-alpha', { ...deps })).resolves.toEqual([alpha]);
    await expect(loadStudyAttempts('student-beta', { ...deps })).resolves.toEqual([beta]);
  });

  it('uses encoded stable stage ids and rejects a conflicting attempt id', async () => {
    const h = harness();
    const deps = {
      store: h.store,
      learnerKey: 'anon:fictional-device',
      now: h.now,
      mintRecordId: h.nextId,
    };
    const profileId = 'student/alpha';
    expect(zhongkaoStageId(profileId)).toBe('zhongkao-profile:student%2Falpha');
    const first = studyAttempt({ id: 'conflict', profileId });
    const second = studyAttempt({
      id: 'conflict',
      profileId,
      questionSummary: 'different fictional question',
    });
    await saveStudyAttempt(first, deps);
    await expect(saveStudyAttempt(second, { ...deps })).rejects.toThrow(
      'ZHONGKAO_STUDY_ATTEMPT_CONFLICT',
    );
  });

  it('does not route per-problem coach events through the long-lived session helper', () => {
    expect(() =>
      zhongkaoRuntimeSessionId(
        ZHONGKAO_RUNTIME_KINDS.coachEvent as never,
        'student-alpha',
        'anon:fictional-device',
      ),
    ).toThrow('ZHONGKAO_RUNTIME_KIND_INVALID');
  });

  it('keeps all Zhongkao kinds in the shared validator table', async () => {
    expect(APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.studentProfile]).toBeTypeOf(
      'function',
    );
    expect(APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.studyAttempt]).toBeTypeOf(
      'function',
    );
    expect(APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.coachEvent]).toBeTypeOf(
      'function',
    );
    const profile = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    expect(
      APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.studentProfile]!(profile).valid,
    ).toBe(true);
    expect(
      APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.studyAttempt]!(studyAttempt()).valid,
    ).toBe(true);
    expect(
      APP_RUNTIME_PAYLOAD_VALIDATORS[ZHONGKAO_RUNTIME_KINDS.coachEvent]!({
        schemaVersion: 1,
        eventId: 'coach-event-alpha',
        coachSessionId: 'coach-session-alpha',
        profileId: 'student-alpha',
        eventType: 'coach_started',
        createdAt: NOW,
        agentSessionId: 'agent-chat-alpha',
        sourceUserMessageSeq: 1,
        operationId: 'coach-operation-alpha',
        operationFingerprint: 'a'.repeat(64),
        subjectId: 'math',
        knowledgePointIds: ['linear-equations'],
        questionSource: { type: 'typed' },
        questionText: 'Solve the fictional equation.',
      }).valid,
    ).toBe(true);
  });
});
