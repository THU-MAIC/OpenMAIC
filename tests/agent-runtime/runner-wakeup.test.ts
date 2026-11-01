/**
 * Runner per-session NOTIFY wakeup wiring (hermetic unit port of the
 * reference's runner-notify PG contract).
 *
 * What is pinned here, with a REAL `runSession` loop and a fake Agent:
 *
 *  1. the runner registers exactly ONE `{kind:'session'}` wakeup subscription
 *     per run and removes it when the run ends (no leaked subscription);
 *  2. a session-route wake runs BOTH cheap point reads — `isCancelRequested`
 *     (the cancel check) and the drain (`listUserMessages`) — so a user
 *     message written by the control plane is steered into the live agent in
 *     the hundreds-of-ms range instead of on the 5s fallback poll;
 *  3. the 5s message/cancel polls stay as the lossy-NOTIFY backstop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // The drain refuses to steer without a matching lease, and WORKER_ID is a
  // random-per-process value. Capture it from the first appendRunEvent call
  // (the runner passes WORKER_ID as its second argument) and hand it back
  // through getSession so `leaseMatches` sees a live, owned session.
  const history = { started: false };
  let workerId: string | undefined;
  let deliveredUserMessageSeq = 0;
  const recordWorker = async (_id: string, worker: string, _event?: { type?: string }) => {
    workerId = worker;
    return 1;
  };
  const store = {
    appendRunEvent: vi.fn(recordWorker),
    clearCancel: vi.fn(async () => undefined),
    finishSession: vi.fn(async () => true),
    getSession: vi.fn(async () =>
      workerId
        ? {
            id: 'session-wake',
            ownerId: 'owner-1',
            status: 'running',
            attempt: 1,
            deliveredUserMessageSeq,
            lease: { workerId, workerPid: process.pid, heartbeatAt: Date.now() },
          }
        : null,
    ),
    // The event log as the runner reads it: the user messages listUserMessages
    // models, as `user_message` events, and no earlier run.
    readEventsAfter: vi.fn(async (sessionId: string, afterSeq: number) =>
      afterSeq > 0
        ? []
        : [
            ...(history.started
              ? [{ id: 1, ts: 1, attempt: 1, type: 'run_started', data: {} }]
              : []),
            ...(await store.listUserMessages(sessionId)).map((message) => ({
              id: message.seq,
              ts: message.ts,
              attempt: 1,
              type: 'user_message',
              data: {
                text: message.text,
                delivery: message.delivery,
                materials: message.materials,
                locale: message.locale,
              },
            })),
          ],
    ),
    heartbeat: vi.fn(async () => true),
    markUserMessageDelivered: vi.fn(async (_id, _worker, _attempt, messageSeq: number) => {
      deliveredUserMessageSeq = Math.max(deliveredUserMessageSeq, messageSeq);
      return true;
    }),
    getCancelRequestedAt: vi.fn(async () => null),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(
      async (
        _sessionId?: string,
      ): Promise<
        Array<{
          seq: number;
          ts: number;
          text: string;
          delivery: string;
          materials: unknown[];
          locale?: string;
        }>
      > => [],
    ),
    releaseLease: vi.fn(async () => undefined),
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
  };
  const bus = {
    route: undefined as undefined | { kind: string; sessionId: string },
    wake: undefined as undefined | (() => void),
    unsubscribeWakeup: vi.fn(),
  };
  return {
    store,
    bus,
    /** Transcript the next run finds in its entry tree (a run cut off mid-turn). */
    entrySeed: [] as unknown[],
    history,
    /** The default event append; a test that replaces it leaves it replaced. */
    recordWorker,
    resetWorker: () => {
      workerId = undefined;
      deliveredUserMessageSeq = 0;
    },
  };
});

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: vi.fn(async () => mocks.store),
}));

vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  subscribeAgentEventWakeup: vi.fn(
    (route: { kind: string; sessionId: string }, wake: () => void) => {
      mocks.bus.route = route;
      mocks.bus.wake = wake;
      return mocks.bus.unsubscribeWakeup;
    },
  ),
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
  const { InMemorySessionRepo, Session } = await import('@earendil-works/pi-agent-core');
  return {
    ...actual,
    AgentSessionEntryStorage: {
      open: async ({ sessionId }: { sessionId: string }) => {
        const storage = (await new InMemorySessionRepo().create({ id: sessionId })).getStorage();
        if (mocks.entrySeed.length) {
          const seeded = new Session(storage);
          for (const message of mocks.entrySeed.splice(0)) {
            await seeded.appendMessage(message as never);
          }
        }
        return storage;
      },
    },
  };
});

