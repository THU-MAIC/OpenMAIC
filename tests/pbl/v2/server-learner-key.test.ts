/**
 * PBL v2 runtime must use the server-derived learner key.
 *
 * The runtime store is the server one, which refuses any learner key other
 * than the request owner's (`403 FORBIDDEN_LEARNER`). The PBL paths keep their
 * drain watermarks in a default device KV store; that store must not also be
 * what the learner key is read or minted from, or saving a course with a PBL
 * v2 scene fails, and a browser-minted key lands in the storage slot the
 * one-way importer reads as "this browser's pre-server runtime partition".
 */
import type {
  RuntimePayload,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
} from '@openmaic/dsl';
import type { RuntimeSessionInit, RuntimeStore } from '@openmaic/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

const SERVER_KEY = 'server-owner-1';
const STAGE_ID = 'stage-pbl-server-key';
const SCENE_ID = 'scene-pbl-server-key';

/** A runtime store that answers like the embedded endpoint: only the owner's key. */
class OwnerOnlyRuntimeStore implements RuntimeStore {
  readonly sessions: RuntimeSession[] = [];
  readonly records: RuntimeRecord[] = [];
  readonly learnerKeysSeen = new Set<string>();

  private requireOwner(learnerKey: string): void {
    this.learnerKeysSeen.add(learnerKey);
    if (learnerKey !== SERVER_KEY) {
      throw Object.assign(new Error('FORBIDDEN_LEARNER'), { status: 403 });
    }
  }

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    this.requireOwner(init.learnerKey);
    const session: RuntimeSession = { ...init, runtimeDslVersion: 'test' };
    this.sessions.push(session);
    return session;
  }

  async getSession(sessionId: string): Promise<RuntimeSession | undefined> {
    return this.sessions.find((session) => session.id === sessionId);
  }

  async listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]> {
    this.requireOwner(learnerKey);
    return this.sessions.filter(
      (session) => session.stageId === stageId && session.learnerKey === learnerKey,
    );
  }

  async setSessionStatus(): Promise<void> {}
  async deleteSession(): Promise<void> {}

  async appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
  ): Promise<RuntimeRecord<TPayload>> {
    const seq = this.records.filter((record) => record.sessionId === init.sessionId).length;
    const record: RuntimeRecord<TPayload> = { ...init, seq };
    this.records.push(record);
    return record;
  }

  async listRecords(sessionId: string): Promise<RuntimeRecord[]> {
    return this.records.filter((record) => record.sessionId === sessionId);
  }

  async mergeLearner(): Promise<number> {
    return 0;
  }
  async deleteLearnerRuntime(): Promise<void> {}
  async deleteStageRuntime(): Promise<void> {}
  async deleteAllRuntime(): Promise<void> {}
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

function makeProject(): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 'Server key project',
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
        microtasks: [
          { id: 'mt-1', title: 'Task 1', status: 'todo', assignee: 'user', hints: [], order: 0 },
        ],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [
      {
        agentId: 'role-i',
        messages: [
          {
            id: 'msg-1',
            roleType: 'user',
            content: 'Learner state that must reach the server',
            ts: '2026-05-29T00:00:01.000Z',
            microtaskId: 'mt-1',
          },
        ],
      },
    ],
    engagementEvents: [],
    runtimeEvents: [],
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
  } as PBLProjectV2;
}

let storage: Storage;
let store: OwnerOnlyRuntimeStore;

beforeEach(async () => {
  vi.resetModules();
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  store = new OwnerOnlyRuntimeStore();
  const { configureRuntimeStorage, resetRuntimeStorageForTests } =
    await import('@/lib/runtime/store');
  resetRuntimeStorageForTests();
  configureRuntimeStorage({ store, learnerKey: async () => SERVER_KEY });
});

afterEach(async () => {
  const { resetRuntimeStorageForTests } = await import('@/lib/runtime/store');
  resetRuntimeStorageForTests();
  vi.unstubAllGlobals();
});

/** No key under the device learner-key slot: nothing was minted in this browser. */
function mintedLearnerKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)!;
    if (key.includes('runtime.learnerKey')) keys.push(key);
  }
  return keys;
}

describe('PBL v2 runtime under server persistence', () => {
  it('saves (synchronizes) a PBL v2 scene under the server key and mints nothing', async () => {
    const { synchronizePBLProjectRuntime } = await import('@/lib/pbl/v2/runtime/hydration');

    await expect(
      synchronizePBLProjectRuntime({
        stageId: STAGE_ID,
        sceneId: SCENE_ID,
        project: makeProject(),
      }),
    ).resolves.toBeUndefined();

    expect([...store.learnerKeysSeen]).toEqual([SERVER_KEY]);
    expect(store.records.length).toBeGreaterThan(0);
    expect(mintedLearnerKeys()).toEqual([]);
  });

  it('hydrates and drains under the server key and mints nothing', async () => {
    const { hydratePBLProjectFromRuntime } = await import('@/lib/pbl/v2/runtime/hydration');
    const { drainProjectRuntime } = await import('@/lib/pbl/v2/runtime/drain');

    await hydratePBLProjectFromRuntime({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      project: makeProject(),
    });
    await drainProjectRuntime({ stageId: STAGE_ID, sceneId: SCENE_ID, project: makeProject() });

    expect([...store.learnerKeysSeen]).toEqual([SERVER_KEY]);
    expect(mintedLearnerKeys()).toEqual([]);
  });
});
