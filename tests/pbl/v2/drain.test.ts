import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type {
  RuntimePayload,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
} from '@openmaic/dsl';
import {
  BrowserKVStore,
  BrowserRuntimeStore,
  type KVScope,
  type KVStore,
  type RuntimeSessionInit,
  type RuntimeStore,
} from '@openmaic/storage';

import { applyInstructorEvent } from '@/components/scene-renderers/pbl/v2/apply-instructor-event';
import {
  applyAdvanceProjectPatch,
  buildAdvanceProjectPatch,
} from '@/lib/pbl/v2/operations/advance-patch';
import { advanceMicrotask, startMicrotask } from '@/lib/pbl/v2/operations/progress';
import { addSubmission } from '@/lib/pbl/v2/operations/submission';
import { clearStageDrainWatermarks, drainProjectRuntime } from '@/lib/pbl/v2/runtime/drain';
import { withRuntimeStorageExclusiveLock } from '@/lib/utils/chat-storage-lock';
import {
  enrichPBLRuntimeEvent,
  PBL_RUNTIME_PAYLOAD_VERSION,
  type PBLRuntimeStorePayload,
} from '@/lib/pbl/v2/runtime/record-payloads';
import type { PBLEngagementEvent, PBLProjectV2, PBLRuntimeEvent } from '@/lib/pbl/v2/types';

if (!('IDBKeyRange' in globalThis)) {
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
}

const STAGE_ID = 'stage-1';
const SCENE_ID = 'scene-1';
const LEARNER_KEY = 'anon:test-device';

interface PBLDrainWatermark {
  lastRuntimeEventId?: string;
  lastEngagementEventId?: string;
}

function watermarkKey(stageId = STAGE_ID, sceneId = SCENE_ID, learnerKey = LEARNER_KEY): string {
  return `runtime.pblDrain.${stageId}.${sceneId}.${learnerKey}`;
}

function deterministicPBLSessionId(stageId = STAGE_ID, learnerKey = LEARNER_KEY): string {
  return `pbl-${stageId}-${learnerKey}`;
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, String(value)),
  } as Storage;
}

function serialLockManager(): Pick<LockManager, 'request'> {
  const tails = new Map<string, Promise<void>>();
  return {
    async request<T>(
      name: string,
      optionsOrCallback: LockOptions | (() => Promise<T> | T),
      maybeCallback?: () => Promise<T> | T,
    ): Promise<T> {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(name, current);
      await previous;
      try {
        return await callback();
      } finally {
        release();
        if (tails.get(name) === current) tails.delete(name);
      }
    },
  } as Pick<LockManager, 'request'>;
}

class MemoryKVStore implements KVStore {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string, scope: KVScope = 'account'): Promise<T | null> {
    return (this.values.get(`${scope}:${key}`) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T, scope: KVScope = 'account'): Promise<void> {
    this.values.set(`${scope}:${key}`, value);
  }

  async remove(key: string, scope: KVScope = 'account'): Promise<void> {
    this.values.delete(`${scope}:${key}`);
  }

  async keys(prefix = '', scope: KVScope = 'account'): Promise<string[]> {
    const scopedPrefix = `${scope}:`;
    return [...this.values.keys()]
      .filter((key) => key.startsWith(scopedPrefix))
      .map((key) => key.slice(scopedPrefix.length))
      .filter((key) => key.startsWith(prefix));
  }
}

class MemoryRuntimeStore implements RuntimeStore {
  readonly sessions: RuntimeSession[] = [];
  readonly records: RuntimeRecord[] = [];
  readonly appendAttempts: RuntimeRecordInit[] = [];
  private readonly failOnceIds = new Set<string>();

  failOnceOnRecord(id: string): void {
    this.failOnceIds.add(id);
  }

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    const session: RuntimeSession = { ...init, runtimeDslVersion: 'test' };
    this.sessions.push(session);
    return session;
  }

  async getSession(sessionId: string): Promise<RuntimeSession | undefined> {
    return this.sessions.find((session) => session.id === sessionId);
  }

  async listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]> {
    return this.sessions.filter(
      (session) => session.stageId === stageId && session.learnerKey === learnerKey,
    );
  }

  async setSessionStatus(): Promise<void> {}

  async deleteSession(): Promise<void> {}

  async appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
  ): Promise<RuntimeRecord<TPayload>> {
    this.appendAttempts.push(init);
    if (this.failOnceIds.delete(init.id)) {
      throw new Error(`append failed for ${init.id}`);
    }
    const seq = this.records.filter((record) => record.sessionId === init.sessionId).length;
    const record: RuntimeRecord<TPayload> = { ...init, seq };
    this.records.push(record);
    return record;
  }

  async listRecords(sessionId: string, opts?: { sceneId?: string }): Promise<RuntimeRecord[]> {
    return this.records.filter(
      (record) =>
        record.sessionId === sessionId && (opts?.sceneId ? record.sceneId === opts.sceneId : true),
    );
  }

  async mergeLearner(): Promise<number> {
    return 0;
  }

  async deleteLearnerRuntime(): Promise<void> {}

  async deleteStageRuntime(): Promise<void> {}
  async deleteAllRuntime(): Promise<void> {}
}

