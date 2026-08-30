/**
 * Runner-level integration pins for the frozen Zhongkao terminal boundary.
 *
 * The terminal-gate unit suite owns provider chunk filtering and pi's loop
 * mechanics. These tests use the real `runSession` state machine with a fake
 * Agent so the server wiring remains observable without a database or LLM:
 * the exact durable turn, run-local gate identity, Coach registration,
 * terminal publication, queued-turn isolation, and crash recovery.
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import {
  BrowserRuntimeStore,
  type AgentSessionUserMessage,
  type ClaimedAgentSession,
  type RuntimeStore,
} from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acceptTerminalToolGateCall,
  type TerminalToolGate,
} from '@/lib/agent/runtime/terminal-tool-gate';
import { AGENT_TOOL_TIMEOUT_ENV } from '@/lib/agent/runtime/tool-timeout';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'runner-test-uuid'),
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
  resolveWebSearchCapability: vi.fn(),
  listSessionMaterials: vi.fn(async () => []),
  listSkills: vi.fn(async () => []),
  findSkill: vi.fn(),
  buildSkillPreload: vi.fn(),
  createZhongkaoCoachActionTool: vi.fn(),
  createZhongkaoMaterialSourceAdapter: vi.fn(() => ({})),
  createGenerationAiCallFactory: vi.fn(),
}));

vi.mock('node:crypto', async (importActual) => {
  const actual = await importActual<typeof import('node:crypto')>();
  return { ...actual, randomUUID: mocks.randomUUID };
});

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: mocks.getAgentSessionStore,
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));

vi.mock('@/lib/server/agent-runtime/entry-tree-storage', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/entry-tree-storage')>();
  return {
    ...actual,
    AgentSessionEntryStorage: { open: mocks.openEntryStorage },
  };
});

vi.mock('@/lib/server/agent-runtime/agent-driver-model', () => ({
  resolveAgentDriverModel: mocks.resolveAgentDriverModel,
}));

vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: mocks.createCallLlmStreamFn,
}));

vi.mock('@/lib/agent/runtime/build-agent', () => ({
  buildAgent: mocks.buildAgent,
}));

vi.mock('@/lib/server/agent-runtime/web-search', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/web-search')>();
  return { ...actual, resolveWebSearchCapability: mocks.resolveWebSearchCapability };
});

vi.mock('@/lib/server/agent-runtime/session-materials', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return { ...actual, listSessionMaterials: mocks.listSessionMaterials };
});

vi.mock('@/lib/server/agent-runtime/skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/skills')>();
  return {
    ...actual,
    listSkills: mocks.listSkills,
    findSkill: mocks.findSkill,
  };
});

vi.mock('@/lib/server/agent-runtime/skill-preload', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/skill-preload')>();
  return { ...actual, buildSkillPreload: mocks.buildSkillPreload };
});

vi.mock('@/lib/server/agent-runtime/user-skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/user-skills')>();
  return { ...actual, listUserSkills: vi.fn(async () => []) };
});

vi.mock('@/lib/server/agent-runtime/zhongkao-coach-tool', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/zhongkao-coach-tool')>();
  return {
    ...actual,
    createZhongkaoCoachActionTool: mocks.createZhongkaoCoachActionTool,
  };
});

vi.mock('@/lib/server/agent-runtime/zhongkao-material-source', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/zhongkao-material-source')>();
  return {
    ...actual,
    createZhongkaoMaterialSourceAdapter: mocks.createZhongkaoMaterialSourceAdapter,
  };
});

vi.mock('@/lib/server/agent-runtime/generation-ai-call', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/generation-ai-call')>();
  return {
    ...actual,
    createGenerationAiCallFactory: mocks.createGenerationAiCallFactory,
  };
});

import { durableUserMessageSeq, runSession } from '@/lib/server/agent-runtime/runner';
import {
  createCoachFallbackCorrelation,
  createCoachPresentationCorrelation,
  inspectCoachPresentationEventData,
} from '@/lib/server/agent-runtime/zhongkao-terminal-presentation';
import {
  ZHONGKAO_COACH_ACTION_SCHEMA,
  ZHONGKAO_COACH_TOOL_NAME,
  type CoachToolParams,
  type ZhongkaoCoachToolContext,
  type ZhongkaoCoachToolOutput,
} from '@/lib/server/agent-runtime/zhongkao-coach-tool';
import { interruptedToolResult } from '@/lib/server/agent-runtime/tool-call-integrity';
import {
  GUARDED_COACH_CANCELLED_TURN_EVENT,
  tagDurableUserMessage,
} from '@/lib/server/agent-runtime/trusted-turn';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import {
  buildCoachNotice,
  renderCoachTerminalPresentation,
  type CoachTerminalPresentation,
} from '@/lib/zhongkao/coach-public-presentation';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { saveStudentProfile } from '@/lib/zhongkao/runtime';

const WORKER_ID = `runner-t:${process.pid}`;
const OWNER_ID = 'owner-1';
const PROFILE_ID = 'profile-1';

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

const COACH_SKILL = {
  id: 'zhongkao-coach',
  name: 'zhongkao-coach',
  title: '2027 中考伴学',
  description: 'test Coach skill',
  content: 'test-only skill body',
  filePath: 'skills/agent-runtime/zhongkao-coach/SKILL.md',
  constraints: null,
  source: 'builtin' as const,
};

interface PersistedEvent {
  id: number;
  ts: number;
  attempt: number;
  type: string;
  data: unknown;
}

interface BuildAgentOptions {
  streamFn: unknown;
  tools: Array<{ name: string }>;
  allowedToolNames?: ReadonlySet<string>;
  history?: AgentMessage[];
  terminalToolGate?: TerminalToolGate;
  afterToolCall?: (context: unknown) => unknown | Promise<unknown>;
}

interface FakeAgent {
  subscribe(listener: (event: AgentEvent, signal?: AbortSignal) => void): () => void;
  prompt: ReturnType<typeof vi.fn>;
  continue: ReturnType<typeof vi.fn>;
  waitForIdle: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  readonly state: { messages: AgentMessage[]; errorMessage?: string };
}

interface AgentScriptContext {
  emit(event: AgentEvent): void;
  options: BuildAgentOptions;
  store: FakeStore;
}

type AgentScript = (context: AgentScriptContext) => void | Promise<void>;

function makeMeta(id: string, overrides: Partial<ClaimedAgentSession> = {}): ClaimedAgentSession {
  return {
    id,
    ownerId: OWNER_ID,
    prompt: '先给我一个小提示',
    stageId: 'stage-1',
    existingCourse: false,
    status: 'running',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    claimReason: 'queued',
    claimSeq: 0,
    deliveredUserMessageSeq: 0,
    ...overrides,
  };
}

function durableRow(seq: number, text: string): AgentSessionUserMessage {
  return {
    seq,
    ts: seq,
    text,
    delivery: 'queued',
    materials: [],
  };
}

function makeStore(
  meta: ClaimedAgentSession,
  initialRows: AgentSessionUserMessage[] = [],
  initialEvents?: readonly PersistedEvent[],
) {
  const rows = [...initialRows];
  let deliveredThrough = meta.deliveredUserMessageSeq;
  const events: PersistedEvent[] = initialEvents
    ? initialEvents.map((event) => ({ ...event }))
    : rows.map((row) => ({
        id: row.seq,
        ts: row.ts,
        attempt: meta.attempt,
        type: 'user_message',
        data: { text: row.text, delivery: row.delivery, materials: row.materials },
      }));
  let nextEventId = Math.max(
    meta.claimSeq,
    0,
    ...rows.map((row) => row.seq),
    ...events.map((event) => event.id),
  );

  const store = {
    events,
    rows,
    appendRunEvent: vi.fn(
      async (
        _id: string,
        _workerId: string,
        event: { ts: number; attempt: number; type: string; data: unknown },
      ) => {
        const id = ++nextEventId;
        events.push({ id, ...event });
        return id;
      },
    ),
    readEventsAfter: vi.fn(async (_id: string, after: number, limit: number) =>
      events.filter((event) => event.id > after).slice(0, limit),
    ),
    clearCancel: vi.fn(async () => undefined),
    finishSession: vi.fn(async () => true),
    getSession: vi.fn(async () => ({
      ...meta,
      deliveredUserMessageSeq: deliveredThrough,
      lease: { workerId: WORKER_ID, workerPid: process.pid, heartbeatAt: Date.now() },
    })),
    hasSessionRunHistory: vi.fn(async () => false),
    heartbeat: vi.fn(async () => true),
    getCancelRequestedAt: vi.fn(async (): Promise<number | null> => null),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(async () => [...rows]),
    markUserMessageDelivered: vi.fn(async (...args: unknown[]) => {
      const seq = Number(args[3]);
      deliveredThrough = Math.max(deliveredThrough, seq);
      return true;
    }),
    assertActiveLease: vi.fn(async () => undefined),
    registerSessionUrls: vi.fn(async () => []),
    releaseLease: vi.fn(async () => undefined),
    requeueForRetry: vi.fn(async () => true),
    requeueSession: vi.fn(async () => true),
    pushUserMessage(text: string): AgentSessionUserMessage {
      const seq = ++nextEventId;
      const row = durableRow(seq, text);
      rows.push(row);
      events.push({
        id: seq,
        ts: row.ts,
        attempt: meta.attempt,
        type: 'user_message',
        data: { text, delivery: 'queued', materials: [] },
      });
      return row;
    },
  };
  return store;
}

type FakeStore = ReturnType<typeof makeStore>;

async function makeEntryTree(id: string, seed: AgentMessage[] = []): Promise<Session> {
  const repo = new InMemorySessionRepo();
  const session = await repo.create({ id });
  for (const message of seed) await session.appendMessage(message);
  return session;
}

function inputMessages(input: unknown): AgentMessage[] {
  if (Array.isArray(input)) return input as AgentMessage[];
  return [{ role: 'user', content: String(input), timestamp: 1 } as unknown as AgentMessage];
}

function makeFakeAgent(
  options: BuildAgentOptions,
  store: FakeStore,
  script?: AgentScript,
): FakeAgent {
  const messages = [...(options.history ?? [])];
  const listeners = new Set<(event: AgentEvent, signal?: AbortSignal) => void>();
  const emit = (event: AgentEvent): void => {
    if (event.type === 'message_end') messages.push(event.message);
    for (const listener of [...listeners]) listener(event, undefined);
  };
  const runScript = async (): Promise<void> => {
    await script?.({ emit, options, store });
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: vi.fn(async (input: unknown) => {
      for (const message of inputMessages(input)) {
        emit({ type: 'message_start', message });
        emit({ type: 'message_end', message });
      }
      await runScript();
    }),
    continue: vi.fn(runScript),
    waitForIdle: vi.fn(async () => undefined),
    steer: vi.fn(),
    abort: vi.fn(),
    state: {
      get messages() {
        return messages;
      },
      errorMessage: undefined,
    },
  };
}

function coachOutput(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    facts: { replayed: false, eventAppended: true },
    allowedActions: [],
    ...overrides,
  };
}

const DEFAULT_COACH_CALL_PARAMS = {
  action: 'request_hint',
  profileId: PROFILE_ID,
  coachSessionId: 'coach-session-1',
  expectedRevision: 0,
} satisfies CoachToolParams;

const FULL_SOLUTION_COACH_CALL_PARAMS = {
  ...DEFAULT_COACH_CALL_PARAMS,
  action: 'request_full_solution',
} satisfies CoachToolParams;

function assistantToolCall(
  id = 'coach-call-1',
  argumentsValue: unknown = DEFAULT_COACH_CALL_PARAMS,
): AgentMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id,
        name: ZHONGKAO_COACH_TOOL_NAME,
        arguments: argumentsValue,
      },
    ],
    stopReason: 'toolUse',
    timestamp: 2,
  } as unknown as AgentMessage;
}

function skillPreloadPair(id = 'call_sklpre_runner_test'): AgentMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id,
          name: 'read',
          arguments: { path: COACH_SKILL.filePath, limit: 10 },
        },
      ],
      stopReason: 'toolUse',
      timestamp: 1,
    } as unknown as AgentMessage,
    {
      role: 'toolResult',
      toolCallId: id,
      toolName: 'read',
      content: [{ type: 'text', text: COACH_SKILL.content }],
      details: { path: COACH_SKILL.filePath, lines: 10, totalLines: 10 },
      isError: false,
      timestamp: 1,
    } as unknown as AgentMessage,
  ];
}

type ActualCoachFactory = (
  context: ZhongkaoCoachToolContext,
) => ReturnType<
  typeof import('@/lib/server/agent-runtime/zhongkao-coach-tool').createZhongkaoCoachActionTool
>;

interface CommittedCoachAction {
  actualFactory: ActualCoachFactory;
  runtimeStore: RuntimeStore;
  params: CoachToolParams;
  presentation: CoachTerminalPresentation;
  targetSeq: number;
  recordsBeforeReplay: number;
}

async function seedCommittedCoachAction(
  agentSessionId: string,
  kind: 'hint' | 'full_solution',
): Promise<CommittedCoachAction> {
  const runtimeStore = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `runner-coach-orphan-${kind}-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  const nowValue = '2026-08-29T08:00:00.000Z';
  await saveStudentProfile(
    createInitialStudentProfile({ profileId: PROFILE_ID, createdAt: nowValue }),
    {
      store: runtimeStore,
      learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(OWNER_ID),
      now: () => nowValue,
      mintRecordId: () => `profile-record-${kind}`,
    },
  );
  const actualModule = await vi.importActual<
    typeof import('@/lib/server/agent-runtime/zhongkao-coach-tool')
  >('@/lib/server/agent-runtime/zhongkao-coach-tool');
  const actualFactory = actualModule.createZhongkaoCoachActionTool as ActualCoachFactory;
  const execute = async (
    seq: number,
    text: string,
    params: CoachToolParams,
    generationCall?: ZhongkaoCoachToolContext['generationCall'],
  ): Promise<ZhongkaoCoachToolOutput> => {
    const tool = actualFactory({
      trustedTurn: { ownerId: OWNER_ID, agentSessionId, userMessageSeq: seq },
      runtimeStore,
      readTrustedUserMessage: async () => ({ seq, text }),
      ...(generationCall ? { generationCall } : {}),
      now: () => nowValue,
    });
    const raw = await (
      tool.execute as unknown as (
        toolCallId: string,
        value: CoachToolParams,
        signal?: AbortSignal,
      ) => Promise<unknown>
    )(`seed-call-${seq}`, params, undefined);
    return (raw as { details: ZhongkaoCoachToolOutput }).details;
  };

  const started = await execute(1, '虚构题目：解方程 2x = 8。', {
    action: 'start_problem',
    profileId: PROFILE_ID,
    subjectId: 'math',
    knowledgePointIds: ['linear-equations'],
    questionSourceType: 'typed',
  });
  const coachSessionId = started.coachSessionId!;

  let targetSeq: number;
  let params: CoachToolParams;
  let accepted: ZhongkaoCoachToolOutput;
  if (kind === 'hint') {
    targetSeq = 2;
    params = {
      action: 'request_hint',
      profileId: PROFILE_ID,
      coachSessionId,
      expectedRevision: started.revision!,
    };
    accepted = await execute(targetSeq, '请给我一个提示。', params);
  } else {
    const firstAttempt = await execute(
      2,
      'x = 3',
      {
        action: 'submit_attempt',
        profileId: PROFILE_ID,
        coachSessionId,
        expectedRevision: started.revision!,
      },
      async () => JSON.stringify({ schemaVersion: 1, type: 'unsupported' }),
    );
    const secondAttempt = await execute(3, 'x = 4', {
      action: 'submit_attempt',
      profileId: PROFILE_ID,
      coachSessionId,
      expectedRevision: firstAttempt.revision!,
    });
    targetSeq = 4;
    params = {
      action: 'request_full_solution',
      profileId: PROFILE_ID,
      coachSessionId,
      expectedRevision: secondAttempt.revision!,
    };
    accepted = await execute(targetSeq, '请展示完整解析。', params, async () =>
      JSON.stringify({
        schemaVersion: 1,
        explanation: '先用等式性质把未知数单独留在一边。',
        finalAnswer: 'x = 4',
        claims: [],
      }),
    );
  }
  if (!accepted.presentation) throw new Error('test seed did not persist a presentation');
  const sessions = await runtimeStore.listSessions(
    `zhongkao-profile:${PROFILE_ID}`,
    resolveZhongkaoLearnerKeyFromOwnerId(OWNER_ID),
  );
  const coachSession = sessions.find((session) => session.kind === 'zhongkaoCoachEvent');
  if (!coachSession) throw new Error('test seed did not create a Coach runtime session');
  return {
    actualFactory,
    runtimeStore,
    params,
    presentation: accepted.presentation,
    targetSeq,
    recordsBeforeReplay: (await runtimeStore.listRecords(coachSession.id)).length,
  };
}

async function coachRecordCount(runtimeStore: RuntimeStore): Promise<number> {
  const sessions = await runtimeStore.listSessions(
    `zhongkao-profile:${PROFILE_ID}`,
    resolveZhongkaoLearnerKeyFromOwnerId(OWNER_ID),
  );
  const coachSession = sessions.find((session) => session.kind === 'zhongkaoCoachEvent');
  return coachSession ? (await runtimeStore.listRecords(coachSession.id)).length : 0;
}

function coachToolResult(output: unknown, id = 'coach-call-1'): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: ZHONGKAO_COACH_TOOL_NAME,
    content: [{ type: 'text', text: JSON.stringify(output) }],
    details: output,
    isError: false,
    timestamp: 3,
  } as unknown as AgentMessage;
}

function emitMessage(context: AgentScriptContext, message: AgentMessage): void {
  context.emit({ type: 'message_start', message });
  context.emit({ type: 'message_end', message });
}

async function emitCoachResult(
  context: AgentScriptContext,
  output: unknown,
  params: CoachToolParams = DEFAULT_COACH_CALL_PARAMS,
): Promise<void> {
  const call = assistantToolCall('coach-call-1', params);
  emitMessage(context, call);
  const override = (await context.options.afterToolCall?.({
    toolCall: (call as { content: unknown[] }).content[0],
    result: { details: output, content: [{ type: 'text', text: JSON.stringify(output) }] },
    isError: false,
  })) as
    | { content?: Array<{ type: 'text'; text: string }>; details?: unknown; isError?: boolean }
    | undefined;
  const result = coachToolResult(override?.details ?? output) as AgentMessage & {
    content: Array<{ type: 'text'; text: string }>;
    details: unknown;
    isError: boolean;
  };
  if (override?.content !== undefined) result.content = override.content;
  if (override?.details !== undefined) result.details = override.details;
  if (override?.isError !== undefined) result.isError = override.isError;
  emitMessage(context, result);
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) =>
      part && typeof part === 'object' && 'text' in part ? [String(part.text ?? '')] : [],
    )
    .join('');
}

function isServerPresentationMessage(message: AgentMessage): boolean {
  return (message as { provider?: unknown }).provider === 'openmaic-server';
}

interface RunHarnessOptions {
  rows?: AgentSessionUserMessage[];
  events?: PersistedEvent[];
  seed?: AgentMessage[];
  hasPriorRun?: boolean;
  script?: AgentScript;
  configureStore?: (store: FakeStore) => void;
  cancelledTurnSeq?: number;
}

async function runHarness(meta: ClaimedAgentSession, options: RunHarnessOptions = {}) {
  const session = await makeEntryTree(meta.id, options.seed);
  if (options.cancelledTurnSeq !== undefined) {
    await session.appendCustomEntry('openmaic.guarded-coach-cancelled-turn.v1', {
      userMessageSeq: options.cancelledTurnSeq,
    });
  }
  const store = makeStore(meta, options.rows, options.events);
  options.configureStore?.(store);
  store.hasSessionRunHistory.mockResolvedValue(options.hasPriorRun ?? false);
  mocks.openEntryStorage.mockResolvedValue(session.getStorage());
  mocks.getAgentSessionStore.mockResolvedValue(store);

  let buildOptions: BuildAgentOptions | undefined;
  let agent: FakeAgent | undefined;
  const streamCallIndex = mocks.createCallLlmStreamFn.mock.calls.length;
  mocks.buildAgent.mockImplementation((captured: BuildAgentOptions) => {
    buildOptions = captured;
    agent = makeFakeAgent(captured, store, options.script);
    return agent;
  });

  await runSession({ running: new Map(), shuttingDown: false }, meta);
  return {
    session,
    store,
    get agent() {
      return agent;
    },
    get buildOptions() {
      return buildOptions;
    },
    streamOptions: mocks.createCallLlmStreamFn.mock.calls[streamCallIndex]?.[0] as
      | { terminalToolGate?: TerminalToolGate }
      | undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentDriverModel.mockResolvedValue({
    connection: { model: undefined, thinkingConfig: undefined },
    piModel: { api: 'openai-completions', provider: 'openai', id: 'driver-model' },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8192,
  });
  mocks.createCallLlmStreamFn.mockImplementation(() => () => undefined);
  mocks.resolveWebSearchCapability.mockReturnValue(null);
  mocks.listSessionMaterials.mockResolvedValue([]);
  mocks.listSkills.mockResolvedValue([]);
  mocks.findSkill.mockImplementation(async (id: string | undefined) =>
    id === COACH_SKILL.id ? COACH_SKILL : null,
  );
  mocks.buildSkillPreload.mockImplementation(
    async (input: { text: string; forced?: (typeof COACH_SKILL)[] }) => ({
      text: input.text,
      messages: [],
      requested: input.forced ?? [],
      injected: [],
      deferred: [],
    }),
  );
  mocks.createZhongkaoCoachActionTool.mockReturnValue({
    name: ZHONGKAO_COACH_TOOL_NAME,
    label: 'Zhongkao Coach action',
    description: 'test-only Coach tool',
    parameters: ZHONGKAO_COACH_ACTION_SCHEMA,
    execute: vi.fn(),
  });
  mocks.createGenerationAiCallFactory.mockReturnValue(vi.fn());
  mocks.getServerPersistenceProvider.mockResolvedValue({
    documentStore: { forOwner: () => ({}) },
    runtimeStore: {},
  });
});

describe('runSession frozen Zhongkao terminal wiring', () => {
  it('binds one gate and one Coach tool to the exact durable student turn', async () => {
    const row = durableRow(1, '这是我的尝试');
    const meta = makeMeta('coach-wiring', {
      skillId: COACH_SKILL.id,
      claimSeq: row.seq,
    });
    const run = await runHarness(meta, { rows: [row] });

    expect(run.buildOptions).toBeDefined();
    const gate = run.buildOptions?.terminalToolGate;
    expect(gate).toMatchObject({
      requiredToolName: ZHONGKAO_COACH_TOOL_NAME,
      suppressAssistantTextBeforeTool: true,
      terminalAfterTool: true,
    });
    expect(run.streamOptions?.terminalToolGate).toBe(gate);
    expect(run.buildOptions?.tools.map((tool) => tool.name)).toContain(ZHONGKAO_COACH_TOOL_NAME);
    expect(run.buildOptions?.allowedToolNames?.has(ZHONGKAO_COACH_TOOL_NAME)).toBe(true);
    expect(mocks.createZhongkaoCoachActionTool).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedTurn: {
          ownerId: OWNER_ID,
          agentSessionId: meta.id,
          userMessageSeq: row.seq,
        },
        beforeExecute: expect.any(Function),
        createGenerationCall: expect.any(Function),
      }),
    );
    const coachContext = mocks.createZhongkaoCoachActionTool.mock.calls[0]?.[0] as
      | ZhongkaoCoachToolContext
      | undefined;
    const toolSignal = new AbortController().signal;
    const generationCall = vi.fn();
    const selectGenerationCall = vi.fn(() => generationCall);
    mocks.createGenerationAiCallFactory.mockReturnValueOnce(selectGenerationCall);
    expect(coachContext?.createGenerationCall?.(toolSignal)).toBe(generationCall);
    expect(mocks.createGenerationAiCallFactory).toHaveBeenLastCalledWith({
      abortSignal: toolSignal,
    });
    expect(selectGenerationCall).toHaveBeenCalledWith('scene-content');

    const prompt = run.agent?.prompt.mock.calls[0]?.[0];
    expect(Array.isArray(prompt)).toBe(true);
    expect(durableUserMessageSeq((prompt as AgentMessage[])[0]!)).toBe(row.seq);
    expect(run.store.markUserMessageDelivered).toHaveBeenCalledWith(
      meta.id,
      WORKER_ID,
      meta.attempt,
      row.seq,
    );
  });

  it.each([
    {
      label: 'hint',
      output: coachOutput({ presentation: { kind: 'hint', text: '先只列出已知条件。' } }),
      presentation: { kind: 'hint', text: '先只列出已知条件。' } as const,
      params: DEFAULT_COACH_CALL_PARAMS,
    },
    {
      label: 'full solution',
      output: coachOutput({
        presentation: {
          kind: 'full_solution',
          explanation: '先移项，再合并同类项。',
          finalAnswer: 'x = 2',
        },
      }),
      presentation: {
        kind: 'full_solution',
        explanation: '先移项，再合并同类项。',
        finalAnswer: 'x = 2',
      } as const,
      params: FULL_SOLUTION_COACH_CALL_PARAMS,
    },
    {
      label: 'stable error',
      output: coachOutput({
        ok: false,
        code: 'FULL_SOLUTION_LOCKED',
        facts: { replayed: false, eventAppended: true },
      }),
      presentation: buildCoachNotice('FULL_SOLUTION_LOCKED'),
      params: FULL_SOLUTION_COACH_CALL_PARAMS,
    },
  ])(
    'publishes accepted $label content once and ends without another model turn',
    async (testCase) => {
      const row = durableRow(1, `student-${testCase.label}`);
      const meta = makeMeta(`coach-${testCase.label.replaceAll(' ', '-')}`, {
        skillId: COACH_SKILL.id,
        claimSeq: row.seq,
      });
      const run = await runHarness(meta, {
        rows: [row],
        script: (context) => emitCoachResult(context, testCase.output, testCase.params),
      });

      expect(run.agent?.prompt).toHaveBeenCalledTimes(1);
      expect(run.agent?.continue).not.toHaveBeenCalled();
      expect(mocks.buildAgent).toHaveBeenCalledTimes(1);

      const correlation = createCoachPresentationCorrelation({
        agentSessionId: meta.id,
        userMessageSeq: row.seq,
      });
      const publicEvents = run.store.events.filter((event) => {
        if (event.type !== 'message_start' && event.type !== 'message_end') return false;
        return inspectCoachPresentationEventData(event.data, correlation).status === 'published';
      });
      expect(publicEvents.map((event) => event.type)).toEqual(['message_start', 'message_end']);
      for (const event of publicEvents) {
        expect(inspectCoachPresentationEventData(event.data, correlation)).toMatchObject({
          status: 'published',
          presentation: testCase.presentation,
        });
      }

      const tree = (await run.session.buildContext()).messages;
      const published = tree.filter(
        (message) =>
          message.role === 'assistant' &&
          (message as { provider?: unknown }).provider === 'openmaic-server',
      );
      expect(published).toHaveLength(1);
      expect(messageText(published[0]!)).toBe(
        renderCoachTerminalPresentation(testCase.presentation as CoachTerminalPresentation),
      );
      expect(run.store.finishSession).toHaveBeenCalledWith(
        meta.id,
        WORKER_ID,
        expect.objectContaining({ status: 'succeeded' }),
      );
    },
  );

  it('uses fixed coach_notice when no Coach call occurs and never publishes model prose', async () => {
    const modelProse = 'MODEL-PROSE-ANSWER-42';
    const row = durableRow(1, '我卡住了');
    const meta = makeMeta('coach-fallback-missing', {
      skillId: COACH_SKILL.id,
      claimSeq: row.seq,
    });
    const run = await runHarness(meta, { rows: [row] });

    expect(run.buildOptions?.terminalToolGate?.suppressAssistantTextBeforeTool).toBe(true);
    const correlation = createCoachPresentationCorrelation({
      agentSessionId: meta.id,
      userMessageSeq: row.seq,
    });
    const publishedEnd = run.store.events.find(
      (event) =>
        event.type === 'message_end' &&
        inspectCoachPresentationEventData(event.data, correlation).status === 'published',
    );
    expect(publishedEnd).toBeDefined();
    const inspected = inspectCoachPresentationEventData(publishedEnd?.data, correlation);
    expect(inspected).toMatchObject({
      status: 'published',
      presentation: { kind: 'coach_notice' },
    });
    const publicText = inspected.status === 'published' ? messageText(inspected.message) : '';
    expect(publicText).not.toContain(modelProse);
    expect(publicText).not.toContain('ANSWER-LEAK-42');

    const durable = JSON.stringify({
      events: run.store.events,
      tree: (await run.session.buildContext()).messages,
    });
    expect(durable).not.toContain(modelProse);
    expect(durable).not.toContain('ANSWER-LEAK-42');
    const serverMessages = (await run.session.buildContext()).messages.filter(
      (message) => (message as { provider?: unknown }).provider === 'openmaic-server',
    );
    expect(serverMessages).toHaveLength(1);
    expect(messageText(serverMessages[0]!)).not.toContain('ANSWER-LEAK-42');
  });

  it.each([
    {
      label: 'malformed result',
      output: { ok: true, internal: 'provider prose: ANSWER-LEAK-42' },
    },
    {
      label: 'unproven runtime conflict',
      output: coachOutput({
        ok: false,
        code: 'COACH_SESSION_CONFLICT',
        facts: { replayed: false, eventAppended: false },
      }),
    },
  ])('parks a live $label for replay without publishing or delivering', async (testCase) => {
    const row = durableRow(1, '我卡住了');
    const meta = makeMeta(`coach-live-uncertain-${testCase.label.replaceAll(' ', '-')}`, {
      skillId: COACH_SKILL.id,
      claimSeq: row.seq,
    });
    const run = await runHarness(meta, {
      rows: [row],
      script: (context) => emitCoachResult(context, testCase.output),
    });

    const tree = (await run.session.buildContext()).messages;
    expect(tree.filter(isServerPresentationMessage)).toHaveLength(0);
    expect(run.store.markUserMessageDelivered).not.toHaveBeenCalled();
    expect(run.store.requeueForRetry).toHaveBeenCalledWith(meta.id);
    expect(run.store.finishSession).toHaveBeenCalledWith(
      meta.id,
      WORKER_ID,
      expect.objectContaining({ status: 'failed' }),
    );
    expect(JSON.stringify({ tree, events: run.store.events })).not.toContain('ANSWER-LEAK-42');
  });

  it('converts a guarded setup failure to fixed terminal copy without durable raw error', async () => {
    const privateError = 'PRIVATE_DRIVER_SETUP_ERROR';
    mocks.resolveAgentDriverModel.mockRejectedValueOnce(new Error(privateError));
    const row = durableRow(1, '请按伴学流程处理');
    const meta = makeMeta('coach-setup-failure', {
      skillId: COACH_SKILL.id,
      claimSeq: row.seq,
    });

    const run = await runHarness(meta, { rows: [row] });

    expect(run.buildOptions).toBeUndefined();
    const durable = JSON.stringify({
      events: run.store.events,
      tree: (await run.session.buildContext()).messages,
    });
    expect(durable).not.toContain(privateError);
    expect(durable).toContain('这次内容暂时没有生成成功');
    expect(run.store.finishSession).toHaveBeenCalledWith(
      meta.id,
      WORKER_ID,
      expect.objectContaining({ status: 'succeeded' }),
    );
    expect(run.store.markUserMessageDelivered).toHaveBeenCalledWith(
      meta.id,
      WORKER_ID,
      meta.attempt,
      row.seq,
    );
    expect(run.store.requeueForRetry).not.toHaveBeenCalled();
  });

  it('publishes a fixed Coach notice instead of the generic over-attempt verdict', async () => {
    const row = durableRow(1, '请安全结束当前伴学 turn');
    const meta = makeMeta('coach-over-attempt-cap', {
      skillId: COACH_SKILL.id,
      attempt: Number.MAX_SAFE_INTEGER,
      claimSeq: row.seq,
    });

    const run = await runHarness(meta, { rows: [row] });

    expect(run.buildOptions).toBeUndefined();
    const durable = JSON.stringify({
      events: run.store.events,
      tree: (await run.session.buildContext()).messages,
    });
    expect(durable).toContain('这次内容暂时没有生成成功');
    expect(durable).not.toContain('consecutive unattended attempts');
    expect(run.store.finishSession).toHaveBeenCalledWith(
      meta.id,
      WORKER_ID,
      expect.objectContaining({ status: 'succeeded', resetAttempt: true }),
    );
    expect(run.store.markUserMessageDelivered).toHaveBeenCalledWith(
      meta.id,
      WORKER_ID,
      meta.attempt,
      row.seq,
    );
    expect(run.store.requeueForRetry).not.toHaveBeenCalled();
  });

  it('recovers an accepted Coach presentation before applying the attempt-limit verdict', async () => {
    const row = durableRow(1, '请给我提示');
    const user = tagDurableUserMessage(
      { role: 'user', content: row.text, timestamp: 1 } as unknown as AgentMessage,
      row.seq,
    );
    const accepted = coachOutput({ presentation: { kind: 'hint', text: '先检查已知条件。' } });
    const meta = makeMeta('coach-over-attempt-checkpoint', {
      skillId: COACH_SKILL.id,
      attempt: Number.MAX_SAFE_INTEGER,
      claimReason: 'orphaned',
      claimSeq: 3,
      deliveredUserMessageSeq: row.seq,
    });
    const session = await makeEntryTree(meta.id, [
      user,
      assistantToolCall('over-attempt-checkpoint-call'),
      coachToolResult(accepted, 'over-attempt-checkpoint-call'),
    ]);
    const store = makeStore(meta, [row]);
    store.hasSessionRunHistory.mockResolvedValue(true);
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);

    await runSession({ running: new Map(), shuttingDown: false }, meta);

    const serverMessages = (await session.buildContext()).messages.filter(
      isServerPresentationMessage,
    );
    expect(serverMessages).toHaveLength(1);
    expect(messageText(serverMessages[0]!)).toBe('先检查已知条件。');
    expect(messageText(serverMessages[0]!)).not.toContain('这次内容暂时没有生成成功');
    expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
    expect(mocks.buildAgent).not.toHaveBeenCalled();
  });

  it('applies an attempt-limit notice to queued N+1 after completed N', async () => {
    const first = durableRow(1, 'turn N');
    const later = durableRow(2, 'turn N+1 at verdict');
    const firstMeta = makeMeta('coach-over-attempt-next-turn', {
      skillId: COACH_SKILL.id,
      claimSeq: first.seq,
    });
    const run = await runHarness(firstMeta, { rows: [first, later] });
    mocks.createZhongkaoCoachActionTool.mockClear();

    await runSession(
      { running: new Map(), shuttingDown: false },
      {
        ...firstMeta,
        attempt: Number.MAX_SAFE_INTEGER,
        claimReason: 'orphaned',
        claimSeq: later.seq,
        deliveredUserMessageSeq: first.seq,
      },
    );

    expect(
      (await run.session.buildContext()).messages.filter(isServerPresentationMessage),
    ).toHaveLength(2);
    expect(run.store.markUserMessageDelivered).toHaveBeenCalledWith(
      firstMeta.id,
      WORKER_ID,
      Number.MAX_SAFE_INTEGER,
      later.seq,
    );
    expect(mocks.createZhongkaoCoachActionTool).not.toHaveBeenCalled();
    expect(mocks.resolveAgentDriverModel).toHaveBeenCalledTimes(1);
  });

  it('parks without publishing when a retry-stable fallback turn cannot be read', async () => {
    const privateError = 'PRIVATE_USER_EVENT_READ_FAILURE';
    const row = durableRow(1, '请按伴学流程处理');
    const meta = makeMeta('coach-fallback-read-failure', {
      skillId: COACH_SKILL.id,
      claimSeq: row.seq,
    });
    let originalRead:
      | ((
          ...args: Parameters<FakeStore['readEventsAfter']>
        ) => ReturnType<FakeStore['readEventsAfter']>)
      | undefined;
    const first = await runHarness(meta, {
      rows: [row],
      configureStore: (store) => {
        originalRead = store.readEventsAfter.getMockImplementation();
        store.readEventsAfter
          .mockRejectedValueOnce(new Error(privateError))
          .mockImplementation(originalRead!);
      },
    });

    const firstTree = (await first.session.buildContext()).messages;
    expect(firstTree.filter(isServerPresentationMessage)).toHaveLength(0);
    expect(JSON.stringify(first.store.events)).not.toContain(privateError);
    expect(first.store.requeueForRetry).toHaveBeenCalledWith(meta.id);

    await runSession(
      { running: new Map(), shuttingDown: false },
      { ...meta, attempt: 2, claimSeq: 99 },
    );
    const repaired = (await first.session.buildContext()).messages.filter(
      isServerPresentationMessage,
    );
    expect(repaired).toHaveLength(1);
  });

  it.each([
    {
      label: 'wrong tool',
      expectedReason: 'WRONG_TOOL_CALLED' as const,
      calls: [
        {
          type: 'toolCall' as const,
          id: 'wrong-call',
          name: 'other_tool',
          arguments: { privateMarker: 'WRONG_TOOL_PRIVATE_INPUT' },
        },
      ],
    },
    {
      label: 'invalid Coach args',
      expectedReason: 'COACH_TOOL_INPUT_INVALID' as const,
      calls: [
        {
          type: 'toolCall' as const,
          id: 'invalid-call',
          name: ZHONGKAO_COACH_TOOL_NAME,
          arguments: { action: 'get_state', privateMarker: 'INVALID_PRIVATE_INPUT' },
        },
      ],
    },
    {
      label: 'duplicate Coach call',
      expectedReason: 'NO_COACH_CALL' as const,
      calls: [
        {
          type: 'toolCall' as const,
          id: 'accepted-call',
          name: ZHONGKAO_COACH_TOOL_NAME,
          arguments: {
            action: 'get_state',
            profileId: 'profile-1',
            coachSessionId: 'coach-1',
          },
        },
        {
          type: 'toolCall' as const,
          id: 'duplicate-call',
          name: ZHONGKAO_COACH_TOOL_NAME,
          arguments: {
            action: 'get_state',
            profileId: 'profile-1',
            coachSessionId: 'coach-1',
          },
        },
      ],
    },
  ])('converges $label to one fixed Runner notice', async ({ calls, expectedReason }) => {
    const row = durableRow(1, '请按伴学流程处理');
    const meta = makeMeta(`coach-gate-${expectedReason.toLowerCase()}`, {
      skillId: COACH_SKILL.id,
      claimSeq: row.seq,
    });
    const run = await runHarness(meta, {
      rows: [row],
      script: ({ options }) => {
        const gate = options.terminalToolGate!;
        for (const call of calls) {
          acceptTerminalToolGateCall(gate, call, options.tools as never);
        }
      },
    });

    const serverMessages = (await run.session.buildContext()).messages.filter(
      isServerPresentationMessage,
    );
    expect(serverMessages).toHaveLength(1);
    expect(messageText(serverMessages[0]!)).toBe(
      renderCoachTerminalPresentation(buildCoachNotice(expectedReason)),
    );
    expect(
      mocks.createZhongkaoCoachActionTool.mock.results[0]?.value.execute,
    ).not.toHaveBeenCalled();
    const durable = JSON.stringify({
      events: run.store.events,
      tree: (await run.session.buildContext()).messages,
    });
    expect(durable).not.toContain('PRIVATE_INPUT');
  });

  it('queues N+1 behind active N instead of steering it into the guarded Agent', async () => {
    const first = durableRow(1, 'turn N');
    const meta = makeMeta('coach-queue-boundary', {
      skillId: COACH_SKILL.id,
      claimSeq: first.seq,
    });
    let later: AgentSessionUserMessage | undefined;
    const run = await runHarness(meta, {
      rows: [first],
      script: ({ store }) => {
        later = store.pushUserMessage('turn N+1');
      },
    });

    expect(later?.seq).toBeGreaterThan(meta.claimSeq);
    expect(run.store.events).toContainEqual(
      expect.objectContaining({ id: later?.seq, type: 'user_message' }),
    );
    expect(run.agent?.steer).not.toHaveBeenCalled();
    expect(run.store.markUserMessageDelivered).toHaveBeenCalledTimes(1);
    expect(run.store.markUserMessageDelivered.mock.calls[0]?.[3]).toBe(first.seq);
    expect(run.store.requeueSession).toHaveBeenCalledWith(meta.id);
    expect(JSON.stringify((await run.session.buildContext()).messages)).not.toContain('turn N+1');
  });

  it('lets cancellation win over an uncertain Coach receipt without retry or publication', async () => {
    const row = durableRow(1, 'turn N');
    const meta = makeMeta('coach-cancel-uncertain', {
      skillId: COACH_SKILL.id,
      claimSeq: row.seq,
    });
    const run = await runHarness(meta, {
      rows: [row],
      configureStore: (store) => store.getCancelRequestedAt.mockResolvedValue(123),
      script: async (context) => {
        const call = assistantToolCall();
        emitMessage(context, call);
        await context.options.afterToolCall?.({
          toolCall: (call as { content: unknown[] }).content[0],
          result: { details: { ok: true, malformed: true }, content: [] },
          isError: false,
        });
        throw new Error('simulated abort race after an uncertain Coach call');
      },
    });

    expect(run.store.finishSession).toHaveBeenCalledWith(
      meta.id,
      WORKER_ID,
      expect.objectContaining({
        status: 'cancelled',
        consumeCancelRequestedAt: 123,
      }),
    );
    expect(run.store.requeueForRetry).not.toHaveBeenCalled();
    expect((await run.session.buildContext()).messages.filter(isServerPresentationMessage)).toEqual(
      [],
    );
    expect(run.store.markUserMessageDelivered).toHaveBeenCalledWith(
      meta.id,
      WORKER_ID,
      meta.attempt,
      row.seq,
    );
    const results = (await run.session.buildContext()).messages.filter(
      (message) => message.role === 'toolResult' && message.toolName === ZHONGKAO_COACH_TOOL_NAME,
    );
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain('interrupted before a result was recorded');
  });

  it('consumes cancelled text-only N without publishing it and requeues queued N+1', async () => {
    const row = durableRow(1, 'turn N');
    const meta = makeMeta('coach-cancel-queued-next', {
      skillId: COACH_SKILL.id,
      claimSeq: row.seq,
    });
    let later: AgentSessionUserMessage | undefined;
    const run = await runHarness(meta, {
      rows: [row],
      configureStore: (store) => store.getCancelRequestedAt.mockResolvedValue(123),
      script: ({ store }) => {
        later = store.pushUserMessage('turn N+1');
      },
    });

    expect(run.store.markUserMessageDelivered.mock.calls.map((call) => call[3])).toEqual([row.seq]);
    expect(run.store.requeueSession).toHaveBeenCalledWith(meta.id);
    expect(run.store.requeueForRetry).not.toHaveBeenCalled();
    expect((await run.session.buildContext()).messages.filter(isServerPresentationMessage)).toEqual(
      [],
    );
    expect(later?.seq).toBeGreaterThan(meta.claimSeq);
    const tombstones = (await run.session.getBranch()).filter(
      (entry) => entry.type === 'custom' && entry.customType.includes('cancelled-turn'),
    );
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({ data: { userMessageSeq: row.seq } });
  });
});

describe('runSession Zhongkao recovery and isolation', () => {
  it.each([
    { failure: 'entry tree after the durable marker', markerPersisted: true },
    { failure: 'the durable marker itself', markerPersisted: false },
  ])(
    'does not resurrect cancelled N after $failure fails and claim cleanup precedes N+1',
    async ({ markerPersisted }) => {
      const first = durableRow(1, 'turn N must stay cancelled');
      const initialMeta = makeMeta(`coach-cancel-durable-${markerPersisted ? 'tree' : 'event'}`, {
        skillId: COACH_SKILL.id,
        claimSeq: first.seq,
        deliveredUserMessageSeq: 0,
      });
      const session = await makeEntryTree(initialMeta.id);
      const store = makeStore(initialMeta, [first]);
      store.getCancelRequestedAt.mockResolvedValue(123);
      mocks.openEntryStorage.mockResolvedValue(session.getStorage());
      mocks.getAgentSessionStore.mockResolvedValue(store);
      mocks.buildAgent.mockImplementation((captured: BuildAgentOptions) =>
        makeFakeAgent(captured, store),
      );

      const originalAppend = store.appendRunEvent.getMockImplementation()!;
      let getPathSpy: ReturnType<typeof vi.spyOn> | undefined;
      if (markerPersisted) {
        let markerWritten = false;
        store.appendRunEvent.mockImplementation(async (...args) => {
          const result = await originalAppend(...args);
          if (args[2].type === GUARDED_COACH_CANCELLED_TURN_EVENT) markerWritten = true;
          return result;
        });
        const storage = session.getStorage();
        const originalGetPath = storage.getPathToRoot.bind(storage);
        getPathSpy = vi.spyOn(storage, 'getPathToRoot').mockImplementation(async (...args) => {
          if (markerWritten) {
            throw new Error('simulated entry-tree outage after cancellation marker');
          }
          return originalGetPath(...args);
        });
      } else {
        store.appendRunEvent.mockImplementation(async (...args) => {
          if (args[2].type === GUARDED_COACH_CANCELLED_TURN_EVENT) {
            throw new Error('simulated cancellation marker write outage');
          }
          return originalAppend(...args);
        });
      }

      const firstRunError = await runSession(
        { running: new Map(), shuttingDown: false },
        initialMeta,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      if (!markerPersisted) {
        expect(firstRunError).toBeInstanceOf(Error);
        expect((firstRunError as Error).message).toContain('simulated');
      }

      const markerEvents = store.events.filter(
        (event) => event.type === GUARDED_COACH_CANCELLED_TURN_EVENT,
      );
      expect(markerEvents).toHaveLength(markerPersisted ? 1 : 0);
      if (markerPersisted) {
        expect(markerEvents[0]?.data).toEqual({ schemaVersion: 1, userMessageSeq: first.seq });
      }
      expect(store.markUserMessageDelivered).not.toHaveBeenCalled();

      getPathSpy?.mockRestore();
      store.appendRunEvent.mockImplementation(originalAppend);
      // This is the durable side of settleCancelledAtClaim: it is committed in
      // the same transaction that clears the request and releases the lease.
      await store.appendRunEvent(initialMeta.id, WORKER_ID, {
        ts: 2,
        attempt: initialMeta.attempt,
        type: 'session_end',
        data: { status: 'cancelled', cancelledUserMessageSeq: first.seq },
      });
      store.getCancelRequestedAt.mockResolvedValue(null);
      const later = store.pushUserMessage('turn N+1 after claim cancellation cleanup');

      const resumedMeta = makeMeta(initialMeta.id, {
        skillId: COACH_SKILL.id,
        claimReason: 'queued',
        attempt: initialMeta.attempt + 1,
        claimSeq: later.seq,
        deliveredUserMessageSeq: 0,
      });
      const resumedStore = makeStore(resumedMeta, store.rows, store.events);
      resumedStore.hasSessionRunHistory.mockResolvedValue(true);
      mocks.getAgentSessionStore.mockResolvedValue(resumedStore);
      mocks.openEntryStorage.mockResolvedValue(session.getStorage());
      mocks.createZhongkaoCoachActionTool.mockClear();
      mocks.buildAgent.mockImplementation((captured: BuildAgentOptions) =>
        makeFakeAgent(captured, resumedStore),
      );

      await runSession({ running: new Map(), shuttingDown: false }, resumedMeta);

      expect(mocks.createZhongkaoCoachActionTool).toHaveBeenCalledTimes(1);
      expect(mocks.createZhongkaoCoachActionTool).toHaveBeenCalledWith(
        expect.objectContaining({
          trustedTurn: expect.objectContaining({ userMessageSeq: later.seq }),
        }),
      );
      const prompt = mocks.buildAgent.mock.results.at(-1)?.value.prompt.mock.calls[0]?.[0] as
        | AgentMessage[]
        | undefined;
      expect(prompt).toBeDefined();
      expect(durableUserMessageSeq(prompt![0]!)).toBe(later.seq);
      expect(resumedStore.markUserMessageDelivered.mock.calls.map((call) => call[3])).toEqual([
        first.seq,
        later.seq,
      ]);
      const firstCorrelation = createCoachPresentationCorrelation({
        agentSessionId: resumedMeta.id,
        userMessageSeq: first.seq,
      });
      expect(
        resumedStore.events.some(
          (event) =>
            (event.type === 'message_start' || event.type === 'message_end') &&
            inspectCoachPresentationEventData(event.data, firstCorrelation).status === 'published',
        ),
      ).toBe(false);
    },
  );

  it('fails closed when an exact claim cancellation target lacks its raw tagged cursor', async () => {
    const first = durableRow(1, 'turn N with damaged branch provenance');
    const later = durableRow(3, 'turn N+1');
    const meta = makeMeta('coach-claim-cancel-missing-cursor', {
      skillId: COACH_SKILL.id,
      claimReason: 'queued',
      attempt: 2,
      claimSeq: later.seq,
      deliveredUserMessageSeq: 0,
    });
    const run = await runHarness(meta, {
      rows: [first, later],
      events: [
        {
          id: first.seq,
          ts: first.ts,
          attempt: 1,
          type: 'user_message',
          data: { text: first.text, delivery: first.delivery, materials: [] },
        },
        {
          id: 2,
          ts: 2,
          attempt: 1,
          type: 'session_end',
          data: { status: 'cancelled', cancelledUserMessageSeq: first.seq },
        },
        {
          id: later.seq,
          ts: later.ts,
          attempt: 1,
          type: 'user_message',
          data: { text: later.text, delivery: later.delivery, materials: [] },
        },
      ],
      hasPriorRun: true,
    });

    expect(mocks.buildAgent).not.toHaveBeenCalled();
    expect(mocks.createZhongkaoCoachActionTool).not.toHaveBeenCalled();
    expect(run.store.markUserMessageDelivered).not.toHaveBeenCalled();
    expect(run.store.requeueForRetry).toHaveBeenCalledWith(meta.id);
    expect(run.store.requeueSession).not.toHaveBeenCalled();
  });

  it('ignores an older cancellation terminal written after queued N+1 and processes N+1', async () => {
    const first = durableRow(1, 'turn N');
    const later = durableRow(2, 'turn N+1 queued before cancellation settled');
    const events: PersistedEvent[] = [
      {
        id: first.seq,
        ts: first.ts,
        attempt: 1,
        type: 'user_message',
        data: { text: first.text, delivery: first.delivery, materials: [] },
      },
      {
        id: later.seq,
        ts: later.ts,
        attempt: 1,
        type: 'user_message',
        data: { text: later.text, delivery: later.delivery, materials: [] },
      },
      {
        id: 3,
        ts: 3,
        attempt: 1,
        type: GUARDED_COACH_CANCELLED_TURN_EVENT,
        data: { schemaVersion: 1, userMessageSeq: first.seq },
      },
      {
        id: 4,
        ts: 4,
        attempt: 1,
        type: 'session_end',
        data: { status: 'cancelled', cancelledUserMessageSeq: first.seq },
      },
    ];
    const meta = makeMeta('coach-old-cancel-before-next', {
      skillId: COACH_SKILL.id,
      claimReason: 'queued',
      attempt: 2,
      claimSeq: 4,
      deliveredUserMessageSeq: first.seq,
    });
    const run = await runHarness(meta, {
      rows: [first, later],
      events,
      seed: [
        tagDurableUserMessage(
          { role: 'user', content: first.text, timestamp: 1 } as unknown as AgentMessage,
          first.seq,
        ),
      ],
      cancelledTurnSeq: first.seq,
      hasPriorRun: true,
    });

    expect(mocks.createZhongkaoCoachActionTool).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedTurn: expect.objectContaining({ userMessageSeq: later.seq }),
      }),
    );
    const prompt = run.agent?.prompt.mock.calls[0]?.[0] as AgentMessage[];
    expect(durableUserMessageSeq(prompt[0]!)).toBe(later.seq);
    expect(run.store.markUserMessageDelivered.mock.calls.map((call) => call[3])).toEqual([
      later.seq,
    ]);
  });

  it.each([
    { failure: 'driver setup failure', attempt: 2, failDriver: true },
    { failure: 'attempt-cap verdict', attempt: 99, failDriver: false },
  ])(
    'binds a queued N+1 $failure to N+1 instead of the delivered cancelled N cursor',
    async ({ attempt, failDriver }) => {
      const first = durableRow(1, 'cancelled turn N');
      const later = durableRow(2, 'queued turn N+1');
      const events: PersistedEvent[] = [
        {
          id: first.seq,
          ts: first.ts,
          attempt: 1,
          type: 'user_message',
          data: { text: first.text, delivery: first.delivery, materials: [] },
        },
        {
          id: later.seq,
          ts: later.ts,
          attempt: 1,
          type: 'user_message',
          data: { text: later.text, delivery: later.delivery, materials: [] },
        },
        {
          id: 3,
          ts: 3,
          attempt: 1,
          type: GUARDED_COACH_CANCELLED_TURN_EVENT,
          data: { schemaVersion: 1, userMessageSeq: first.seq },
        },
        {
          id: 4,
          ts: 4,
          attempt: 1,
          type: 'session_end',
          data: { status: 'cancelled', cancelledUserMessageSeq: first.seq },
        },
      ];
      const meta = makeMeta('coach-queued-next-setup-failure', {
        skillId: COACH_SKILL.id,
        claimReason: 'queued',
        attempt,
        claimSeq: 4,
        deliveredUserMessageSeq: first.seq,
      });
      if (failDriver) {
        mocks.resolveAgentDriverModel.mockRejectedValueOnce(
          new Error('simulated driver setup failure'),
        );
      }
      const run = await runHarness(meta, {
        rows: [first, later],
        events,
        seed: [
          tagDurableUserMessage(
            { role: 'user', content: first.text, timestamp: 1 } as unknown as AgentMessage,
            first.seq,
          ),
        ],
        cancelledTurnSeq: first.seq,
        hasPriorRun: true,
      });

      expect(mocks.buildAgent).not.toHaveBeenCalled();
      expect(run.store.markUserMessageDelivered.mock.calls.map((call) => call[3])).toEqual([
        later.seq,
      ]);
      const laterCorrelation = createCoachPresentationCorrelation({
        agentSessionId: meta.id,
        userMessageSeq: later.seq,
      });
      const firstCorrelation = createCoachPresentationCorrelation({
        agentSessionId: meta.id,
        userMessageSeq: first.seq,
      });
      expect(
        run.store.events.some(
          (event) =>
            event.type === 'message_end' &&
            inspectCoachPresentationEventData(event.data, laterCorrelation).status === 'published',
        ),
      ).toBe(true);
      expect(
        run.store.events.some(
          (event) =>
            event.type === 'message_end' &&
            inspectCoachPresentationEventData(event.data, firstCorrelation).status === 'published',
        ),
      ).toBe(false);
    },
  );

  it('recovers a tombstone-before-watermark crash by skipping N and binding only N+1', async () => {
    const first = durableRow(1, 'turn N');
    const later = durableRow(4, 'turn N+1');
    const firstFrame = tagDurableUserMessage(
      { role: 'user', content: first.text, timestamp: 1 } as unknown as AgentMessage,
      first.seq,
    );
    const meta = makeMeta('coach-cancel-tombstone-crash', {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: later.seq,
      deliveredUserMessageSeq: 0,
    });
    const run = await runHarness(meta, {
      rows: [first, later],
      seed: [
        firstFrame,
        assistantToolCall(),
        interruptedToolResult({ id: 'coach-call-1', name: ZHONGKAO_COACH_TOOL_NAME }),
      ],
      cancelledTurnSeq: first.seq,
      hasPriorRun: true,
    });

    expect(mocks.createZhongkaoCoachActionTool).toHaveBeenCalledTimes(1);
    expect(mocks.createZhongkaoCoachActionTool).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedTurn: expect.objectContaining({ userMessageSeq: later.seq }),
      }),
    );
    const prompt = run.agent?.prompt.mock.calls[0]?.[0] as AgentMessage[];
    expect(durableUserMessageSeq(prompt[0]!)).toBe(later.seq);
    expect(run.store.markUserMessageDelivered.mock.calls.map((call) => call[3])).toEqual([
      first.seq,
      later.seq,
    ]);
    const firstCorrelation = createCoachPresentationCorrelation({
      agentSessionId: meta.id,
      userMessageSeq: first.seq,
    });
    expect(
      run.store.events.some(
        (event) =>
          (event.type === 'message_start' || event.type === 'message_end') &&
          inspectCoachPresentationEventData(event.data, firstCorrelation).status === 'published',
      ),
    ).toBe(false);
  });

  it('recovers raw branch N even when durable event N+1 already exists', async () => {
    const first = durableRow(1, 'turn N');
    const later = durableRow(4, 'turn N+1');
    const firstFrame = tagDurableUserMessage(
      { role: 'user', content: first.text, timestamp: 1 } as unknown as AgentMessage,
      first.seq,
    );
    const meta = makeMeta('coach-crash-turn', {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: later.seq,
      deliveredUserMessageSeq: first.seq,
    });
    const run = await runHarness(meta, {
      rows: [first, later],
      seed: [firstFrame],
      hasPriorRun: true,
    });

    expect(mocks.createZhongkaoCoachActionTool).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedTurn: expect.objectContaining({ userMessageSeq: first.seq }),
      }),
    );
    expect(run.agent?.continue).toHaveBeenCalledTimes(1);
    expect(run.agent?.prompt).not.toHaveBeenCalled();
    expect(run.agent?.steer).not.toHaveBeenCalled();
    expect(run.store.requeueForRetry).toHaveBeenCalledWith(meta.id);
    expect(JSON.stringify((await run.session.buildContext()).messages)).not.toContain(later.text);
  });

  it('publishes a checkpointed Coach result after crash without calling the model, then replays idempotently', async () => {
    const row = durableRow(1, '请给我提示');
    const user = tagDurableUserMessage(
      { role: 'user', content: row.text, timestamp: 1 } as unknown as AgentMessage,
      row.seq,
    );
    const accepted = coachOutput({ presentation: { kind: 'hint', text: '只检查下一步符号。' } });
    const session = await makeEntryTree('coach-result-recovery', [
      user,
      assistantToolCall('checkpointed-call'),
      coachToolResult(accepted, 'checkpointed-call'),
    ]);
    const meta = makeMeta('coach-result-recovery', {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: 3,
      deliveredUserMessageSeq: row.seq,
    });
    const store = makeStore(meta, [row]);
    store.hasSessionRunHistory.mockResolvedValue(true);
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);

    await runSession({ running: new Map(), shuttingDown: false }, meta);
    await runSession({ running: new Map(), shuttingDown: false }, meta);

    expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
    expect(mocks.createCallLlmStreamFn).not.toHaveBeenCalled();
    expect(mocks.buildAgent).not.toHaveBeenCalled();
    const tree = (await session.buildContext()).messages;
    const published = tree.filter(
      (message) => (message as { provider?: unknown }).provider === 'openmaic-server',
    );
    expect(published).toHaveLength(1);
    expect(messageText(published[0]!)).toBe('只检查下一步符号。');

    const correlation = createCoachPresentationCorrelation({
      agentSessionId: meta.id,
      userMessageSeq: row.seq,
    });
    const presentationEvents = store.events.filter(
      (event) =>
        (event.type === 'message_start' || event.type === 'message_end') &&
        inspectCoachPresentationEventData(event.data, correlation).status === 'published',
    );
    expect(presentationEvents.map((event) => event.type)).toEqual(['message_start', 'message_end']);
  });

  it('replays a committed hint from an orphaned call after forced Skill preload without consuming N+1', async () => {
    const sessionId = 'coach-orphan-hint-replay';
    const seeded = await seedCommittedCoachAction(sessionId, 'hint');
    const row = durableRow(seeded.targetSeq, '请给我一个提示。');
    const later = durableRow(seeded.targetSeq + 1, 'turn N+1');
    const callId = 'orphan-hint-call';
    const user = tagDurableUserMessage(
      { role: 'user', content: row.text, timestamp: 1 } as unknown as AgentMessage,
      row.seq,
    );
    const seed = [
      user,
      ...skillPreloadPair(),
      assistantToolCall(callId, seeded.params),
      interruptedToolResult({ id: callId, name: ZHONGKAO_COACH_TOOL_NAME }),
    ];
    const replayCalls: Array<{ id: string; params: CoachToolParams }> = [];
    const replayGeneration = vi.fn(async () => {
      throw new Error('idempotent hint replay must not call generation');
    });
    mocks.createGenerationAiCallFactory.mockReturnValue(vi.fn(() => replayGeneration));
    mocks.getServerPersistenceProvider.mockResolvedValue({
      documentStore: { forOwner: () => ({}) },
      runtimeStore: seeded.runtimeStore,
    });
    mocks.createZhongkaoCoachActionTool.mockImplementation((context: ZhongkaoCoachToolContext) => {
      const tool = seeded.actualFactory(context);
      const execute = tool.execute as unknown as (
        id: string,
        params: CoachToolParams,
        signal?: AbortSignal,
      ) => Promise<unknown>;
      return {
        ...tool,
        execute: async (id: string, params: CoachToolParams, signal?: AbortSignal) => {
          replayCalls.push({ id, params });
          return execute(id, params, signal);
        },
      } as never;
    });
    const meta = makeMeta(sessionId, {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: later.seq,
      deliveredUserMessageSeq: row.seq,
    });
    const run = await runHarness(meta, {
      rows: [row, later],
      seed,
      hasPriorRun: true,
    });

    expect(replayCalls).toEqual([{ id: callId, params: seeded.params }]);
    expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
    expect(mocks.createCallLlmStreamFn).not.toHaveBeenCalled();
    expect(mocks.buildAgent).not.toHaveBeenCalled();
    expect(replayGeneration).not.toHaveBeenCalled();
    expect(await coachRecordCount(seeded.runtimeStore)).toBe(seeded.recordsBeforeReplay);
    const tree = (await run.session.buildContext()).messages;
    const coachResults = tree.filter(
      (message) => message.role === 'toolResult' && message.toolName === ZHONGKAO_COACH_TOOL_NAME,
    );
    expect(coachResults).toHaveLength(1);
    expect((coachResults[0] as { details?: unknown }).details).toMatchObject({
      ok: true,
      presentation: seeded.presentation,
      facts: { replayed: true, eventAppended: false },
    });
    expect(JSON.stringify(tree)).not.toContain('interrupted before a result was recorded');
    const published = tree.filter(isServerPresentationMessage);
    expect(published).toHaveLength(1);
    expect(messageText(published[0]!)).toBe(renderCoachTerminalPresentation(seeded.presentation));
    expect(run.store.markUserMessageDelivered).not.toHaveBeenCalledWith(
      meta.id,
      WORKER_ID,
      meta.attempt,
      later.seq,
    );
    expect(run.store.requeueForRetry).toHaveBeenCalledWith(meta.id);
  });

  it('replays a committed full solution without a second generation or duplicate publication', async () => {
    const sessionId = 'coach-orphan-solution-replay';
    const seeded = await seedCommittedCoachAction(sessionId, 'full_solution');
    const row = durableRow(seeded.targetSeq, '请展示完整解析。');
    const callId = 'orphan-solution-call';
    const user = tagDurableUserMessage(
      { role: 'user', content: row.text, timestamp: 1 } as unknown as AgentMessage,
      row.seq,
    );
    const replayCalls: Array<{ id: string; params: CoachToolParams }> = [];
    const replayGeneration = vi.fn(async () => {
      throw new Error('idempotent solution replay must not call generation');
    });
    mocks.createGenerationAiCallFactory.mockReturnValue(vi.fn(() => replayGeneration));
    mocks.getServerPersistenceProvider.mockResolvedValue({
      documentStore: { forOwner: () => ({}) },
      runtimeStore: seeded.runtimeStore,
    });
    mocks.createZhongkaoCoachActionTool.mockImplementation((context: ZhongkaoCoachToolContext) => {
      const tool = seeded.actualFactory(context);
      const execute = tool.execute as unknown as (
        id: string,
        params: CoachToolParams,
        signal?: AbortSignal,
      ) => Promise<unknown>;
      return {
        ...tool,
        execute: async (id: string, params: CoachToolParams, signal?: AbortSignal) => {
          replayCalls.push({ id, params });
          return execute(id, params, signal);
        },
      } as never;
    });
    const meta = makeMeta(sessionId, {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: row.seq,
      deliveredUserMessageSeq: row.seq,
    });
    const session = await makeEntryTree(sessionId, [
      user,
      assistantToolCall(callId, seeded.params),
    ]);
    const store = makeStore(meta, [row]);
    store.hasSessionRunHistory.mockResolvedValue(true);
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);

    await runSession({ running: new Map(), shuttingDown: false }, meta);
    await runSession({ running: new Map(), shuttingDown: false }, meta);

    expect(replayCalls).toEqual([{ id: callId, params: seeded.params }]);
    expect(replayGeneration).not.toHaveBeenCalled();
    expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
    expect(mocks.buildAgent).not.toHaveBeenCalled();
    expect(await coachRecordCount(seeded.runtimeStore)).toBe(seeded.recordsBeforeReplay);
    const tree = (await session.buildContext()).messages;
    expect(
      tree.filter(
        (message) => message.role === 'toolResult' && message.toolName === ZHONGKAO_COACH_TOOL_NAME,
      ),
    ).toHaveLength(1);
    const published = tree.filter(isServerPresentationMessage);
    expect(published).toHaveLength(1);
    expect(messageText(published[0]!)).toBe(renderCoachTerminalPresentation(seeded.presentation));
  });

  it('parks an uncertain orphan replay error without writing a receipt or publishing', async () => {
    const row = durableRow(1, '请给提示。');
    const callId = 'orphan-uncertain-call';
    const meta = makeMeta('coach-orphan-uncertain', {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: row.seq,
      deliveredUserMessageSeq: row.seq,
    });
    const uncertain = coachOutput({
      ok: false,
      code: 'COACH_SESSION_CONFLICT',
      facts: { replayed: false, eventAppended: false },
    });
    const execute = vi.fn(
      async (_id: string, _params: CoachToolParams, _signal?: AbortSignal): Promise<unknown> => ({
        content: [{ type: 'text', text: JSON.stringify(uncertain) }],
        details: uncertain,
        isError: true,
      }),
    );
    mocks.createZhongkaoCoachActionTool.mockImplementation((context: ZhongkaoCoachToolContext) => ({
      name: ZHONGKAO_COACH_TOOL_NAME,
      label: 'Zhongkao Coach action',
      description: 'test-only recovery tool',
      parameters: ZHONGKAO_COACH_ACTION_SCHEMA,
      execute: async (id: string, params: CoachToolParams, signal?: AbortSignal) => {
        await context.beforeExecute?.();
        return execute(id, params, signal);
      },
    }));
    const run = await runHarness(meta, {
      rows: [row],
      seed: [
        tagDurableUserMessage(
          { role: 'user', content: row.text, timestamp: 1 } as unknown as AgentMessage,
          row.seq,
        ),
        assistantToolCall(callId),
      ],
      hasPriorRun: true,
    });

    expect(execute).toHaveBeenCalledOnce();
    const tree = (await run.session.buildContext()).messages;
    expect(
      tree.filter(
        (message) => message.role === 'toolResult' && message.toolName === ZHONGKAO_COACH_TOOL_NAME,
      ),
    ).toHaveLength(0);
    expect(tree.filter(isServerPresentationMessage)).toHaveLength(0);
    expect(run.store.markUserMessageDelivered).not.toHaveBeenCalled();
    expect(run.store.requeueForRetry).toHaveBeenCalledWith(meta.id);
    expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
  });

  it('times out a never-settling orphan replay and requeues without starting the model', async () => {
    const previousTimeout = process.env[AGENT_TOOL_TIMEOUT_ENV];
    process.env[AGENT_TOOL_TIMEOUT_ENV] = '25';
    let boundedRunTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      const row = durableRow(1, '请给提示。');
      const callId = 'orphan-timeout-call';
      const meta = makeMeta('coach-orphan-timeout', {
        skillId: COACH_SKILL.id,
        claimReason: 'orphaned',
        attempt: 2,
        claimSeq: row.seq,
        deliveredUserMessageSeq: row.seq,
      });
      const capturedSignals: AbortSignal[] = [];
      const execute = vi.fn(
        (_id: string, _params: CoachToolParams, signal?: AbortSignal): Promise<never> => {
          if (signal) capturedSignals.push(signal);
          return new Promise<never>(() => {});
        },
      );
      mocks.createZhongkaoCoachActionTool.mockImplementation(
        (context: ZhongkaoCoachToolContext) => ({
          name: ZHONGKAO_COACH_TOOL_NAME,
          label: 'Zhongkao Coach action',
          description: 'test-only hung recovery tool',
          parameters: ZHONGKAO_COACH_ACTION_SCHEMA,
          execute: async (id: string, params: CoachToolParams, signal?: AbortSignal) => {
            await context.beforeExecute?.();
            return execute(id, params, signal);
          },
        }),
      );

      const boundedRun = new Promise<never>((_resolve, reject) => {
        boundedRunTimer = setTimeout(
          () => reject(new Error('orphan Coach recovery exceeded its test bound')),
          2_000,
        );
      });
      const run = await Promise.race([
        runHarness(meta, {
          rows: [row],
          seed: [
            tagDurableUserMessage(
              { role: 'user', content: row.text, timestamp: 1 } as unknown as AgentMessage,
              row.seq,
            ),
            assistantToolCall(callId),
          ],
          hasPriorRun: true,
        }),
        boundedRun,
      ]);

      expect(execute).toHaveBeenCalledOnce();
      expect(capturedSignals).toHaveLength(1);
      expect(capturedSignals[0]?.aborted).toBe(true);
      expect(capturedSignals[0]?.reason).toMatchObject({
        name: 'AgentToolTimeoutError',
        toolName: ZHONGKAO_COACH_TOOL_NAME,
        timeoutMs: 25,
      });
      const tree = (await run.session.buildContext()).messages;
      expect(tree.filter((message) => message.role === 'toolResult')).toHaveLength(0);
      expect(tree.filter(isServerPresentationMessage)).toHaveLength(0);
      expect(run.store.markUserMessageDelivered).not.toHaveBeenCalled();
      expect(run.store.requeueForRetry).toHaveBeenCalledWith(meta.id);
      expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
      expect(mocks.createCallLlmStreamFn).not.toHaveBeenCalled();
      expect(mocks.buildAgent).not.toHaveBeenCalled();
    } finally {
      if (boundedRunTimer !== undefined) clearTimeout(boundedRunTimer);
      if (previousTimeout === undefined) delete process.env[AGENT_TOOL_TIMEOUT_ENV];
      else process.env[AGENT_TOOL_TIMEOUT_ENV] = previousTimeout;
    }
  });

  it('publishes a fixed notice for a durable stable error with positive operation proof', async () => {
    const row = durableRow(1, '直接给我完整答案。');
    const callId = 'orphan-locked-call';
    const params = {
      action: 'request_full_solution',
      profileId: PROFILE_ID,
      coachSessionId: 'coach-session-1',
      expectedRevision: 0,
    } satisfies CoachToolParams;
    const meta = makeMeta('coach-orphan-locked', {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: row.seq,
      deliveredUserMessageSeq: row.seq,
    });
    const locked = coachOutput({
      ok: false,
      code: 'FULL_SOLUTION_LOCKED',
      facts: { replayed: true, eventAppended: false },
      directive: 'FULL_SOLUTION_LOCKED',
    });
    mocks.createZhongkaoCoachActionTool.mockImplementation((context: ZhongkaoCoachToolContext) => ({
      name: ZHONGKAO_COACH_TOOL_NAME,
      label: 'Zhongkao Coach action',
      description: 'test-only recovery tool',
      parameters: ZHONGKAO_COACH_ACTION_SCHEMA,
      execute: async () => {
        await context.beforeExecute?.();
        return {
          content: [{ type: 'text', text: JSON.stringify(locked) }],
          details: locked,
          isError: true,
        };
      },
    }));
    const run = await runHarness(meta, {
      rows: [row],
      seed: [
        tagDurableUserMessage(
          { role: 'user', content: row.text, timestamp: 1 } as unknown as AgentMessage,
          row.seq,
        ),
        assistantToolCall(callId, params),
      ],
      hasPriorRun: true,
    });

    const tree = (await run.session.buildContext()).messages;
    const coachResults = tree.filter(
      (message) => message.role === 'toolResult' && message.toolName === ZHONGKAO_COACH_TOOL_NAME,
    );
    expect(coachResults).toHaveLength(1);
    expect((coachResults[0] as { isError?: unknown }).isError).toBe(true);
    const published = tree.filter(isServerPresentationMessage);
    expect(published).toHaveLength(1);
    expect(messageText(published[0]!)).toBe(buildCoachNotice('FULL_SOLUTION_LOCKED').text);
    expect(JSON.stringify(published)).not.toContain('完整答案');
    expect(run.store.markUserMessageDelivered).not.toHaveBeenCalled();
    expect(run.store.requeueForRetry).not.toHaveBeenCalled();
    expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'schema-invalid call',
      calls: [assistantToolCall('malformed-call', { action: 'request_hint' })],
    },
    {
      label: 'multiple Coach calls',
      calls: [assistantToolCall('first-call'), assistantToolCall('second-call')],
    },
  ])('parks an ambiguous orphan branch: $label', async ({ label, calls }) => {
    const row = durableRow(1, label);
    const meta = makeMeta(`coach-orphan-${label.replaceAll(' ', '-')}`, {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: row.seq,
      deliveredUserMessageSeq: row.seq,
    });
    const run = await runHarness(meta, {
      rows: [row],
      seed: [
        tagDurableUserMessage(
          { role: 'user', content: row.text, timestamp: 1 } as unknown as AgentMessage,
          row.seq,
        ),
        ...calls,
      ],
      hasPriorRun: true,
    });

    expect(mocks.createZhongkaoCoachActionTool).not.toHaveBeenCalled();
    expect(
      (await run.session.buildContext()).messages.filter(isServerPresentationMessage),
    ).toHaveLength(0);
    expect(run.store.markUserMessageDelivered).not.toHaveBeenCalled();
    expect(run.store.requeueForRetry).toHaveBeenCalledWith(meta.id);
    expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
  });

  it('keeps a provenance-failure notice idempotent when reclaim changes claimSeq', async () => {
    const row = durableRow(1, '损坏 provenance 的 turn');
    const untaggedUser = {
      role: 'user',
      content: row.text,
      timestamp: 1,
    } as unknown as AgentMessage;
    const stopped = {
      role: 'assistant',
      content: [],
      stopReason: 'stop',
      timestamp: 2,
    } as unknown as AgentMessage;
    const session = await makeEntryTree('coach-fallback-reclaim', [untaggedUser, stopped]);
    const firstMeta = makeMeta('coach-fallback-reclaim', {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: 3,
      deliveredUserMessageSeq: row.seq,
    });
    const store = makeStore(firstMeta, [row]);
    store.hasSessionRunHistory.mockResolvedValue(true);
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);

    await runSession({ running: new Map(), shuttingDown: false }, firstMeta);
    await runSession(
      { running: new Map(), shuttingDown: false },
      { ...firstMeta, attempt: 3, claimSeq: 99 },
    );

    const serverMessages = (await session.buildContext()).messages.filter(
      (message) => (message as { provider?: unknown }).provider === 'openmaic-server',
    );
    expect(serverMessages).toHaveLength(1);
    expect(mocks.buildAgent).not.toHaveBeenCalled();
  });

  it('repairs incomplete untagged N before consuming an already-claimed N+1', async () => {
    const first = durableRow(1, 'turn N');
    const later = durableRow(2, 'turn N+1');
    const untaggedUser = {
      role: 'user',
      content: first.text,
      timestamp: 1,
    } as unknown as AgentMessage;
    const stopped = {
      role: 'assistant',
      content: [],
      stopReason: 'stop',
      timestamp: 2,
    } as unknown as AgentMessage;
    const meta = makeMeta('coach-incomplete-previous-turn', {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: later.seq,
      deliveredUserMessageSeq: first.seq,
    });
    const session = await makeEntryTree(meta.id, [untaggedUser, stopped]);
    const store = makeStore(meta, [first, later]);
    store.hasSessionRunHistory.mockResolvedValue(true);
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);

    await runSession({ running: new Map(), shuttingDown: false }, meta);

    const firstCorrelation = createCoachFallbackCorrelation({
      agentSessionId: meta.id,
      fallbackUserMessageSeq: first.seq,
    });
    const laterCorrelation = createCoachPresentationCorrelation({
      agentSessionId: meta.id,
      userMessageSeq: later.seq,
    });
    const laterFallbackCorrelation = createCoachFallbackCorrelation({
      agentSessionId: meta.id,
      fallbackUserMessageSeq: later.seq,
    });
    expect(
      store.events.some(
        (event) =>
          inspectCoachPresentationEventData(event.data, firstCorrelation).status === 'published',
      ),
    ).toBe(true);
    expect(
      store.events.some(
        (event) =>
          inspectCoachPresentationEventData(event.data, laterCorrelation).status === 'published',
      ),
    ).toBe(false);
    expect(
      store.events.some(
        (event) =>
          inspectCoachPresentationEventData(event.data, laterFallbackCorrelation).status ===
          'published',
      ),
    ).toBe(false);
    expect(mocks.createZhongkaoCoachActionTool).not.toHaveBeenCalled();
    expect(store.markUserMessageDelivered).not.toHaveBeenCalledWith(
      meta.id,
      WORKER_ID,
      meta.attempt,
      later.seq,
    );
    expect(store.requeueForRetry).toHaveBeenCalledWith(meta.id);

    await runSession(
      { running: new Map(), shuttingDown: false },
      { ...meta, attempt: 3, claimSeq: later.seq },
    );

    expect(mocks.createZhongkaoCoachActionTool).toHaveBeenCalledTimes(1);
    expect(mocks.createZhongkaoCoachActionTool).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedTurn: expect.objectContaining({ userMessageSeq: later.seq }),
      }),
    );
    expect(store.markUserMessageDelivered).toHaveBeenCalledWith(meta.id, WORKER_ID, 3, later.seq);
    expect(
      (await session.buildContext()).messages.filter(isServerPresentationMessage),
    ).toHaveLength(2);
  });

  it('closes an untagged continue N without consuming claimed N+1', async () => {
    const first = durableRow(1, 'turn N');
    const later = durableRow(2, 'turn N+1');
    const untaggedUser = {
      role: 'user',
      content: first.text,
      timestamp: 1,
    } as unknown as AgentMessage;
    const meta = makeMeta('coach-untagged-continue-boundary', {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: later.seq,
      deliveredUserMessageSeq: first.seq,
    });
    const run = await runHarness(meta, {
      rows: [first, later],
      seed: [untaggedUser],
      hasPriorRun: true,
    });
    const firstCorrelation = createCoachFallbackCorrelation({
      agentSessionId: meta.id,
      fallbackUserMessageSeq: first.seq,
    });
    const laterCorrelation = createCoachPresentationCorrelation({
      agentSessionId: meta.id,
      userMessageSeq: later.seq,
    });
    const laterFallbackCorrelation = createCoachFallbackCorrelation({
      agentSessionId: meta.id,
      fallbackUserMessageSeq: later.seq,
    });

    expect(
      run.store.events.some(
        (event) =>
          inspectCoachPresentationEventData(event.data, firstCorrelation).status === 'published',
      ),
    ).toBe(true);
    expect(
      run.store.events.some(
        (event) =>
          inspectCoachPresentationEventData(event.data, laterCorrelation).status === 'published',
      ),
    ).toBe(false);
    expect(
      run.store.events.some(
        (event) =>
          inspectCoachPresentationEventData(event.data, laterFallbackCorrelation).status ===
          'published',
      ),
    ).toBe(false);
    expect(run.store.markUserMessageDelivered).not.toHaveBeenCalledWith(
      meta.id,
      WORKER_ID,
      meta.attempt,
      later.seq,
    );
    expect(mocks.createZhongkaoCoachActionTool).not.toHaveBeenCalled();
  });

  it('binds a continue setup failure to N instead of claimed N+1', async () => {
    const first = durableRow(1, 'turn N');
    const later = durableRow(2, 'turn N+1');
    const firstFrame = tagDurableUserMessage(
      { role: 'user', content: first.text, timestamp: 1 } as unknown as AgentMessage,
      first.seq,
    );
    const meta = makeMeta('coach-continue-setup-boundary', {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: later.seq,
      deliveredUserMessageSeq: first.seq,
    });
    mocks.resolveAgentDriverModel.mockRejectedValueOnce(new Error('PRIVATE_SETUP_FAILURE'));
    const run = await runHarness(meta, {
      rows: [first, later],
      seed: [firstFrame],
      hasPriorRun: true,
    });
    const firstCorrelation = createCoachPresentationCorrelation({
      agentSessionId: meta.id,
      userMessageSeq: first.seq,
    });
    const laterCorrelation = createCoachPresentationCorrelation({
      agentSessionId: meta.id,
      userMessageSeq: later.seq,
    });

    expect(
      run.store.events.some(
        (event) =>
          inspectCoachPresentationEventData(event.data, firstCorrelation).status === 'published',
      ),
    ).toBe(true);
    expect(
      run.store.events.some(
        (event) =>
          inspectCoachPresentationEventData(event.data, laterCorrelation).status === 'published',
      ),
    ).toBe(false);
    expect(run.store.markUserMessageDelivered).not.toHaveBeenCalledWith(
      meta.id,
      WORKER_ID,
      meta.attempt,
      later.seq,
    );
    expect(mocks.createZhongkaoCoachActionTool).not.toHaveBeenCalled();
  });

  it('parks a delivered watermark that has no exact durable user row', async () => {
    const untaggedUser = {
      role: 'user',
      content: 'missing durable row',
      timestamp: 1,
    } as unknown as AgentMessage;
    const meta = makeMeta('coach-missing-delivered-row', {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: 1,
      deliveredUserMessageSeq: 1,
    });
    const run = await runHarness(meta, {
      rows: [],
      seed: [untaggedUser],
      hasPriorRun: true,
    });

    expect(
      (await run.session.buildContext()).messages.filter(isServerPresentationMessage),
    ).toHaveLength(0);
    expect(run.store.markUserMessageDelivered).not.toHaveBeenCalled();
    expect(run.store.requeueForRetry).toHaveBeenCalledWith(meta.id);
    expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
    expect(mocks.createZhongkaoCoachActionTool).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'recovered turn behind watermark',
      rows: [durableRow(1, 'turn N'), durableRow(2, 'turn N+1')],
      taggedSeq: 1,
      delivered: 2,
      claimSeq: 2,
    },
    {
      label: 'recovered turn skips earliest undelivered row',
      rows: [durableRow(1, 'turn N'), durableRow(2, 'turn N+1')],
      taggedSeq: 2,
      delivered: 0,
      claimSeq: 2,
    },
    {
      label: 'watermark beyond claim',
      rows: [durableRow(1, 'turn N'), durableRow(99, 'impossible delivered row')],
      taggedSeq: 1,
      delivered: 99,
      claimSeq: 2,
    },
  ])('parks $label without binding a Coach tool', async (testCase) => {
    const taggedRow = testCase.rows.find((row) => row.seq === testCase.taggedSeq)!;
    const frame = tagDurableUserMessage(
      { role: 'user', content: taggedRow.text, timestamp: 1 } as unknown as AgentMessage,
      taggedRow.seq,
    );
    const meta = makeMeta(`coach-watermark-${testCase.label.replaceAll(' ', '-')}`, {
      skillId: COACH_SKILL.id,
      claimReason: 'orphaned',
      attempt: 2,
      claimSeq: testCase.claimSeq,
      deliveredUserMessageSeq: testCase.delivered,
    });
    const run = await runHarness(meta, {
      rows: testCase.rows,
      seed: [frame],
      hasPriorRun: true,
    });

    expect(
      (await run.session.buildContext()).messages.filter(isServerPresentationMessage),
    ).toHaveLength(0);
    expect(run.store.markUserMessageDelivered).not.toHaveBeenCalled();
    expect(run.store.requeueForRetry).toHaveBeenCalledWith(meta.id);
    expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
    expect(mocks.createZhongkaoCoachActionTool).not.toHaveBeenCalled();
  });

  it('parks recovery read failure on N without publishing or marking claimed N+1', async () => {
    const first = durableRow(1, 'turn N');
    const later = durableRow(2, 'turn N+1');
    const firstMeta = makeMeta('coach-recovery-read-failure', {
      skillId: COACH_SKILL.id,
      claimSeq: first.seq,
    });
    const run = await runHarness(firstMeta, { rows: [first, later] });
    expect(
      (await run.session.buildContext()).messages.filter(isServerPresentationMessage),
    ).toHaveLength(1);

    const originalRead = run.store.readEventsAfter.getMockImplementation()!;
    run.store.readEventsAfter
      .mockRejectedValueOnce(new Error('TRANSIENT_RECOVERY_EVENT_READ_FAILURE'))
      .mockImplementation(originalRead);
    run.store.markUserMessageDelivered.mockClear();
    run.store.requeueForRetry.mockClear();
    mocks.createZhongkaoCoachActionTool.mockClear();

    await runSession(
      { running: new Map(), shuttingDown: false },
      {
        ...firstMeta,
        attempt: 2,
        claimReason: 'orphaned',
        claimSeq: later.seq,
        deliveredUserMessageSeq: first.seq,
      },
    );

    expect(
      (await run.session.buildContext()).messages.filter(isServerPresentationMessage),
    ).toHaveLength(1);
    expect(run.store.markUserMessageDelivered).not.toHaveBeenCalled();
    expect(run.store.requeueForRetry).toHaveBeenCalledWith(firstMeta.id);
    expect(mocks.createZhongkaoCoachActionTool).not.toHaveBeenCalled();
  });

  it('stops an over-cap recovery read failure without an automatic retry loop', async () => {
    const first = durableRow(1, 'turn N');
    const later = durableRow(2, 'turn N+1');
    const firstMeta = makeMeta('coach-over-cap-recovery-read-failure', {
      skillId: COACH_SKILL.id,
      claimSeq: first.seq,
    });
    const run = await runHarness(firstMeta, { rows: [first, later] });
    const originalRead = run.store.readEventsAfter.getMockImplementation()!;
    run.store.readEventsAfter
      .mockRejectedValueOnce(new Error('TRANSIENT_RECOVERY_EVENT_READ_FAILURE'))
      .mockImplementation(originalRead);
    run.store.finishSession.mockClear();
    run.store.markUserMessageDelivered.mockClear();
    run.store.requeueForRetry.mockClear();

    await runSession(
      { running: new Map(), shuttingDown: false },
      {
        ...firstMeta,
        attempt: Number.MAX_SAFE_INTEGER,
        claimReason: 'orphaned',
        claimSeq: later.seq,
        deliveredUserMessageSeq: first.seq,
      },
    );

    expect(
      (await run.session.buildContext()).messages.filter(isServerPresentationMessage),
    ).toHaveLength(1);
    expect(run.store.markUserMessageDelivered).not.toHaveBeenCalled();
    expect(run.store.requeueForRetry).not.toHaveBeenCalled();
    expect(run.store.finishSession).toHaveBeenCalledWith(
      firstMeta.id,
      WORKER_ID,
      expect.objectContaining({
        status: 'failed',
        error: 'Guarded Coach attempt limit reached without safe publication.',
      }),
    );
  });

  it('repairs an already-published N+1 fallback after completed N without starting a new run', async () => {
    const first = durableRow(1, 'turn N');
    const later = durableRow(2, 'turn N+1');
    const firstMeta = makeMeta('coach-next-turn-fallback-repair', {
      skillId: COACH_SKILL.id,
      claimSeq: first.seq,
    });
    const run = await runHarness(firstMeta, { rows: [first, later] });
    const originalMark = run.store.markUserMessageDelivered.getMockImplementation()!;
    run.store.markUserMessageDelivered
      .mockResolvedValueOnce(false)
      .mockImplementation(originalMark);
    mocks.resolveAgentDriverModel.mockRejectedValueOnce(new Error('PRIVATE_SETUP_FAILURE'));

    await runSession(
      { running: new Map(), shuttingDown: false },
      {
        ...firstMeta,
        attempt: 2,
        claimReason: 'orphaned',
        claimSeq: later.seq,
        deliveredUserMessageSeq: first.seq,
      },
    );

    expect(
      (await run.session.buildContext()).messages.filter(isServerPresentationMessage),
    ).toHaveLength(2);
    mocks.resolveAgentDriverModel.mockClear();
    mocks.buildAgent.mockClear();
    mocks.createZhongkaoCoachActionTool.mockClear();
    run.store.markUserMessageDelivered.mockClear();

    await runSession(
      { running: new Map(), shuttingDown: false },
      {
        ...firstMeta,
        attempt: 3,
        claimReason: 'orphaned',
        claimSeq: later.seq,
        deliveredUserMessageSeq: first.seq,
      },
    );

    expect(
      (await run.session.buildContext()).messages.filter(isServerPresentationMessage),
    ).toHaveLength(2);
    expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
    expect(mocks.buildAgent).not.toHaveBeenCalled();
    expect(mocks.createZhongkaoCoachActionTool).not.toHaveBeenCalled();
    expect(run.store.markUserMessageDelivered).toHaveBeenCalledWith(
      firstMeta.id,
      WORKER_ID,
      3,
      later.seq,
    );
  });

  it('starts an after-claim N+1 on the next claim without reusing the N fallback', async () => {
    const first = durableRow(1, 'turn N');
    const later = durableRow(2, 'turn N+1 after claim');
    const firstMeta = makeMeta('coach-after-claim-fallback', {
      skillId: COACH_SKILL.id,
      claimSeq: first.seq,
      deliveredUserMessageSeq: first.seq,
    });
    const run = await runHarness(firstMeta, {
      rows: [first, later],
      configureStore: (store) => {
        store.finishSession.mockResolvedValueOnce(false).mockResolvedValue(true);
      },
    });

    expect(JSON.stringify((await run.session.buildContext()).messages)).not.toContain(later.text);
    await runSession(
      { running: new Map(), shuttingDown: false },
      { ...firstMeta, claimReason: 'orphaned', attempt: 2, claimSeq: 99 },
    );

    const serverMessages = (await run.session.buildContext()).messages.filter(
      isServerPresentationMessage,
    );
    expect(serverMessages).toHaveLength(2);
    expect(mocks.createZhongkaoCoachActionTool).toHaveBeenCalledTimes(1);
    expect(mocks.createZhongkaoCoachActionTool).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedTurn: expect.objectContaining({ userMessageSeq: later.seq }),
      }),
    );
    expect(run.store.markUserMessageDelivered).toHaveBeenCalledWith(
      firstMeta.id,
      WORKER_ID,
      2,
      later.seq,
    );
    expect(
      (await run.session.buildContext()).messages.filter(
        (message) => durableUserMessageSeq(message) === later.seq,
      ),
    ).toHaveLength(1);
  });

  it('repairs one published fallback after a crash before its delivered watermark', async () => {
    const row = durableRow(1, '需要固定安全提示');
    const firstMeta = makeMeta('coach-fallback-watermark-repair', {
      skillId: COACH_SKILL.id,
      claimSeq: row.seq,
    });
    mocks.resolveAgentDriverModel.mockRejectedValueOnce(new Error('PRIVATE_SETUP_FAILURE'));
    let originalMark:
      | ((
          ...args: Parameters<FakeStore['markUserMessageDelivered']>
        ) => ReturnType<FakeStore['markUserMessageDelivered']>)
      | undefined;
    const first = await runHarness(firstMeta, {
      rows: [row],
      configureStore: (store) => {
        originalMark = store.markUserMessageDelivered.getMockImplementation();
        store.markUserMessageDelivered
          .mockResolvedValueOnce(false)
          .mockImplementation(originalMark!);
      },
    });

    expect(first.store.finishSession).not.toHaveBeenCalled();
    expect(first.store.requeueForRetry).not.toHaveBeenCalled();
    expect(
      (await first.session.buildContext()).messages.filter(isServerPresentationMessage),
    ).toHaveLength(1);

    mocks.resolveAgentDriverModel.mockClear();
    mocks.buildAgent.mockClear();
    await runSession(
      { running: new Map(), shuttingDown: false },
      { ...firstMeta, claimReason: 'orphaned', attempt: 2, claimSeq: 99 },
    );

    expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
    expect(mocks.buildAgent).not.toHaveBeenCalled();
    expect(
      (await first.session.buildContext()).messages.filter(isServerPresentationMessage),
    ).toHaveLength(1);
    expect(first.store.markUserMessageDelivered).toHaveBeenLastCalledWith(
      firstMeta.id,
      WORKER_ID,
      2,
      row.seq,
    );
  });

  it('requeues a failed presentation event append and repairs it from durable Coach state', async () => {
    const row = durableRow(1, '请给一个提示');
    const output = coachOutput({ presentation: { kind: 'hint', text: '先检查符号。' } });
    let originalAppend:
      | ((
          ...args: Parameters<FakeStore['appendRunEvent']>
        ) => ReturnType<FakeStore['appendRunEvent']>)
      | undefined;
    let failedPresentationStart = false;
    const firstMeta = makeMeta('coach-publication-retry', {
      skillId: COACH_SKILL.id,
      claimSeq: row.seq,
    });
    const first = await runHarness(firstMeta, {
      rows: [row],
      script: (context) => emitCoachResult(context, output),
      configureStore: (store) => {
        originalAppend = store.appendRunEvent.getMockImplementation();
        store.appendRunEvent.mockImplementation(async (...args) => {
          const event = args[2];
          const message = (event.data as { message?: { provider?: unknown } })?.message;
          if (
            !failedPresentationStart &&
            event.type === 'message_start' &&
            message?.provider === 'openmaic-server'
          ) {
            failedPresentationStart = true;
            throw new Error('PRIVATE_EVENT_STORE_FAILURE');
          }
          return originalAppend!(...args);
        });
      },
    });

    expect(failedPresentationStart).toBe(true);
    expect(first.store.requeueForRetry).toHaveBeenCalledWith(firstMeta.id);
    expect(JSON.stringify(first.store.events)).not.toContain('PRIVATE_EVENT_STORE_FAILURE');

    first.store.appendRunEvent.mockImplementation(originalAppend!);
    mocks.resolveAgentDriverModel.mockClear();
    mocks.buildAgent.mockClear();
    await runSession(
      { running: new Map(), shuttingDown: false },
      { ...firstMeta, claimReason: 'queued', attempt: 2, claimSeq: 99 },
    );

    expect(mocks.resolveAgentDriverModel).not.toHaveBeenCalled();
    expect(mocks.buildAgent).not.toHaveBeenCalled();
    const correlation = createCoachPresentationCorrelation({
      agentSessionId: firstMeta.id,
      userMessageSeq: row.seq,
    });
    const repairedEvents = first.store.events.filter(
      (event) =>
        (event.type === 'message_start' || event.type === 'message_end') &&
        inspectCoachPresentationEventData(event.data, correlation).status === 'published',
    );
    expect(repairedEvents.map((event) => event.type)).toEqual(['message_start', 'message_end']);
  });

  it('keeps ordinary -> Zhongkao -> ordinary gates and tools isolated by run', async () => {
    const ordinaryA = await runHarness(makeMeta('ordinary-a'));
    const row = durableRow(1, 'Coach turn');
    const coach = await runHarness(
      makeMeta('isolated-coach', {
        skillId: COACH_SKILL.id,
        claimSeq: row.seq,
      }),
      { rows: [row] },
    );
    const ordinaryB = await runHarness(makeMeta('ordinary-b'));

    for (const ordinary of [ordinaryA, ordinaryB]) {
      expect(ordinary.streamOptions?.terminalToolGate).toBeUndefined();
      expect(ordinary.buildOptions?.terminalToolGate).toBeUndefined();
      expect(ordinary.buildOptions?.tools.map((tool) => tool.name)).not.toContain(
        ZHONGKAO_COACH_TOOL_NAME,
      );
      expect(ordinary.buildOptions?.allowedToolNames?.has(ZHONGKAO_COACH_TOOL_NAME)).toBe(false);
    }
    expect(coach.buildOptions?.terminalToolGate).toBeDefined();
    expect(coach.streamOptions?.terminalToolGate).toBe(coach.buildOptions?.terminalToolGate);
    expect(coach.buildOptions?.tools.map((tool) => tool.name)).toContain(ZHONGKAO_COACH_TOOL_NAME);
    expect(mocks.createZhongkaoCoachActionTool).toHaveBeenCalledTimes(1);
  });

  it('keeps an overlapping ordinary and Zhongkao session isolated', async () => {
    const coachRow = durableRow(1, 'concurrent Coach turn');
    const normalRow = durableRow(1, 'concurrent ordinary turn');
    const coachMeta = makeMeta('concurrent-coach', {
      skillId: COACH_SKILL.id,
      claimSeq: coachRow.seq,
    });
    const normalMeta = makeMeta('concurrent-normal', { claimSeq: normalRow.seq });
    const coachSession = await makeEntryTree(coachMeta.id);
    const normalSession = await makeEntryTree(normalMeta.id);
    const coachStore = makeStore(coachMeta, [coachRow]);
    const normalStore = makeStore(normalMeta, [normalRow]);
    const sessions = new Map([
      [coachMeta.id, coachSession],
      [normalMeta.id, normalSession],
    ]);
    mocks.getAgentSessionStore.mockResolvedValueOnce(coachStore).mockResolvedValueOnce(normalStore);
    mocks.openEntryStorage.mockImplementation(async ({ sessionId }: { sessionId: string }) =>
      sessions.get(sessionId)!.getStorage(),
    );

    let coachBuild: BuildAgentOptions | undefined;
    let normalBuild: BuildAgentOptions | undefined;
    let coachStreamGate: TerminalToolGate | undefined;
    let normalStreamGate: TerminalToolGate | undefined;
    mocks.createCallLlmStreamFn.mockImplementation(
      (options: { terminalToolGate?: TerminalToolGate }) => {
        if (options.terminalToolGate) coachStreamGate = options.terminalToolGate;
        else normalStreamGate = options.terminalToolGate;
        return () => undefined;
      },
    );

    const ctx = { running: new Map(), shuttingDown: false };
    let arrivals = 0;
    let release!: () => void;
    const bothRunning = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rendezvous = async (): Promise<void> => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothRunning;
      expect(ctx.running.size).toBe(2);
    };
    mocks.buildAgent.mockImplementation((captured: BuildAgentOptions) => {
      if (captured.terminalToolGate) {
        coachBuild = captured;
        return makeFakeAgent(captured, coachStore, rendezvous);
      }
      normalBuild = captured;
      return makeFakeAgent(captured, normalStore, async (context) => {
        await rendezvous();
        emitMessage(context, {
          role: 'assistant',
          content: [{ type: 'text', text: 'ORDINARY_VISIBLE_TEXT' }],
          stopReason: 'stop',
          timestamp: 2,
        } as unknown as AgentMessage);
      });
    });

    await Promise.all([runSession(ctx, coachMeta), runSession(ctx, normalMeta)]);

    expect(arrivals).toBe(2);
    expect(ctx.running.size).toBe(0);
    expect(coachBuild?.terminalToolGate).toBeDefined();
    expect(coachStreamGate).toBe(coachBuild?.terminalToolGate);
    expect(coachBuild?.tools.map((tool) => tool.name)).toContain(ZHONGKAO_COACH_TOOL_NAME);
    expect(normalBuild?.terminalToolGate).toBeUndefined();
    expect(normalStreamGate).toBeUndefined();
    expect(normalBuild?.tools.map((tool) => tool.name)).not.toContain(ZHONGKAO_COACH_TOOL_NAME);

    const coachDurable = JSON.stringify((await coachSession.buildContext()).messages);
    const normalDurable = JSON.stringify((await normalSession.buildContext()).messages);
    expect(coachDurable).not.toContain('ORDINARY_VISIBLE_TEXT');
    expect(normalDurable).toContain('ORDINARY_VISIBLE_TEXT');
    expect(normalDurable).not.toContain('openmaicCoachTerminalPresentation');
  });
});
