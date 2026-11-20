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
 *   the session_resumed event;
 * - shutdown drain: stop() leaves running turns to finish and settle inside the
 *   drain window and hands off (receipt, park, lease release) what is still
 *   running when it closes; a failure during the drain parks only if it
 *   aborted the run;
 * - resume marker: the settle log marks a takeover of an interrupted run as
 *   resumed by the same test as the session_resumed frame's 'crash' reason.
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import type { ClaimedAgentSession } from '@openmaic/storage';
import type { PgAgentSessionStore } from '@openmaic/storage/agent-session/pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'runner-test-uuid'),
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
  checkSchema: vi.fn(),
}));

vi.mock('@/lib/persistence/schema-boot-check', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/persistence/schema-boot-check')>()),
  assertRuntimeSchemaCompatibility: mocks.checkSchema,
}));

vi.mock('node:crypto', async (importActual) => {
  const actual = await importActual<typeof import('node:crypto')>();
  return { ...actual, randomUUID: mocks.randomUUID };
});

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: mocks.getAgentSessionStore,
  withAgentSessionClaim: async <T>(operation: (store: PgAgentSessionStore) => Promise<T>) =>
    operation(await mocks.getAgentSessionStore()),
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
// The runner lists what the session reaches through the shared resolver;
// links need a database these tests do not have.
vi.mock('@/lib/server/agent-runtime/material-resolver', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/material-resolver')>();
  return {
    ...actual,
    listSessionScopeMaterials: vi.fn(async () => []),
  };
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
// A test can run code while a run is preloading skills, after its setup and
// before its first model call.
const preloading = vi.hoisted(() => ({ hook: undefined as (() => void) | undefined }));
vi.mock('@/lib/server/agent-runtime/skill-preload', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/skill-preload')>();
  return {
    ...actual,
    buildSkillPreload: async (...args: Parameters<typeof actual.buildSkillPreload>) => {
      preloading.hook?.();
      return actual.buildSkillPreload(...args);
    },
  };
});

import {
  handOffRunningSessions,
  runSession,
  startAgentRunner,
} from '@/lib/server/agent-runtime/runner';

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
    deliveredUserMessageSeq: 0,
    ...overrides,
  };
}

function makeStore(meta: ClaimedAgentSession) {
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
    pruneMessageUpdates: vi.fn(async () => 0),
    clearCancel: vi.fn(async () => undefined),
    finishSession: vi.fn(async () => true),
    getSession: vi.fn(async () => ({ ...meta, lease: { workerId: WORKER_ID } })),
    readEventsAfter: vi.fn(async () => []),
    heartbeat: vi.fn(async () => true),
    getCancelRequestedAt: vi.fn(async () => null),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(async () => []),
    releaseLease: vi.fn(async (): Promise<void> => undefined),
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
  steer: ReturnType<typeof vi.fn<(message: AgentMessage) => void>>;
  abort: ReturnType<typeof vi.fn<() => void>>;
  readonly state: { messages: AgentMessage[]; errorMessage?: string };
}

