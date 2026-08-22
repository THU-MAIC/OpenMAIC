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
  allowedActions: [
    'wb_open',
    'wb_draw_text',
    'wb_draw_shape',
    'wb_draw_chart',
    'wb_draw_latex',
    'wb_draw_table',
    'wb_draw_line',
    'wb_draw_code',
    'wb_close',
  ],
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
    expect(names).toEqual([
      'wb_read',
      'wb_open',
      'wb_draw_text',
      'wb_draw_shape',
      'wb_draw_chart',
      'wb_draw_latex',
      'wb_draw_table',
      'wb_draw_line',
      'wb_draw_code',
      'wb_close',
    ]);

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

  it('injects the complete read/open/close control plane for an allowed mutation', () => {
    const tools = buildNativeWhiteboardTools({
      agent: { ...teacher, allowedActions: ['wb_draw_shape'] },
      messageId: 'message-1',
      send: vi.fn(),
      service: service(),
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      requestStartManualVisibilityRevision: 0,
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      'wb_read',
      'wb_open',
      'wb_draw_shape',
      'wb_close',
    ]);
  });

  it('tells every mutation tool to open first for a user-visible drawing', () => {
    const mutationTools = build(service()).tools.filter((tool) => tool.name.startsWith('wb_draw_'));

    expect(mutationTools).toHaveLength(7);
    for (const tool of mutationTools) {
      expect(tool.description).toContain(
        'For a user-visible drawing request, call wb_open before this tool',
      );
      expect(tool.description).toContain('this mutation tool never changes visibility itself');
    }
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
      const expectedLastSeqInstruction =
        lastSeq === null
          ? 'Set expectedLastSeq to JSON null exactly.'
          : `Set expectedLastSeq to the JSON number ${lastSeq} exactly; do not use null.`;
      const result = await read.execute('read-1', {});

      expect(result).toMatchObject({
        details: {
          durable: { lastSeq },
          presentation: { visibility: 'closed' },
          nextMutation: {
            expectedLastSeq: lastSeq,
            expectedLastSeqInstruction,
            drawingAllowedWhenVisibilityClosed: true,
          },
        },
      });
      expect(result.content).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining(expectedLastSeqInstruction),
        }),
      ]);
    },
  );

  it('rejects Legacy draw arguments that omit expectedLastSeq or add elementId', () => {
    const draw = build(service()).tools.find((tool) => tool.name === 'wb_draw_text')!;
    const expectedLastSeqSchema = (
      draw.parameters as {
        properties?: {
          expectedLastSeq?: { type?: string[]; minimum?: number; description?: string };
        };
      }
    ).properties?.expectedLastSeq;

    expect(expectedLastSeqSchema).toMatchObject({ type: ['integer', 'null'], minimum: 0 });
    expect(expectedLastSeqSchema?.description).toContain(
      'Copy nextMutation.expectedLastSeq exactly',
    );

    const zeroSeq = { expectedLastSeq: 0, content: 'Runtime authority', x: 10, y: 20 };
    const nullSeq = { expectedLastSeq: null, content: 'Runtime authority', x: 10, y: 20 };
    expect(draw.prepareArguments?.(zeroSeq)).toBe(zeroSeq);
    expect(draw.prepareArguments?.(nullSeq)).toBe(nullSeq);

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

  it('keeps expectedLastSeq required and host-owned identity across every additive schema', () => {
    const tools = build(service()).tools;
    const samples: Record<string, Record<string, unknown>> = {
      wb_draw_shape: { shape: 'rectangle', x: 1, y: 2, width: 30, height: 40 },
      wb_draw_chart: {
        chartType: 'bar',
        x: 1,
        y: 2,
        width: 300,
        height: 200,
        data: { labels: ['A'], legends: ['Value'], series: [[1]] },
      },
      wb_draw_latex: { latex: 'x^2', x: 1, y: 2 },
      wb_draw_table: { x: 1, y: 2, width: 300, height: 120, data: [['A']] },
      wb_draw_line: { startX: 1, startY: 2, endX: 30, endY: 40 },
      wb_draw_code: { language: 'python', code: 'print(1)', x: 1, y: 2 },
    };

    for (const [name, sample] of Object.entries(samples)) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(
        (tool.parameters as { properties?: { expectedLastSeq?: { description?: string } } })
          .properties?.expectedLastSeq?.description,
      ).toContain('Copy nextMutation.expectedLastSeq exactly');
      expect(() => tool.prepareArguments?.(sample)).toThrow('strict schema');
      expect(() =>
        tool.prepareArguments?.({ ...sample, expectedLastSeq: null, elementId: 'model-owned' }),
      ).toThrow('strict schema');
      const valid = { ...sample, expectedLastSeq: null };
      expect(tool.prepareArguments?.(valid)).toBe(valid);
    }
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

  it('commits every remaining additive draw type through the existing element_added contract', async () => {
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
      const tools = build(runtime).tools;
      const draws = [
        {
          name: 'wb_draw_shape',
          params: {
            shape: 'circle',
            x: 40,
            y: 50,
            width: 120,
            height: 120,
            fillColor: '#123456',
          },
        },
        {
          name: 'wb_draw_chart',
          params: {
            chartType: 'bar',
            x: 200,
            y: 50,
            width: 300,
            height: 200,
            data: { labels: ['A'], legends: ['Score'], series: [[3]] },
          },
        },
        {
          name: 'wb_draw_latex',
          params: { latex: 'E = mc^2', x: 40, y: 220, color: '#111111' },
        },
        {
          name: 'wb_draw_table',
          params: {
            x: 300,
            y: 280,
            width: 360,
            height: 160,
            data: [
              ['Name', 'Value'],
              ['A', '3'],
            ],
          },
        },
        {
          name: 'wb_draw_line',
          params: {
            startX: 80,
            startY: 450,
            endX: 260,
            endY: 500,
            points: ['', 'arrow'],
          },
        },
        {
          name: 'wb_draw_code',
          params: {
            language: 'typescript',
            code: 'const answer = 42;\nconsole.log(answer);',
            x: 500,
            y: 40,
          },
        },
      ] as const;

      for (let index = 0; index < draws.length; index += 1) {
        const draw = draws[index]!;
        const tool = tools.find((candidate) => candidate.name === draw.name)!;
        const params = {
          ...draw.params,
          expectedLastSeq: index === 0 ? null : index - 1,
        };
        expect(tool.prepareArguments?.(params)).toBe(params);
        await expect(tool.execute(`draw-${draw.name}`, params)).resolves.toMatchObject({
          details: {
            committedSeq: index,
            lastSeq: index,
            replayed: false,
            dispatchedAction: true,
            affected: { element: { type: draw.name.slice('wb_draw_'.length) } },
          },
        });
      }

      const state = await runtime.read('stage-1');
      expect(state.whiteboard?.elements).toEqual([
        expect.objectContaining({
          type: 'shape',
          left: 40,
          top: 50,
          width: 120,
          height: 120,
          viewBox: [1000, 1000],
          path: 'M 500 0 A 500 500 0 1 1 499 0 Z',
          fill: '#123456',
          fixedRatio: false,
        }),
        expect.objectContaining({
          type: 'chart',
          left: 200,
          top: 50,
          width: 300,
          height: 200,
          chartType: 'bar',
          data: { labels: ['A'], legends: ['Score'], series: [[3]] },
          themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
        }),
        expect.objectContaining({
          type: 'latex',
          left: 40,
          top: 220,
          width: 400,
          height: 80,
          latex: 'E = mc^2',
          html: expect.stringContaining('katex'),
          color: '#111111',
          fixedRatio: true,
        }),
        expect.objectContaining({
          type: 'table',
          left: 300,
          top: 280,
          width: 360,
          height: 160,
          colWidths: [0.5, 0.5],
          cellMinHeight: 36,
          outline: { width: 2, style: 'solid', color: '#eeece1' },
          data: [
            [
              expect.objectContaining({ colspan: 1, rowspan: 1, text: 'Name' }),
              expect.objectContaining({ colspan: 1, rowspan: 1, text: 'Value' }),
            ],
            [
              expect.objectContaining({ colspan: 1, rowspan: 1, text: 'A' }),
              expect.objectContaining({ colspan: 1, rowspan: 1, text: '3' }),
            ],
          ],
        }),
        expect.objectContaining({
          type: 'line',
          left: 80,
          top: 450,
          width: 2,
          start: [0, 0],
          end: [180, 50],
          style: 'solid',
          color: '#333333',
          points: ['', 'arrow'],
        }),
        expect.objectContaining({
          type: 'code',
          language: 'typescript',
          left: 500,
          top: 40,
          width: 500,
          height: 300,
          showLineNumbers: true,
          fontSize: 14,
          lines: [
            expect.objectContaining({ content: 'const answer = 42;' }),
            expect.objectContaining({ content: 'console.log(answer);' }),
          ],
        }),
      ]);
      const table = state.whiteboard?.elements.find((element) => element.type === 'table');
      const code = state.whiteboard?.elements.find((element) => element.type === 'code');
      expect(table?.data.flat().map((cell) => cell.id)).toEqual([
        expect.stringMatching(/^native-wb-table-cell:[0-9a-f]{64}:0:0$/u),
        expect.stringMatching(/^native-wb-table-cell:[0-9a-f]{64}:0:1$/u),
        expect.stringMatching(/^native-wb-table-cell:[0-9a-f]{64}:1:0$/u),
        expect.stringMatching(/^native-wb-table-cell:[0-9a-f]{64}:1:1$/u),
      ]);
      expect(code?.lines.map((line) => line.id)).toEqual([
        expect.stringMatching(/^native-wb-code-line:[0-9a-f]{64}:0$/u),
        expect.stringMatching(/^native-wb-code-line:[0-9a-f]{64}:1$/u),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects non-rectangular tables and model-supplied Native element identity', () => {
    const runtime = service();
    const table = build(runtime).tools.find((tool) => tool.name === 'wb_draw_table')!;
    expect(() =>
      table.prepareArguments?.({
        expectedLastSeq: null,
        x: 1,
        y: 2,
        width: 300,
        height: 120,
        data: [['A', 'B'], ['C']],
      }),
    ).toThrow('strict schema');
    expect(() =>
      table.prepareArguments?.({
        expectedLastSeq: null,
        x: 1,
        y: 2,
        width: 300,
        height: 120,
        data: [['A']],
        elementId: 'model-owned-id',
      }),
    ).toThrow('strict schema');
    expect(runtime.append).not.toHaveBeenCalled();
  });

  it('publishes a JSON Schema 2020-12 compatible fixed-length line marker array', () => {
    const runtime = service();
    const line = build(runtime).tools.find((tool) => tool.name === 'wb_draw_line')!;
    const points = (
      line.parameters as {
        properties?: {
          points?: { items?: unknown; minItems?: number; maxItems?: number };
        };
      }
    ).properties?.points;

    expect(points).toMatchObject({ minItems: 2, maxItems: 2 });
    expect(Array.isArray(points?.items)).toBe(false);
    expect(() =>
      line.prepareArguments?.({
        expectedLastSeq: null,
        startX: 0,
        startY: 0,
        endX: 100,
        endY: 100,
        points: ['arrow'],
      }),
    ).toThrow('strict schema');
    expect(runtime.append).not.toHaveBeenCalled();
  });

  it('rejects zero-length lines before append', () => {
    const runtime = service();
    const harness = build(runtime);
    const line = harness.tools.find((tool) => tool.name === 'wb_draw_line')!;

    expect(() =>
      line.prepareArguments?.({
        expectedLastSeq: null,
        startX: 12,
        startY: 34,
        endX: 12,
        endY: 34,
      }),
    ).toThrow('distinct start and end points');
    expect(runtime.append).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it.each(['', '\n', '   \t'])('rejects blank code %j before append', (code) => {
    const runtime = service();
    const harness = build(runtime);
    const drawCode = harness.tools.find((tool) => tool.name === 'wb_draw_code')!;

    expect(() =>
      drawCode.prepareArguments?.({
        expectedLastSeq: null,
        language: 'python',
        code,
        x: 1,
        y: 2,
      }),
    ).toThrow('strict schema');
    expect(runtime.append).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('rejects empty chart series, palettes, and radar labels before append', () => {
    const runtime = service();
    const chart = build(runtime).tools.find((tool) => tool.name === 'wb_draw_chart')!;
    const base = {
      expectedLastSeq: null,
      chartType: 'bar',
      x: 1,
      y: 2,
      width: 300,
      height: 200,
      data: { labels: ['A'], legends: ['Value'], series: [[1]] },
    };

    expect(() => chart.prepareArguments?.({ ...base, data: { ...base.data, series: [] } })).toThrow(
      'strict schema',
    );
    expect(() =>
      chart.prepareArguments?.({ ...base, data: { ...base.data, series: [[]] } }),
    ).toThrow('strict schema');
    expect(() => chart.prepareArguments?.({ ...base, themeColors: [] })).toThrow('strict schema');
    expect(() =>
      chart.prepareArguments?.({
        ...base,
        chartType: 'radar',
        data: { ...base.data, labels: [] },
      }),
    ).toThrow('strict schema');
    expect(runtime.append).not.toHaveBeenCalled();
  });

  it('describes the existing bar and column orientation in the chart schema', () => {
    const runtime = service();
    const chart = build(runtime).tools.find((tool) => tool.name === 'wb_draw_chart')!;

    expect(JSON.stringify(chart.parameters)).toContain(
      'Use bar for vertical bars with category labels on the x-axis. Use column for horizontal bars with category labels on the y-axis.',
    );
  });

  it('escapes model-authored table text before committing it', async () => {
    const runtime = service();
    const table = build(runtime).tools.find((tool) => tool.name === 'wb_draw_table')!;
    const params = {
      expectedLastSeq: null,
      x: 1,
      y: 2,
      width: 300,
      height: 120,
      data: [['<svg/onload=x>']],
    };

    await table.execute('unsafe-table', params);

    expect(runtime.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: expect.objectContaining({
            kind: 'element_added',
            element: expect.objectContaining({
              type: 'table',
              data: [[expect.objectContaining({ text: '&lt;svg/onload=x&gt;' })]],
            }),
          }),
        }),
      }),
    );
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

  it.each([
    {
      name: 'wb_draw_table',
      params: { x: 10, y: 20, width: 300, height: 120, data: [['A', 'B']] },
      nestedIds: (element: { data?: Array<Array<{ id: string }>> }) =>
        element.data?.flat().map((cell) => cell.id),
      idPattern: /^native-wb-table-cell:[0-9a-f]{64}:0:[01]$/u,
    },
    {
      name: 'wb_draw_code',
      params: { language: 'python', code: 'x = 1\nprint(x)', x: 10, y: 20 },
      nestedIds: (element: { lines?: Array<{ id: string }> }) =>
        element.lines?.map((line) => line.id),
      idPattern: /^native-wb-code-line:[0-9a-f]{64}:[01]$/u,
    },
  ])('exactly replays $name with stable nested IDs and one record', async (testCase) => {
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
      const draw = build(runtime).tools.find((tool) => tool.name === testCase.name)!;
      const params = { ...testCase.params, expectedLastSeq: null };

      await expect(draw.execute('same-nested-tool-call', params)).resolves.toMatchObject({
        details: { committedSeq: 0, replayed: false, dispatchedAction: true },
      });
      const firstState = await runtime.read('stage-1');
      const firstElement = firstState.whiteboard?.elements[0] as Parameters<
        typeof testCase.nestedIds
      >[0];
      const firstIds = testCase.nestedIds(firstElement);

      await expect(draw.execute('same-nested-tool-call', params)).resolves.toMatchObject({
        details: { committedSeq: 0, replayed: true, dispatchedAction: true },
      });
      const replayedState = await runtime.read('stage-1');
      const replayedElement = replayedState.whiteboard?.elements[0] as Parameters<
        typeof testCase.nestedIds
      >[0];
      expect(testCase.nestedIds(replayedElement)).toEqual(firstIds);
      expect(firstIds).toHaveLength(2);
      firstIds?.forEach((id) => expect(id).toMatch(testCase.idPattern));

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

    const openResult = await open.execute('open-1', {});
    expect(openResult).toMatchObject({
      details: { actionName: 'wb_open', dispatchedAction: true },
    });
    expect(openResult.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringMatching(/did not draw.*continue in the same Child.*wb_draw_\*/u),
      }),
    ]);
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
