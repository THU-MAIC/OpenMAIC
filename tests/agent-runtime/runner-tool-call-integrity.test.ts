/**
 * Runner-level pins for the tool-call-integrity wiring.
 *
 * The module-level tests in tool-call-integrity.test.ts exercise the repair and
 * settlement functions directly. This file drives the actual `runSession` loop
 * through a fake agent (mocked `buildAgent`) so the RUNNER WIRING is observable:
 *
 * - write-time settlement: an assistant tool-call frame emitted mid-run leaves
 *   the call tracked as in-flight; before the terminal flush (normal wind-down,
 *   catch path, or shutdown park) the runner appends an interrupted-result
 *   receipt for it through the fenced entry-tree write chain;
 * - read-time repair: resuming a session whose durable tail contains an orphaned
 *   tool call hands the agent a repaired history (synthetic receipt included)
 *   while leaving the durable tree untouched, and reports the repaired id on
 *   the session_resumed event.
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import type { ClaimedAgentSession } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'runner-test-uuid'),
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
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

// The runner lists the session's materials to build the materials prompt
// block. No material store exists in this harness; an empty list keeps the
// prompt free of the block while the real tool builders stay loaded.
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

vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: mocks.createCallLlmStreamFn,
}));

vi.mock('@/lib/agent/runtime/build-agent', () => ({
  buildAgent: mocks.buildAgent,
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

const SESSION_ID = 'session-1';
const TOOL_CALL_ID = 'call_1';
const TOOL_NAME = 'generate_scene';
/** Mirrors the runner's `WORKER_ID` derivation with the fixed mock uuid. */
const WORKER_ID = `runner-t:${process.pid}`;

const userMessage = (text: string, timestamp: number): AgentMessage =>
  ({ role: 'user', content: text, timestamp }) as unknown as AgentMessage;

const assistantCallMessage = (timestamp: number): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'toolCall', id: TOOL_CALL_ID, name: TOOL_NAME, arguments: {} }],
    stopReason: 'toolUse',
    timestamp,
  }) as unknown as AgentMessage;

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

function makeStore(meta: ClaimedAgentSession, options: { hasSessionRunHistory?: boolean } = {}) {
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
    finishSession: vi.fn(async () => true),
    getSession: vi.fn(async () => ({ ...meta, lease: { workerId: WORKER_ID } })),
    hasSessionRunHistory: vi.fn(async () => options.hasSessionRunHistory ?? false),
    heartbeat: vi.fn(async () => true),
    getCancelRequestedAt: vi.fn(async () => null),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(async () => []),
    releaseLease: vi.fn(async () => undefined),
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
  };
}

type FakeStore = ReturnType<typeof makeStore>;

const runEvents = (store: FakeStore): Array<{ type: string; data?: Record<string, unknown> }> =>
  store.appendRunEvent.mock.calls.map((call) => call[2]);

async function makeEntryTree(seed: AgentMessage[] = []): Promise<Session> {
  const repo = new InMemorySessionRepo();
  const session = await repo.create({ id: SESSION_ID });
  for (const message of seed) await session.appendMessage(message);
  return session;
}

interface FakeAgent {
  subscribe(listener: (event: AgentEvent, signal?: AbortSignal) => void): () => void;
  prompt(text: string): Promise<void>;
  continue(): Promise<void>;
  waitForIdle(): Promise<void>;
  steer(message: AgentMessage): void;
  abort(): void;
  readonly state: { messages: AgentMessage[]; errorMessage?: string };
}

function makeFakeAgent(options: {
  messages?: AgentMessage[];
  onPrompt?: (emit: (event: AgentEvent) => void) => void | Promise<void>;
  onContinue?: (emit: (event: AgentEvent) => void) => void | Promise<void>;
}): FakeAgent {
  const messages = [...(options.messages ?? [])];
  const listeners = new Set<(event: AgentEvent, signal?: AbortSignal) => void>();
  const emit = (event: AgentEvent): void => {
    if (event.type === 'message_end') messages.push(event.message);
    for (const listener of [...listeners]) listener(event, undefined);
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async (_text) => {
      await options.onPrompt?.(emit);
    },
    continue: async () => {
      await options.onContinue?.(emit);
    },
    waitForIdle: async () => {},
    steer: () => {},
    abort: () => {},
    state: {
      get messages() {
        return messages;
      },
      errorMessage: undefined,
    },
  };
}

/** Emit a complete pi turn: user prompt + assistant frame with one tool call, no result. */
function emitToolCallTurn(emit: (event: AgentEvent) => void): void {
  const user = userMessage('Build a lesson', 1);
  const assistant = assistantCallMessage(2);
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({ type: 'message_start', message: user });
  emit({ type: 'message_end', message: user });
  emit({ type: 'message_start', message: assistant });
  emit({ type: 'message_end', message: assistant });
  emit({ type: 'turn_end', message: assistant, toolResults: [] });
  emit({ type: 'agent_end', messages: [user, assistant] });
}

