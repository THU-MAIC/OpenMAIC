import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserRuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import { learningView, stageKey } from '@/lib/server/pbl-v3/runtime';
import { teachingRunnerConfig, withTeachingTurnBoundary } from '@/lib/server/pbl-v3/runner-tools';
import { requestStateTail } from '@/lib/agent/runtime/request-state-tail';
import type { Study, RoleBinding } from '@/lib/server/pbl-v3/store';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import type { UserMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  query: vi.fn(async () => ({ rows: [] })),
  get: vi.fn(),
  roles: vi.fn(),
  binding: vi.fn(),
  lease: vi.fn(),
  notify: vi.fn(),
  getSession: vi.fn(),
  exclusive: vi.fn(async (_id, work) => work()),
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.provider,
}));
vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  notifyDurableAgentEvent: mocks.notify,
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({
    listUserMessages: async () => [],
    assertActiveLease: mocks.lease,
    getSession: mocks.getSession,
  }),
}));
vi.mock('@/lib/server/pbl-v3/store', () => ({
  LearningStore: {
    open: async () => ({
      pool: { query: mocks.query },
      get: mocks.get,
      roles: mocks.roles,
      binding: mocks.binding,
      hasSeenOnboarding: async () => true,
      waitForExclusive: mocks.exclusive,
    }),
  },
}));

let row: Study, binding: RoleBinding;
const principal = { ownerId: 'owner' } as OwnerPrincipal;
const request = {
  sessionId: 'role-session',
  ownerId: 'owner',
  workerId: 'worker',
  attempt: 1,
  signal: new AbortController().signal,
};
beforeEach(() => {
  vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', undefined);
  Object.assign(globalThis, { IDBKeyRange });
  const project = installedProject({ id: 'greeting-python', version: '1.0.0' });
  row = {
    id: 'study',
    owner_id: 'owner',
    stage_id: 'real-classroom-stage',
    project_id: project.ref.id,
    project_version: project.ref.version,
    project,
    revision: 0,
    state: startOrchestration(project.definition).state,
    environment_id: null,
    evaluation: null,
  } as Study;
  binding = {
    session_id: 'role-session',
    study_id: row.id,
    role: 'discussion',
    stage_key: stageKey(row),
    feedback_seq: 0,
  } as RoleBinding;
  mocks.get.mockReset().mockImplementation(async (_id, ownerId) => {
    if (ownerId !== row.owner_id) throw new Error('wrong owner');
    return row;
  });
  mocks.roles.mockReset().mockResolvedValue([]);
  mocks.binding.mockReset().mockResolvedValue(binding);
  mocks.query.mockClear();
  mocks.provider.mockReset().mockResolvedValue({
    pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
    runtimeStore: new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    }),
  });
  mocks.lease.mockReset().mockResolvedValue(undefined);
  mocks.notify.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

it('disabled registration, prompt and LearningView are byte-identical to the unset flag and never open RuntimeStore', async () => {
  const baseline = await teachingRunnerConfig(request);
  const view = await learningView(principal, row.id);
  vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', 'false');
  const disabled = await teachingRunnerConfig(request);
  expect(
    disabled.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  ).toEqual(
    baseline.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  );
  expect(disabled.systemPrompt).toBe(baseline.systemPrompt);
  expect(disabled.initialContext).toBe(baseline.initialContext);
  expect(JSON.stringify(await learningView(principal, row.id))).toBe(JSON.stringify(view));
  expect(view).not.toHaveProperty('explainBoard');
  expect(baseline.tools.some((t) => t.name.startsWith('wb_'))).toBe(false);
  expect(mocks.provider).not.toHaveBeenCalled();
});

it.each(['mentor', 'discussion', 'planner', 'coder'] as const)(
  'registers the board tools, with open and close, for %s',
  async (role) => {
    binding.role = role;
    vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', '1');
    const config = await teachingRunnerConfig(request);
    const tools = config.tools.filter((t) => t.name.startsWith('wb_'));
    expect(tools).toHaveLength(13);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['wb_open', 'wb_close']));
    expect(JSON.stringify(tools.map((t) => t.parameters))).not.toContain('expectedLastSeq');
    expect(config.systemPrompt).toContain('# Project explanation board');
  },
);