// No installed skills and no user-skill store: the skill surface is
// orthogonal to the wakeup under test.
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

// The owner-bound document store is setup-only in this harness; the tools
// built around it are never invoked.
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getBackgroundDocumentStore: vi.fn(async () => ({})),
}));

// Capability resolution stays hermetic: no web search and no voice
// registration backend in this harness.
vi.mock('@/lib/server/agent-runtime/web-search', () => ({
  resolveWebSearchCapability: () => null,
}));
vi.mock('@/lib/server/agent-runtime/voice-clone-tools', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/voice-clone-tools')>();
  return { ...actual, hasConfiguredVoiceRegistrationCapability: () => false };
});

// A resolvable driver model with a no-op streamFn: the fake Agent below never
// reads the stream, so nothing touches a real model gateway.
vi.mock('@/lib/server/agent-runtime/agent-driver-model', () => ({
  resolveAgentDriverModel: vi.fn(async () => ({
    connection: { model: { id: 'wakeup-test' }, modelId: 'wakeup-test', providerId: 'test' },
    piModel: {
      id: 'wakeup-test',
      name: 'wakeup-test',
      api: 'openai-completions',
      provider: 'test',
      baseUrl: '',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8_192,
  })),
}));
vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: vi.fn(() => async () => undefined),
}));

/**
 * The fake Agent the runner constructs. `prompt` stays pending until the test
 * releases it (or an abort fires), keeping the session "running" while
 * messages/cancels are injected through the wakeup. A steered message is
 * folded into the entry tree via message_end so the runner's post-settle
 * undelivered-message check counts it as delivered.
 */
const fake = vi.hoisted(() => {
  class FakeAgent {
    state: { messages: unknown[]; errorMessage?: string } = { messages: [] };
    steerCalls: Array<{ role: string; content: unknown }> = [];
    /** What the runner built the agent with: its tools, among them the material tools. */
    options: { initialState?: { tools?: unknown[] } } = {};
    /** Hold a steered message's message_end until `consumeSteered` (pi consumes later). */
    deferSteerEnd = false;
    private heldSteers: Array<{ role: string; content: unknown }> = [];
    promptCalls = 0;
    abortCalls = 0;
    private subscribers = new Set<(event: unknown) => void>();
    private release: (() => void) | null = null;

    reset(): void {
      this.state = { messages: [] };
      this.steerCalls = [];
      this.heldSteers = [];
      this.deferSteerEnd = false;
      this.promptCalls = 0;
      this.abortCalls = 0;
      this.subscribers = new Set();
      this.release = null;
    }

    subscribe(cb: (event: unknown) => void): () => void {
      this.subscribers.add(cb);
      return () => this.subscribers.delete(cb);
    }

    abort(): void {
      this.abortCalls += 1;
      this.release?.();
    }

    /** Test hook: let the pending prompt resolve so the run can settle. */
    releasePrompt(): void {
      this.release?.();
      this.release = null;
    }

    clearAllQueues(): void {
      // buildAgent's terminal-barrier hook only calls this on a length stop,
      // which this harness never produces.
    }

    async prompt(input: unknown): Promise<void> {
      this.promptCalls += 1;
      // The prompt becomes the first user message of the conversation (real pi
      // behaviour) — folded into the entry tree via message_end so the
      // runner's post-settle undelivered-message check counts it as delivered.
      const message = Array.isArray(input)
        ? input[0]
        : input && typeof input === 'object'
          ? input
          : { role: 'user', content: input };
      this.state.messages.push(message);
      this.emitMessageEnd(message as { role: string; content: unknown });
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }

    async continue(): Promise<void> {
      await this.prompt('');
    }

    async followUp(message: { role: string; content: unknown }): Promise<void> {
      await this.prompt(String((message as { content?: unknown })?.content ?? ''));
    }

    async waitForIdle(): Promise<void> {
      // Idle immediately after prompt resolves; the drain loop then drains and
      // settles. A blocked prompt never reaches here.
    }

    steer(message: { role: string; content: unknown }): void {
      this.steerCalls.push(message);
      if (this.deferSteerEnd) {
        this.heldSteers.push(message);
        return;
      }
      this.state.messages.push(message);
      this.emitMessageEnd(message);
    }

    /** Test hook: pi takes the held steered messages into the conversation. */
    consumeSteered(): void {
      for (const message of this.heldSteers.splice(0)) {
        this.state.messages.push(message);
        this.emitMessageEnd(message);
      }
    }

    private emitMessageEnd(message: { role: string; content: unknown }): void {
      const event = { type: 'message_end', message };
      for (const cb of [...this.subscribers]) cb(event);
    }
  }

  const current: { instance?: FakeAgent } = {};
  return { FakeAgent, current };
});

