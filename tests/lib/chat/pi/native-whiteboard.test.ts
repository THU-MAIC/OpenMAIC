import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { BrowserRuntimeStore, RuntimeAppendConflictError } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { buildNativeWhiteboardTools } from '@/lib/chat/pi/tools/native-whiteboard';
import { settleWhiteboardVisibility } from '@/lib/chat/pi/whiteboard-visibility';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  createWhiteboardRuntimeService,
  type WhiteboardRuntimeService,
} from '@/lib/whiteboard/runtime/store';

const teacher: AgentConfig = {
  id: 'teacher-1',
  name: 'Teacher',
  role: 'teacher',
  persona: 'Teach clearly.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['wb_open', 'wb_draw_text', 'wb_close'],
  priority: 10,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  isDefault: true,
};

function build(
  service: WhiteboardRuntimeService,
  send: Parameters<typeof buildNativeWhiteboardTools>[0]['send'] = vi.fn(async () => {}),
) {
  return {
    send,
    tools: buildNativeWhiteboardTools({
      agent: teacher,
      messageId: 'message-1',
      send,
      service,
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      requestStartManualVisibilityRevision: 3,
    }),
  };
}

function service(overrides: Partial<WhiteboardRuntimeService> = {}): WhiteboardRuntimeService {
  return {
    read: vi.fn(async () => ({ sessionId: null, whiteboard: null, lastSeq: null })),
    append: vi.fn(async (input) => {
      const operation = input.payload.operation;
      if (operation.kind !== 'element_added') throw new Error('unexpected operation');
      const element = { ...operation.element, defaultFontName: 'Canonical Font' };
      return {
        committedSeq: 0,
        replayed: false,
        state: {
          sessionId: 'runtime-session-1',
          lastSeq: 0,
          whiteboard: {
            id: 'runtime-board-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            elements: [element],
          },
        },
      };
    }),
    reconcileOperation: vi.fn(),
    ...overrides,
  };
}

