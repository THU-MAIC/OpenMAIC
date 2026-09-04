import { BrowserRuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deriveConfirmedExamObservationId,
  deriveExamObservationOccasionId,
  type ConfirmedExamObservationV1,
} from '@/lib/zhongkao/exam-observation';
import { ExamError } from '@/lib/zhongkao/exam-errors';
import type { ExamCreatedDocument, ExamCreatedEvent } from '@/lib/zhongkao/exam-event';
import { deriveKnowledgeProgressFromEvidence } from '@/lib/zhongkao/progress';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';

import { studyAttempt } from './fixtures';

const mocks = vi.hoisted(() => ({
  loadStudentProfile: vi.fn(),
  loadStudyAttempts: vi.fn(),
  listProfileExamRuntimeSnapshots: vi.fn(),
  loadExamRuntime: vi.fn(),
  resolveConfirmedExamObservationsFromRuntime: vi.fn(),
}));

vi.mock('@/lib/zhongkao/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/zhongkao/runtime')>()),
  loadStudentProfile: mocks.loadStudentProfile,
  loadStudyAttempts: mocks.loadStudyAttempts,
}));

vi.mock('@/lib/server/zhongkao/exam-runtime', () => ({
  listProfileExamRuntimeSnapshots: mocks.listProfileExamRuntimeSnapshots,
  loadExamRuntime: mocks.loadExamRuntime,
}));

vi.mock('@/lib/server/zhongkao/exam-knowledge-mapping-service', () => ({
  resolveConfirmedExamObservationsFromRuntime: mocks.resolveConfirmedExamObservationsFromRuntime,
}));

import { collectKnowledgeProgressEvidence } from '@/lib/server/zhongkao/progress-evidence-service';

const PROFILE_ID = 'fictional-progress-profile';
const EXAM_ID = `exam:v1:${'a'.repeat(64)}`;
const OBSERVED_AT = '2026-09-01T08:00:00.000Z';

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