function makeFakeAgent(options: {
  messages?: AgentMessage[];
  onPrompt?: (emit: (event: AgentEvent) => void) => void | Promise<void>;
  onContinue?: (emit: (event: AgentEvent) => void) => void | Promise<void>;
  onAbort?: () => void;
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
    steer: vi.fn(),
    abort: vi.fn(() => options.onAbort?.()),
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

/** Emit a finished pi turn: user prompt + a text-only assistant reply. */
function emitTextTurn(emit: (event: AgentEvent) => void): void {
  const user = userMessage('Build a lesson', 1);
  const assistant = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Done.' }],
    stopReason: 'stop',
    timestamp: 2,
  } as unknown as AgentMessage;
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({ type: 'message_start', message: user });
  emit({ type: 'message_end', message: user });
  emit({ type: 'message_start', message: assistant });
  emit({ type: 'message_end', message: assistant });
  emit({ type: 'turn_end', message: assistant, toolResults: [] });
  emit({ type: 'agent_end', messages: [user, assistant] });
}

/** Emit a turn whose one tool call is still executing: no result, no turn end. */
function emitPendingToolCall(emit: (event: AgentEvent) => void): void {
  const user = userMessage('Build a lesson', 1);
  const assistant = assistantCallMessage(2);
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({ type: 'message_start', message: user });
  emit({ type: 'message_end', message: user });
  emit({ type: 'message_start', message: assistant });
  emit({ type: 'message_end', message: assistant });
}

/**
 * Entry storage whose writes, once `gate()` is called, wait for `release()`:
 * a finished turn reaches the entry store only when the test lets it.
 * `flushing` resolves when the first held write arrives.
 */
async function gatedEntryStorage() {
  const storage = (await makeEntryTree()).getStorage();
  const flushing = Promise.withResolvers<void>();
  const flushed = Promise.withResolvers<void>();
  let gated = false;
  const held = new Proxy(storage, {
    get(target, property) {
      if (property === 'appendEntry') {
        return async (entry: Parameters<typeof target.appendEntry>[0]) => {
          if (gated) {
            flushing.resolve();
            await flushed.promise;
          }
          return target.appendEntry(entry);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    storage: held,
    gate: () => {
      gated = true;
    },
    flushing: flushing.promise,
    release: () => flushed.resolve(),
  };
}

/** A store whose claims hand out `metas` in order, then nothing. */
function claimingStore(...metas: [ClaimedAgentSession, ...ClaimedAgentSession[]]) {
  const claimNextSession = vi.fn(
    async (_workerId: string): Promise<ClaimedAgentSession | null> => null,
  );
  for (const meta of metas) claimNextSession.mockResolvedValueOnce(meta);
  return { ...makeStore(metas[0]), claimNextSession };
}

/** Start a runner that claims one session and runs it on `agent` (fake timers). */
async function startRunnerWith(agent: FakeAgent, storage?: unknown) {
  const meta = makeMeta();
  const store = claimingStore(meta);
  const session = await makeEntryTree();
  mocks.getAgentSessionStore.mockResolvedValue(store);
  mocks.openEntryStorage.mockResolvedValue(storage ?? session.getStorage());
  mocks.buildAgent.mockReturnValue(agent);
  const runner = startAgentRunner();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.buildAgent).toHaveBeenCalledOnce();
  return { store, session, runner };
}

/** Let a stop() that may still be draining reach its deadline under fake timers. */
async function finishStop(runner: ReturnType<typeof startAgentRunner>): Promise<void> {
  const stopping = runner.stop({ timeoutMs: 0 });
  await vi.advanceTimersByTimeAsync(30_000);
  await stopping;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkSchema.mockReset().mockResolvedValue(undefined);
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

afterEach(() => vi.useRealTimers());

describe('runner claim drain', () => {
  it('still executes and settles a normal claim before shutdown', async () => {
    vi.useFakeTimers();
    const meta = makeMeta();
    const store = {
      ...makeStore(meta),
      claimNextSession: vi
        .fn(async (): Promise<ClaimedAgentSession | null> => null)
        .mockResolvedValueOnce(meta),
    };
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.openEntryStorage.mockResolvedValue((await makeEntryTree()).getStorage());
    mocks.buildAgent.mockReturnValue(makeFakeAgent({ onPrompt: emitToolCallTurn }));
    const runner = startAgentRunner();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.buildAgent).toHaveBeenCalledOnce();
      expect(store.finishSession).toHaveBeenCalledWith(
        meta.id,
        WORKER_ID,
        expect.objectContaining({ status: 'succeeded' }),
      );
      expect(store.releaseLease).not.toHaveBeenCalled();
    } finally {
      await runner.stop();
    }
  });

  it('waits for an in-flight claim and its lease release without starting the late turn', async () => {
    vi.useFakeTimers();
    const claim = Promise.withResolvers<ClaimedAgentSession | null>();
    const release = Promise.withResolvers<void>();
    const meta = makeMeta();
    const store = {
      ...makeStore(meta),
      claimNextSession: vi.fn((_workerId: string) => claim.promise),
    };
    store.releaseLease.mockImplementation(() => release.promise);
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.openEntryStorage.mockResolvedValue((await makeEntryTree()).getStorage());
    mocks.buildAgent.mockReturnValue(makeFakeAgent({}));
    const runner = startAgentRunner();
    const drained = vi.fn();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(store.claimNextSession).toHaveBeenCalledOnce();
      const stopping = runner.stop().then(drained);
      await vi.advanceTimersByTimeAsync(200);
      expect(drained).not.toHaveBeenCalled();
      claim.resolve(meta);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.releaseLease).toHaveBeenCalledWith(
        meta.id,
        store.claimNextSession.mock.calls[0]![0],
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(drained).not.toHaveBeenCalled();
      release.resolve();
      await vi.advanceTimersByTimeAsync(200);
      await stopping;
      expect(drained).toHaveBeenCalledOnce();
      expect(mocks.buildAgent).not.toHaveBeenCalled();
      expect(store.finishSession).not.toHaveBeenCalled();
      expect(store.claimNextSession).toHaveBeenCalledOnce();
    } finally {
      claim.resolve(null);
      release.resolve();
      await vi.advanceTimersByTimeAsync(200);
      await runner.stop({ timeoutMs: 0 });
    }
  });

  it('keeps shutdown bounded and still releases a claim that returns after the drain timeout', async () => {
    vi.useFakeTimers();
    const claim = Promise.withResolvers<ClaimedAgentSession | null>();
    const meta = makeMeta();
    const store = {
      ...makeStore(meta),
      claimNextSession: vi.fn((_workerId: string) => claim.promise),
    };
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.openEntryStorage.mockResolvedValue((await makeEntryTree()).getStorage());
    mocks.buildAgent.mockReturnValue(makeFakeAgent({}));
    const runner = startAgentRunner();
    try {
      await vi.advanceTimersByTimeAsync(0);
      const drained = vi.fn();
      const stopping = runner.stop({ timeoutMs: 200 }).then(drained);
      await vi.advanceTimersByTimeAsync(200);
      await stopping;
      expect(drained).toHaveBeenCalledOnce();
      claim.resolve(meta);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.releaseLease).toHaveBeenCalledWith(
        meta.id,
        store.claimNextSession.mock.calls[0]![0],
      );
      expect(mocks.buildAgent).not.toHaveBeenCalled();
      expect(store.finishSession).not.toHaveBeenCalled();
    } finally {
      claim.resolve(null);
      await vi.advanceTimersByTimeAsync(200);
      await runner.stop({ timeoutMs: 0 });
    }
  });

  it('drains a concurrent late claim before schema-refusal retirement completes', async () => {
    vi.useFakeTimers();
    const setup = Promise.withResolvers<never>();
    const lateClaim = Promise.withResolvers<ClaimedAgentSession | null>();
    const meta = makeMeta({
      lease: { workerId: `${WORKER_ID}:runner-test-uuid`, workerPid: process.pid, heartbeatAt: 0 },
    });
    const late = makeMeta({ id: 'late-session' });
    const store = {
      ...makeStore(meta),
      claimNextSession: vi
        .fn(async (_workerId: string): Promise<ClaimedAgentSession | null> => null)
        .mockResolvedValueOnce(meta)
        .mockImplementationOnce(() => lateClaim.promise),
    };
    store.getSession.mockResolvedValue({ ...meta, lease: meta.lease! });
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.openEntryStorage.mockReturnValueOnce(setup.promise);
    const drained = vi.fn();
    const onSchemaRefusal = vi.fn(async () => {
      await runner.stop();
      drained();
    });
    const runner: ReturnType<typeof startAgentRunner> = startAgentRunner({ onSchemaRefusal });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(store.claimNextSession).toHaveBeenCalledTimes(2);
      const error = Object.assign(new Error('newer schema'), { name: 'SchemaVersionAheadError' });
      setup.reject(error);
      await vi.advanceTimersByTimeAsync(200);
      expect(onSchemaRefusal).toHaveBeenCalledWith(error);
      expect(drained).not.toHaveBeenCalled();
      lateClaim.resolve(late);
      await vi.advanceTimersByTimeAsync(200);
      expect(store.releaseLease).toHaveBeenCalledWith(
        late.id,
        store.claimNextSession.mock.calls[1]![0],
      );
      expect(drained).toHaveBeenCalledOnce();
      expect(mocks.buildAgent).not.toHaveBeenCalled();
      expect(store.finishSession).not.toHaveBeenCalled();
      expect(store.claimNextSession).toHaveBeenCalledTimes(2);
    } finally {
      setup.reject(new Error('test cleanup'));
      lateClaim.resolve(null);
      await vi.advanceTimersByTimeAsync(200);
      await runner.stop({ timeoutMs: 0 });
    }
  });
});