class AlreadyExistsRaceStore extends MemoryRuntimeStore {
  private listAttempts = 0;

  constructor(private readonly existing: RuntimeSession) {
    super();
    this.sessions.push(existing);
  }

  async listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]> {
    this.listAttempts += 1;
    if (this.listAttempts === 1) return [];
    return super.listSessions(stageId, learnerKey);
  }

  async createSession(): Promise<RuntimeSession> {
    throw new Error(
      `@openmaic/storage: session ${JSON.stringify(this.existing.id)} already exists`,
    );
  }
}

class SlowFirstAppendStore extends MemoryRuntimeStore {
  readonly appendLog: string[] = [];
  private blocked = false;
  private resolveBlockedAppend: (() => void) | undefined;

  constructor(private readonly slowId: string) {
    super();
  }

  resolveSlowAppend(): void {
    this.resolveBlockedAppend?.();
  }

  async appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
  ): Promise<RuntimeRecord<TPayload>> {
    this.appendLog.push(`start:${init.id}`);
    if (init.id === this.slowId && !this.blocked) {
      this.blocked = true;
      await new Promise<void>((resolve) => {
        this.resolveBlockedAppend = resolve;
      });
    }
    const record = await super.appendRecord(init);
    this.appendLog.push(`finish:${init.id}`);
    return record;
  }
}

function runtimeEvent(id: string, overrides: Partial<PBLRuntimeEvent> = {}): PBLRuntimeEvent {
  return {
    id,
    kind: 'message_created',
    actorType: 'user',
    messageId: `msg-${id}`,
    threadId: 'role-i',
    ts: `2026-05-29T00:00:0${id.slice(-1)}.000Z`,
    ...overrides,
  } as PBLRuntimeEvent;
}

function engagementEvent(
  id: string,
  overrides: Partial<PBLEngagementEvent> = {},
): PBLEngagementEvent {
  return {
    id,
    kind: 'learner_turn',
    microtaskId: 'mt-1',
    milestoneId: 'ms-1',
    ts: `2026-05-29T00:01:0${id.slice(-1)}.000Z`,
    payload: { chars: 12 },
    ...overrides,
  };
}

function recordPayloadEvent(
  payload: RuntimeRecord['payload'],
): PBLRuntimeEvent | PBLEngagementEvent {
  const pblPayload = payload as PBLRuntimeStorePayload;
  if (pblPayload.kind === 'pbl_runtime_event' || pblPayload.kind === 'pbl_engagement_event') {
    return pblPayload.event;
  }
  throw new Error(`unexpected PBL runtime payload ${JSON.stringify(payload)}`);
}

function makeProject(runtimeEvents: PBLRuntimeEvent[]): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 'Runtime drain project',
    description: 'Build something',
    proficiency: 'intermediate',
    language: 'en-US',
    tags: [],
    status: 'active',
    roles: [{ id: 'role-i', type: 'instructor', name: 'Instructor' }],
    milestones: [
      {
        id: 'ms-1',
        title: 'Milestone 1',
        status: 'active',
        order: 0,
        documents: [],
        microtasks: [
          {
            id: 'mt-1',
            title: 'Task 1',
            status: 'todo',
            assignee: 'user',
            hints: [],
            order: 0,
          },
          {
            id: 'mt-2',
            title: 'Task 2',
            status: 'todo',
            assignee: 'user',
            hints: [],
            order: 1,
          },
        ],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [{ agentId: 'role-i', messages: [] }],
    engagementEvents: [],
    runtimeEvents,
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
  };
}

async function readWatermark(kv: KVStore): Promise<PBLDrainWatermark | null> {
  return kv.get<PBLDrainWatermark>(watermarkKey(), 'device');
}

