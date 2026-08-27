/**
 * Runner-level pins for the global tool-call execution bound and prompt
 * cancellation of a hung tool.
 *
 * These tests drive the REAL `runSession` loop with the REAL `buildAgent` and
 * the REAL pi agent loop (only the LLM transport, the session store, and the
 * tool assembly seam are mocked). They pin the two incident behaviors:
 *
 * - a tool call that never settles ends with a structured timeout error result
 *   in the transcript at the configured bound, and the session keeps running
 *   and settles normally (the session does NOT die);
 * - a cancel request that lands while a tool is hung settles the session as
 *   `cancelled` promptly — without waiting for the tool to finish — and the
 *   abort signal is delivered to the tool's in-flight work.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import type { ClaimedAgentSession } from '@openmaic/storage';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'runner-test-uuid'),
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  streamLLM: vi.fn(),
  assembleRunnerTools: vi.fn(),
  buildRunnerCoursePrompt: vi.fn(() => 'system prompt'),
  getOwnerScopedDocumentStore: vi.fn(async () => ({})),
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

vi.mock('@/lib/server/agent-runtime/session-materials', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return { ...actual, listSessionMaterials: vi.fn(async () => []) };
});

vi.mock('@/lib/server/agent-runtime/entry-tree-storage', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/entry-tree-storage')>();
  return {
    ...actual,
    AgentSessionEntryStorage: {
      open: mocks.openEntryStorage,
    },
  };
});

vi.mock('@/lib/server/agent-runtime/agent-driver-model', () => ({
  resolveAgentDriverModel: mocks.resolveAgentDriverModel,
}));

vi.mock('@/lib/ai/llm', () => ({
  streamLLM: mocks.streamLLM,
  callLLM: vi.fn(),
}));

// The tool assembly seam is mocked so the runner's agent executes exactly one
// instrumented hung tool instead of the full production toolset.
vi.mock('@/lib/server/agent-runtime/runner-contract', () => ({
  assembleRunnerTools: mocks.assembleRunnerTools,
  buildRunnerCoursePrompt: mocks.buildRunnerCoursePrompt,
}));

vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: mocks.getOwnerScopedDocumentStore,
}));

// Skills are orthogonal to the behaviour under test; pin the runner to a
// deployment with NO installed skills so no user-skill store is touched.
vi.mock('@/lib/server/agent-runtime/skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/skills')>();
  return {
    ...actual,
    listSkills: vi.fn(async () => []),
    findSkill: vi.fn(async () => null),
  };
});
vi.mock('@/lib/server/agent-runtime/user-skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/user-skills')>();
  return { ...actual, listUserSkills: vi.fn(async () => []) };
});

import { runSession } from '@/lib/server/agent-runtime/runner';
import { AGENT_TOOL_TIMEOUT_ENV } from '@/lib/agent/runtime/tool-timeout';

const SESSION_ID = 'session-1';
const TOOL_NAME = 'read_stage';
/** Mirrors the runner's `WORKER_ID` derivation with the fixed mock uuid. */
const WORKER_ID = `runner-t:${process.pid}`;

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};

const finish = (finishReason: string) => ({
  type: 'finish',
  finishReason,
  totalUsage: ZERO_USAGE,
});

const toolCallPart = (args: unknown = {}) => ({
  type: 'tool-call',
  toolCallId: 'call-1',
  toolName: TOOL_NAME,
  input: args,
});

const resultFrom = (parts: Array<Record<string, unknown>>) => ({
  fullStream: (async function* () {
    for (const part of parts) yield part;
  })(),
  usage: new Promise(() => {}),
});

function useResponses(responses: Array<Array<Record<string, unknown>>>) {
  mocks.streamLLM.mockImplementation(() => {
    const parts = responses.shift();
    return resultFrom(
      parts ?? [{ type: 'text-delta', text: 'unexpected transport' }, finish('stop')],
    );
  });
}

function makeMeta(overrides: Partial<ClaimedAgentSession> = {}): ClaimedAgentSession {
  return {
    id: SESSION_ID,
    ownerId: 'owner-1',
    prompt: 'Build a lesson',
    stageId: 'stage-1',
    existingCourse: false,
    status: 'running',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    claimReason: 'queued',
    claimSeq: 0,
    ...overrides,
  };
}

function makeStore(meta: ClaimedAgentSession, options: { cancelRequested?: () => boolean } = {}) {
  let seq = 0;
  return {
    appendRunEvent: vi.fn(
      async (
        _id: string,
        _workerId: string,
        _event: { type: string; data?: Record<string, unknown> },
      ) => {
        seq += 1;
        return seq;
      },
    ),
    clearCancel: vi.fn(async () => undefined),
    finishSession: vi.fn(
      async (_id: string, _workerId: string, _patch: { status: string }) => true,
    ),
    getSession: vi.fn(async () => ({ ...meta, lease: { workerId: WORKER_ID } })),
    hasSessionRunHistory: vi.fn(async () => false),
    heartbeat: vi.fn(async () => true),
    getCancelRequestedAt: vi.fn(async () => (options.cancelRequested?.() ? 123 : null)),
    isCancelRequested: vi.fn(async () => options.cancelRequested?.() ?? false),
    listUserMessages: vi.fn(async () => []),
    releaseLease: vi.fn(async () => undefined),
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
  };
}

