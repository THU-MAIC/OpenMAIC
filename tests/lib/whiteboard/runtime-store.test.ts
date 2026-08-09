import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { PPTElement, Whiteboard } from '@openmaic/dsl';
import {
  BrowserRuntimeStore,
  RuntimeAppendConflictError,
  type RuntimeStore,
} from '@openmaic/storage';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { deleteStageRuntimeSafely } from '@/lib/runtime/store';
import { withRuntimeStorageExclusiveLock } from '@/lib/utils/chat-storage-lock';
import {
  createWhiteboardRuntimeService,
  WhiteboardRuntimeSessionAmbiguousError,
  WhiteboardRuntimeSessionInvariantError,
  whiteboardRuntimeSessionId,
} from '@/lib/whiteboard/runtime/store';
import {
  LEGACY_WHITEBOARD_SOURCE_KIND,
  WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
  type LegacySnapshotImportedOperation,
  type WhiteboardElementAddedOperation,
  type WhiteboardRuntimePayloadV1,
} from '@/lib/whiteboard/runtime/types';

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

function board(id = 'board-1'): Whiteboard {
  return { id, viewportSize: 1000, viewportRatio: 0.5625, elements: [] };
}

type LegacyPayload = WhiteboardRuntimePayloadV1 & {
  operation: LegacySnapshotImportedOperation;
};

type ElementAddedPayload = WhiteboardRuntimePayloadV1 & {
  operation: WhiteboardElementAddedOperation;
};

function textElement(id = 'text-added', content = 'learner text'): PPTElement {
  return {
    id,
    type: 'text',
    left: 40,
    top: 50,
    width: 240,
    height: 60,
    rotate: 0,
    content,
    defaultFontName: 'Inter',
    defaultColor: '#000000',
  };
}

function payload(id = 'operation-1', boardId = 'board-1'): LegacyPayload {
  return {
    payloadVersion: WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
    operationId: id,
    operation: {
      kind: 'legacy_snapshot_imported',
      source: {
        kind: LEGACY_WHITEBOARD_SOURCE_KIND,
        fingerprint: `sha256:${'1'.repeat(64)}`,
      },
      whiteboard: board(boardId),
    },
  };
}

function elementPayload(id = 'element-operation-1', element = textElement()): ElementAddedPayload {
  return {
    payloadVersion: WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
    operationId: id,
    operation: { kind: 'element_added', element },
  };
}

function runtimeStore(): BrowserRuntimeStore {
  return new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
}

function service(store: RuntimeStore, learnerKey = 'learner-1') {
  return createWhiteboardRuntimeService({
    store,
    resolveLearnerKey: () => learnerKey,
    now: () => '2026-08-06T00:00:00.000Z',
    withMaintenanceLock: (work) => work(),
  });
}

