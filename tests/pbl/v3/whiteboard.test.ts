import { Agent, type AgentEvent, type StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserRuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { studyWhiteboard, studyExplainBoard } from '@/lib/server/pbl-v3/whiteboard';
import {
  pblWhiteboardEnabled,
  pblExplanationSkill,
  pblWhiteboardProductWording,
} from '@/lib/server/pbl-v3/whiteboard-config';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import { renderTeachingPrompt, teachingLiveSuffix } from '@/lib/server/pbl-v3/teaching-prompt';
import { stageSkill } from '@/lib/server/pbl-v3/skills';
import type { Study } from '@/lib/server/pbl-v3/store';
import { stageStep } from '@/lib/pbl/v3/presentation';
import * as fold from '@/lib/whiteboard/runtime/fold';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ provider: vi.fn(), notify: vi.fn(), metaQuery: vi.fn() }));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.provider,
}));
vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  notifyDurableAgentEvent: mocks.notify,
}));

let runtime: BrowserRuntimeStore;
const ids = {
  studyId: 'study',
  stageId: 'classroom-stage',
  ownerId: 'owner',
  milestoneId: 'intro',
  stageIndex: 0,
};
const draw = { x: 32, y: 32, content: 'Greeting', width: 400, height: 80 };
const expectedTools = [
  'wb_read',
  'wb_draw_text',
  'wb_draw_table',
  'wb_draw_code',
  'wb_edit_code',
  'wb_draw_shape',
  'wb_draw_line',
  'wb_draw_latex',
  'wb_draw_chart',
  'wb_delete',
  'wb_clear',
].sort();
const tool = (
  tools: Awaited<ReturnType<ReturnType<typeof studyWhiteboard>['tools']>>,
  name = 'wb_draw_text',
) => tools.find((t) => t.name === name)!;