type FakeStore = ReturnType<typeof makeStore>;

async function makeEntryTree(): Promise<Session> {
  const repo = new InMemorySessionRepo();
  return repo.create({ id: SESSION_ID });
}

const HungToolParams = Type.Object({});

/** A tool whose execution never settles on its own, recording the signal. */
function makeHungTool(
  captured: AbortSignal[],
  started?: () => void,
): AgentTool<typeof HungToolParams> {
  return {
    name: TOOL_NAME,
    label: 'Read stage',
    description: 'Test tool',
    parameters: HungToolParams,
    async execute(_callId, _params, signal) {
      if (signal) captured.push(signal);
      started?.();
      return new Promise(() => {});
    },
  };
}

const setToolTimeout = (value: string | undefined): void => {
  if (value === undefined) delete process.env[AGENT_TOOL_TIMEOUT_ENV];
  else process.env[AGENT_TOOL_TIMEOUT_ENV] = value;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentDriverModel.mockResolvedValue({
    // A truthy model stub: the real stream-fn adapter reads `.provider` off
    // the language model while mapping the first turn.
    connection: { model: {} as never, thinkingConfig: undefined },
    piModel: { api: 'openai-completions', provider: 'openai', id: 'driver-model' },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8192,
  });
  mocks.getServerPersistenceProvider.mockResolvedValue({
    documentStore: { forOwner: () => ({}) },
  });
});

afterEach(() => {
  setToolTimeout(undefined);
  vi.useRealTimers();
});

describe('runner: global tool-call execution bound', () => {
  it('ends a never-settling tool call with a timeout error result and keeps the session alive', async () => {
    vi.useFakeTimers();
    setToolTimeout('5000');
    const meta = makeMeta();
    const session = await makeEntryTree();
    const store = makeStore(meta);
    const captured: AbortSignal[] = [];
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.assembleRunnerTools.mockReturnValue([makeHungTool(captured, started)]);
    useResponses([
      [toolCallPart(), finish('tool-calls')],
      [{ type: 'text-delta', text: 'complete' }, finish('stop')],
    ]);

    const run = runSession({ running: new Map(), shuttingDown: false }, meta);
    await gate;
    await vi.advanceTimersByTimeAsync(5_000);
    await run;

    // The tool call settled as a structured error tool-result in the
    // transcript at the configured bound...
    const messages = (await session.buildContext()).messages;
    const toolResult = messages.find((message) => message.role === 'toolResult');
    expect(toolResult).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: TOOL_NAME,
      isError: true,
    });
    expect(JSON.stringify(toolResult)).toContain('execution budget');
    expect(JSON.stringify(toolResult)).toContain('5000ms');
    // ...the session did NOT die: it settled normally as succeeded...
    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({ status: 'succeeded' }),
    );
    expect(store.clearCancel).not.toHaveBeenCalled();
    // ...the agent made its next model turn after the timeout error...
    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    // ...and the abort signal reached the tool's in-flight work.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.aborted).toBe(true);
    expect(captured[0]?.reason).toMatchObject({ name: 'AgentToolTimeoutError' });
  });
});

describe('runner: cancel of a hung tool', () => {
  it('settles the session as cancelled promptly without waiting for the tool', async () => {
    vi.useFakeTimers();
    // The tool budget is far beyond the test window: only the cancel can end
    // the call within it.
    setToolTimeout('60000');
    const meta = makeMeta();
    const session = await makeEntryTree();
    let cancelRequested = false;
    const store = makeStore(meta, { cancelRequested: () => cancelRequested });
    const captured: AbortSignal[] = [];
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.assembleRunnerTools.mockReturnValue([makeHungTool(captured, started)]);
    useResponses([[toolCallPart(), finish('tool-calls')]]);

    const run = runSession({ running: new Map(), shuttingDown: false }, meta);
    await gate;
    expect(captured[0]?.aborted).toBe(false);

    // The user cancels while the tool is still hung. The runner observes the
    // cancel at its next checkpoint and the tool-call race settles on the
    // abort signal — the session must reach `cancelled` within one poll
    // interval, nowhere near the 60s tool budget.
    cancelRequested = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await run;

    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({
        status: 'cancelled',
        resetAttempt: true,
        expectedAttempt: 1,
        consumeCancelRequestedAt: 123,
      }),
    );
    expect(store.clearCancel).not.toHaveBeenCalled();
    // The abort was delivered to the tool's in-flight work.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.aborted).toBe(true);
    // The hung tool's own promise never settled: the run ended on the cancel,
    // not on the tool.
    expect(store.finishSession.mock.calls[0]?.[2]).toMatchObject({ status: 'cancelled' });
  });
});
