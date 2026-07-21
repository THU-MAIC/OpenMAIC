import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import {
  backfillQuizAttempt,
  createQuizAttemptWriter,
  recordQuizAttempt,
  type QuizAttemptRuntimeDeps,
} from '@/lib/quiz/runtime';
import type { QuestionResult } from '@/lib/quiz/grading';

const results: QuestionResult[] = [
  { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
];

function makeHarness(): { store: RuntimeStore; deps: QuizAttemptRuntimeDeps } {
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `quiz-runtime-${Math.random()}`,
  });
  let tick = 0;
  return {
    store,
    deps: {
      store,
      learnerKey: 'learner-1',
      now: () => new Date(Date.UTC(2026, 6, 14, 12, 0, tick++)).toISOString(),
      mintRecordId: () => `record-${tick}`,
    },
  };
}

function wrapStore(store: RuntimeStore, overrides: Partial<RuntimeStore>): RuntimeStore {
  return new Proxy(store, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof RuntimeStore];
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('quiz attempt runtime persistence', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'IDBKeyRange', {
      configurable: true,
      value: IDBKeyRange,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid draft changes into one latest snapshot', async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    const writer = createQuizAttemptWriter({ debounceMs: 500, write });
    const base = {
      stageId: 'stage-1',
      sceneId: 'scene-quiz',
      attemptId: 'attempt-1',
    };

    writer.scheduleDraft({ ...base, answers: { q1: 'A' } });
    writer.scheduleDraft({ ...base, answers: { q1: 'AB' } });
    writer.scheduleDraft({ ...base, answers: { q1: 'ABC' } });

    await vi.advanceTimersByTimeAsync(499);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledExactlyOnceWith({
      ...base,
      phase: 'draft',
      answers: { q1: 'ABC' },
    });
  });

  it('flushes the latest draft to completion before writing submitted', async () => {
    let releaseDraft!: () => void;
    const order: string[] = [];
    const write = vi.fn(async (input: { phase: string }) => {
      order.push(`start:${input.phase}`);
      if (input.phase === 'draft') {
        await new Promise<void>((resolve) => {
          releaseDraft = resolve;
        });
      }
      order.push(`end:${input.phase}`);
    });
    const writer = createQuizAttemptWriter({ write });
    const base = {
      stageId: 'stage-1',
      sceneId: 'scene-quiz',
      attemptId: 'attempt-1',
      answers: { q1: 'A' },
    };

    writer.scheduleDraft(base);
    const submitted = writer.recordPhase({ ...base, phase: 'submitted' });
    await vi.waitFor(() => expect(order).toEqual(['start:draft']));
    releaseDraft();
    await submitted;

    expect(order).toEqual(['start:draft', 'end:draft', 'start:submitted', 'end:submitted']);
  });

  it('recovers when another tab wins the same session create race without Web Locks', async () => {
    const { store } = makeHarness();
    let missingReads = 0;
    let releaseBoth!: () => void;
    const bothMissing = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const racingGet: RuntimeStore['getSession'] = async (sessionId) => {
      const session = await store.getSession(sessionId);
      if (session) return session;
      missingReads += 1;
      if (missingReads === 2) releaseBoth();
      await bothMissing;
      return undefined;
    };
    const tabA = wrapStore(store, { getSession: racingGet });
    const tabB = wrapStore(store, { getSession: racingGet });
    const input = {
      stageId: 'stage-1',
      sceneId: 'scene-quiz',
      attemptId: 'attempt-race',
      phase: 'draft' as const,
      answers: { q1: 'A' },
    };

    await Promise.all([
      recordQuizAttempt(input, {
        store: tabA,
        learnerKey: 'learner-1',
        now: () => '2026-07-14T12:00:00.000Z',
        mintRecordId: () => 'record-a',
      }),
      recordQuizAttempt(input, {
        store: tabB,
        learnerKey: 'learner-1',
        now: () => '2026-07-14T12:00:00.001Z',
        mintRecordId: () => 'record-b',
      }),
    ]);

    expect(await store.listSessions('stage-1', 'learner-1')).toHaveLength(1);
    expect((await store.listRecords('attempt-race')).length).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates concurrent identical lifecycle writes without Web Locks', async () => {
    const { store } = makeHarness();
    await store.createSession({
      id: 'attempt-race',
      kind: 'quizAttempt',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-07-14T12:00:00.000Z',
      updatedAt: '2026-07-14T12:00:00.000Z',
    });
    let emptyReads = 0;
    let releaseBoth!: () => void;
    const bothReadEmpty = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const racingList: RuntimeStore['listRecords'] = async (sessionId, options) => {
      const records = await store.listRecords(sessionId, options);
      if (records.length === 0) {
        emptyReads += 1;
        if (emptyReads === 2) releaseBoth();
        await bothReadEmpty;
      }
      return records;
    };
    const tabA = wrapStore(store, { listRecords: racingList });
    const tabB = wrapStore(store, { listRecords: racingList });
    const input = {
      stageId: 'stage-1',
      sceneId: 'scene-quiz',
      attemptId: 'attempt-race',
      phase: 'submitted' as const,
      answers: { q1: 'A' },
    };

    await Promise.all([
      recordQuizAttempt(input, {
        store: tabA,
        learnerKey: 'learner-1',
        mintRecordId: () => 'record-a',
      }),
      recordQuizAttempt(input, {
        store: tabB,
        learnerKey: 'learner-1',
        mintRecordId: () => 'record-b',
      }),
    ]);

    expect((await store.listRecords('attempt-race')).map((record) => record.payload)).toEqual([
      { payloadVersion: 1, phase: 'submitted', answers: { q1: 'A' } },
    ]);
  });

  it('rolls over when another tab completes after this tab observed active', async () => {
    const { store } = makeHarness();
    await store.createSession({
      id: 'attempt-race',
      kind: 'quizAttempt',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-07-14T12:00:00.000Z',
      updatedAt: '2026-07-14T12:00:00.000Z',
    });
    let appendStarted!: () => void;
    const didStartAppend = new Promise<void>((resolve) => {
      appendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const mayAppend = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const staleTab = wrapStore(store, {
      appendRecord: async (input) => {
        appendStarted();
        await mayAppend;
        return store.appendRecord(input);
      },
    });
    const staleWrite = recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-quiz',
        attemptId: 'attempt-race',
        phase: 'draft',
        answers: { q1: 'B' },
      },
      {
        store: staleTab,
        learnerKey: 'learner-1',
        now: () => '2026-07-14T12:00:00.002Z',
        mintRecordId: () => 'record-stale',
      },
    );
    await didStartAppend;

    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-quiz',
        attemptId: 'attempt-race',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
      {
        store,
        learnerKey: 'learner-1',
        now: () => '2026-07-14T12:00:00.001Z',
        mintRecordId: () => 'record-completed',
      },
    );
    releaseAppend();
    await staleWrite;

    const sessions = await store.listSessions('stage-1', 'learner-1');
    expect(sessions).toHaveLength(2);
    const rollover = sessions.find((session) => session.id !== 'attempt-race');
    expect(rollover?.status).toBe('active');
    expect((await store.listRecords(rollover!.id)).map((record) => record.payload)).toEqual([
      { payloadVersion: 1, phase: 'draft', answers: { q1: 'B' } },
    ]);
  });

  it('does not disguise an unrelated append failure as a completion race', async () => {
    const { store } = makeHarness();
    await store.createSession({
      id: 'attempt-failure',
      kind: 'quizAttempt',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-07-14T12:00:00.000Z',
      updatedAt: '2026-07-14T12:00:00.000Z',
    });
    const failingTab = wrapStore(store, {
      appendRecord: async () => {
        await store.setSessionStatus('attempt-failure', 'completed', '2026-07-14T12:00:00.001Z');
        throw new Error('storage unavailable');
      },
    });

    await expect(
      recordQuizAttempt(
        {
          stageId: 'stage-1',
          sceneId: 'scene-quiz',
          attemptId: 'attempt-failure',
          phase: 'draft',
          answers: { q1: 'B' },
        },
        { store: failingTab, learnerKey: 'learner-1' },
      ),
    ).rejects.toThrow('storage unavailable');
    expect(await store.listSessions('stage-1', 'learner-1')).toHaveLength(1);
  });

  it('rolls stale-tab writes onto a new session after the shared attempt completed', async () => {
    const { store, deps } = makeHarness();
    const base = {
      stageId: 'stage-1',
      sceneId: 'scene-quiz',
      attemptId: 'attempt-shared',
    };
    await recordQuizAttempt({ ...base, phase: 'reviewed', answers: { q1: 'A' }, results }, deps);

    await recordQuizAttempt({ ...base, phase: 'draft', answers: { q1: 'B' } }, deps);
    await recordQuizAttempt({ ...base, phase: 'submitted', answers: { q1: 'B' } }, deps);
    await recordQuizAttempt({ ...base, phase: 'reviewed', answers: { q1: 'B' }, results }, deps);

    const sessions = await store.listSessions('stage-1', 'learner-1');
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.status === 'completed')).toBe(true);
    const rollover = sessions.find((session) => session.id !== 'attempt-shared');
    expect(rollover).toBeDefined();
    expect((await store.listRecords(rollover!.id)).map((record) => record.payload)).toEqual([
      { payloadVersion: 1, phase: 'draft', answers: { q1: 'B' } },
      { payloadVersion: 1, phase: 'submitted', answers: { q1: 'B' } },
      { payloadVersion: 1, phase: 'reviewed', answers: { q1: 'B' }, results },
    ]);
  });

  it('drops a delayed draft with the same answers after another tab completed', async () => {
    const { store, deps } = makeHarness();
    const base = {
      stageId: 'stage-1',
      sceneId: 'scene-quiz',
      attemptId: 'attempt-shared',
      answers: { q1: 'A' },
    };
    await recordQuizAttempt({ ...base, phase: 'reviewed', results }, deps);

    await recordQuizAttempt({ ...base, phase: 'draft' }, deps);

    expect((await store.listSessions('stage-1', 'learner-1')).map((session) => session.id)).toEqual(
      ['attempt-shared'],
    );
    expect((await store.listRecords('attempt-shared')).map((record) => record.payload)).toEqual([
      { payloadVersion: 1, phase: 'reviewed', answers: { q1: 'A' }, results },
    ]);
  });

  it('records the quiz lifecycle in one learner-scoped session', async () => {
    const { store, deps } = makeHarness();
    const base = {
      stageId: 'stage-1',
      sceneId: 'scene-quiz',
      attemptId: 'attempt-1',
    };

    await recordQuizAttempt({ ...base, phase: 'draft', answers: { q1: 'A' } }, deps);
    await recordQuizAttempt({ ...base, phase: 'submitted', answers: { q1: 'A' } }, deps);
    await recordQuizAttempt({ ...base, phase: 'reviewed', answers: { q1: 'A' }, results }, deps);

    const sessions = await store.listSessions('stage-1', 'learner-1');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'attempt-1',
      kind: 'quizAttempt',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'completed',
    });
    const records = await store.listRecords('attempt-1');
    expect(records.map((record) => record.payload)).toEqual([
      { payloadVersion: 1, phase: 'draft', answers: { q1: 'A' } },
      { payloadVersion: 1, phase: 'submitted', answers: { q1: 'A' } },
      { payloadVersion: 1, phase: 'reviewed', answers: { q1: 'A' }, results },
    ]);
    expect(records.every((record) => record.sceneId === 'scene-quiz')).toBe(true);
  });

  it('deduplicates equal writes and ignores stale phase regressions', async () => {
    const { store, deps } = makeHarness();
    const base = {
      stageId: 'stage-1',
      sceneId: 'scene-quiz',
      attemptId: 'attempt-1',
      answers: { q1: 'A' },
    };

    await recordQuizAttempt({ ...base, phase: 'draft' }, deps);
    await recordQuizAttempt({ ...base, phase: 'submitted' }, deps);
    await recordQuizAttempt({ ...base, phase: 'submitted' }, deps);
    await recordQuizAttempt({ ...base, phase: 'draft', answers: { q1: 'B' } }, deps);

    const records = await store.listRecords('attempt-1');
    expect(records.map((record) => record.payload)).toEqual([
      { payloadVersion: 1, phase: 'draft', answers: { q1: 'A' } },
      { payloadVersion: 1, phase: 'submitted', answers: { q1: 'A' } },
    ]);
  });

  it('backfills a reviewed legacy snapshot without clearing or mutating its inputs', async () => {
    const { store, deps } = makeHarness();
    const answers = { q1: 'A' };
    const legacyResults = structuredClone(results);

    await backfillQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-quiz',
        attemptId: 'attempt-legacy',
        submittedAnswers: answers,
        results: legacyResults,
      },
      deps,
    );
    await backfillQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-quiz',
        attemptId: 'attempt-legacy',
        submittedAnswers: answers,
        results: legacyResults,
      },
      deps,
    );

    expect(answers).toEqual({ q1: 'A' });
    expect(legacyResults).toEqual(results);
    expect((await store.getSession('attempt-legacy'))?.status).toBe('completed');
    expect((await store.listRecords('attempt-legacy')).map((record) => record.payload)).toEqual([
      { payloadVersion: 1, phase: 'submitted', answers: { q1: 'A' } },
      {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
    ]);
  });

  it('preserves an explicitly reviewed legacy snapshot with empty results', async () => {
    const { store, deps } = makeHarness();

    await backfillQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-quiz',
        attemptId: 'attempt-empty-results',
        submittedAnswers: { q1: 'A' },
        results: [],
      },
      deps,
    );

    expect((await store.getSession('attempt-empty-results'))?.status).toBe('completed');
    expect(
      (await store.listRecords('attempt-empty-results')).map((record) => record.payload),
    ).toEqual([
      { payloadVersion: 1, phase: 'submitted', answers: { q1: 'A' } },
      { payloadVersion: 1, phase: 'reviewed', answers: { q1: 'A' }, results: [] },
    ]);
  });

  it('heals an active reviewed tail without appending the reviewed fact twice', async () => {
    const { store, deps } = makeHarness();
    await store.createSession({
      id: 'attempt-orphan',
      kind: 'quizAttempt',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-07-14T12:00:00.000Z',
      updatedAt: '2026-07-14T12:00:00.000Z',
    });
    const reviewedPayload = {
      payloadVersion: 1 as const,
      phase: 'reviewed' as const,
      answers: { q1: 'A' },
      results,
    };
    await store.appendRecord({
      id: 'legacy-reviewed',
      sessionId: 'attempt-orphan',
      sceneId: 'scene-quiz',
      createdAt: '2026-07-14T12:00:00.001Z',
      payload: reviewedPayload,
    });

    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-quiz',
        attemptId: 'attempt-orphan',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
      deps,
    );

    expect((await store.getSession('attempt-orphan'))?.status).toBe('completed');
    expect((await store.listRecords('attempt-orphan')).map((record) => record.payload)).toEqual([
      reviewedPayload,
    ]);
  });

  it('keeps repeated attempts in separate sessions', async () => {
    const { store, deps } = makeHarness();

    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-quiz',
        attemptId: 'attempt-1',
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
      deps,
    );
    await recordQuizAttempt(
      {
        stageId: 'stage-1',
        sceneId: 'scene-quiz',
        attemptId: 'attempt-2',
        phase: 'draft',
        answers: { q1: 'B' },
      },
      deps,
    );

    const sessions = await store.listSessions('stage-1', 'learner-1');
    expect(sessions.map((session) => [session.id, session.status])).toEqual([
      ['attempt-1', 'completed'],
      ['attempt-2', 'active'],
    ]);
  });

  it('fails before appending when an attempt id belongs to another runtime partition', async () => {
    const { store, deps } = makeHarness();
    await store.createSession({
      id: 'attempt-1',
      kind: 'quizAttempt',
      stageId: 'other-stage',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-07-14T12:00:00.000Z',
      updatedAt: '2026-07-14T12:00:00.000Z',
    });

    await expect(
      recordQuizAttempt(
        {
          stageId: 'stage-1',
          sceneId: 'scene-quiz',
          attemptId: 'attempt-1',
          phase: 'draft',
          answers: {},
        },
        deps,
      ),
    ).rejects.toThrow('does not belong to stage "stage-1" and learner "learner-1"');
    expect(await store.listRecords('attempt-1')).toEqual([]);
  });
});