vi.mock('@earendil-works/pi-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-agent-core')>();
  class MockAgent extends fake.FakeAgent {
    constructor(options: { initialState?: { tools?: unknown[] } } = {}) {
      super();
      this.options = options;
      // The runner constructs exactly one Agent per run; expose it so tests can
      // wait for the run to reach the prompt and observe its steer/abort.
      fake.current.instance = this;
    }
  }
  return { ...actual, Agent: MockAgent };
});

import { runSession } from '@/lib/server/agent-runtime/runner';

const SESSION = {
  id: 'session-wake',
  ownerId: 'owner-1',
  prompt: 'Build a lesson',
  stageId: 'stage-1',
  existingCourse: false,
  status: 'running' as const,
  attempt: 1,
  createdAt: 1,
  updatedAt: 1,
  claimReason: 'queued' as const,
  claimSeq: 1,
  deliveredUserMessageSeq: 0,
};

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // The run must be parked on the pending prompt AND its lease captured
    // (the worker id is learned from the first appendRunEvent call, which the
    // runner queues on its write chain before reaching the prompt). Without
    // the lease the drain would refuse to steer.
    if (
      fake.current.instance &&
      fake.current.instance.promptCalls > 0 &&
      mocks.store.appendRunEvent.mock.calls.length > 0
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run never reached a ready state');
}

describe('runSession NOTIFY wakeup wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.current.instance?.reset();
    fake.current.instance = undefined;
    mocks.resetWorker();
    mocks.bus.route = undefined;
    mocks.bus.wake = undefined;
    mocks.store.listUserMessages.mockResolvedValue([]);
  });

  it('subscribes to the session route, wakes the cancel check and drain, and unsubscribes on settle', async () => {
    const run = runSession({ running: new Map(), shuttingDown: false }, SESSION);
    await waitForReady();

    expect(mocks.bus.route).toEqual({ kind: 'session', sessionId: 'session-wake' });
    expect(mocks.bus.wake).toBeTypeOf('function');

    // A user message lands on the control plane; the SAME wake that fired for
    // it must drain it into the live agent immediately — no 5s fallback poll.
    mocks.store.listUserMessages.mockResolvedValueOnce([
      { seq: 2, ts: 1, text: 'follow-up from the control plane', delivery: 'steer', materials: [] },
    ]);
    mocks.bus.wake?.();
    await vi.waitFor(() => {
      expect(fake.current.instance?.steerCalls).toEqual([
        expect.objectContaining({ role: 'user', content: 'follow-up from the control plane' }),
      ]);
    });
    // The wake runs BOTH cheap point reads: the drain above and the cancel
    // check — one shared subscription, two checks (reference semantics).
    expect(mocks.store.listUserMessages).toHaveBeenCalledWith('session-wake');
    expect(mocks.store.getCancelRequestedAt).toHaveBeenCalled();

    // Release the pending prompt and let the run settle; the subscription must
    // go away with it.
    fake.current.instance?.releasePrompt();
    await run;
    expect(mocks.store.markUserMessageDelivered).toHaveBeenCalledWith(
      'session-wake',
      expect.any(String),
      1,
      2,
    );
    expect(mocks.store.requeueSession).not.toHaveBeenCalled();
    expect(mocks.bus.unsubscribeWakeup).toHaveBeenCalledOnce();
  });

  it('delivers the durable opening message once and does not requeue after settlement', async () => {
    mocks.store.listUserMessages.mockResolvedValue([
      { seq: 1, ts: 1, text: 'Build a lesson', delivery: 'queued', materials: [] },
    ]);

    const run = runSession({ running: new Map(), shuttingDown: false }, SESSION);
    await waitForReady();
    fake.current.instance?.releasePrompt();
    await run;

    expect(mocks.store.markUserMessageDelivered).toHaveBeenCalledWith(
      'session-wake',
      expect.any(String),
      1,
      1,
    );
    expect(fake.current.instance?.promptCalls).toBe(1);
    expect(mocks.store.requeueSession).not.toHaveBeenCalled();
    expect(mocks.store.requeueForRetry).not.toHaveBeenCalled();
  });

  it('rescues exactly once when a message lands after the final drain', async () => {
    const opening = { seq: 1, ts: 1, text: 'Build a lesson', delivery: 'queued', materials: [] };
    const late = { seq: 2, ts: 2, text: 'One more change', delivery: 'steer', materials: [] };
    mocks.store.listUserMessages.mockResolvedValue([opening]);
    mocks.store.requeueSession.mockResolvedValueOnce(true).mockResolvedValue(false);

    const run = runSession({ running: new Map(), shuttingDown: false }, SESSION);
    await waitForReady();
    mocks.store.appendRunEvent.mockImplementation(async (_id, _worker, event) => {
      if (event?.type === 'session_end') {
        mocks.store.listUserMessages.mockResolvedValue([opening, late]);
      }
      return 10;
    });
    fake.current.instance?.releasePrompt();
    await run;

    expect(mocks.store.markUserMessageDelivered).toHaveBeenCalledWith(
      'session-wake',
      expect.any(String),
      1,
      1,
    );
    expect(mocks.store.requeueSession).toHaveBeenCalledOnce();
    expect(mocks.store.requeueForRetry).not.toHaveBeenCalled();
  });

  it('still unsubscribes when setup fails before the agent is built', async () => {
    // A driver-model failure kills the run during setup — the wakeup
    // subscription created before the try must still be cleaned up.
    const { resolveAgentDriverModel } =
      await import('@/lib/server/agent-runtime/agent-driver-model');
    vi.mocked(resolveAgentDriverModel).mockRejectedValueOnce(new Error('driver unavailable'));

    await runSession({ running: new Map(), shuttingDown: false }, SESSION);

    expect(mocks.bus.route).toEqual({ kind: 'session', sessionId: 'session-wake' });
    expect(mocks.bus.unsubscribeWakeup).toHaveBeenCalledOnce();
  });
});