async function drain(project: PBLProjectV2, store: RuntimeStore, kv: KVStore): Promise<void> {
  await drainProjectRuntime({
    stageId: STAGE_ID,
    sceneId: SCENE_ID,
    project,
    store,
    kv,
    learnerKey: LEARNER_KEY,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
});

describe('drainProjectRuntime', () => {
  it('wraps unknown runtime event kinds in a valid runtime payload', () => {
    const futureEvent = {
      id: 'future-1',
      kind: 'future_event_kind',
      actorType: 'system',
      ts: '2026-05-29T00:00:01.000Z',
    } as unknown as PBLRuntimeEvent;

    expect(enrichPBLRuntimeEvent(makeProject([]), futureEvent)).toEqual({
      kind: 'pbl_runtime_event',
      payloadVersion: PBL_RUNTIME_PAYLOAD_VERSION,
      event: futureEvent,
      attachment: null,
      attachmentMissingReason: 'unhandled_event_kind',
    });
  });

  it('creates a pbl runtime session, appends project runtime events, and advances the watermark', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const events = [
      runtimeEvent('evt-1', { milestoneId: 'ms-1', microtaskId: 'mt-1' }),
      runtimeEvent('evt-2', {
        kind: 'status_changed',
        actorType: 'system',
        entityType: 'milestone',
        entityId: 'ms-1',
        from: 'active',
        to: 'completed',
        milestoneId: 'ms-1',
      }),
      runtimeEvent('evt-3', {
        kind: 'proficiency_updated',
        actorType: 'system',
        tier: 'intermediate',
        score: 0.62,
        confidence: 0.9,
      }),
    ];
    const project = makeProject(events);

    await drain(project, store, kv);

    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]).toMatchObject({
      id: deterministicPBLSessionId(),
      kind: 'pbl',
      stageId: STAGE_ID,
      learnerKey: LEARNER_KEY,
      status: 'active',
    });
    expect(Date.parse(store.sessions[0]!.createdAt)).not.toBeNaN();
    expect(store.records).toHaveLength(events.length);
    expect(store.records.map((record) => record.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    expect(store.records.map((record) => record.sessionId)).toEqual([
      store.sessions[0]!.id,
      store.sessions[0]!.id,
      store.sessions[0]!.id,
    ]);
    expect(store.records.map((record) => record.sceneId)).toEqual([SCENE_ID, SCENE_ID, SCENE_ID]);
    expect(store.records.map((record) => record.subAnchor)).toEqual(['mt-1', 'ms-1', undefined]);
    expect(store.records.map((record) => record.createdAt)).toEqual(
      events.map((event) => event.ts),
    );
    expect(store.records.map((record) => recordPayloadEvent(record.payload))).toEqual(events);
    await expect(readWatermark(kv)).resolves.toEqual({ lastRuntimeEventId: 'evt-3' });
  });

  it('enriches id-only runtime events with document content while leaving the outbox unchanged', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject([
      runtimeEvent('evt-msg-1', {
        kind: 'message_created',
        actorType: 'user',
        messageId: 'msg-1',
        threadId: 'role-i',
        microtaskId: 'mt-1',
        milestoneId: 'ms-1',
      }),
      runtimeEvent('evt-sub-1', {
        kind: 'submission_created',
        actorType: 'user',
        submissionId: 'sub-1',
        microtaskId: 'mt-1',
        milestoneId: 'ms-1',
      }),
      runtimeEvent('evt-eval-1', {
        kind: 'evaluation_created',
        actorType: 'system',
        evaluationId: 'eval-1',
        microtaskId: 'mt-1',
        milestoneId: 'ms-1',
      }),
    ]);
    project.threads[0]!.messages.push({
      id: 'msg-1',
      roleType: 'user',
      content: 'Learner message content',
      ts: '2026-05-29T00:00:01.000Z',
      microtaskId: 'mt-1',
    });
    project.submissions.push({
      id: 'sub-1',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      kind: 'text',
      content: 'Submission body',
      createdAt: '2026-05-29T00:00:02.000Z',
    });
    project.evaluations.push({
      id: 'eval-1',
      kind: 'task',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      feedback: 'Evaluation feedback',
      strengths: ['Specific'],
      improvements: [],
      score: 88,
      createdAt: '2026-05-29T00:00:03.000Z',
    });

    const outboxBefore = structuredClone(project.runtimeEvents);
    await drain(project, store, kv);

    expect(project.runtimeEvents).toEqual(outboxBefore);
    expect(store.records.map((record) => (record.payload as PBLRuntimeStorePayload).kind)).toEqual([
      'pbl_runtime_event',
      'pbl_runtime_event',
      'pbl_runtime_event',
    ]);
    expect(store.records[0]!.payload).toEqual({
      kind: 'pbl_runtime_event',
      payloadVersion: 1,
      event: {
        id: 'evt-msg-1',
        kind: 'message_created',
        actorType: 'user',
        messageId: 'msg-1',
        threadId: 'role-i',
        ts: '2026-05-29T00:00:01.000Z',
        microtaskId: 'mt-1',
        milestoneId: 'ms-1',
      },
      attachment: {
        kind: 'message',
        message: {
          id: 'msg-1',
          roleType: 'user',
          content: 'Learner message content',
          ts: '2026-05-29T00:00:01.000Z',
          microtaskId: 'mt-1',
        },
      },
      attachmentMissingReason: undefined,
    });
    expect(store.records[0]!.payload as PBLRuntimeStorePayload).toMatchObject({
      kind: 'pbl_runtime_event',
      event: { id: 'evt-msg-1', messageId: 'msg-1' },
      attachment: {
        kind: 'message',
        message: { id: 'msg-1', content: 'Learner message content' },
      },
    });
    expect(store.records[1]!.payload as PBLRuntimeStorePayload).toMatchObject({
      kind: 'pbl_runtime_event',
      event: { id: 'evt-sub-1', submissionId: 'sub-1' },
      attachment: {
        kind: 'submission',
        submission: { id: 'sub-1', content: 'Submission body' },
      },
    });
    expect(store.records[2]!.payload as PBLRuntimeStorePayload).toMatchObject({
      kind: 'pbl_runtime_event',
      event: { id: 'evt-eval-1', evaluationId: 'eval-1' },
      attachment: {
        kind: 'evaluation',
        evaluation: { id: 'eval-1', feedback: 'Evaluation feedback' },
      },
    });
    expect(JSON.stringify(project.runtimeEvents)).not.toContain('Learner message content');
    expect(JSON.stringify(project.runtimeEvents)).not.toContain('Submission body');
    expect(JSON.stringify(project.runtimeEvents)).not.toContain('Evaluation feedback');
  });

  it('records a null attachment with a reason when referenced content is missing', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject([
      runtimeEvent('evt-missing-message', {
        kind: 'message_created',
        actorType: 'user',
        messageId: 'missing-message',
        threadId: 'role-i',
      }),
    ]);

    await drain(project, store, kv);

    expect(store.records[0]!.payload).toMatchObject({
      kind: 'pbl_runtime_event',
      event: { id: 'evt-missing-message', messageId: 'missing-message' },
      attachment: null,
      attachmentMissingReason: 'message_not_found',
    });
  });

  it('keeps independent watermarks for two PBL scenes on the same stage', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const sceneA = makeProject([runtimeEvent('scene-a-1')]);
    const sceneB = makeProject([runtimeEvent('scene-b-1')]);

    await drainProjectRuntime({
      stageId: STAGE_ID,
      sceneId: 'scene-a',
      project: sceneA,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await drainProjectRuntime({
      stageId: STAGE_ID,
      sceneId: 'scene-b',
      project: sceneB,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await drainProjectRuntime({
      stageId: STAGE_ID,
      sceneId: 'scene-a',
      project: sceneA,
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });

    expect(store.records.map((record) => record.id)).toEqual(['scene-a-1', 'scene-b-1']);
    await expect(
      kv.get<PBLDrainWatermark>(watermarkKey(STAGE_ID, 'scene-a', LEARNER_KEY), 'device'),
    ).resolves.toEqual({ lastRuntimeEventId: 'scene-a-1' });
    await expect(
      kv.get<PBLDrainWatermark>(watermarkKey(STAGE_ID, 'scene-b', LEARNER_KEY), 'device'),
    ).resolves.toEqual({ lastRuntimeEventId: 'scene-b-1' });
  });

  it('keeps independent watermarks for two learners on the same stage and scene', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const learnerA = 'anon:learner-a';
    const learnerB = 'anon:learner-b';
    const projectA = makeProject([runtimeEvent('learner-a-1')]);
    const projectB = makeProject([runtimeEvent('learner-b-1')]);

    await drainProjectRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project: projectA,
      store,
      kv,
      learnerKey: learnerA,
    });
    await drainProjectRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project: projectB,
      store,
      kv,
      learnerKey: learnerB,
    });
    await drainProjectRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project: projectA,
      store,
      kv,
      learnerKey: learnerA,
    });

    expect(store.records.map((record) => record.id)).toEqual(['learner-a-1', 'learner-b-1']);
    await expect(
      kv.get<PBLDrainWatermark>(watermarkKey(STAGE_ID, SCENE_ID, learnerA), 'device'),
    ).resolves.toEqual({ lastRuntimeEventId: 'learner-a-1' });
    await expect(
      kv.get<PBLDrainWatermark>(watermarkKey(STAGE_ID, SCENE_ID, learnerB), 'device'),
    ).resolves.toEqual({ lastRuntimeEventId: 'learner-b-1' });
  });

  it('shares one deterministic pbl session across concurrent first drains', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject([runtimeEvent('evt-1')]);

    await Promise.all([drain(project, store, kv), drain(project, store, kv)]);

    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]?.id).toBe(deterministicPBLSessionId());
    expect(new Set(store.records.map((record) => record.sessionId))).toEqual(
      new Set([deterministicPBLSessionId()]),
    );
    expect(store.records.map((record) => record.id)).toEqual(['evt-1']);
  });

  it('uses the listed pbl session when deterministic create loses an already-exists race', async () => {
    const existing: RuntimeSession = {
      id: deterministicPBLSessionId(),
      kind: 'pbl',
      stageId: STAGE_ID,
      learnerKey: LEARNER_KEY,
      status: 'active',
      createdAt: '2026-05-29T00:00:00.000Z',
      updatedAt: '2026-05-29T00:00:00.000Z',
      runtimeDslVersion: 'test',
    };
    const store = new AlreadyExistsRaceStore(existing);
    const kv = new MemoryKVStore();
    const project = makeProject([runtimeEvent('evt-1')]);

    await drain(project, store, kv);

    expect(store.sessions).toHaveLength(1);
    expect(store.records.map((record) => record.sessionId)).toEqual([existing.id]);
    expect(store.records.map((record) => record.id)).toEqual(['evt-1']);
  });

  it('redrains and repairs the watermark when BrowserKVStore cannot parse the raw value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new MemoryRuntimeStore();
    const storage = memoryStorage();
    const kv = new BrowserKVStore({ storage });
    const project = makeProject([runtimeEvent('evt-1')]);
    const key = watermarkKey();
    storage.setItem(`maic:device:${key}`, '{invalid json');

    await drain(project, store, kv);

    expect(store.records.map((record) => record.id)).toEqual(['evt-1']);
    const raw = storage.getItem(`maic:device:${key}`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ lastRuntimeEventId: 'evt-1' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('clears only device watermarks for the requested stage', async () => {
    const kv = new MemoryKVStore();
    await kv.set<PBLDrainWatermark>(
      watermarkKey('stage-a', 'scene-1', 'learner-1'),
      { lastRuntimeEventId: 'a1' },
      'device',
    );
    await kv.set<PBLDrainWatermark>(
      watermarkKey('stage-a', 'scene-2', 'learner-2'),
      { lastRuntimeEventId: 'a2' },
      'device',
    );
    await kv.set<PBLDrainWatermark>(
      watermarkKey('stage-b', 'scene-1', 'learner-1'),
      { lastRuntimeEventId: 'b1' },
      'device',
    );
    await kv.set<PBLDrainWatermark>(
      watermarkKey('stage-a', 'scene-1', 'learner-1'),
      { lastRuntimeEventId: 'account-a1' },
      'account',
    );

    await clearStageDrainWatermarks('stage-a', kv);

    await expect(
      kv.get<PBLDrainWatermark>(watermarkKey('stage-a', 'scene-1', 'learner-1'), 'device'),
    ).resolves.toBeNull();
    await expect(
      kv.get<PBLDrainWatermark>(watermarkKey('stage-a', 'scene-2', 'learner-2'), 'device'),
    ).resolves.toBeNull();
    await expect(
      kv.get<PBLDrainWatermark>(watermarkKey('stage-b', 'scene-1', 'learner-1'), 'device'),
    ).resolves.toEqual({ lastRuntimeEventId: 'b1' });
    await expect(
      kv.get<PBLDrainWatermark>(watermarkKey('stage-a', 'scene-1', 'learner-1'), 'account'),
    ).resolves.toEqual({ lastRuntimeEventId: 'account-a1' });
  });

  it('does not append anything on a second drain when no runtime events were added', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject([runtimeEvent('evt-1'), runtimeEvent('evt-2')]);

    await drain(project, store, kv);
    await drain(project, store, kv);

    expect(store.records.map((record) => record.id)).toEqual(['evt-1', 'evt-2']);
    expect(store.sessions).toHaveLength(1);
    await expect(readWatermark(kv)).resolves.toEqual({ lastRuntimeEventId: 'evt-2' });
  });

  it('appends only events after the persisted watermark', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject([runtimeEvent('evt-1'), runtimeEvent('evt-2')]);
    await drain(project, store, kv);

    project.runtimeEvents?.push(runtimeEvent('evt-3'), runtimeEvent('evt-4'));
    await drain(project, store, kv);

    expect(store.records.map((record) => record.id)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4']);
    await expect(readWatermark(kv)).resolves.toEqual({ lastRuntimeEventId: 'evt-4' });
  });

  it('never throws when append fails mid-drain and resumes from the last successful event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new MemoryRuntimeStore();
    store.failOnceOnRecord('evt-2');
    const kv = new MemoryKVStore();
    const project = makeProject([
      runtimeEvent('evt-1'),
      runtimeEvent('evt-2'),
      runtimeEvent('evt-3'),
    ]);

    await expect(drain(project, store, kv)).resolves.toBeUndefined();
    expect(store.records.map((record) => record.id)).toEqual(['evt-1']);
    await expect(readWatermark(kv)).resolves.toEqual({ lastRuntimeEventId: 'evt-1' });
    expect(warn).toHaveBeenCalledOnce();

    await expect(drain(project, store, kv)).resolves.toBeUndefined();
    expect(store.records.map((record) => record.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    await expect(readWatermark(kv)).resolves.toEqual({ lastRuntimeEventId: 'evt-3' });
    warn.mockRestore();
  });

  it('keeps same-key drain work serialized after the caller timeout wins', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new SlowFirstAppendStore('evt-slow-1');
    const kv = new MemoryKVStore();
    const stageId = 'stage-timeout';
    const sceneId = 'scene-timeout';

    const first = drainProjectRuntime({
      stageId,
      sceneId,
      project: makeProject([
        runtimeEvent('evt-slow-1'),
        runtimeEvent('evt-slow-2'),
        runtimeEvent('evt-slow-3'),
      ]),
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await vi.waitFor(() => expect(store.appendLog).toEqual(['start:evt-slow-1']));
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(first).resolves.toBeUndefined();

    const second = drainProjectRuntime({
      stageId,
      sceneId,
      project: makeProject([runtimeEvent('evt-recovers')]),
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.appendLog).toEqual(['start:evt-slow-1']);

    store.resolveSlowAppend();
    await vi.waitFor(() => expect(store.appendLog).toContain('start:evt-recovers'));
    await expect(second).resolves.toBeUndefined();

    expect(store.appendLog.filter((entry) => entry.startsWith('start:'))).toEqual([
      'start:evt-slow-1',
      'start:evt-recovers',
    ]);
    expect(store.records.map((record) => record.id)).toEqual(['evt-slow-1', 'evt-recovers']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps runtime-wide maintenance behind an active PBL drain', async () => {
    vi.stubGlobal('navigator', { locks: serialLockManager() });
    const store = new SlowFirstAppendStore('evt-maintenance-lock');
    const kv = new MemoryKVStore();
    const draining = drainProjectRuntime({
      stageId: 'stage-maintenance-lock',
      sceneId: 'scene-maintenance-lock',
      project: makeProject([runtimeEvent('evt-maintenance-lock')]),
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await vi.waitFor(() => expect(store.appendLog).toEqual(['start:evt-maintenance-lock']));

    let maintenanceStarted = false;
    const maintenance = withRuntimeStorageExclusiveLock(async () => {
      maintenanceStarted = true;
    });
    await Promise.resolve();
    expect(maintenanceStarted).toBe(false);

    store.resolveSlowAppend();
    await draining;
    await maintenance;
    expect(maintenanceStarted).toBe(true);
  });

  it('enrolls queued PBL drains ahead of later runtime maintenance', async () => {
    vi.stubGlobal('navigator', { locks: serialLockManager() });
    const store = new SlowFirstAppendStore('evt-first-enrolled');
    const kv = new MemoryKVStore();
    const stageId = 'stage-queued-maintenance';
    const sceneId = 'scene-queued-maintenance';
    const first = drainProjectRuntime({
      stageId,
      sceneId,
      project: makeProject([runtimeEvent('evt-first-enrolled')]),
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await vi.waitFor(() => expect(store.appendLog).toEqual(['start:evt-first-enrolled']));

    const second = drainProjectRuntime({
      stageId,
      sceneId,
      project: makeProject([runtimeEvent('evt-second-enrolled')]),
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await Promise.resolve();
    const maintenance = withRuntimeStorageExclusiveLock(async () => {
      store.records.splice(0);
      store.sessions.splice(0);
    });

    store.resolveSlowAppend();
    await Promise.all([first, second, maintenance]);

    expect(store.records).toEqual([]);
    expect(store.sessions).toEqual([]);
  });

  it('does not permanently block later drains after a queued append times out', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new SlowFirstAppendStore('evt-hangs');
    const kv = new MemoryKVStore();
    const stageId = 'stage-timeout-recovery';
    const sceneId = 'scene-timeout-recovery';

    const first = drainProjectRuntime({
      stageId,
      sceneId,
      project: makeProject([runtimeEvent('evt-hangs')]),
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await vi.waitFor(() => expect(store.appendLog).toEqual(['start:evt-hangs']));
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(first).resolves.toBeUndefined();
    store.resolveSlowAppend();

    const second = drainProjectRuntime({
      stageId,
      sceneId,
      project: makeProject([runtimeEvent('evt-recovers')]),
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await vi.waitFor(() =>
      expect(store.appendAttempts.map((attempt) => attempt.id)).toContain('evt-recovers'),
    );
    await expect(second).resolves.toBeUndefined();

    expect(store.records.map((record) => record.id)).toEqual(['evt-hangs', 'evt-recovers']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('releases same-key drains after a hung append and keeps late duplicate state consistent', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new SlowFirstAppendStore('evt-1');
    const kv = new MemoryKVStore();
    const stageId = 'stage-hard-cap';
    const sceneId = 'scene-hard-cap';

    const first = drainProjectRuntime({
      stageId,
      sceneId,
      project: makeProject([runtimeEvent('evt-1')]),
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await vi.waitFor(() => expect(store.appendLog).toEqual(['start:evt-1']));
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(first).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(4_000);
    const second = drainProjectRuntime({
      stageId,
      sceneId,
      project: makeProject([runtimeEvent('evt-1'), runtimeEvent('evt-2')]),
      store,
      kv,
      learnerKey: LEARNER_KEY,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(store.appendLog).toEqual(['start:evt-1']);

    await vi.advanceTimersByTimeAsync(2_001);
    await vi.waitFor(() =>
      expect(store.appendLog.filter((entry) => entry === 'start:evt-1')).toHaveLength(2),
    );
    await expect(second).resolves.toBeUndefined();

    expect(store.records.map((record) => record.id)).toEqual(['evt-1', 'evt-2']);
    await expect(
      kv.get<PBLDrainWatermark>(watermarkKey(stageId, sceneId, LEARNER_KEY), 'device'),
    ).resolves.toEqual({ lastRuntimeEventId: 'evt-2' });

    store.resolveSlowAppend();
    await vi.waitFor(() =>
      expect(store.appendLog.filter((entry) => entry === 'finish:evt-1')).toHaveLength(2),
    );
    await vi.advanceTimersByTimeAsync(20_000);

    expect(store.records.map((record) => record.id)).toEqual(['evt-1', 'evt-2', 'evt-1']);
    await expect(
      kv.get<PBLDrainWatermark>(watermarkKey(stageId, sceneId, LEARNER_KEY), 'device'),
    ).resolves.toEqual({ lastRuntimeEventId: 'evt-2' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('redrains the whole visible ledger when the watermark event id is no longer present', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject([runtimeEvent('evt-1'), runtimeEvent('evt-2')]);
    await drain(project, store, kv);
    await kv.set<PBLDrainWatermark>(watermarkKey(), { lastRuntimeEventId: 'evicted' }, 'device');

    await drain(project, store, kv);

    expect(store.records.map((record) => record.id)).toEqual(['evt-1', 'evt-2', 'evt-1', 'evt-2']);
    await expect(readWatermark(kv)).resolves.toEqual({ lastRuntimeEventId: 'evt-2' });
  });

  it('redrains the whole visible engagement ledger when its watermark event id is no longer present', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject([runtimeEvent('evt-1')]);
    project.engagementEvents.push(engagementEvent('eng-1'), engagementEvent('eng-2'));
    await drain(project, store, kv);
    await kv.set<PBLDrainWatermark>(
      watermarkKey(),
      { lastRuntimeEventId: 'evt-1', lastEngagementEventId: 'evicted' },
      'device',
    );

    await drain(project, store, kv);

    expect(store.records.map((record) => record.id)).toEqual([
      'evt-1',
      'eng-1',
      'eng-2',
      'eng-1',
      'eng-2',
    ]);
    await expect(readWatermark(kv)).resolves.toEqual({
      lastRuntimeEventId: 'evt-1',
      lastEngagementEventId: 'eng-2',
    });
  });

  it('persists runtime progress when engagement draining fails and resumes engagement later', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new MemoryRuntimeStore();
    store.failOnceOnRecord('eng-1');
    const kv = new MemoryKVStore();
    const project = makeProject([runtimeEvent('evt-1')]);
    project.engagementEvents.push(engagementEvent('eng-1'), engagementEvent('eng-2'));

    await expect(drain(project, store, kv)).resolves.toBeUndefined();
    expect(store.records.map((record) => record.id)).toEqual(['evt-1']);
    await expect(readWatermark(kv)).resolves.toEqual({ lastRuntimeEventId: 'evt-1' });
    expect(warn).toHaveBeenCalledOnce();

    await expect(drain(project, store, kv)).resolves.toBeUndefined();
    expect(store.records.map((record) => record.id)).toEqual(['evt-1', 'eng-1', 'eng-2']);
    await expect(readWatermark(kv)).resolves.toEqual({
      lastRuntimeEventId: 'evt-1',
      lastEngagementEventId: 'eng-2',
    });
    warn.mockRestore();
  });

  it('drains runtime and engagement records in global chronological order', async () => {
    const store = new MemoryRuntimeStore();
    const kv = new MemoryKVStore();
    const project = makeProject([
      runtimeEvent('rt-late', { ts: '2026-05-29T00:00:04.000Z' }),
      runtimeEvent('rt-early', { ts: '2026-05-29T00:00:01.000Z' }),
      runtimeEvent('rt-tie', { ts: '2026-05-29T00:00:03.000Z' }),
    ]);
    project.engagementEvents.push(
      engagementEvent('eng-middle', { ts: '2026-05-29T00:00:02.000Z' }),
      engagementEvent('eng-tie', { ts: '2026-05-29T00:00:03.000Z' }),
    );

    await drain(project, store, kv);

    expect(store.records.map((record) => record.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(store.records.map((record) => record.id)).toEqual([
      'rt-early',
      'eng-middle',
      'rt-tie',
      'eng-tie',
      'rt-late',
    ]);
    await expect(readWatermark(kv)).resolves.toEqual({
      lastRuntimeEventId: 'rt-late',
      lastEngagementEventId: 'eng-tie',
    });
  });

  it('drains runtime and engagement ledgers from a realistic reducer sequence into one browser session', async () => {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const kv = new MemoryKVStore();
    let project = makeProject([]);
    let draft = '';

    startMicrotask(project, 'mt-1');
    project = applyInstructorEvent(
      {
        type: 'project_patch',
        patch: {
          kind: 'message',
          message: {
            id: 'msg-instructor-1',
            agentId: 'role-i',
            roleType: 'instructor',
            content: 'Start by sketching the loop invariant.',
            ts: '2026-05-29T00:00:01.000Z',
            microtaskId: 'mt-1',
          },
        },
      },
      project,
      (fn) => {
        draft = fn(draft);
      },
    );
    addSubmission(project, {
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      kind: 'text',
      content: 'The invariant is preserved after each iteration.',
    });

    const serverProject = structuredClone(project) as PBLProjectV2;
    const advance = advanceMicrotask(serverProject, 'mt-1', 'learner completed the draft', {
      problems: '',
      resolution: 'Clear explanation',
      performance: 'ready for the next task',
    });
    expect(advance.ok).toBe(true);
    const patch = buildAdvanceProjectPatch(serverProject, {
      microtaskId: 'mt-1',
      milestoneCompleted: advance.ok ? advance.milestoneCompleted : false,
      projectCompleted: advance.ok ? advance.projectCompleted : false,
      nextMicrotaskId: advance.ok ? advance.nextMicrotaskId : undefined,
      shouldEvaluateTask: false,
    });
    applyAdvanceProjectPatch(project, patch);

    const runtimeEvents = project.runtimeEvents ?? [];
    const engagementEvents = project.engagementEvents;
    const expectedEvents = [
      ...runtimeEvents.map((event, index) => ({ event, ledger: 'runtime' as const, index })),
      ...engagementEvents.map((event, index) => ({
        event,
        ledger: 'engagement' as const,
        index,
      })),
    ]
      .sort((a, b) => {
        const byTimestamp = a.event.ts.localeCompare(b.event.ts);
        if (byTimestamp !== 0) return byTimestamp;
        if (a.ledger !== b.ledger) return a.ledger === 'runtime' ? -1 : 1;
        return a.index - b.index;
      })
      .map(({ event }) => event) as Array<PBLRuntimeEvent | PBLEngagementEvent>;

    await drain(project, store, kv);

    const sessions = await store.listSessions(STAGE_ID, LEARNER_KEY);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      kind: 'pbl',
      stageId: STAGE_ID,
      learnerKey: LEARNER_KEY,
      status: 'active',
    });

    const records = await store.listRecords(sessions[0]!.id);
    expect(records.map((record) => record.seq)).toEqual(expectedEvents.map((_, index) => index));
    expect(records.map((record) => record.id)).toEqual(expectedEvents.map((event) => event.id));
    expect(records.map((record) => recordPayloadEvent(record.payload))).toEqual(expectedEvents);
    expect(
      records.map((record) => ({
        kind: recordPayloadEvent(record.payload).kind,
        id: recordPayloadEvent(record.payload).id,
      })),
    ).toEqual(expectedEvents.map((event) => ({ kind: event.kind, id: event.id })));
    expect(records.map((record) => record.sceneId)).toEqual(expectedEvents.map(() => SCENE_ID));
    expect(records.map((record) => record.subAnchor)).toEqual(
      expectedEvents.map((event) =>
        'actorType' in event ? (event.microtaskId ?? event.milestoneId) : event.microtaskId,
      ),
    );
    expect(records.map((record) => record.createdAt)).toEqual(
      expectedEvents.map((event) => event.ts),
    );
    await expect(readWatermark(kv)).resolves.toEqual({
      lastRuntimeEventId: runtimeEvents.at(-1)?.id,
      lastEngagementEventId: engagementEvents.at(-1)?.id,
    });
  });
});