it('LearningView reads the current stage on every snapshot; running tools wake it before a turn receipt', async () => {
  vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', 'true');
  const config = await teachingRunnerConfig(request);
  expect((await learningView(principal, row.id)).explainBoard).toEqual({
    whiteboard: null,
    lastSeq: null,
    pages: [],
  });
  const draw = config.tools.find((t) => t.name === 'wb_draw_text')!;
  const results = await Promise.all([
    draw.execute('one', { x: 32, y: 32, content: 'Welcome' }),
    draw.execute('two', { x: 32, y: 120, content: 'Next block' }),
  ]);
  expect(results.map((r) => r.details)).toEqual(
    [0, 1].map((lastSeq) => expect.objectContaining({ ok: true, lastSeq })),
  );
  expect(mocks.lease).toHaveBeenCalledTimes(2);
  expect(mocks.notify).toHaveBeenCalledTimes(2);
  expect(config.isTurnComplete()).toBe(false);
  const view = await learningView(principal, row.id);
  expect(view.explainBoard?.lastSeq).toBe(1);
  expect(view.explainBoard?.whiteboard?.elements).toHaveLength(2);
  row.state.position.stageIndex = 1;
  expect((await learningView(principal, row.id)).explainBoard).toEqual({
    whiteboard: null,
    lastSeq: null,
    pages: [
      {
        id: `${row.project!.definition.milestones[0].id}:0:final`,
        milestoneIndex: 0,
        stageIndex: 0,
        step: 'teaching',
        whiteboard: view.explainBoard!.whiteboard,
      },
    ],
  });
  await expect(draw.execute('stale', { x: 0, y: 0, content: 'Old note' })).rejects.toThrow(
    'stage changed',
  );
  expect(mocks.notify).toHaveBeenCalledTimes(2);
});

it('refreshes board state at every model request tail while preserving system prefix and durable messages', async () => {
  vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', 'true');
  binding.feedback_seq = 1;
  const config = await teachingRunnerConfig(request);
  const streamFn = vi.fn<StreamFn>();
  const boundary = withTeachingTurnBoundary(
    streamFn,
    () => false,
    config.historyWindow,
    config.liveContext,
  );
  const model = {
    id: 'test',
    api: 'openai-completions',
    contextWindow: 128000,
  } as Parameters<StreamFn>[0];
  const messages: UserMessage[] = [{ role: 'user', content: 'Please explain.', timestamp: 1 }];
  const context = { systemPrompt: config.systemPrompt, messages };
  await boundary(model, context);
  expect(requestStateTail(streamFn.mock.calls[0][1])).toContain('"lastSeq":null');
  await config.tools
    .find((t) => t.name === 'wb_draw_text')!
    .execute('write', { x: 32, y: 32, content: 'CURRENT_BOARD_SENTINEL' });
  await boundary(model, context);
  const sent = streamFn.mock.calls[1][1];
  expect(sent.systemPrompt).toBe(config.systemPrompt);
  expect(sent.systemPrompt).not.toContain('CURRENT_BOARD_SENTINEL');
  expect(requestStateTail(sent)).toContain('CURRENT_BOARD_SENTINEL');
  expect(requestStateTail(sent)).toContain('"lastSeq":0');
  expect(context.messages).toEqual(messages);
  expect(messages).toHaveLength(1);
});

it('rejects writes after lease loss without changing the board', async () => {
  vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', 'true');
  const config = await teachingRunnerConfig(request);
  mocks.lease.mockRejectedValue(new Error('lease lost'));
  await expect(config.tools.find((t) => t.name === 'wb_clear')!.execute('a', {})).rejects.toThrow(
    'lease lost',
  );
  expect(mocks.notify).not.toHaveBeenCalled();
});