/**
 * #1880: the material tools speak the language of the user message the run is
 * answering. These runs go through the REAL `runSession` and call the
 * `list_materials` the runner registered, on a conversation source whose
 * parse failed because no parser is configured; its `reason` shows which
 * language is in effect.
 */
describe('runSession material wording follows the consumed message', () => {
  const REASON = {
    'zh-CN': '解析服务不可用',
    'en-US': 'Parsing service unavailable',
    'ja-JP': '解析サービスを利用できません',
  } as const;
  const message = (seq: number, locale?: string) => ({
    seq,
    ts: seq,
    text: `message ${seq}`,
    delivery: 'queued',
    materials: [],
    ...(locale ? { locale } : {}),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    fake.current.instance?.reset();
    fake.current.instance = undefined;
    mocks.resetWorker();
    // An earlier test replaces the append; the drain needs the lease it records.
    mocks.store.appendRunEvent.mockImplementation(mocks.recordWorker);
    mocks.store.listUserMessages.mockResolvedValue([]);
    const { listSessionScopeMaterials } =
      await import('@/lib/server/agent-runtime/material-resolver');
    vi.mocked(listSessionScopeMaterials).mockResolvedValue([
      {
        origin: 'session',
        record: {
          id: 'mat_failed',
          sessionId: 'session-wake',
          kind: 'source',
          title: 'deck.pptx',
          ownerMaterialId: null,
          sourceUrl: null,
          textAssetId: null,
          rawAssetId: 'raw',
          textChars: 0,
          derivedFrom: null,
          extraction: {
            status: 'failed',
            attempts: 1,
            error: 'no parser: set PARSER_BASE_URL and PARSER_API_KEY',
            reasonCode: 'service_unavailable',
          },
          createdAt: new Date(0).toISOString(),
        },
      },
    ] as never);
  });

  /** What the registered list_materials says about the failed source right now. */
  async function listedReason(): Promise<string> {
    const tools = (fake.current.instance?.options.initialState?.tools ?? []) as Array<{
      name: string;
      execute: (id: string, params: unknown) => Promise<{ details: unknown }>;
    }>;
    const list = tools.find((candidate) => candidate.name === 'list_materials')!;
    const { details } = await list.execute('list', {});
    const wire = JSON.stringify(details);
    expect(wire).not.toContain('PARSER_BASE_URL');
    return (details as { materials: Array<{ extraction: { reason: string } }> }).materials[0]!
      .extraction.reason;
  }

  async function settle(run: Promise<void>): Promise<void> {
    fake.current.instance?.releasePrompt();
    await run;
  }

  it('uses the language the session was created in for a first prompt with no message event', async () => {
    const run = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, locale: 'en-US' },
    );
    await waitForReady();
    expect(await listedReason()).toBe(REASON['en-US']);
    await settle(run);
  });

  it('falls back to the project default when neither the session nor a message names one', async () => {
    const run = runSession({ running: new Map(), shuttingDown: false }, SESSION);
    await waitForReady();
    expect(await listedReason()).toBe(REASON['zh-CN']);
    await settle(run);
  });

  it('answers queued messages in their own language, each from when it is consumed', async () => {
    // Two queued messages: the run starts from the first; the second's
    // language must not reach the turn before it.
    mocks.store.listUserMessages.mockResolvedValue([message(5, 'en-US'), message(6, 'ja-JP')]);
    const run = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, locale: 'zh-CN' },
    );
    await waitForReady();
    expect(await listedReason()).toBe(REASON['en-US']);

    // The second is drained and handed to pi, but not yet consumed.
    fake.current.instance!.deferSteerEnd = true;
    mocks.bus.wake?.();
    await vi.waitFor(() => expect(fake.current.instance?.steerCalls).toHaveLength(1));
    expect(await listedReason()).toBe(REASON['en-US']);

    // Pi takes it into the conversation: from its turn on, its language.
    fake.current.instance!.consumeSteered();
    expect(await listedReason()).toBe(REASON['ja-JP']);
    await settle(run);
  });

  it('keeps the language in effect when a steered message names none, or an unsupported one', async () => {
    mocks.store.listUserMessages.mockResolvedValue([message(5, 'en-US')]);
    const run = runSession({ running: new Map(), shuttingDown: false }, SESSION);
    await waitForReady();
    expect(await listedReason()).toBe(REASON['en-US']);
    mocks.store.listUserMessages.mockResolvedValue([
      message(5, 'en-US'),
      message(6),
      message(7, 'xx-YY'),
    ]);
    mocks.bus.wake?.();
    await vi.waitFor(() => expect(fake.current.instance?.steerCalls).toHaveLength(2));
    expect(await listedReason()).toBe(REASON['en-US']);
    await settle(run);
  });

  it('restores the language of the last consumed message after a restart with nothing pending', async () => {
    // Both messages were consumed before the worker died; the session itself
    // was created in English. The resumed run must not fall back to that.
    mocks.store.listUserMessages.mockResolvedValue([message(5, 'en-US'), message(6, 'ja-JP')]);
    const run = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, locale: 'en-US', claimReason: 'orphaned', deliveredUserMessageSeq: 6 },
    );
    await waitForReady();
    expect(await listedReason()).toBe(REASON['ja-JP']);
    await settle(run);
  });

  it('continues a cut-off turn in its own language, not that of a message queued since', async () => {
    // The worker died mid-turn after consuming message 5; message 6 arrived
    // meanwhile. The takeover continues turn 5 -- and only consuming 6 moves on.
    mocks.entrySeed.push({ role: 'user', content: 'message 5', timestamp: 5 });
    mocks.history.started = true;
    mocks.store.listUserMessages.mockResolvedValue([message(5, 'en-US'), message(6, 'ja-JP')]);
    const run = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, locale: 'zh-CN', claimReason: 'orphaned', deliveredUserMessageSeq: 5 },
    );
    await waitForReady();
    expect(await listedReason()).toBe(REASON['en-US']);
    mocks.bus.wake?.();
    await vi.waitFor(() => expect(fake.current.instance?.steerCalls).toHaveLength(1));
    expect(await listedReason()).toBe(REASON['ja-JP']);
    await settle(run);
    mocks.history.started = false;
  });

  it('resumes in the language of a frame saved before its delivered cursor landed', async () => {
    // The worker saved user frame 6 to the transcript, then stopped before the
    // separate delivered-cursor write: the cursor still says 5. The takeover
    // continues the turn answering 6, so it must speak 6's language.
    mocks.entrySeed.push({
      role: 'user',
      content: 'message 6',
      timestamp: 6,
      openmaicDurableUserMessageSeq: 6,
    });
    mocks.history.started = true;
    mocks.store.listUserMessages.mockResolvedValue([message(5, 'en-US'), message(6, 'ja-JP')]);
    const run = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, locale: 'zh-CN', claimReason: 'orphaned', deliveredUserMessageSeq: 5 },
    );
    await waitForReady();
    expect(await listedReason()).toBe(REASON['ja-JP']);
    await settle(run);
    mocks.history.started = false;
  });

  it('keeps two sessions apart: one run’s language never reaches the next', async () => {
    const first = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, locale: 'ja-JP' },
    );
    await waitForReady();
    expect(await listedReason()).toBe(REASON['ja-JP']);
    await settle(first);

    fake.current.instance?.reset();
    fake.current.instance = undefined;
    mocks.resetWorker();
    const second = runSession(
      { running: new Map(), shuttingDown: false },
      { ...SESSION, id: 'session-other', locale: 'en-US' },
    );
    await waitForReady();
    expect(await listedReason()).toBe(REASON['en-US']);
    await settle(second);
  });
});