/** The runner's settlement must leave exactly user + assistant + interrupted receipt. */
function expectInterruptedReceipt(messages: readonly AgentMessage[]): void {
  expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult']);
  expect(messages[2]).toMatchObject({
    role: 'toolResult',
    toolCallId: TOOL_CALL_ID,
    toolName: TOOL_NAME,
    isError: true,
  });
  expect(JSON.stringify((messages[2] as { content?: unknown }).content ?? [])).toContain(
    'interrupted',
  );
  expect(typeof (messages[2] as { timestamp?: unknown }).timestamp).toBe('number');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentDriverModel.mockResolvedValue({
    connection: { model: undefined, thinkingConfig: undefined },
    piModel: { api: 'openai-completions', provider: 'openai', id: 'driver-model' },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8192,
  });
  mocks.createCallLlmStreamFn.mockReturnValue((() => {}) as never);
  // The owner-bound document store is never touched in these runner pins
  // (buildAgent is mocked), so a bare forOwner facade is enough.
  mocks.getServerPersistenceProvider.mockResolvedValue({
    documentStore: { forOwner: () => ({}) },
  });
});

describe('write-time settlement of interrupted tool calls', () => {
  it('persists an interrupted receipt through the fenced chain when a call is in flight at wind-down', async () => {
    const meta = makeMeta();
    const session = await makeEntryTree();
    const store = makeStore(meta);
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.buildAgent.mockImplementation(() =>
      makeFakeAgent({
        onPrompt: (emit) => emitToolCallTurn(emit),
      }),
    );

    await runSession({ running: new Map(), shuttingDown: false }, meta);

    expectInterruptedReceipt((await session.buildContext()).messages);
    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({ status: 'succeeded' }),
    );
    // The receipt is appended to the entry tree only: no toolResult frame ever
    // reached the runner's event log.
    const toolResultEvents = runEvents(store).filter(
      (event) =>
        event.type === 'message_end' &&
        (event.data?.message as { role?: string } | undefined)?.role === 'toolResult',
    );
    expect(toolResultEvents).toEqual([]);
  });

  it('parks a shutdown-interrupted run with a durable receipt for the orphaned call', async () => {
    const meta = makeMeta();
    const session = await makeEntryTree();
    const store = makeStore(meta);
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.buildAgent.mockImplementation(() =>
      makeFakeAgent({
        onPrompt: async (emit) => {
          emitToolCallTurn(emit);
          throw new Error('worker draining before result');
        },
      }),
    );

    await runSession({ running: new Map(), shuttingDown: true }, meta);

    expectInterruptedReceipt((await session.buildContext()).messages);
    const events = runEvents(store);
    expect(events.at(-1)?.type).toBe('session_interrupted');
    expect(events.at(-1)?.data).toMatchObject({ reason: 'runner shutdown', attempt: 1 });
    expect(store.releaseLease).toHaveBeenCalledWith(SESSION_ID, WORKER_ID);
    expect(store.finishSession).not.toHaveBeenCalled();
  });

  it('appends the receipt on the catch path when the run fails before the result lands', async () => {
    const meta = makeMeta();
    const session = await makeEntryTree();
    const store = makeStore(meta);
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.buildAgent.mockImplementation(() =>
      makeFakeAgent({
        onPrompt: async (emit) => {
          emitToolCallTurn(emit);
          throw new Error('provider disconnected');
        },
      }),
    );

    await runSession({ running: new Map(), shuttingDown: false }, meta);

    expectInterruptedReceipt((await session.buildContext()).messages);
    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({ status: 'failed' }),
    );
    expect(runEvents(store).at(-1)?.type).toBe('session_end');
  });
});

describe('read-time repair of an orphaned durable tool call', () => {
  it('hands the resumed agent the repaired history, reports the repair, and leaves the tree untouched', async () => {
    const meta = makeMeta({ claimReason: 'orphaned', attempt: 2 });
    const seedUser = userMessage('Build a lesson', 1);
    const seedAssistant = assistantCallMessage(2);
    const session = await makeEntryTree([seedUser, seedAssistant]);
    const store = makeStore(meta, { hasSessionRunHistory: true });
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);

    let history: AgentMessage[] | undefined;
    mocks.buildAgent.mockImplementation((options: { history?: AgentMessage[] }) => {
      history = options.history;
      return makeFakeAgent({ messages: options.history ?? [] });
    });

    await runSession({ running: new Map(), shuttingDown: false }, meta);

    // The model history seeded into the agent contains the synthetic receipt...
    expect(history).toHaveLength(3);
    expect(history?.[0]).toBe(seedUser);
    expect(history?.[1]).toBe(seedAssistant);
    expect(history?.[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: TOOL_CALL_ID,
      isError: true,
    });
    expect(JSON.stringify(history?.[2])).toContain('interrupted');

    // ...the session_resumed event reports the repaired id...
    const resumed = runEvents(store).find((event) => event.type === 'session_resumed');
    expect(resumed?.data).toMatchObject({
      repairedToolCalls: [TOOL_CALL_ID],
      transcriptMessages: 3,
    });

    // ...and the durable tree was never mutated.
    const after = await session.buildContext();
    expect(after.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(after.messages[0]).toBe(seedUser);
    expect(after.messages[1]).toBe(seedAssistant);
  });
});