describe('whiteboard RuntimeStore service', () => {
  it('creates one deterministic session and commits through required CAS', async () => {
    const store = runtimeStore();
    const runtime = service(store);
    await expect(runtime.read('stage-1')).resolves.toEqual({
      sessionId: null,
      whiteboard: null,
      lastSeq: null,
    });
    const result = await runtime.append({
      stageId: 'stage-1',
      expectedLastSeq: null,
      payload: payload(),
    });
    expect(result).toMatchObject({ committedSeq: 0, replayed: false });
    expect(result.state.whiteboard?.id).toBe('board-1');
    expect(
      await store.getSession(whiteboardRuntimeSessionId('stage-1', 'learner-1')),
    ).toMatchObject({ kind: 'whiteboard', status: 'active' });
  });

  it('commits learner elements into one deterministic session-owned board', async () => {
    const store = runtimeStore();
    const runtime = service(store, 'private-learner');
    const firstInput = {
      stageId: 'stage-1',
      expectedLastSeq: null,
      payload: elementPayload(),
    };
    const first = await runtime.append(firstInput);
    expect(first).toMatchObject({
      committedSeq: 0,
      replayed: false,
      state: {
        whiteboard: {
          id: expect.stringMatching(/^runtime-whiteboard:[0-9a-f]{64}$/u),
          viewportSize: 1000,
          viewportRatio: 0.5625,
          background: { type: 'solid', color: '#ffffff' },
          animations: [],
          elements: [{ id: 'text-added' }],
        },
      },
    });
    expect(first.state.whiteboard?.id).not.toContain('private-learner');
    await expect(runtime.append({ ...firstInput, expectedLastSeq: 99 })).resolves.toMatchObject({
      committedSeq: 0,
      replayed: true,
    });

    const second = await runtime.append({
      stageId: 'stage-1',
      expectedLastSeq: 0,
      payload: elementPayload('element-operation-2', textElement('text-2', 'second')),
    });
    expect(second.state.whiteboard?.id).toBe(first.state.whiteboard?.id);
    expect(second.state.whiteboard?.elements.map((element) => element.id)).toEqual([
      'text-added',
      'text-2',
    ]);
    expect(Object.isFrozen(second.state.whiteboard)).toBe(true);

    const sameIdentity = await service(runtimeStore(), 'private-learner').append(firstInput);
    const otherIdentity = await service(runtimeStore(), 'other-learner').append(firstInput);
    expect(sameIdentity.state.whiteboard?.id).toBe(first.state.whiteboard?.id);
    expect(otherIdentity.state.whiteboard?.id).not.toBe(first.state.whiteboard?.id);
  });

  it('rejects duplicate elements and Legacy-after-learner before persistence', async () => {
    const store = runtimeStore();
    const runtime = service(store);
    await runtime.append({
      stageId: 'stage-1',
      expectedLastSeq: null,
      payload: elementPayload(),
    });
    await expect(
      runtime.append({
        stageId: 'stage-1',
        expectedLastSeq: null,
        payload: elementPayload('element-operation-stale'),
      }),
    ).rejects.toBeInstanceOf(RuntimeAppendConflictError);
    await expect(
      runtime.append({
        stageId: 'stage-1',
        expectedLastSeq: 0,
        payload: elementPayload('element-operation-2'),
      }),
    ).rejects.toThrow('WHITEBOARD_RUNTIME_ELEMENT_ALREADY_EXISTS');
    await expect(
      runtime.append({
        stageId: 'stage-1',
        expectedLastSeq: 0,
        payload: payload('legacy-after-learner'),
      }),
    ).rejects.toThrow('WHITEBOARD_RUNTIME_IMPORT_AFTER_STATE');

    const sessionId = whiteboardRuntimeSessionId('stage-1', 'learner-1');
    expect(await store.listRecords(sessionId)).toHaveLength(1);
    await expect(runtime.read('stage-1')).resolves.toMatchObject({
      lastSeq: 0,
      whiteboard: { elements: [{ id: 'text-added' }] },
    });
  });

  it('preserves imported board metadata when applying a learner element', async () => {
    const imported = payload();
    imported.operation.whiteboard = {
      id: 'board-1',
      viewportSize: 2048,
      viewportRatio: 0.75,
      elements: [textElement('legacy-text', 'legacy')],
      background: { type: 'solid', color: '#123456' },
      animations: [
        {
          id: 'animation-1',
          elId: 'legacy-text',
          effect: 'fadeIn',
          type: 'in',
          duration: 500,
          trigger: 'click',
        },
      ],
      script: 'preserve this script',
    };
    const runtime = service(runtimeStore());
    await runtime.append({ stageId: 'stage-1', expectedLastSeq: null, payload: imported });
    const result = await runtime.append({
      stageId: 'stage-1',
      expectedLastSeq: 0,
      payload: elementPayload(),
    });
    expect(result.state.whiteboard).toMatchObject({
      id: 'board-1',
      viewportSize: 2048,
      viewportRatio: 0.75,
      background: { type: 'solid', color: '#123456' },
      animations: [
        {
          id: 'animation-1',
          elId: 'legacy-text',
          effect: 'fadeIn',
          type: 'in',
          duration: 500,
          trigger: 'click',
        },
      ],
      script: 'preserve this script',
    });
    expect(result.state.whiteboard?.elements.map((element) => element.id)).toEqual([
      'legacy-text',
      'text-added',
    ]);
  });

  it('detaches a learner element before the first async boundary', async () => {
    const runtime = service(runtimeStore());
    const mutable = elementPayload();
    const pending = runtime.append({
      stageId: 'stage-1',
      expectedLastSeq: null,
      payload: mutable,
    });
    mutable.operation.element.id = 'mutated-after-call';
    mutable.operation.element.left = 999;
    const result = await pending;
    expect(result.state.whiteboard?.elements[0]).toMatchObject({ id: 'text-added', left: 40 });
  });

  it('replays an exact committed operation and rejects a conflicting retry', async () => {
    const runtime = service(runtimeStore());
    const input = { stageId: 'stage-1', expectedLastSeq: null, payload: payload() };
    await runtime.append(input);
    await expect(runtime.append(input)).resolves.toMatchObject({ committedSeq: 0, replayed: true });
    await expect(
      runtime.append({ ...input, payload: payload('operation-1', 'board-other') }),
    ).rejects.toThrow('WHITEBOARD_RUNTIME_OPERATION_CONFLICT');
  });

  it('rejects a conflicting learner operation id without changing committed state', async () => {
    const store = runtimeStore();
    const runtime = service(store);
    const first = elementPayload('element-operation-conflict', textElement('text-a', 'first'));
    await runtime.append({ stageId: 'stage-1', expectedLastSeq: null, payload: first });

    await expect(
      runtime.append({
        stageId: 'stage-1',
        expectedLastSeq: 0,
        payload: elementPayload('element-operation-conflict', textElement('text-b', 'conflicting')),
      }),
    ).rejects.toThrow('WHITEBOARD_RUNTIME_OPERATION_CONFLICT');

    const sessionId = whiteboardRuntimeSessionId('stage-1', 'learner-1');
    expect(await store.listRecords(sessionId)).toHaveLength(1);
    await expect(runtime.read('stage-1')).resolves.toMatchObject({
      lastSeq: 0,
      whiteboard: { elements: [{ id: 'text-a', content: 'first' }] },
    });
  });

  it('rejects inherited payload fields before persistence', async () => {
    const store = runtimeStore();
    const runtime = service(store);
    const inherited = {
      payloadVersion: WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
      operationId: 'inherited-operation',
      operation: elementPayload().operation,
    };
    const previous = new Map(
      Object.keys(inherited).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(Object.prototype, key),
      ]),
    );
    let attempt: ReturnType<typeof runtime.append>;
    try {
      for (const [key, value] of Object.entries(inherited)) {
        Object.defineProperty(Object.prototype, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      attempt = runtime.append({
        stageId: 'stage-1',
        expectedLastSeq: null,
        payload: {} as WhiteboardRuntimePayloadV1,
      });
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
        else delete (Object.prototype as Record<string, unknown>)[key];
      }
    }

    await expect(attempt!).rejects.toThrow('Invalid whiteboard runtime payload');
    expect(
      await store.listRecords(whiteboardRuntimeSessionId('stage-1', 'learner-1')),
    ).toHaveLength(0);
  });

  it('preserves RuntimeAppendConflictError and commits no stale record', async () => {
    const store = runtimeStore();
    const runtime = service(store);
    await runtime.append({ stageId: 'stage-1', expectedLastSeq: null, payload: payload() });
    await expect(
      runtime.append({
        stageId: 'stage-1',
        expectedLastSeq: null,
        payload: payload('operation-2', 'board-2'),
      }),
    ).rejects.toBeInstanceOf(RuntimeAppendConflictError);
    expect(
      await store.listRecords(whiteboardRuntimeSessionId('stage-1', 'learner-1')),
    ).toHaveLength(1);
  });

  it('rejects an anticipated tail before persistence while preserving exact replay', async () => {
    const store = runtimeStore();
    const runtime = service(store);
    await expect(
      runtime.append({
        stageId: 'stage-1',
        expectedLastSeq: 0,
        payload: payload(),
      }),
    ).rejects.toBeInstanceOf(RuntimeAppendConflictError);
    expect(
      await store.listRecords(whiteboardRuntimeSessionId('stage-1', 'learner-1')),
    ).toHaveLength(0);

    await runtime.append({ stageId: 'stage-1', expectedLastSeq: null, payload: payload() });
    await expect(
      runtime.append({ stageId: 'stage-1', expectedLastSeq: 99, payload: payload() }),
    ).resolves.toMatchObject({ committedSeq: 0, replayed: true });
    expect(
      await store.listRecords(whiteboardRuntimeSessionId('stage-1', 'learner-1')),
    ).toHaveLength(1);
  });

  it('rejects a second distinct legacy import before persistence', async () => {
    const store = runtimeStore();
    const runtime = service(store);
    await runtime.append({ stageId: 'stage-1', expectedLastSeq: null, payload: payload() });

    await expect(
      runtime.append({
        stageId: 'stage-1',
        expectedLastSeq: 0,
        payload: payload('operation-2', 'board-2'),
      }),
    ).rejects.toThrow('WHITEBOARD_RUNTIME_IMPORT_AFTER_STATE');

    const sessionId = whiteboardRuntimeSessionId('stage-1', 'learner-1');
    expect(await store.listRecords(sessionId)).toHaveLength(1);
    await expect(runtime.read('stage-1')).resolves.toMatchObject({
      sessionId,
      whiteboard: { id: 'board-1' },
      lastSeq: 0,
    });
  });

  it('recovers a committed response loss without appending twice', async () => {
    const backing = runtimeStore();
    let first = true;
    const lossy: RuntimeStore = {
      ...backing,
      createSession: backing.createSession.bind(backing),
      getSession: backing.getSession.bind(backing),
      listSessions: backing.listSessions.bind(backing),
      setSessionStatus: backing.setSessionStatus.bind(backing),
      deleteSession: backing.deleteSession.bind(backing),
      listRecords: backing.listRecords.bind(backing),
      mergeLearner: backing.mergeLearner.bind(backing),
      deleteLearnerRuntime: backing.deleteLearnerRuntime.bind(backing),
      deleteStageRuntime: backing.deleteStageRuntime.bind(backing),
      deleteAllRuntime: backing.deleteAllRuntime.bind(backing),
      appendRecord: async (...args) => {
        const committed = await backing.appendRecord(...args);
        if (first) {
          first = false;
          throw new Error('response lost');
        }
        return committed;
      },
    };
    await expect(
      service(lossy).append({
        stageId: 'stage-1',
        expectedLastSeq: null,
        payload: payload(),
      }),
    ).resolves.toMatchObject({ committedSeq: 0, replayed: true });
    expect(
      await backing.listRecords(whiteboardRuntimeSessionId('stage-1', 'learner-1')),
    ).toHaveLength(1);
  });

  it('keeps a recoverable empty shell when the first append fails and always supplies CAS', async () => {
    const backing = runtimeStore();
    let fail = true;
    const seenOptions: unknown[] = [];
    const wrapped: RuntimeStore = {
      ...backing,
      createSession: backing.createSession.bind(backing),
      getSession: backing.getSession.bind(backing),
      listSessions: backing.listSessions.bind(backing),
      setSessionStatus: backing.setSessionStatus.bind(backing),
      deleteSession: backing.deleteSession.bind(backing),
      listRecords: backing.listRecords.bind(backing),
      mergeLearner: backing.mergeLearner.bind(backing),
      deleteLearnerRuntime: backing.deleteLearnerRuntime.bind(backing),
      deleteStageRuntime: backing.deleteStageRuntime.bind(backing),
      deleteAllRuntime: backing.deleteAllRuntime.bind(backing),
      appendRecord: async (init, options) => {
        seenOptions.push(options);
        if (fail) {
          fail = false;
          throw new Error('append unavailable');
        }
        return backing.appendRecord(init, options);
      },
    };
    const runtime = service(wrapped);
    await expect(
      runtime.append({ stageId: 'stage-1', expectedLastSeq: null, payload: payload() }),
    ).rejects.toThrow('append unavailable');
    await expect(runtime.read('stage-1')).resolves.toMatchObject({
      sessionId: whiteboardRuntimeSessionId('stage-1', 'learner-1'),
      whiteboard: null,
      lastSeq: null,
    });
    await expect(
      runtime.append({ stageId: 'stage-1', expectedLastSeq: null, payload: payload() }),
    ).resolves.toMatchObject({ committedSeq: 0 });
    expect(seenOptions).toEqual([{ expectedLastSeq: null }, { expectedLastSeq: null }]);
  });

  it('detaches caller-owned payload before the first async boundary', async () => {
    const store = runtimeStore();
    const runtime = service(store);
    const mutable = payload();
    const pending = runtime.append({ stageId: 'stage-1', expectedLastSeq: null, payload: mutable });
    mutable.operation.whiteboard.id = 'mutated';
    await pending;
    expect((await runtime.read('stage-1')).whiteboard?.id).toBe('board-1');
  });

  it.each(['payload', 'whiteboard'] as const)(
    'rejects an own __proto__ key on the %s before persistence',
    async (target) => {
      const store = runtimeStore();
      const runtime = service(store);
      const candidate = payload();
      const object = target === 'payload' ? candidate : candidate.operation.whiteboard;
      Object.defineProperty(object, '__proto__', {
        value: null,
        enumerable: true,
        writable: true,
        configurable: true,
      });

      await expect(
        runtime.append({
          stageId: 'stage-1',
          expectedLastSeq: null,
          payload: candidate,
        }),
      ).rejects.toThrow('Invalid whiteboard runtime payload');
      expect(
        await store.listRecords(whiteboardRuntimeSessionId('stage-1', 'learner-1')),
      ).toHaveLength(0);
    },
  );

  it('uses only the trusted service learner identity even if input has an extra learnerKey', async () => {
    const store = runtimeStore();
    const runtime = service(store, 'trusted-learner');
    await runtime.append({
      stageId: 'stage-1',
      expectedLastSeq: null,
      payload: payload(),
      learnerKey: 'attacker-selected-learner',
    } as Parameters<typeof runtime.append>[0] & { learnerKey: string });

    expect(await store.listSessions('stage-1', 'trusted-learner')).toHaveLength(1);
    expect(await store.listSessions('stage-1', 'attacker-selected-learner')).toEqual([]);
  });

  it('converges concurrent deterministic session creation and recovers a lost create response', async () => {
    const backing = runtimeStore();
    let entrants = 0;
    let releaseCreates!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreates = resolve;
    });
    const racing = new Proxy(backing, {
      get(target, property) {
        if (property === 'createSession') {
          return async (...args: Parameters<RuntimeStore['createSession']>) => {
            entrants += 1;
            if (entrants === 2) releaseCreates();
            await createGate;
            return target.createSession(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    const first = service(racing);
    const second = service(racing);
    const results = await Promise.all([
      first.append({ stageId: 'stage-1', expectedLastSeq: null, payload: payload() }),
      second.append({ stageId: 'stage-1', expectedLastSeq: null, payload: payload() }),
    ]);
    expect(results.every((result) => result.committedSeq === 0)).toBe(true);
    expect(await backing.listSessions('stage-1', 'learner-1')).toHaveLength(1);
    expect(
      await backing.listRecords(whiteboardRuntimeSessionId('stage-1', 'learner-1')),
    ).toHaveLength(1);

    const lostBacking = runtimeStore();
    let loseResponse = true;
    const lossyCreate = new Proxy(lostBacking, {
      get(target, property) {
        if (property === 'createSession') {
          return async (...args: Parameters<RuntimeStore['createSession']>) => {
            const created = await target.createSession(...args);
            if (loseResponse) {
              loseResponse = false;
              throw new Error('create response lost');
            }
            return created;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    await expect(
      service(lossyCreate).append({
        stageId: 'stage-2',
        expectedLastSeq: null,
        payload: payload('lost-create-operation'),
      }),
    ).resolves.toMatchObject({ committedSeq: 0, replayed: false });
    expect(await lostBacking.listSessions('stage-2', 'learner-1')).toHaveLength(1);
  });

  it('fails closed for multiple active and inactive whiteboard sessions', async () => {
    const ambiguous = runtimeStore();
    for (const id of ['one', 'two']) {
      await ambiguous.createSession({
        id,
        kind: 'whiteboard',
        stageId: 'stage-1',
        learnerKey: 'learner-1',
        status: 'active',
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:00.000Z',
      });
    }
    await expect(service(ambiguous).read('stage-1')).rejects.toBeInstanceOf(
      WhiteboardRuntimeSessionAmbiguousError,
    );

    const inactive = runtimeStore();
    await inactive.createSession({
      id: whiteboardRuntimeSessionId('stage-1', 'learner-1'),
      kind: 'whiteboard',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'completed',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
    });
    await expect(service(inactive).read('stage-1')).rejects.toBeInstanceOf(
      WhiteboardRuntimeSessionInvariantError,
    );

    const mixed = runtimeStore();
    await mixed.createSession({
      id: 'active',
      kind: 'whiteboard',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
    });
    await mixed.createSession({
      id: 'inactive',
      kind: 'whiteboard',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'archived',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
    });
    await expect(service(mixed).read('stage-1')).rejects.toBeInstanceOf(
      WhiteboardRuntimeSessionInvariantError,
    );
  });

  it('validates a deterministic create-race winner and reuses a merge-rekeyed active session', async () => {
    const wrong = runtimeStore();
    await wrong.createSession({
      id: whiteboardRuntimeSessionId('stage-1', 'learner-1'),
      kind: 'chat',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
    });
    await expect(service(wrong).read('stage-1')).rejects.toBeInstanceOf(
      WhiteboardRuntimeSessionInvariantError,
    );

    const merged = runtimeStore();
    const oldRuntime = service(merged, 'old-learner');
    await oldRuntime.append({ stageId: 'stage-1', expectedLastSeq: null, payload: payload() });
    await merged.mergeLearner('old-learner', 'new-learner');
    expect((await service(merged, 'new-learner').read('stage-1')).whiteboard?.id).toBe('board-1');
    expect(await merged.listSessions('stage-1', 'new-learner')).toHaveLength(1);
  });

  it('successful same-ID cleanup yields empty state while failed cleanup retains state', async () => {
    const store = runtimeStore();
    const runtime = service(store);
    await runtime.append({ stageId: 'stage-1', expectedLastSeq: null, payload: payload() });
    await store.deleteStageRuntime('stage-1');
    await expect(runtime.read('stage-1')).resolves.toEqual({
      sessionId: null,
      whiteboard: null,
      lastSeq: null,
    });

    await runtime.append({ stageId: 'stage-1', expectedLastSeq: null, payload: payload() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = { ...store, deleteStageRuntime: vi.fn().mockRejectedValue(new Error('failed')) };
    await expect(
      deleteStageRuntimeSafely('stage-1', failed as unknown as RuntimeStore),
    ).resolves.toBeUndefined();
    expect((await runtime.read('stage-1')).whiteboard?.id).toBe('board-1');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('shares the maintenance lock with destructive Stage cleanup', async () => {
    vi.stubGlobal('window', {});
    const backing = runtimeStore();
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendEntered = false;
    const delayed: RuntimeStore = {
      ...backing,
      createSession: backing.createSession.bind(backing),
      getSession: backing.getSession.bind(backing),
      listSessions: backing.listSessions.bind(backing),
      setSessionStatus: backing.setSessionStatus.bind(backing),
      deleteSession: backing.deleteSession.bind(backing),
      listRecords: backing.listRecords.bind(backing),
      mergeLearner: backing.mergeLearner.bind(backing),
      deleteLearnerRuntime: backing.deleteLearnerRuntime.bind(backing),
      deleteStageRuntime: backing.deleteStageRuntime.bind(backing),
      deleteAllRuntime: backing.deleteAllRuntime.bind(backing),
      appendRecord: async (...args) => {
        appendEntered = true;
        await appendGate;
        return backing.appendRecord(...args);
      },
    };
    const runtime = createWhiteboardRuntimeService({
      store: delayed,
      resolveLearnerKey: () => 'learner-1',
      now: () => '2026-08-06T00:00:00.000Z',
    });
    const append = runtime.append({
      stageId: 'stage-1',
      expectedLastSeq: null,
      payload: payload(),
    });
    await vi.waitFor(() => expect(appendEntered).toBe(true));
    let cleanupEntered = false;
    const cleanup = withRuntimeStorageExclusiveLock(async () => {
      cleanupEntered = true;
      await backing.deleteStageRuntime('stage-1');
    });
    await Promise.resolve();
    expect(cleanupEntered).toBe(false);
    releaseAppend();
    await append;
    await cleanup;
    expect(cleanupEntered).toBe(true);
    await expect(runtime.read('stage-1')).resolves.toEqual({
      sessionId: null,
      whiteboard: null,
      lastSeq: null,
    });
  });
});