describe('shutdown drain', () => {
  it('lets a running turn finish and settle normally while the runner drains', async () => {
    vi.useFakeTimers();
    const turn = Promise.withResolvers<void>();
    const agent = makeFakeAgent({
      onPrompt: async (emit) => {
        await turn.promise;
        emitTextTurn(emit);
      },
    });
    const { store, runner } = await startRunnerWith(agent);
    try {
      const stopped = vi.fn();
      const stopping = runner.stop().then(stopped);
      // Inside the drain window of the default budget (10s, 5s of it to drain).
      await vi.advanceTimersByTimeAsync(3_000);
      expect(agent.abort).not.toHaveBeenCalled();
      expect(store.finishSession).not.toHaveBeenCalled();
      expect(stopped).not.toHaveBeenCalled();

      turn.resolve();
      await vi.advanceTimersByTimeAsync(200);
      await stopping;
      expect(store.finishSession).toHaveBeenCalledWith(
        SESSION_ID,
        WORKER_ID,
        expect.objectContaining({ status: 'succeeded' }),
      );
      expect(agent.abort).not.toHaveBeenCalled();
      expect(store.releaseLease).not.toHaveBeenCalled();
      expect(runEvents(store).map((event) => event.type)).not.toContain('session_interrupted');
    } finally {
      turn.resolve();
      await finishStop(runner);
    }
  });

  it('hands off a session still running when the drain window closes', async () => {
    vi.useFakeTimers();
    const aborted = Promise.withResolvers<void>();
    const agent = makeFakeAgent({
      onPrompt: async (emit) => {
        emitPendingToolCall(emit);
        await aborted.promise;
      },
      onAbort: () => aborted.resolve(),
    });
    const { store, session, runner } = await startRunnerWith(agent);
    try {
      const stopping = runner.stop();
      await vi.advanceTimersByTimeAsync(4_800);
      expect(agent.abort).not.toHaveBeenCalled();
      // The window closes at 5s; the remaining 5s settle the handoff.
      await vi.advanceTimersByTimeAsync(400);
      expect(agent.abort).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(200);
      await stopping;
      expectInterruptedReceipt((await session.buildContext()).messages);
      expect(runEvents(store).at(-1)).toMatchObject({
        type: 'session_interrupted',
        data: { reason: 'runner shutdown', attempt: 1 },
      });
      expect(store.releaseLease).toHaveBeenCalledWith(SESSION_ID, WORKER_ID);
      expect(store.finishSession).not.toHaveBeenCalled();
    } finally {
      aborted.resolve();
      await finishStop(runner);
    }
  });

  it('does not let a second stop() cut a running drain short', async () => {
    vi.useFakeTimers();
    const turn = Promise.withResolvers<void>();
    const agent = makeFakeAgent({
      onPrompt: async (emit) => {
        await turn.promise;
        emitTextTurn(emit);
      },
    });
    const { store, runner } = await startRunnerWith(agent);
    try {
      const first = runner.stop();
      expect(runner.stop({ timeoutMs: 0 })).toBe(first);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(agent.abort).not.toHaveBeenCalled();
      turn.resolve();
      await vi.advanceTimersByTimeAsync(200);
      await first;
      expect(store.finishSession).toHaveBeenCalledWith(
        SESSION_ID,
        WORKER_ID,
        expect.objectContaining({ status: 'succeeded' }),
      );
    } finally {
      turn.resolve();
      await finishStop(runner);
    }
  });

  it('hands off a run whose entry write fails during the drain, for another instance to retry', async () => {
    vi.useFakeTimers();
    let failWrites = false;
    const storage = (await makeEntryTree()).getStorage();
    // The write fails on its own and the session aborts itself. While the
    // runner shuts down, that parks it like a handoff instead of failing it.
    const failing = new Proxy(storage, {
      get(target, property) {
        if (property === 'appendEntry') {
          return async (entry: Parameters<typeof target.appendEntry>[0]) => {
            if (failWrites) throw new Error('entry store unavailable');
            return target.appendEntry(entry);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const turn = Promise.withResolvers<void>();
    const agent = makeFakeAgent({
      onPrompt: async (emit) => {
        await turn.promise;
        emitTextTurn(emit);
      },
    });
    const { store, runner } = await startRunnerWith(agent, failing);
    try {
      const stopping = runner.stop();
      failWrites = true;
      turn.resolve();
      // Well inside the drain window: the runner aborted nothing itself.
      await vi.advanceTimersByTimeAsync(200);
      await stopping;
      expect(runEvents(store).at(-1)).toMatchObject({
        type: 'session_interrupted',
        data: { reason: 'runner shutdown', attempt: 1 },
      });
      expect(store.releaseLease).toHaveBeenCalledWith(SESSION_ID, WORKER_ID);
      expect(store.finishSession).not.toHaveBeenCalled();
    } finally {
      turn.resolve();
      await finishStop(runner);
    }
  });

  it('attributes a lease lost mid-drain to the lease and reports it in the stop summary', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const aborted = Promise.withResolvers<void>();
    const agent = makeFakeAgent({
      onPrompt: async (emit) => {
        emitPendingToolCall(emit);
        await aborted.promise;
      },
      onAbort: () => aborted.resolve(),
    });
    const { store, runner } = await startRunnerWith(agent);
    try {
      const stopping = runner.stop({ timeoutMs: 30_000 });
      store.heartbeat.mockResolvedValue(false);
      // The next heartbeat (every 2s) finds the lease taken.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(agent.abort).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(200);
      await stopping;
      // Another instance holds the session now: nothing to release or settle.
      expect(store.releaseLease).not.toHaveBeenCalled();
      expect(store.finishSession).not.toHaveBeenCalled();
      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(lines).toContainEqual(
        expect.stringContaining(`session ${SESSION_ID} parked at attempt 1 (lease lost)`),
      );
      expect(lines).toContainEqual(
        expect.stringMatching(
          /1 session\(s\) running at stop, 0 aborted when the drain window closed, 0 still settling; outcomes interrupted:lease lost=1$/,
        ),
      );
    } finally {
      log.mockRestore();
      aborted.resolve();
      await finishStop(runner);
    }
  });

  it('counts each session once in the stop summary, even when its park cannot release the lease', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const aborted = Promise.withResolvers<void>();
    const agent = makeFakeAgent({
      onPrompt: async (emit) => {
        emitPendingToolCall(emit);
        await aborted.promise;
      },
      onAbort: () => aborted.resolve(),
    });
    const { store, runner } = await startRunnerWith(agent);
    // Each park retry emits its interruption again before it fails.
    store.releaseLease.mockRejectedValue(new Error('database unavailable'));
    try {
      const stopping = runner.stop();
      await vi.advanceTimersByTimeAsync(5_400);
      await stopping;
      const interrupted = runEvents(store).filter((event) => event.type === 'session_interrupted');
      expect(interrupted.length).toBeGreaterThan(1);
      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(lines).toContainEqual(
        expect.stringMatching(
          /1 session\(s\) running at stop, 1 aborted when the drain window closed, 0 still settling; outcomes interrupted:runner shutdown=1$/,
        ),
      );
    } finally {
      log.mockRestore();
      error.mockRestore();
      aborted.resolve();
      await finishStop(runner);
    }
  });

  it('does not abort or count a verdict that is already settling when the window closes', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Over the attempt cap: the claim settles as failed without running.
    const store = claimingStore(makeMeta({ attempt: 6 }));
    const settled = Promise.withResolvers<boolean>();
    store.finishSession.mockImplementationOnce(() => settled.promise);
    mocks.getAgentSessionStore.mockResolvedValue(store);
    const runner = startAgentRunner();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(store.finishSession).toHaveBeenCalledOnce();
      const stopping = runner.stop();
      await vi.advanceTimersByTimeAsync(5_200);
      settled.resolve(true);
      await vi.advanceTimersByTimeAsync(400);
      await stopping;
      // Its outcome was decided before the stop, so only the abort count shows it.
      expect(log.mock.calls.map((call) => String(call[0]))).toContainEqual(
        expect.stringMatching(
          /1 session\(s\) running at stop, 0 aborted when the drain window closed, 0 still settling$/,
        ),
      );
    } finally {
      log.mockRestore();
      warn.mockRestore();
      settled.resolve(true);
      await finishStop(runner);
    }
  });

  it('leaves a session that only settles to finish when it hands sessions off, unless the schema is refused', () => {
    const settling = { abort: new AbortController(), settling: true };
    const working = { abort: new AbortController() };
    const cancelling = { abort: new AbortController() };
    cancelling.abort.abort();
    const ctx = {
      running: new Map([
        ['settling', settling],
        ['working', working],
        ['cancelling', cancelling],
      ]),
      shuttingDown: false,
    };
    expect(handOffRunningSessions(ctx)).toBe(1);
    expect(ctx.shuttingDown).toBe(true);
    expect(settling.abort.signal.aborted).toBe(false);
    expect(working.abort.signal.aborted).toBe(true);
    // A schema refusal hands off the settling session too.
    expect(handOffRunningSessions(ctx, { includeSettling: true })).toBe(1);
    expect(settling.abort.signal.aborted).toBe(true);
  });

  it('leaves a turn that completed alone when the drain window closes during its final flush', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // The finished turn is still being written when the drain window closes.
    const writes = await gatedEntryStorage();
    const agent = makeFakeAgent({
      onPrompt: (emit) => {
        writes.gate();
        emitTextTurn(emit);
      },
    });
    const { store, runner } = await startRunnerWith(agent, writes.storage);
    try {
      await writes.flushing;
      const stopping = runner.stop();
      await vi.advanceTimersByTimeAsync(5_200);
      // The window closed while the completed turn was still being written.
      expect(agent.abort).not.toHaveBeenCalled();
      writes.release();
      await vi.advanceTimersByTimeAsync(400);
      await stopping;
      expect(store.finishSession).toHaveBeenCalledWith(
        SESSION_ID,
        WORKER_ID,
        expect.objectContaining({ status: 'succeeded' }),
      );
      expect(runEvents(store).map((event) => event.type)).not.toContain('session_interrupted');
      expect(store.releaseLease).not.toHaveBeenCalled();
      expect(log.mock.calls.map((call) => String(call[0]))).toContainEqual(
        expect.stringMatching(
          /1 session\(s\) running at stop, 0 aborted when the drain window closed, 0 still settling; outcomes end:succeeded=1$/,
        ),
      );
    } finally {
      log.mockRestore();
      writes.release();
      await finishStop(runner);
    }
  });

  it('hands off a turn that completed alone when the process monitor refuses the schema during its final flush', async () => {
    vi.useFakeTimers();
    const writes = await gatedEntryStorage();
    const agent = makeFakeAgent({
      onPrompt: (emit) => {
        writes.gate();
        emitTextTurn(emit);
      },
    });
    const { store, runner } = await startRunnerWith(agent, writes.storage);
    try {
      await writes.flushing;
      // Let the finished turn reach its final flush, where it only settles.
      await vi.advanceTimersByTimeAsync(200);
      runner.handOff();
      writes.release();
      await vi.advanceTimersByTimeAsync(400);
      // It must not settle against the refused schema: it parks instead.
      expect(runEvents(store).at(-1)).toMatchObject({
        type: 'session_interrupted',
        data: { reason: 'runner shutdown', attempt: 1 },
      });
      expect(store.releaseLease).toHaveBeenCalledWith(SESSION_ID, WORKER_ID);
      expect(store.finishSession).not.toHaveBeenCalled();
    } finally {
      writes.release();
      await finishStop(runner);
    }
  });

  it('hands off a turn that completed alone when another session meets a schema refusal', async () => {
    const settlingMeta = makeMeta();
    const refusedMeta = makeMeta({ id: 'session-2' });
    const store = makeStore(settlingMeta);
    const writes = await gatedEntryStorage();
    const setup = Promise.withResolvers<never>();
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.openEntryStorage.mockImplementation(({ sessionId }: { sessionId: string }) =>
      sessionId === refusedMeta.id ? setup.promise : Promise.resolve(writes.storage),
    );
    mocks.buildAgent.mockReturnValue(
      makeFakeAgent({
        onPrompt: (emit) => {
          writes.gate();
          emitTextTurn(emit);
        },
      }),
    );
    const onSchemaRefusal = vi.fn(async () => {});
    const ctx = { running: new Map(), shuttingDown: false, onSchemaRefusal };
    const settlingRun = runSession(ctx, settlingMeta);
    const refusedRun = runSession(ctx, refusedMeta);
    try {
      await writes.flushing;
      await vi.waitFor(() => expect(ctx.running.get(settlingMeta.id)?.settling).toBe(true));
      setup.reject(Object.assign(new Error('newer schema'), { name: 'SchemaVersionAheadError' }));
      await refusedRun;
      expect(onSchemaRefusal).toHaveBeenCalledOnce();
      expect(ctx.running.get(settlingMeta.id)?.abort.signal.aborted).toBe(true);
      writes.release();
      await settlingRun;
      const events = store.appendRunEvent.mock.calls
        .filter((call) => call[0] === settlingMeta.id)
        .map((call) => call[2]);
      expect(events.at(-1)).toMatchObject({
        type: 'session_interrupted',
        data: { reason: 'runner shutdown' },
      });
      expect(store.releaseLease).toHaveBeenCalledWith(settlingMeta.id, WORKER_ID);
      expect(store.finishSession).not.toHaveBeenCalled();
    } finally {
      writes.release();
      setup.reject(new Error('test cleanup'));
      await Promise.allSettled([settlingRun, refusedRun]);
      mocks.openEntryStorage.mockReset();
    }
  });

  it('hands off a run whose shutdown begins while it preloads, before its first model call', async () => {
    vi.useFakeTimers();
    const meta = makeMeta();
    const store = claimingStore(meta);
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.openEntryStorage.mockResolvedValue((await makeEntryTree()).getStorage());
    const agent = makeFakeAgent({ onPrompt: emitTextTurn });
    const prompt = vi.spyOn(agent, 'prompt');
    mocks.buildAgent.mockReturnValue(agent);
    const runner = startAgentRunner();
    let stopping: Promise<void> | undefined;
    preloading.hook = () => {
      stopping ??= runner.stop();
    };
    try {
      await vi.advanceTimersByTimeAsync(400);
      expect(stopping).toBeDefined();
      await stopping;
      expect(prompt).not.toHaveBeenCalled();
      expect(runEvents(store).at(-1)).toMatchObject({
        type: 'session_interrupted',
        data: { reason: 'runner shutdown', attempt: 1 },
      });
      expect(store.releaseLease).toHaveBeenCalledWith(SESSION_ID, WORKER_ID);
      expect(store.finishSession).not.toHaveBeenCalled();
    } finally {
      preloading.hook = undefined;
      await finishStop(runner);
    }
  });

  it('hands off a session still setting up when the shutdown begins, without starting its turn', async () => {
    vi.useFakeTimers();
    const meta = makeMeta();
    const store = claimingStore(meta);
    const tree = await makeEntryTree();
    const opening = Promise.withResolvers<ReturnType<Session['getStorage']>>();
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.openEntryStorage.mockReturnValueOnce(opening.promise);
    const agent = makeFakeAgent({ onPrompt: emitTextTurn });
    const prompt = vi.spyOn(agent, 'prompt');
    mocks.buildAgent.mockReturnValue(agent);
    const runner = startAgentRunner();
    try {
      await vi.advanceTimersByTimeAsync(0);
      const stopping = runner.stop();
      opening.resolve(tree.getStorage());
      await vi.advanceTimersByTimeAsync(400);
      await stopping;
      expect(mocks.buildAgent).toHaveBeenCalledOnce();
      expect(prompt).not.toHaveBeenCalled();
      expect(runEvents(store).at(-1)).toMatchObject({
        type: 'session_interrupted',
        data: { reason: 'runner shutdown', attempt: 1 },
      });
      expect(store.releaseLease).toHaveBeenCalledWith(SESSION_ID, WORKER_ID);
      expect(store.finishSession).not.toHaveBeenCalled();
    } finally {
      opening.resolve(tree.getStorage());
      await finishStop(runner);
    }
  });

  it('still force-aborts and retires on a schema refusal that arrives mid-drain', async () => {
    vi.useFakeTimers();
    const running = makeMeta();
    const settingUp = makeMeta({ id: 'session-2' });
    const store = claimingStore(running, settingUp);
    const tree = await makeEntryTree();
    const setup = Promise.withResolvers<never>();
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.openEntryStorage.mockImplementation(({ sessionId }: { sessionId: string }) =>
      sessionId === settingUp.id ? setup.promise : Promise.resolve(tree.getStorage()),
    );
    const aborted = Promise.withResolvers<void>();
    const agent = makeFakeAgent({
      onPrompt: async (emit) => {
        emitPendingToolCall(emit);
        await aborted.promise;
      },
      onAbort: () => aborted.resolve(),
    });
    mocks.buildAgent.mockReturnValue(agent);
    const onSchemaRefusal = vi.fn(async () => {});
    const runner = startAgentRunner({ onSchemaRefusal });
    const eventsOf = (id: string) =>
      store.appendRunEvent.mock.calls.filter((call) => call[0] === id).map((call) => call[2]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.buildAgent).toHaveBeenCalledOnce();
      const stopping = runner.stop({ timeoutMs: 30_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(agent.abort).not.toHaveBeenCalled();

      const error = Object.assign(new Error('newer schema'), { name: 'SchemaVersionAheadError' });
      setup.reject(error);
      await vi.advanceTimersByTimeAsync(0);
      // Long before the 25s drain window would have closed.
      expect(agent.abort).toHaveBeenCalledOnce();
      expect(onSchemaRefusal).toHaveBeenCalledOnce();
      expect(onSchemaRefusal).toHaveBeenCalledWith(error);
      await vi.advanceTimersByTimeAsync(200);
      await stopping;
      expect(eventsOf(running.id).at(-1)).toMatchObject({
        type: 'session_interrupted',
        data: { reason: 'runner shutdown' },
      });
      expect(eventsOf(settingUp.id).at(-1)).toMatchObject({
        type: 'session_interrupted',
        data: { reason: 'schema compatibility changed' },
      });
      expect(store.finishSession).not.toHaveBeenCalled();
    } finally {
      aborted.resolve();
      setup.reject(new Error('test cleanup'));
      await finishStop(runner);
      mocks.openEntryStorage.mockReset();
    }
  });
});

describe('runtime schema incompatibility', () => {
  const refusal = () =>
    Object.assign(new Error('newer schema'), { name: 'SchemaVersionAheadError' });

  it('reuses a successful schema check between scans and refreshes it after 30 seconds', async () => {
    vi.useFakeTimers();
    const claimNextSession = vi.fn(async () => null);
    mocks.getAgentSessionStore.mockResolvedValue({ claimNextSession });
    const runner = startAgentRunner();
    try {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(mocks.checkSchema).toHaveBeenCalledOnce();
      expect(claimNextSession.mock.calls.length).toBeGreaterThan(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.checkSchema).toHaveBeenCalledTimes(2);
    } finally {
      await runner.stop();
    }
  });

  it('stops before another claim when a previously compatible schema becomes incompatible', async () => {
    vi.useFakeTimers();
    const claimNextSession = vi.fn(async () => null);
    mocks.getAgentSessionStore.mockResolvedValue({ claimNextSession });
    const onSchemaRefusal = vi.fn(async () => {});
    const runner = startAgentRunner({ onSchemaRefusal });
    try {
      await vi.advanceTimersByTimeAsync(29_999);
      const claims = claimNextSession.mock.calls.length;
      const error = refusal();
      mocks.checkSchema.mockRejectedValueOnce(error);
      await vi.advanceTimersByTimeAsync(1);
      expect(onSchemaRefusal).toHaveBeenCalledWith(error);
      expect(claimNextSession).toHaveBeenCalledTimes(claims);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.checkSchema).toHaveBeenCalledTimes(2);
      expect(claimNextSession).toHaveBeenCalledTimes(claims);
    } finally {
      await runner.stop();
    }
  });

  it('does not cache a failed refresh or claim input until that check succeeds', async () => {
    vi.useFakeTimers();
    const claimNextSession = vi.fn(async () => null);
    mocks.getAgentSessionStore.mockResolvedValue({ claimNextSession });
    const onSchemaRefusal = vi.fn(async () => {});
    const runner = startAgentRunner({ onSchemaRefusal });
    try {
      await vi.advanceTimersByTimeAsync(29_999);
      const claims = claimNextSession.mock.calls.length;
      mocks.checkSchema.mockRejectedValueOnce(new Error('ECONNRESET'));
      await vi.advanceTimersByTimeAsync(1);
      expect(claimNextSession).toHaveBeenCalledTimes(claims);
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.checkSchema).toHaveBeenCalledTimes(3);
      expect(claimNextSession).toHaveBeenCalledTimes(claims + 1);
      expect(onSchemaRefusal).not.toHaveBeenCalled();
    } finally {
      await runner.stop();
    }
  });

  it('does not claim a learner input when another release has upgraded a lazy store', async () => {
    vi.useFakeTimers();
    const claimNextSession = vi.fn(async () => null);
    mocks.getAgentSessionStore.mockResolvedValue({ claimNextSession });
    const onSchemaRefusal = vi.fn(async () => {});
    mocks.checkSchema.mockRejectedValueOnce(refusal());
    const runner = startAgentRunner({ onSchemaRefusal });
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(onSchemaRefusal).toHaveBeenCalledOnce();
      expect(claimNextSession).not.toHaveBeenCalled();
      expect(mocks.checkSchema).toHaveBeenCalledOnce();
    } finally {
      await runner.stop();
    }
  });

  it('keeps polling on temporary database failure without claiming or retiring the process', async () => {
    vi.useFakeTimers();
    const claimNextSession = vi.fn(async () => null);
    mocks.getAgentSessionStore.mockResolvedValue({ claimNextSession });
    const onSchemaRefusal = vi.fn(async () => {});
    mocks.checkSchema.mockRejectedValueOnce(new Error('ECONNRESET'));
    const runner = startAgentRunner({ onSchemaRefusal });
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(onSchemaRefusal).not.toHaveBeenCalled();
      expect(claimNextSession).toHaveBeenCalled();
    } finally {
      await runner.stop();
    }
  });

  it('parks a claim if migration races the preflight instead of failing and automatically retrying the input', async () => {
    const meta = makeMeta();
    const store = makeStore(meta);
    mocks.getAgentSessionStore.mockResolvedValue(store);
    const error = refusal();
    mocks.openEntryStorage.mockRejectedValueOnce(error);
    const onSchemaRefusal = vi.fn(async () => {});
    const other = new AbortController();
    const ctx = {
      running: new Map([['other', { abort: other }]]),
      shuttingDown: false,
      onSchemaRefusal,
    };
    await runSession(ctx, meta);
    expect(ctx.shuttingDown).toBe(true);
    expect(other.signal.aborted).toBe(true);
    expect(onSchemaRefusal).toHaveBeenCalledWith(error);
    expect(store.finishSession).not.toHaveBeenCalled();
    expect(store.requeueForRetry).not.toHaveBeenCalled();
    expect(store.releaseLease).toHaveBeenCalledWith(SESSION_ID, WORKER_ID);
    expect(runEvents(store)).toContainEqual(
      expect.objectContaining({
        type: 'session_interrupted',
        data: expect.objectContaining({ reason: 'schema compatibility changed' }),
      }),
    );
  });

  it('hands the refusal to retirement once when several sessions meet it', async () => {
    const first = makeMeta();
    const second = makeMeta({ id: 'session-2' });
    const store = makeStore(first);
    mocks.getAgentSessionStore.mockResolvedValue(store);
    const error = refusal();
    mocks.openEntryStorage.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    const onSchemaRefusal = vi.fn(async () => {});
    const ctx = { running: new Map(), shuttingDown: false, onSchemaRefusal };
    try {
      await Promise.all([runSession(ctx, first), runSession(ctx, second)]);
    } finally {
      mocks.openEntryStorage.mockReset();
    }
    // Both sessions park, but the process retires once: a second retirement
    // would restart the drain and exit path the first one already owns.
    expect(onSchemaRefusal).toHaveBeenCalledOnce();
    expect(onSchemaRefusal).toHaveBeenCalledWith(error);
    for (const id of [first.id, second.id]) {
      const events = store.appendRunEvent.mock.calls
        .filter((call) => call[0] === id)
        .map((call) => call[2]);
      expect(events.at(-1)).toMatchObject({
        type: 'session_interrupted',
        data: { reason: 'schema compatibility changed' },
      });
      expect(store.releaseLease).toHaveBeenCalledWith(id, WORKER_ID);
    }
    expect(store.finishSession).not.toHaveBeenCalled();
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

    const messageEndSeqs = store.appendRunEvent.mock.calls.flatMap((call, index) =>
      call[2].type === 'message_end' ? [index + 1] : [],
    );
    expect(store.pruneMessageUpdates.mock.calls).toEqual(
      messageEndSeqs.map((seq) => [SESSION_ID, seq]),
    );
    for (const [index, seq] of messageEndSeqs.entries()) {
      const appendCallOrder = store.appendRunEvent.mock.invocationCallOrder[seq - 1]!;
      expect(store.pruneMessageUpdates.mock.invocationCallOrder[index]).toBeGreaterThan(
        appendCallOrder,
      );
    }
  });

  it('parks a run the shutdown hands off with a durable receipt for the orphaned call', async () => {
    vi.useFakeTimers();
    const aborted = Promise.withResolvers<void>();
    const agent = makeFakeAgent({
      onPrompt: async (emit) => {
        emitPendingToolCall(emit);
        await aborted.promise;
      },
      onAbort: () => aborted.resolve(),
    });
    const { store, session, runner } = await startRunnerWith(agent);
    try {
      // A zero budget has no drain window: the session is handed off at once.
      await runner.stop({ timeoutMs: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(agent.abort).toHaveBeenCalledOnce();
      expectInterruptedReceipt((await session.buildContext()).messages);
      const events = runEvents(store);
      expect(events.at(-1)?.type).toBe('session_interrupted');
      expect(events.at(-1)?.data).toMatchObject({ reason: 'runner shutdown', attempt: 1 });
      expect(store.releaseLease).toHaveBeenCalledWith(SESSION_ID, WORKER_ID);
      expect(store.finishSession).not.toHaveBeenCalled();
    } finally {
      aborted.resolve();
      await finishStop(runner);
    }
  });

  it('settles a run whose own code throws while a shutdown drains, instead of parking it', async () => {
    const meta = makeMeta();
    const session = await makeEntryTree();
    const store = makeStore(meta);
    const ctx = { running: new Map(), shuttingDown: false };
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.buildAgent.mockImplementation(() =>
      makeFakeAgent({
        onPrompt: async (emit) => {
          emitToolCallTurn(emit);
          // The drain starts mid-turn. pi records a provider failure in the
          // transcript and resolves; a rejection stands for the runner's own code.
          ctx.shuttingDown = true;
          throw new Error('runner step failed while draining');
        },
      }),
    );

    // Draining, but the runner never handed this session off.
    await runSession(ctx, meta);

    expectInterruptedReceipt((await session.buildContext()).messages);
    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({ status: 'failed' }),
    );
    expect(runEvents(store).at(-1)?.type).toBe('session_end');
    expect(store.releaseLease).not.toHaveBeenCalled();
  });

  it('settles a setup failure during the drain as a failure instead of parking it', async () => {
    const meta = makeMeta();
    const store = makeStore(meta);
    mocks.openEntryStorage.mockResolvedValue((await makeEntryTree()).getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.resolveAgentDriverModel.mockRejectedValueOnce(new Error('driver unavailable'));

    // Draining from the start: the setup failure did not abort the run.
    await runSession({ running: new Map(), shuttingDown: true }, meta);

    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({ status: 'failed', error: 'driver unavailable' }),
    );
    expect(store.releaseLease).not.toHaveBeenCalled();
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
    const store = makeStore(meta);
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

describe('resume marker in the settle log', () => {
  /** Settle one claim over an interrupted transcript; return its settle line and resume reason. */
  async function settle(meta: ClaimedAgentSession) {
    const session = await makeEntryTree([
      userMessage('Build a lesson', 1),
      assistantCallMessage(2),
    ]);
    const store = makeStore(meta);
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.buildAgent.mockImplementation((options: { history?: AgentMessage[] }) =>
      makeFakeAgent({ messages: options.history ?? [] }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runSession({ running: new Map(), shuttingDown: false }, meta);
      return {
        line: log.mock.calls
          .map((call) => String(call[0]))
          .find((text) => text.includes(`session ${SESSION_ID} -> `)),
        resumedReason: runEvents(store).find((event) => event.type === 'session_resumed')?.data
          ?.reason,
      };
    } finally {
      log.mockRestore();
    }
  }

  it('marks the takeover of a parked run as resumed, though the park spent no attempt', async () => {
    // A park releases the lease, and the next claim takes the run over as
    // `orphaned` without counting an attempt: it is still attempt 1.
    const { line, resumedReason } = await settle(makeMeta({ claimReason: 'orphaned', attempt: 1 }));
    expect(resumedReason).toBe('crash');
    expect(line).toContain('-> succeeded (attempt 1, resumed, ');
  });

  it('does not mark a retry after a failure as resumed, though it is a later attempt', async () => {
    // A failed run requeued for retry keeps its attempt count and is claimed
    // as `queued`: a new attempt, not the takeover of an interrupted run.
    const { line, resumedReason } = await settle(makeMeta({ claimReason: 'queued', attempt: 2 }));
    expect(resumedReason).toBe('follow_up');
    expect(line).toContain('-> succeeded (attempt 2, ');
    expect(line).not.toContain('resumed');
  });
});