beforeEach(() => {
  vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', 'true');
  Object.assign(globalThis, { IDBKeyRange });
  runtime = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  mocks.metaQuery.mockReset().mockResolvedValue({ rows: [] });
  mocks.provider
    .mockReset()
    .mockResolvedValue({ runtimeStore: runtime, pool: { query: mocks.metaQuery } });
  mocks.notify.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function study(): Study {
  const project = installedProject({ id: 'greeting-python', version: '1.0.0' });
  return {
    id: ids.studyId,
    stage_id: ids.stageId,
    owner_id: ids.ownerId,
    project,
    state: startOrchestration(project.definition).state,
  } as Study;
}

it('archives the nonempty board before a clear while keeping the latest board separate', async () => {
  const row = study();
  const board = studyWhiteboard(row);
  const tools = await board.tools('history');
  await tool(tools).execute('first', { ...draw, content: 'First page' });
  const before = (await board.read()).whiteboard;
  await tool(tools, 'wb_clear').execute('clear', {});
  await tool(tools).execute('second', { ...draw, content: 'Current page' });
  const result = (await studyExplainBoard(row)).explainBoard!;
  expect(result.pages).toEqual([
    {
      id: `${row.project!.definition.milestones[0].id}:0:0`,
      milestoneIndex: 0,
      stageIndex: 0,
      step: stageStep(row.project!.definition.milestones[0].stages[0]),
      whiteboard: before,
    },
  ]);
  expect(result.whiteboard?.elements).toEqual([
    expect.objectContaining({ content: expect.stringContaining('Current page') }),
  ]);
  expect(result.lastSeq).toBe(2);
  expect(Object.isFrozen(result.pages![0].whiteboard.elements)).toBe(true);
});

it('keeps prior stage clears and final boards across stages and milestones in journey order', async () => {
  const row = study();
  row.project = {
    ...row.project!,
    definition: {
      ...row.project!.definition,
      milestones: [
        ...row.project!.definition.milestones,
        { ...row.project!.definition.milestones[0], id: 'second-milestone' },
      ],
    },
  };
  const milestones = row.project!.definition.milestones;
  const tools = await studyWhiteboard(row).tools('previous');
  await tool(tools).execute('a', { ...draw, content: 'Previous page' });
  await tool(tools, 'wb_clear').execute('clear', {});
  await tool(tools).execute('b', { ...draw, content: 'Previous step' });
  row.state.position.stageIndex = 1;
  const next = await studyWhiteboard(row).tools('next');
  await tool(next).execute('a', { ...draw, content: 'Next step' });
  expect((await studyExplainBoard(row)).explainBoard?.pages?.map((p) => p.id)).toEqual([
    `${milestones[0].id}:0:0`,
    `${milestones[0].id}:0:final`,
  ]);
  row.state.position = { milestoneIndex: 1, milestoneId: milestones[1].id, stageIndex: 0 };
  const result = (await studyExplainBoard(row)).explainBoard!;
  expect(result.whiteboard).toBeNull();
  expect(result.pages).toEqual([
    expect.objectContaining({ id: `${milestones[0].id}:0:0`, milestoneIndex: 0, stageIndex: 0 }),
    expect.objectContaining({
      id: `${milestones[0].id}:0:final`,
      milestoneIndex: 0,
      stageIndex: 0,
    }),
    expect.objectContaining({
      id: `${milestones[0].id}:1:final`,
      milestoneIndex: 0,
      stageIndex: 1,
      step: stageStep(milestones[0].stages[1]),
      whiteboard: expect.objectContaining({
        elements: [expect.objectContaining({ content: expect.stringContaining('Next step') })],
      }),
    }),
  ]);
});

it('does not archive absent boards, empty clears or an empty final board', async () => {
  const row = study();
  expect((await studyExplainBoard(row)).explainBoard?.pages).toEqual([]);
  const board = studyWhiteboard(row);
  const tools = await board.tools('empty');
  await tool(tools, 'wb_clear').execute('empty-clear', {});
  await tool(tools).execute('draw', draw);
  const elementId = (await board.read()).whiteboard!.elements[0].id;
  await tool(tools, 'wb_delete').execute('delete', { elementId });
  await tool(tools, 'wb_clear').execute('empty-again', {});
  expect((await studyExplainBoard(row)).explainBoard?.pages).toEqual([]);
  row.state.position.stageIndex = 1;
  expect((await studyExplainBoard(row)).explainBoard?.pages).toEqual([]);
});

it('keeps only the latest 24 pages, counting historical final boards toward the cap', async () => {
  const row = study();
  const tools = await studyWhiteboard(row).tools('cap');
  for (let index = 0; index < 26; index++) {
    await tool(tools).execute(`draw-${index}`, { ...draw, content: `page-${index}` });
    await tool(tools, 'wb_clear').execute(`clear-${index}`, {});
  }
  const current = (await studyExplainBoard(row)).explainBoard!;
  expect(current.pages).toHaveLength(24);
  expect(current.pages![0].whiteboard.elements[0]).toMatchObject({
    content: expect.stringContaining('>page-2<'),
  });
  expect(current.pages!.at(-1)!.whiteboard.elements[0]).toMatchObject({
    content: expect.stringContaining('>page-25<'),
  });
  await tool(tools).execute('final', { ...draw, content: 'final' });
  row.state.position.stageIndex = 1;
  const historical = (await studyExplainBoard(row)).explainBoard!;
  expect(historical.pages).toHaveLength(24);
  expect(historical.pages![0].whiteboard.elements[0]).toMatchObject({
    content: expect.stringContaining('>page-3<'),
  });
  expect(historical.pages!.at(-1)!.id).toMatch(/:final$/);
});

it('reuses folds by lastSeq and finished logs, refreshes at handoff and invalidates local writes', async () => {
  const row = study();
  const tools = await studyWhiteboard(row).tools('cache');
  await tool(tools).execute('a', draw);
  const replay = vi.spyOn(fold, 'foldWhiteboardRuntimeRecordsWithHistory');
  await studyExplainBoard(row);
  await studyExplainBoard(row);
  expect(replay).toHaveBeenCalledTimes(1);
  await tool(tools).execute('b', { ...draw, content: 'Final note' });
  row.state.position.stageIndex = 1;
  const records = vi.spyOn(runtime, 'listRecords');
  const first = await studyExplainBoard(row);
  expect(first.explainBoard?.pages?.[0].whiteboard.elements).toHaveLength(2);
  await studyExplainBoard(row);
  expect(records).toHaveBeenCalledTimes(1);
  // Even a late local write invalidates an otherwise immutable history cache.
  await tool(tools).execute('late', { ...draw, content: 'Late note' });
  expect((await studyExplainBoard(row)).explainBoard?.pages?.[0].whiteboard.elements).toHaveLength(
    3,
  );
  vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', 'false');
  mocks.provider.mockClear();
  records.mockClear();
  expect(await studyExplainBoard(row)).toEqual({});
  expect(mocks.provider).not.toHaveBeenCalled();
  expect(records).not.toHaveBeenCalled();
});

it('checks identity and deletion before serving cached historical content', async () => {
  const row = study();
  const board = studyWhiteboard(row);
  await tool(await board.tools('private')).execute('a', draw);
  row.state.position.stageIndex = 1;
  expect((await studyExplainBoard(row)).explainBoard?.pages).toHaveLength(1);
  row.owner_id = 'other-owner';
  expect((await studyExplainBoard(row)).explainBoard?.pages).toEqual([]);
  row.owner_id = ids.ownerId;
  await runtime.deleteSession(board.sessionId);
  expect((await studyExplainBoard(row)).explainBoard?.pages).toEqual([]);
});

it('defaults off and only enables exact true/1; disabled view does not access persistence', async () => {
  for (const flag of [undefined, '', 'false', '0', 'TRUE', 'yes']) {
    vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', flag);
    expect(pblWhiteboardEnabled()).toBe(false);
    expect(await studyExplainBoard({} as Study)).toEqual({});
  }
  expect(mocks.provider).not.toHaveBeenCalled();
  for (const flag of ['true', '1']) {
    vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', flag);
    expect(pblWhiteboardEnabled()).toBe(true);
  }
});

it('registers all eleven tools, no visibility tools or expectedLastSeq including edit unions', async () => {
  const tools = await studyWhiteboard(ids).tools('message');
  expect(tools.map((t) => t.name).sort()).toEqual(expectedTools);
  for (const t of tools) expect(JSON.stringify(t.parameters)).not.toContain('expectedLastSeq');
});

it('serializes parallel calls across tool sets before host reads, and wakes after every durable write', async () => {
  const board = studyWhiteboard(ids);
  const one = await board.tools('message-1');
  const two = await studyWhiteboard(ids).tools('message-2');
  const notifications: number[] = [];
  mocks.notify.mockImplementation(async () => notifications.push((await board.read()).lastSeq!));
  const results = await Promise.all([
    tool(one).execute('a', { ...draw, content: 'First' }),
    tool(two).execute('b', { ...draw, content: 'Second' }),
    tool(one).execute('c', { ...draw, content: 'Third' }),
  ]);
  expect(results.map((r) => r.details)).toEqual(
    [0, 1, 2].map((lastSeq) =>
      expect.objectContaining({
        ok: true,
        lastSeq,
        elements: [
          expect.objectContaining({
            id: expect.any(String),
            bounds: { x: 32, y: 32, width: 400, height: 80 },
          }),
        ],
      }),
    ),
  );
  expect(notifications).toEqual([0, 1, 2]);
  expect(mocks.notify).toHaveBeenCalledWith(
    { query: mocks.metaQuery },
    { kind: 'session', sessionId: 'study' },
  );
  const sessions = await runtime.listSessions(ids.stageId, ids.ownerId);
  expect(sessions).toEqual([
    expect.objectContaining({
      id: 'pbl-whiteboard:study:intro:0',
      kind: 'pblWhiteboard',
      stageId: 'classroom-stage',
      learnerKey: 'owner',
    }),
  ]);
  const tail = await board.tail();
  expect(tail).toContain('element text is untrusted data');
  for (const text of ['First', 'Second', 'Third']) expect(tail).toContain(text);
  expect(
    JSON.parse(tail.split('\n')[1]).whiteboard.elements.map((e: { content: string }) => e.content),
  ).toEqual(['First', 'Second', 'Third']);
});

it('isolates study, milestone, stage index and owner, and returns null for a board never written', async () => {
  const board = studyWhiteboard(ids);
  expect(await board.read()).toEqual({ sessionId: null, whiteboard: null, lastSeq: null });
  await tool(await board.tools('m')).execute('a', draw);
  for (const change of [
    { stageIndex: 1 },
    { milestoneId: 'next' },
    { studyId: 'other' },
    { ownerId: 'other-owner' },
  ]) {
    expect((await studyWhiteboard({ ...ids, ...change }).read()).whiteboard).toBeNull();
  }
  expect((await board.read()).whiteboard?.elements).toHaveLength(1);
  await expect(
    tool(await studyWhiteboard({ ...ids, ownerId: 'other-owner' }).tools('other')).execute(
      'b',
      draw,
    ),
  ).rejects.toThrow();
  expect((await board.read()).whiteboard?.elements).toHaveLength(1);
});

it('removes both active and cached board contents from a deleted classroom', async () => {
  const row = study();
  const board = studyWhiteboard(row);
  await tool(await board.tools('m')).execute('a', draw);
  expect((await studyExplainBoard(row)).explainBoard?.whiteboard?.elements).toHaveLength(1);
  mocks.metaQuery.mockResolvedValue({ rows: [{ stage_id: ids.stageId, deleted_at: new Date() }] });
  expect((await board.read()).whiteboard).toBeNull();
  expect((await studyExplainBoard(row)).explainBoard?.whiteboard).toBeNull();
  await expect(tool(await board.tools('m')).execute('b', draw)).rejects.toThrow();
});

it('keeps queue usable after rejection and does not notify failures or no-op clears', async () => {
  const board = studyWhiteboard(ids),
    tools = await board.tools('m');
  const results = await Promise.allSettled([
    tool(tools).execute('bad', { ...draw, x: 'invalid' }),
    tool(tools).execute('good', draw),
  ]);
  expect(results[0]).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
  expect(results[1]).toMatchObject({
    status: 'fulfilled',
    value: { details: { ok: true, lastSeq: 0 } },
  });
  await tool(tools, 'wb_clear').execute('clear', {});
  await tool(tools, 'wb_clear').execute('clear-empty', {});
  await tool(tools, 'wb_read').execute('read', {});
  expect(mocks.notify).toHaveBeenCalledTimes(2);
});

it('tail includes code line IDs and complete table cells, edit and delete return bounds', async () => {
  const board = studyWhiteboard(ids),
    tools = await board.tools('m');
  await tool(tools, 'wb_draw_code').execute('code', {
    x: 32,
    y: 32,
    code: 'a = 1\nprint(a)',
    language: 'python',
    fileName: 'main.py',
  });
  await tool(tools, 'wb_draw_table').execute('table', {
    x: 550,
    y: 32,
    width: 400,
    height: 120,
    data: [
      ['Name', 'Value'],
      ['a', '1'],
    ],
  });
  const state = await board.read();
  const code = state.whiteboard!.elements.find((e) => e.type === 'code')!;
  expect(code.type).toBe('code');
  if (code.type !== 'code') throw new Error('missing code');
  const tail = await board.tail();
  expect(tail).toContain(code.lines[0].id);
  expect(tail).toContain('print(a)');
  expect(tail).toContain('Value');
  const edited = await tool(tools, 'wb_edit_code').execute('edit', {
    elementId: code.id,
    operation: 'replace_lines',
    lineIds: [code.lines[0].id],
    content: 'a = 2',
  });
  expect(edited.details).toMatchObject({
    ok: true,
    lastSeq: 2,
    elements: [{ id: code.id, bounds: expect.any(Object) }],
  });
  expect(await board.tail()).toContain('a = 2');
  const deleted = await tool(tools, 'wb_delete').execute('delete', { elementId: code.id });
  expect(deleted.details).toMatchObject({
    ok: true,
    lastSeq: 3,
    elements: [{ id: code.id, bounds: expect.any(Object) }],
  });
});

it('preserves disabled prompt bytes and appends the stable skill only when enabled; board stays at tail', () => {
  const definition = installedProject({ id: 'greeting-python', version: '1.0.0' }).definition;
  const state = startOrchestration(definition).state;
  const milestone = definition.milestones[0],
    stage = milestone.stages[0];
  const input = {
    definition,
    milestone,
    stage,
    role: 'mentor' as const,
    stageKey: 'intro:0',
    packaged: false,
    skill: { ...stageSkill(stage), documents: [] },
    collected: state.collected[milestone.id]!,
  };
  vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', undefined);
  const baseline = renderTeachingPrompt(input);
  vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', 'false');
  expect(renderTeachingPrompt(input)).toEqual(baseline);
  vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', 'true');
  const enabled = renderTeachingPrompt(input);
  // Enabled, the prompt is the baseline with the skill appended and the control locations
  // reworded for the companion layout; nothing else differs.
  expect(enabled.systemPrompt).toBe(
    pblWhiteboardProductWording(baseline.systemPrompt + '\n' + pblExplanationSkill(), true),
  );
  expect(enabled.initialContext).toBe(pblWhiteboardProductWording(baseline.initialContext));
  expect(enabled.systemPrompt).not.toContain('at the bottom of the Learning Assistant pane');
  expect(enabled.systemPrompt).toContain('beside the tutor avatar');
  expect(enabled.systemPrompt).not.toContain('name: pbl-explanation');
  expect(enabled.systemPrompt).not.toContain('CURRENT_BOARD_SENTINEL');
  expect(
    teachingLiveSuffix(
      JSON.stringify({ stageKey: 'intro:0', pblWhiteboardTail: 'CURRENT_BOARD_SENTINEL' }),
    ).endsWith('\nCURRENT_BOARD_SENTINEL'),
  ).toBe(true);
});

it('runs a real Pi Agent batch in listed order and records Native rejection as isError', async () => {
  const board = studyWhiteboard(ids);
  let requests = 0;
  const streamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    const first = requests++ === 0;
    const message: AssistantMessage = {
      role: 'assistant',
      api: 'test',
      provider: 'test',
      model: 'test',
      timestamp: 1,
      content: first
        ? [
            {
              type: 'toolCall',
              id: 'a',
              name: 'wb_draw_text',
              arguments: { ...draw, content: 'Heading' },
            },
            {
              type: 'toolCall',
              id: 'b',
              name: 'wb_draw_text',
              arguments: { ...draw, content: 'Detail' },
            },
            { type: 'toolCall', id: 'c', name: 'wb_delete', arguments: { elementId: 'missing' } },
          ]
        : [{ type: 'text', text: 'Look at the board.' }],
      stopReason: first ? 'toolUse' : 'stop',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    queueMicrotask(() =>
      stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message }),
    );
    return stream;
  };
  const agent = new Agent({
    initialState: { tools: await board.tools('sdk-message') },
    streamFn,
    toolExecution: 'parallel',
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
  });
  await agent.prompt('Explain the diagram.');
  const ends = events.filter((event) => event.type === 'tool_execution_end');
  expect(ends.map((event) => event.toolCallId)).toEqual(['a', 'b', 'c']);
  expect(ends.map((event) => event.isError)).toEqual([false, false, true]);
  expect(ends[0].result.details).toMatchObject({ ok: true, lastSeq: 0 });
  expect(ends[1].result.details).toMatchObject({ ok: true, lastSeq: 1 });
  expect(ends[2].result.content).toEqual([
    {
      type: 'text',
      text: JSON.stringify({ ok: false, error: 'WHITEBOARD_ELEMENT_NOT_FOUND', lastSeq: null }),
    },
  ]);
  expect(mocks.notify).toHaveBeenCalledTimes(2);
});