async function rewriteSessionRow(
  indexedDB: IDBFactory,
  dbName: string,
  sessionId: string,
  rewrite: (row: Record<string, unknown>) => void,
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('sessions', 'readwrite');
    const sessions = transaction.objectStore('sessions');
    const request = sessions.get(sessionId);
    request.onsuccess = () => {
      const row = request.result as Record<string, unknown>;
      rewrite(row);
      sessions.put(row);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

function snapshot(
  examSessionId: string,
  status: 'ready_for_extraction' | 'deleting' | 'deleted' = 'ready_for_extraction',
  projected = true,
  profileId = PROFILE_ID,
) {
  return {
    state: {
      examSessionId,
      profileId,
      status,
      ...(projected ? { observationProjection: { status: 'completed' } } : {}),
    },
  };
}

function observation(examSessionId = EXAM_ID): ConfirmedExamObservationV1 {
  const mappingFingerprint = 'b'.repeat(64);
  const assessmentFingerprint = 'c'.repeat(64);
  return {
    schemaVersion: 1,
    observationId: deriveConfirmedExamObservationId({
      examSessionId,
      confirmedQuestionId: 'confirmed-question-1',
      mappingFingerprint,
      assessmentFingerprint,
    }),
    profileId: PROFILE_ID,
    examSessionId,
    confirmedQuestionId: 'confirmed-question-1',
    subjectId: 'math',
    knowledgePointIds: ['linear-equations'],
    occasionId: deriveExamObservationOccasionId(examSessionId),
    observedAt: OBSERVED_AT,
    mappingSource: 'owner_confirmed_manual_mapping',
    assessmentStatus: 'evaluated',
    outcome: 'incorrect',
  };
}

function deps() {
  return {
    ownerId: 'fictional-progress-owner',
    store: { marker: 'store' },
    withExamMutationLock: async <T>(_key: string, work: () => Promise<T>) => work(),
  } as never;
}

beforeEach(() => {
  mocks.loadStudentProfile.mockReset().mockResolvedValue({ profileId: PROFILE_ID });
  mocks.loadStudyAttempts.mockReset().mockResolvedValue([]);
  mocks.listProfileExamRuntimeSnapshots.mockReset().mockResolvedValue([]);
  mocks.loadExamRuntime.mockReset();
  mocks.resolveConfirmedExamObservationsFromRuntime.mockReset();
});

describe('profile-wide KnowledgeProgress evidence collection', () => {
  it('merges StudyAttempts with complete active Exam observations deterministically', async () => {
    const attempt = {
      id: 'attempt-before-exam',
      createdAt: '2026-08-31T08:00:00.000Z',
    };
    const active = snapshot(EXAM_ID);
    mocks.loadStudyAttempts.mockResolvedValueOnce([attempt]);
    mocks.listProfileExamRuntimeSnapshots.mockResolvedValueOnce([active]);
    mocks.loadExamRuntime.mockResolvedValueOnce(active);
    mocks.resolveConfirmedExamObservationsFromRuntime.mockResolvedValueOnce({
      observations: [observation()],
    });

    const result = await collectKnowledgeProgressEvidence(deps(), PROFILE_ID);
    expect(result).toMatchObject({
      profileId: PROFILE_ID,
      studyAttemptCount: 1,
      examObservationCount: 1,
      activeExamCount: 1,
    });
    expect(result.evidence.map((item) => item.sourceKind)).toEqual([
      'study_attempt',
      'exam_observation',
    ]);
  });

  it('ignores corrupt non-authoritative knowledge suggestions while preserving evidence semantics', async () => {
    const attempt = studyAttempt({
      id: 'attempt-before-suggestions',
      profileId: PROFILE_ID,
      createdAt: '2026-08-31T08:00:00.000Z',
    });
    const confirmedObservation = observation();
    const suggestionStateRead = vi.fn();
    const active = snapshot(EXAM_ID);
    Object.assign(active.state, {
      knowledgeSuggestions: new Proxy(
        {
          status: 'completed',
          suggestionArtifact: { sha256: 'corrupt', byteLength: -1 },
        },
        {
          get(target, property, receiver) {
            suggestionStateRead(property);
            return Reflect.get(target, property, receiver);
          },
        },
      ),
    });
    const suggestionArtifactRead = vi.fn().mockResolvedValue(Buffer.from('{not-json', 'utf8'));
    const trustedDeps = {
      ownerId: 'fictional-progress-owner',
      store: { marker: 'store' },
      byteStore: { get: suggestionArtifactRead },
      withExamMutationLock: async <T>(_key: string, work: () => Promise<T>) => work(),
    } as never;
    mocks.loadStudyAttempts.mockResolvedValueOnce([attempt]);
    mocks.listProfileExamRuntimeSnapshots.mockResolvedValueOnce([active]);
    mocks.loadExamRuntime.mockResolvedValueOnce(active);
    mocks.resolveConfirmedExamObservationsFromRuntime.mockResolvedValueOnce({
      observations: [confirmedObservation],
    });

    const result = await collectKnowledgeProgressEvidence(trustedDeps, PROFILE_ID);
    const progressInput = {
      profileId: PROFILE_ID,
      subjectId: 'math',
      knowledgePointId: 'linear-equations',
    };
    const authoritativeOnly = deriveKnowledgeProgressFromEvidence({
      ...progressInput,
      evidence: [
        { sourceKind: 'study_attempt', attempt },
        { sourceKind: 'exam_observation', observation: confirmedObservation },
      ],
    });

    expect(suggestionStateRead).not.toHaveBeenCalled();
    expect(suggestionArtifactRead).not.toHaveBeenCalled();
    expect(
      deriveKnowledgeProgressFromEvidence({ ...progressInput, evidence: result.evidence }),
    ).toEqual(authoritativeOnly);
    expect(authoritativeOnly).toMatchObject({
      state: 'weak',
      attempts: 1,
      incorrectObservationCount: 2,
      examObservationCount: 1,
      examOccasionCount: 1,
    });
  });

  it('excludes deleting, deleted, incomplete, and foreign-profile Exam evidence', async () => {
    mocks.listProfileExamRuntimeSnapshots.mockResolvedValueOnce([
      snapshot(`exam:v1:${'b'.repeat(64)}`, 'deleting'),
      snapshot(`exam:v1:${'c'.repeat(64)}`, 'deleted'),
      snapshot(`exam:v1:${'d'.repeat(64)}`, 'ready_for_extraction', false),
      snapshot(`exam:v1:${'e'.repeat(64)}`, 'ready_for_extraction', true, 'other-profile'),
    ]);

    const result = await collectKnowledgeProgressEvidence(deps(), PROFILE_ID);
    expect(result.examObservationCount).toBe(0);
    expect(result.activeExamCount).toBe(0);
    expect(mocks.loadExamRuntime).not.toHaveBeenCalled();
  });

  it('rechecks state under the Exam lock so delete-first removes evidence', async () => {
    const listed = snapshot(EXAM_ID);
    mocks.listProfileExamRuntimeSnapshots.mockResolvedValueOnce([listed]);
    mocks.loadExamRuntime.mockResolvedValueOnce(snapshot(EXAM_ID, 'deleted'));

    const result = await collectKnowledgeProgressEvidence(deps(), PROFILE_ID);
    expect(result.examObservationCount).toBe(0);
    expect(mocks.resolveConfirmedExamObservationsFromRuntime).not.toHaveBeenCalled();
  });

  it('removes previously collected Exam evidence after the Exam is deleted and evidence is recomputed', async () => {
    const active = snapshot(EXAM_ID);
    mocks.listProfileExamRuntimeSnapshots.mockResolvedValueOnce([active]).mockResolvedValueOnce([]);
    mocks.loadExamRuntime.mockResolvedValueOnce(active);
    mocks.resolveConfirmedExamObservationsFromRuntime.mockResolvedValueOnce({
      observations: [observation()],
    });

    const beforeDelete = await collectKnowledgeProgressEvidence(deps(), PROFILE_ID);
    const afterDelete = await collectKnowledgeProgressEvidence(deps(), PROFILE_ID);

    expect(beforeDelete.examObservationCount).toBe(1);
    expect(beforeDelete.evidence).toHaveLength(1);
    expect(afterDelete.examObservationCount).toBe(0);
    expect(afterDelete.evidence).toEqual([]);
  });

  it('collects multiple active Exams and orders equal-time observations by deterministic id', async () => {
    const laterId = `exam:v1:${'f'.repeat(64)}`;
    const first = snapshot(EXAM_ID);
    const second = snapshot(laterId);
    const firstObservation = observation(EXAM_ID);
    const secondObservation = observation(laterId);
    mocks.listProfileExamRuntimeSnapshots.mockResolvedValueOnce([second, first]);
    mocks.loadExamRuntime.mockImplementation(async (_deps: unknown, examSessionId: string) =>
      examSessionId === EXAM_ID ? first : second,
    );
    mocks.resolveConfirmedExamObservationsFromRuntime.mockImplementation(
      async (_deps: unknown, current: ReturnType<typeof snapshot>) => ({
        observations: [
          current.state.examSessionId === EXAM_ID ? firstObservation : secondObservation,
        ],
      }),
    );

    const result = await collectKnowledgeProgressEvidence(deps(), PROFILE_ID);

    expect(result.activeExamCount).toBe(2);
    expect(result.examObservationCount).toBe(2);
    expect(result.evidence.map((item) => item.sourceKind)).toEqual([
      'exam_observation',
      'exam_observation',
    ]);
    const ids = result.evidence.map((item) =>
      item.sourceKind === 'exam_observation' ? item.observation.observationId : '',
    );
    expect(ids).toEqual([...ids].sort());
  });

  it('keeps two Exam errors weak but fails closed when their complete listing is corrupt', async () => {
    const secondExamId = `exam:v1:${'f'.repeat(64)}`;
    const first = snapshot(EXAM_ID);
    const second = snapshot(secondExamId);
    mocks.listProfileExamRuntimeSnapshots.mockResolvedValueOnce([first, second]);
    mocks.loadExamRuntime.mockImplementation(async (_deps: unknown, examSessionId: string) =>
      examSessionId === EXAM_ID ? first : second,
    );
    mocks.resolveConfirmedExamObservationsFromRuntime.mockImplementation(
      async (_deps: unknown, current: ReturnType<typeof snapshot>) => ({
        observations: [observation(current.state.examSessionId)],
      }),
    );

    const complete = await collectKnowledgeProgressEvidence(deps(), PROFILE_ID);
    expect(
      deriveKnowledgeProgressFromEvidence({
        profileId: PROFILE_ID,
        subjectId: 'math',
        knowledgePointId: 'linear-equations',
        evidence: complete.evidence,
      }),
    ).toMatchObject({
      state: 'weak',
      incorrectObservationCount: 2,
      examOccasionCount: 2,
    });

    mocks.listProfileExamRuntimeSnapshots.mockRejectedValueOnce(
      new ExamError('EXAM_EVENT_CONFLICT'),
    );
    await expect(collectKnowledgeProgressEvidence(deps(), PROFILE_ID)).rejects.toMatchObject({
      code: 'EXAM_EVENT_CONFLICT',
    });
  });

  it('rejects instead of returning the remaining Exam when Browser listing omits a corrupt peer', async () => {
    const actualExamRuntime = await vi.importActual<
      typeof import('@/lib/server/zhongkao/exam-runtime')
    >('@/lib/server/zhongkao/exam-runtime');
    const actualProfileRuntime =
      await vi.importActual<typeof import('@/lib/zhongkao/runtime')>('@/lib/zhongkao/runtime');
    const indexedDB = new IDBFactory();
    const dbName = `progress-evidence-corruption-${Math.random()}`;
    const store = new BrowserRuntimeStore({ indexedDB, dbName });
    const ownerId = 'fictional-progress-owner';
    const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(ownerId);

    function createdEvent(clientRequestId: string, sourceSha256: string): ExamCreatedEvent {
      const examSessionId = actualExamRuntime.deriveExamSessionId({
        learnerKey,
        profileId: PROFILE_ID,
        clientRequestId,
      });
      const document: ExamCreatedDocument = {
        examDocumentId: actualExamRuntime.deriveExamDocumentId(examSessionId, 'question_paper'),
        role: 'question_paper',
        ownerMaterialId: `mat_${'0'.repeat(26)}`,
        sourceSha256,
        mimeType: 'application/pdf',
        byteLength: 12,
      };
      const requestFingerprint = actualExamRuntime.createExamRequestFingerprint({
        schemaVersion: 1,
        profileId: PROFILE_ID,
        subjectId: 'math',
        documents: [{ role: document.role, ownerMaterialId: document.ownerMaterialId }],
      });
      const documentSetFingerprint = actualExamRuntime.createExamDocumentSetFingerprint([document]);
      const operationId = actualExamRuntime.deriveExamCreatedOperationId(examSessionId);
      return {
        schemaVersion: 1,
        eventId: actualExamRuntime.deriveExamEventId(operationId),
        examSessionId,
        profileId: PROFILE_ID,
        eventType: 'exam_created',
        createdAt: OBSERVED_AT,
        operationId,
        operationFingerprint: actualExamRuntime.createExamOperationFingerprint({
          action: 'exam_created',
          schemaVersion: 1,
          examSessionId,
          profileId: PROFILE_ID,
          subjectId: 'math',
          requestFingerprint,
          documentSetFingerprint,
          documents: [document],
        }),
        subjectId: 'math',
        requestFingerprint,
        documentSetFingerprint,
        documents: [document],
      };
    }

    const valid = createdEvent('valid-exam-request', 'd'.repeat(64));
    const corrupt = createdEvent('corrupt-exam-request', 'e'.repeat(64));
    await actualExamRuntime.ensureExamRuntimeCreated({ store, ownerId }, valid);
    await actualExamRuntime.ensureExamRuntimeCreated({ store, ownerId }, corrupt);
    await rewriteSessionRow(
      indexedDB,
      dbName,
      actualExamRuntime.examRuntimeSessionId(corrupt.examSessionId),
      (row) => {
        row.createdAt = 'not-iso';
      },
    );

    await expect(
      store.listSessions(actualProfileRuntime.zhongkaoStageId(PROFILE_ID), learnerKey),
    ).resolves.toMatchObject([{ id: actualExamRuntime.examRuntimeSessionId(valid.examSessionId) }]);
    mocks.listProfileExamRuntimeSnapshots.mockImplementationOnce(
      actualExamRuntime.listProfileExamRuntimeSnapshots,
    );

    await expect(
      collectKnowledgeProgressEvidence(
        {
          store,
          ownerId,
          withExamMutationLock: async <T>(_key: string, work: () => Promise<T>) => work(),
        } as never,
        PROFILE_ID,
      ),
    ).rejects.toMatchObject({ code: 'EXAM_EVENT_CONFLICT' });
    expect(mocks.loadExamRuntime).not.toHaveBeenCalled();
  });

  it('fails closed on corrupt active Exam observations instead of returning partial evidence', async () => {
    const active = snapshot(EXAM_ID);
    mocks.listProfileExamRuntimeSnapshots.mockResolvedValueOnce([active]);
    mocks.loadExamRuntime.mockResolvedValueOnce(active);
    mocks.resolveConfirmedExamObservationsFromRuntime.mockRejectedValueOnce(
      new ExamError('EXAM_OBSERVATION_ARTIFACT_CORRUPT'),
    );

    await expect(collectKnowledgeProgressEvidence(deps(), PROFILE_ID)).rejects.toMatchObject({
      code: 'EXAM_OBSERVATION_ARTIFACT_CORRUPT',
    });
  });

  it('fails closed when owner/profile Exam enumeration or a current history is corrupt', async () => {
    mocks.listProfileExamRuntimeSnapshots.mockRejectedValueOnce(
      new ExamError('EXAM_EVENT_CONFLICT'),
    );
    await expect(collectKnowledgeProgressEvidence(deps(), PROFILE_ID)).rejects.toMatchObject({
      code: 'EXAM_EVENT_CONFLICT',
    });

    const active = snapshot(EXAM_ID);
    mocks.listProfileExamRuntimeSnapshots.mockResolvedValueOnce([active]);
    mocks.loadExamRuntime.mockRejectedValueOnce(new ExamError('EXAM_EVENT_CONFLICT'));
    await expect(collectKnowledgeProgressEvidence(deps(), PROFILE_ID)).rejects.toMatchObject({
      code: 'EXAM_EVENT_CONFLICT',
    });
    expect(mocks.resolveConfirmedExamObservationsFromRuntime).not.toHaveBeenCalled();
  });

  it('requires the owner-scoped profile before enumerating evidence', async () => {
    mocks.loadStudentProfile.mockResolvedValueOnce(undefined);
    await expect(collectKnowledgeProgressEvidence(deps(), PROFILE_ID)).rejects.toMatchObject({
      code: 'EXAM_PROFILE_NOT_FOUND',
    });
    expect(mocks.loadStudyAttempts).not.toHaveBeenCalled();
    expect(mocks.listProfileExamRuntimeSnapshots).not.toHaveBeenCalled();
  });

  it('passes the trusted owner deps and requested profile into the server-only Exam enumerator', async () => {
    const trustedDeps = deps();
    await collectKnowledgeProgressEvidence(trustedDeps, PROFILE_ID);
    expect(mocks.listProfileExamRuntimeSnapshots).toHaveBeenCalledExactlyOnceWith(
      trustedDeps,
      PROFILE_ID,
    );
  });
});