describe('Native RuntimeStore whiteboard tools', () => {
  it('uses actual allowedActions inventory and co-registers wb_read', () => {
    const names = build(service()).tools.map((tool) => tool.name);
    expect(names).toEqual(['wb_read', 'wb_open', 'wb_draw_text', 'wb_close']);

    const readOnly = buildNativeWhiteboardTools({
      agent: { ...teacher, allowedActions: [] },
      messageId: 'message-1',
      send: vi.fn(),
      service: service(),
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      requestStartManualVisibilityRevision: 0,
    });
    expect(readOnly).toEqual([]);
  });

  it.each([null, 0] as const)(
    'returns nextMutation.expectedLastSeq=%s without falsy coercion and keeps closed visibility non-blocking',
    async (lastSeq) => {
      const runtime = service({
        read: vi.fn(async () => ({
          sessionId: lastSeq === null ? null : 'runtime-session-1',
          whiteboard:
            lastSeq === null
              ? null
              : {
                  id: 'runtime-board-1',
                  viewportSize: 1000,
                  viewportRatio: 0.5625,
                  elements: [],
                },
          lastSeq,
        })),
      });
      const send = vi.fn(async (event) => {
        if (event.type === 'whiteboard' && event.data.kind === 'visibility_query') {
          settleWhiteboardVisibility({
            queryId: event.data.queryId,
            stageId: event.data.stageId,
            learnerKey: 'learner-1',
            visibility: 'closed',
          });
        }
      });
      const read = build(runtime, send).tools.find((tool) => tool.name === 'wb_read')!;

      await expect(read.execute('read-1', {})).resolves.toMatchObject({
        details: {
          durable: { lastSeq },
          presentation: { visibility: 'closed' },
          nextMutation: {
            expectedLastSeq: lastSeq,
            drawingAllowedWhenVisibilityClosed: true,
          },
        },
      });
    },
  );

  it('rejects Legacy draw arguments that omit expectedLastSeq or add elementId', () => {
    const draw = build(service()).tools.find((tool) => tool.name === 'wb_draw_text')!;

    expect(
      (draw.parameters as { properties?: { expectedLastSeq?: { description?: string } } })
        .properties?.expectedLastSeq?.description,
    ).toContain('Copy nextMutation.expectedLastSeq exactly');

    expect(() => draw.prepareArguments?.({ content: 'Runtime authority', x: 10, y: 20 })).toThrow(
      'Native whiteboard arguments must match the strict schema.',
    );
    expect(() =>
      draw.prepareArguments?.({
        expectedLastSeq: null,
        content: 'Runtime authority',
        x: 10,
        y: 20,
        elementId: 'legacy-element',
      }),
    ).toThrow('Native whiteboard arguments must match the strict schema.');
  });

  it('commits element_added, returns canonical post-state, and emits only a projection hint', async () => {
    const runtime = service();
    const { tools, send } = build(runtime);
    const draw = tools.find((tool) => tool.name === 'wb_draw_text')!;
    const params = {
      expectedLastSeq: null,
      content: '<unsafe> original ',
      x: 40,
      y: 50,
      width: 300,
      height: 80,
      fontSize: 20,
      color: '#123456',
    };

    expect(draw.prepareArguments?.(params)).toBe(params);
    const result = await draw.execute('draw-1', params);

    expect(runtime.append).toHaveBeenCalledWith({
      stageId: 'stage-1',
      expectedLastSeq: null,
      payload: {
        payloadVersion: 1,
        operationId: expect.any(String),
        operation: {
          kind: 'element_added',
          element: expect.objectContaining({
            id: expect.any(String),
            type: 'text',
            left: 40,
            top: 50,
            content: '<p style="font-size: 20px;">&lt;unsafe&gt; original </p>',
          }),
        },
      },
    });
    expect(send).toHaveBeenCalledWith({
      type: 'whiteboard',
      data: { kind: 'projection', stageId: 'stage-1', lastSeq: 0 },
    });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'action' }));
    expect(result).toMatchObject({
      details: {
        committedSeq: 0,
        lastSeq: 0,
        replayed: false,
        dispatchedAction: true,
        affected: { element: { defaultFontName: 'Canonical Font' } },
      },
    });
  });

  it('keeps host-derived operation and element IDs stable for one logical tool call', async () => {
    const runtime = service();
    const draw = build(runtime).tools.find((tool) => tool.name === 'wb_draw_text')!;
    const params = {
      expectedLastSeq: null,
      content: 'stable identity',
      x: 10,
      y: 20,
    };

    await draw.execute('same-tool-call', params);
    await draw.execute('same-tool-call', params);

    const append = vi.mocked(runtime.append);
    const firstPayload = append.mock.calls[0]![0].payload;
    const secondPayload = append.mock.calls[1]![0].payload;
    expect(secondPayload.operationId).toBe(firstPayload.operationId);
    expect(secondPayload.operation).toEqual(firstPayload.operation);
    expect(firstPayload.operationId).toMatch(/^native-wb-operation:[0-9a-f]{64}$/u);
    expect(firstPayload.operation).toMatchObject({
      kind: 'element_added',
      element: { id: expect.stringMatching(/^native-wb-element:[0-9a-f]{64}$/u) },
    });
  });

  it('exactly replays one logical draw without appending a second record', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    try {
      const store = new BrowserRuntimeStore({
        indexedDB: new IDBFactory(),
        payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
      });
      const runtime = createWhiteboardRuntimeService({
        store,
        resolveLearnerKey: () => 'learner-1',
        withMaintenanceLock: (work) => work(),
      });
      const draw = build(runtime).tools.find((tool) => tool.name === 'wb_draw_text')!;
      const params = {
        expectedLastSeq: null,
        content: 'one logical draw',
        x: 10,
        y: 20,
      };

      await expect(draw.execute('same-tool-call', params)).resolves.toMatchObject({
        details: { committedSeq: 0, replayed: false, dispatchedAction: true },
      });
      await expect(draw.execute('same-tool-call', params)).resolves.toMatchObject({
        details: { committedSeq: 0, replayed: true, dispatchedAction: true },
      });

      const sessions = await store.listSessions('stage-1', 'learner-1');
      expect(sessions).toHaveLength(1);
      await expect(store.listRecords(sessions[0]!.id)).resolves.toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects stale null when the authoritative sequence is zero', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    try {
      const store = new BrowserRuntimeStore({
        indexedDB: new IDBFactory(),
        payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
      });
      const runtime = createWhiteboardRuntimeService({
        store,
        resolveLearnerKey: () => 'learner-1',
        withMaintenanceLock: (work) => work(),
      });
      const draw = build(runtime).tools.find((tool) => tool.name === 'wb_draw_text')!;

      await expect(
        draw.execute('draw-first', {
          expectedLastSeq: null,
          content: 'first',
          x: 10,
          y: 20,
        }),
      ).resolves.toMatchObject({ details: { committedSeq: 0 } });
      await expect(
        draw.execute('draw-stale', {
          expectedLastSeq: null,
          content: 'must not commit',
          x: 30,
          y: 40,
        }),
      ).resolves.toMatchObject({
        isError: true,
        details: { code: 'STALE_STATE', actualLastSeq: 0 },
      });

      const sessions = await store.listSessions('stage-1', 'learner-1');
      await expect(store.listRecords(sessions[0]!.id)).resolves.toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects whitespace and identity/extra fields before append', () => {
    const runtime = service();
    const draw = build(runtime).tools.find((tool) => tool.name === 'wb_draw_text')!;
    expect(() =>
      draw.prepareArguments?.({
        expectedLastSeq: null,
        content: '   ',
        x: 1,
        y: 2,
      }),
    ).toThrow('strict schema');
    expect(() =>
      draw.prepareArguments?.({
        expectedLastSeq: null,
        content: 'valid',
        x: 1,
        y: 2,
        stageId: 'attacker-stage',
      }),
    ).toThrow('strict schema');
    expect(() =>
      draw.prepareArguments?.({
        expectedLastSeq: null,
        content: 'valid',
        x: Number.POSITIVE_INFINITY,
        y: 2,
      }),
    ).toThrow('strict schema');
    expect(() =>
      draw.prepareArguments?.({
        expectedLastSeq: null,
        content: 'valid',
        x: 1,
        y: 2,
        width: 0,
      }),
    ).toThrow('strict schema');
    expect(runtime.append).not.toHaveBeenCalled();
  });

  it('maps CAS conflict to a failed tool result without projection or action observation', async () => {
    const append = vi.fn(async () => {
      throw new RuntimeAppendConflictError('session-1', null, 4);
    });
    const runtime = service({ append });
    const { tools, send } = build(runtime);
    const draw = tools.find((tool) => tool.name === 'wb_draw_text')!;

    const result = await draw.execute('draw-1', {
      expectedLastSeq: null,
      content: 'valid',
      x: 1,
      y: 2,
    });

    expect(result).toMatchObject({
      isError: true,
      details: { code: 'STALE_STATE', actualLastSeq: 4 },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('reconciles an exact committed draw after append settlement becomes uncertain', async () => {
    const append = vi.fn(async () => {
      throw new Error('post-commit fold unavailable');
    });
    const reconcileOperation = vi.fn(async (_stageId, payload) => {
      const operation = payload.operation;
      if (operation.kind !== 'element_added') throw new Error('unexpected operation');
      return {
        status: 'exact' as const,
        committedSeq: 4,
        state: {
          sessionId: 'runtime-session-1',
          lastSeq: 4,
          whiteboard: {
            id: 'runtime-board-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            elements: [operation.element],
          },
        },
      };
    });
    const runtime = service({ append, reconcileOperation });
    const { tools, send } = build(runtime);
    const draw = tools.find((tool) => tool.name === 'wb_draw_text')!;

    const result = await draw.execute('draw-uncertain', {
      expectedLastSeq: null,
      content: 'already committed',
      x: 1,
      y: 2,
    });

    expect(reconcileOperation).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      details: {
        committedSeq: 4,
        lastSeq: 4,
        replayed: true,
        dispatchedAction: true,
      },
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      type: 'whiteboard',
      data: { kind: 'projection', stageId: 'stage-1', lastSeq: 4 },
    });
  });

  it('does not retry append or claim failure when an uncertain draw cannot be reconciled', async () => {
    const append = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const reconcileOperation = vi.fn(async () => ({
      status: 'empty' as const,
      state: { sessionId: null, whiteboard: null, lastSeq: null },
    }));
    const runtime = service({ append, reconcileOperation });
    const { tools, send } = build(runtime);
    const draw = tools.find((tool) => tool.name === 'wb_draw_text')!;

    const result = await draw.execute('draw-uncertain', {
      expectedLastSeq: null,
      content: 'uncertain result',
      x: 1,
      y: 2,
    });

    expect(append).toHaveBeenCalledOnce();
    expect(reconcileOperation).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      isError: true,
      details: { code: 'WHITEBOARD_MUTATION_FAILED' },
      content: [
        expect.objectContaining({ text: expect.stringContaining('could not be confirmed') }),
      ],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps learner and Stage partitions disjoint through the Native tool path', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    try {
      const store = new BrowserRuntimeStore({
        indexedDB: new IDBFactory(),
        payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
      });
      const serviceFor = (learnerKey: string) =>
        createWhiteboardRuntimeService({
          store,
          resolveLearnerKey: () => learnerKey,
          withMaintenanceLock: (work) => work(),
        });
      const learnerA = serviceFor('learner-a');
      const learnerB = serviceFor('learner-b');
      const drawFor = (
        runtime: WhiteboardRuntimeService,
        learnerKey: string,
        stageId: string,
        messageId: string,
      ) =>
        buildNativeWhiteboardTools({
          agent: teacher,
          messageId,
          send: vi.fn(async () => {}),
          service: runtime,
          stageId,
          learnerKey,
          requestStartManualVisibilityRevision: 0,
        }).find((tool) => tool.name === 'wb_draw_text')!;

      await drawFor(learnerA, 'learner-a', 'stage-1', 'message-a1').execute('draw-a1', {
        expectedLastSeq: null,
        content: 'learner A, stage 1',
        x: 1,
        y: 1,
      });
      await drawFor(learnerB, 'learner-b', 'stage-1', 'message-b1').execute('draw-b1', {
        expectedLastSeq: null,
        content: 'learner B, stage 1',
        x: 2,
        y: 2,
      });
      await drawFor(learnerA, 'learner-a', 'stage-2', 'message-a2').execute('draw-a2', {
        expectedLastSeq: null,
        content: 'learner A, stage 2',
        x: 3,
        y: 3,
      });

      const content = async (runtime: WhiteboardRuntimeService, stageId: string) =>
        (await runtime.read(stageId)).whiteboard?.elements.map((element) =>
          element.type === 'text' ? element.content : '',
        );
      await expect(content(learnerA, 'stage-1')).resolves.toEqual([
        expect.stringContaining('learner A, stage 1'),
      ]);
      await expect(content(learnerB, 'stage-1')).resolves.toEqual([
        expect.stringContaining('learner B, stage 1'),
      ]);
      await expect(content(learnerA, 'stage-2')).resolves.toEqual([
        expect.stringContaining('learner A, stage 2'),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps open and close UI-only while using existing action observation', async () => {
    const runtime = service();
    const { tools, send } = build(runtime);
    const open = tools.find((tool) => tool.name === 'wb_open')!;
    const close = tools.find((tool) => tool.name === 'wb_close')!;

    await expect(open.execute('open-1', {})).resolves.toMatchObject({
      details: { actionName: 'wb_open', dispatchedAction: true },
    });
    await expect(close.execute('close-1', {})).resolves.toMatchObject({
      details: { actionName: 'wb_close', dispatchedAction: true },
    });
    expect(send).toHaveBeenNthCalledWith(1, {
      type: 'whiteboard',
      data: {
        kind: 'open',
        stageId: 'stage-1',
        manualVisibilityRevision: 3,
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: 'whiteboard',
      data: {
        kind: 'close',
        stageId: 'stage-1',
        manualVisibilityRevision: 3,
      },
    });
    expect(runtime.append).not.toHaveBeenCalled();
  });
});
